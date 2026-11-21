/** Shared independent-review runtime; task policies remain in their own entry points. */
import type { Context } from '@deepseek-ai/cordis';
import type { SubagentActivation, SubagentResult, SubagentStartRequest } from '@deepseek-ai/dsh-subagent';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import { VERIFIER_PRESET, VERIFIER_PRESET_ID } from './preset.js';
import { errorMessages, isCancellation, type VerificationRecording } from './recording.js';

/** 子代理终局结果与句柄。用官方类型，不手写重复定义。 */
type VerifierResult = SubagentResult;
type VerifierRun = SubagentActivation;

/**
 * 派发给 spawn 的请求。
 *
 * 0.2.1 起 `label` / `signal` 挪到了 `SubagentActivationSpec` 的外层，
 * `persona` / `toolFilter` 被删除（改由 Agent Preset 承担）。
 */
export type VerifierRequest = Omit<SubagentStartRequest, 'label' | 'signal'>;

/** 一次派发尝试的产物。`run` 用于报 session id，`result` 是终局结果。 */
export interface VerifierAttempt {
  run: VerifierRun | undefined;
  result: VerifierResult;
}

/**
 * 0.2.1 起，验证者的只读工具面由一份独立 Agent Preset 承担。
 *
 * 这里**不能降级**成「没有 preset 就直接 spawn」：那会把 write/edit 还给
 * 验证者，Actor ≠ Verifier 的核心保证当场消失。宿主没有 preset registry，
 * 或 preset 激活失败时，宁可让 `sdlc_verify` 报错，也不静默放宽。
 */
const NO_PRESET_REGISTRY_MESSAGE =
  '当前宿主没有 agent preset registry（ctx.agentPresets），无法启动只读验证者。' +
  '0.2.1 起独立验证要求 dsh-agent-preset-registry（web/desktop 自带；headless 没有）。' +
  '不会降级为继承全部工具的子代理——那会让验证者重新拿到 write/edit。';

/**
 * 一次验证运行对验证者 preset 的租约。
 *
 * 为什么不常驻注册：`agentPresets/list` 会把**每一条声明**都列进新会话/设置页
 * 的模式选择器。验证者 preset 是内部实现细节，常驻注册会让用户看到一个可选的
 * 「SDLC Verifier 模式」（实测截图）。改成**按需注册、跑完归还**：
 * 空闲时选择器里只有「AI 原生 SDLC」，验证期间才短暂存在。
 *
 * 用 depth 计数支持并发验证：同一个插件实例里重叠的 sdlc_verify 共享一次注册，
 * 最后一个离开时才 dispose；disposer 交给 registry 的代际退役处理，
 * 仍被验证者 Agent 持有的引用不会失效。
 */
interface VerifierPresetLease {
  depth: number;
  release: () => Promise<void> | void;
}

const verifierPresetLeases = new WeakMap<Context, VerifierPresetLease>();

export async function withVerifierPreset<T>(ctx: Context, run: () => Promise<T>): Promise<T> {
  const registry = ctx.get('agentPresets');
  if (registry === undefined) throw new Error(NO_PRESET_REGISTRY_MESSAGE);

  let lease = verifierPresetLeases.get(ctx);
  if (lease === undefined) {
    let release: (() => Promise<void> | void) | undefined;
    try {
      release = await registry.register(VERIFIER_PRESET);
    } catch (error) {
      throw new Error(
        `验证者 preset "${VERIFIER_PRESET_ID}" 注册失败：${errorMessages(error).join('; ')}` +
          '。独立验证需要 read/grep/glob/shell/skill；修好 preset 再验证，不要绕过。',
      );
    }
    if (typeof release !== 'function') {
      throw new Error(
        `验证者 preset "${VERIFIER_PRESET_ID}" 注册没有返回 disposer（registry 契约不匹配）`,
      );
    }
    lease = { depth: 0, release };
    verifierPresetLeases.set(ctx, lease);
  }

  lease.depth += 1;
  try {
    return await run();
  } finally {
    lease.depth -= 1;
    if (lease.depth === 0) {
      verifierPresetLeases.delete(ctx);
      try {
        await lease.release();
      } catch {
        // 归还失败不应掩盖这次验证的结果：preset 代际退役是 registry 的职责，
        // 最坏情况只是下一次注册前旧代际仍在（registry 会按更新处理）。
      }
    }
  }
}

export async function assertVerifierPreset(ctx: Context): Promise<void> {
  const registry = ctx.get('agentPresets');
  if (registry === undefined) throw new Error(NO_PRESET_REGISTRY_MESSAGE);
  let preset;
  try {
    preset = await registry.resolve(VERIFIER_PRESET_ID);
  } catch (error) {
    throw new Error(
      `验证者 preset "${VERIFIER_PRESET_ID}" 解析失败：${errorMessages(error).join('; ')}`,
    );
  }
  if (preset === undefined || preset.id !== VERIFIER_PRESET_ID) {
    throw new Error(`验证者 preset "${VERIFIER_PRESET_ID}" 没有注册成功`);
  }
  if (preset.broken !== undefined) {
    throw new Error(
      `验证者 preset "${VERIFIER_PRESET_ID}" 激活失败：${preset.broken}` +
        '。独立验证需要 read/grep/glob/shell/skill；修好 preset 再验证，不要绕过。',
    );
  }
}

/**
 * 派发一次验证者子代理并等它settle。
 *
 * 抽成函数是为了**重试**：实测（2026-10-15）有一次验证者把调查全做完了
 * （72 次工具调用、421 秒），却在写 structured_output 时参数流整段为空，
 * 报 `tool input is invalid JSON`，成果全部作废、只能退回 needs_human。
 * 那是一次**生成期的偶发失败**，不是调查失败——重试一次是正当的处置。
 *
 * `SubagentActivation` 的契约要求消费者**总是** dispose（取消剩余工作、
 * 达到静默）。不 dispose 会在 abort/异常路径上泄漏子代理句柄。
 */
export async function dispatchVerifier(
  ctx: Context,
  provider: string,
  request: VerifierRequest,
  signal: AbortSignal,
  recording: VerificationRecording,
  attempt: number,
  label = 'sdlc-verify',
): Promise<VerifierAttempt> {
  let run: VerifierAttempt['run'];
  let disposal: Promise<void> | undefined;
  // DSH's activation signal only owns startup. Once published, cancellation is
  // the consumer's responsibility via dispose(), even while result is pending.
  // The listener starts one owned promise; finally always joins that same work.
  const dispose = (): Promise<void> => disposal ??= Promise.resolve().then(async () => {
    try { await run?.dispose(); } catch { /* Keep the original result/error. */ }
  });
  const cancelPublishedRun = (): void => { void dispose(); };
  await recording.record('attempt_started', {
    attempt, prompt: request.prompt?.map((block) => 'text' in block ? block.text : '').join('\n') ?? '',
  });
  try {
    signal.throwIfAborted();
    // provider 必须在 spawn（in-process）上：只有它支持独立 preset 且不继承
    // 父级上下文。fork 继承对话历史，0.2.1 会直接拒绝 agentPreset。
    run = await ctx.subagents.startActivation({
      provider,
      label,
      // DSH 0.2.2-rc.2 起 `SubagentActivationSpec` 把请求字段**拍平**到 spec
      // 顶层（不再是 `{ request }` 包装）。旧写法在 rc.3 上会在运行时读
      // `spec.parent.id` 时抛 TypeError，验证者根本派发不出去——类型检查和
      // 真实运行时探针都抓到过（2026-11-14）。
      ...request,
      signal,
      // caller：结果直接返回给本次工具调用，不再作为消息投递给父会话。
      delivery: 'caller',
    });
    // Observe rejection immediately: recording the session may itself require I/O.
    const pending = run.result.then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    signal.addEventListener('abort', cancelPublishedRun, { once: true });
    // Cancellation may race with startActivation resolving its published handle.
    if (signal.aborted) cancelPublishedRun();
    await recording.record('attempt_session', { attempt, session_id: String(run.childId) });
    const settled = await pending;
    if (!settled.ok) throw settled.error;
    const result = settled.result;
    await recording.record('attempt_finished', {
      attempt, session_id: String(run.childId), result,
      structured: result.structured, stopReason: result.stopReason, diagnostic: result.diagnostic,
    });
    return { run, result };
  } catch (error) {
    await recording.record('attempt_finished', {
      attempt, ...(run ? { session_id: String(run.childId) } : {}),
      error: errorMessages(error).join('; '), cancelled: isCancellation(error, signal),
    });
    throw error;
  } finally {
    signal.removeEventListener('abort', cancelPublishedRun);
    if (run !== undefined) await dispose();
  }
}
