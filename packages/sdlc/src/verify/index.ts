/**
 * @ai-native-sdlc-plugin/dsh-sdlc/verify
 *
 * AI 原生 SDLC 的**独立验证**能力。这个插件只做一件事：让"验证"成为一个
 * 不由实现者自己宣布的、有证据要求的、机器可读的动作。
 *
 * 两条机制：
 *
 * 1. `sdlc_verify` —— 以**新上下文 + 受限工具 + 强制结构化输出**启动一个验证子代理。
 *    这是 Actor ≠ Verifier 的实质：验证者看不到 Actor 的推理过程，只看制品；
 *    它没有 write/edit（但保留 bash 以便复核证据）；它必须提交机器可读裁决，
 *    而不是一段自然语言。
 *
 * 2. 测试冻结（`sdlc_fix_start` / `sdlc_fix_end` + guard）—— bug 修复期间
 *    禁止改动测试资产。手册要求"用于证明缺陷的测试不能被 Actor 改写"，
 *    在 DSH 里这必须由**单调的 guard** 保证：提示词里请求没有约束力。
 *
 * 设计上刻意不做的事：不重新定义 Agent Loop（DSH 官方 loop 已足够好），
 * 不把流程状态存在插件里（制品与状态属于 Git）。
 */

import { createHash } from 'node:crypto';
import {startTaskVerification, completeTaskVerification, abandonTaskVerification, type TaskVerificationContext} from '../task/verification.js';
import type { Context } from '@deepseek-ai/cordis';
// 显式 import：ctx.fs 由 dsh-fs 的 declaration merging 提供
import type { FsTarget as _FsTarget } from '@deepseek-ai/dsh-fs';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
// 只为触发 declaration merging：`ctx.sandboxPolicy` 由它提供
import type { SandboxPolicyService as _SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy';
import { JSON_SCHEMA, load as parseYaml } from 'js-yaml';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { SubagentActivation, SubagentResult, SubagentStartRequest } from '@deepseek-ai/dsh-subagent';
// 只为触发 declaration merging：`ctx.agentPresets` 由它提供（可选服务，用 ctx.get 读）。
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import { judgeTestMutation } from './test-freeze.js';
import { VERIFIER_PRESET, VERIFIER_PRESET_ID } from './preset.js';
import { errorMessages, isCancellation, recordVerificationRun, VERIFIER_FINGERPRINT, type VerificationRecording } from './recording.js';
import type { Finding, Verdict } from './verdict.js';
import {
  assertSchemasAligned,
  buildVerificationPrompt,
  enforceCriteriaPolicy,
  VERDICT_SCHEMA,
  VERIFIER_PERSONA,
  TOOL_OUTPUT_SCHEMA,
} from './verdict.js';

export const name = 'sdlc-verify';

/**
 * 依赖的 Cordis 服务。
 *
 * ⚠️ **每个访问到的服务都必须在这里列出。** Cordis 对未声明的服务访问会抛
 * `cannot get property "<name>" without inject`——而插件激活失败是
 * "警告后继续"，所以症状只是 `fiberPhase: failed`，不仔细看会以为装上了。
 */
// `sandboxPolicy` 必须有：写 verification.json 要按会话策略解析（否则会落到
// 沙箱的部署 fallback 根，写入被误判越界——实测第二次踩到，第一次在 sdlc-task）。
// ⚠️ **不要往里加 `logger`。** 实测（2026-10-15）：加了之后插件在本机
// desktop profile 里停在 `fiberPhase: "pending"`——`apply()` 在等一个
// 不存在的服务，于是**所有工具静默消失**（`Error: unknown tool "sdlc_verify"`），
// 而 App 照常启动、其它插件全部 active。
// 这条与"少写一个就抛 `cannot get property`"是同一个坑的两面：
// **少了会抛错，多了会静默挂起**，后者更难查——没有报错，只有工具不见了。
export const inject = ['tools', 'subagents', 'systemPrompt', 'fs', 'sandboxPolicy'];

/**
 * ⚠️ 验证者的工具面**已经不在这里**声明了。
 *
 * 0.2.0 的 `SubagentStartRequest` 上有 `toolFilter` / `persona`；0.2.1-rc.2
 * 把这两个字段从公开契约里删除，官方 `tool-subagent` 直接报
 * “configure persona and tool plugins in an Agent Preset and select it with
 * agentPreset (spawn only)”。所以只读工具面现在由 `src/preset.ts` 里一份
 * **独立的 Agent Preset** 定义，`sdlc_verify` 通过 `agentPreset` 选择它。
 *
 * 旧实现留下的三条教训仍然成立，并已带进 preset：
 * - allow 白名单挡不住 scope 自注册的 `subagent`；preset 从零组合，能挡住。
 * - `tool-skill` 必须给，否则 `sdlc-workflow` 交付的验证纪律读不到。
 * - shell 工具必须按平台选；两个都放会让另一个平台的整条通路报错。
 */

export interface SdlcVerifyConfig {
  /** 承载验证的 subagent provider 名。默认使用内置 in-process spawn。 */
  verifierProvider: string;
  /** 验证者的模型覆盖。留空 = 继承父级。 */
  verifierModel: string;
  /** 单次验证的 token 上限（0 = 不限制）。 */
  verifierMaxTokens: number;
  /**
   * 结构化裁决没产出时是否重试一次。默认开。
   *
   * 实测（2026-10-15）：验证者把调查全做完（72 次工具调用、421 秒），
   * 却在写 `structured_output` 时参数流整段为空。那是**生成期**的偶发失败，
   * 不是调查失败；不重试等于把整轮调查丢掉。
   * 关掉它只应出于调试目的——正常路径上"多给一次机会"没有坏处。
   */
  verifierRetryOnMalformed: boolean;
}

/**
 * 插件配置。
 *
 * ⚠️ **必须是 Standard Schema 校验器，不能是普通对象。**
 * Cordis 的 `resolveConfig` 会调用 `Config['~standard'].validate(config)`；
 * 导出 plain object 会在加载时抛
 * `TypeError: Cannot read properties of undefined (reading 'validate')`
 * ——而且失败是"警告后继续"，所以插件会静默地不激活（`fiberPhase: failed`）。
 *
 * schemastery 与 zod 都实现 Standard Schema；官方包用 schemastery。
 */
export const Config = z.object({
  verifierProvider: z.string().default('spawn'),
  verifierModel: z.string().default(''),
  verifierMaxTokens: z.number().default(0),
  verifierRetryOnMalformed: z.boolean().default(true),
});

/**
 * 冻结状态 —— **进程级全局，不按 agent 记账。**
 *
 * 为什么是全局：测试资产是**仓库级的共享资源**，不是某个会话的私有物。
 * 按 agent 记账有一个实测出来的漏洞——actor 只要用自带的 `subagent` 工具
 * 派一个子代理（另一个 agent id），冻结就完全看不到它，改测试照旧成功。
 * 而 `Agent` 类型只暴露 `id`（没有 parent、没有 session），
 * 无法沿血缘判断，所以"全局"既是更准确的语义，也是更可靠的实现。
 *
 * 代价（明确记录）：同一进程内无法并行跑两个互不相干的修复——
 * 后一个 `sdlc_fix_start` 会覆盖前一个的冻结。对"一次修一个 bug"的
 * 实际工作流这不构成限制；若将来需要并行，应把冻结键改成任务 id，
 * 并让 `sdlc_verify` 把任务 id 传给守卫。
 *
 * ⚠️ 已知限制：**内存态**，进程重启即清空。重启本身中断了修复工作，
 * 所以冻结随之中止是安全的方向（失败方向是"不再保护"而非"错误保护"）。
 * 也正因为 `Agent` 不暴露 session，无法写持久事件——
 * 所以这里**不**声称有审计链；审计来自 git 与工具调用记录。
 */
let frozen: { task?: string; reason: string } | undefined;

/**
 * 把模型传来的数组参数收敛为 `string[]`（丢掉非字符串项与空串）。
 */
function coerceStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

/**
 * 把模型传来的 `artifacts` 参数收敛为 `Record<string, string>`。
 *
 * 参数 DSL 的 `json` 节点是"任意 JSON 值"，所以运行时类型宽于声明。
 * 这里做一次显式收窄：非字符串值静默丢弃，避免把对象塞进提示词路径位。
 */
function coerceArtifactMap(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return out;
}

/**
 * 插件入口。
 *
 * `config` 由 Cordis 经 `Config['~standard'].validate()` 校验并填好默认值后传入，
 * 所以这里可以直接当作已解析的配置使用。
 */
/**
 * 解析选项：把会话 cwd（或策略给的 workspace 根）作为 cwd 传进去。
 * 与 sdlc-task 同一套写法——官方 dsh-tool-fs 也是这么做的。
 */
/** 解析本次调用的沙箱策略（写操作专用）。 */
interface ResolvedTask {
  id: string;
  dir: string;
  artifacts: Record<string, string>;
}

/**
 * 从 `task_id` 解析任务目录与已登记制品。
 *
 * 读取制品入口；后续状态更新统一走 task/io 的锁与文件版本检查。
 *
 * 拿不到任务时返回 undefined（调用方退回到显式 artifacts），
 * 但任务**存在却读不动**时要抛错——那说明状态文件坏了，不该静默降级。
 */
async function resolveTask(
  ctx: Context,
  exec: { agent?: unknown },
  taskId: unknown,
  signal?: AbortSignal,
): Promise<ResolvedTask | undefined> {
  if (typeof taskId !== 'string' || taskId.trim() === '') return undefined;

  const agent = exec.agent as { session?: { header?: { cwd?: unknown } } } | undefined;
  const cwdRaw = agent?.session?.header?.cwd;
  if (typeof cwdRaw !== 'string' || cwdRaw === '') {
    throw new Error(
      `给了 task_id=${taskId} 但拿不到 session 的 cwd，无法定位任务目录。` +
        '要么在有工作目录的会话里调用，要么去掉 task_id 并显式传 artifacts。',
    );
  }
  const repoRoot = cwdRaw.replace(/\/+$/, '');
  const id = taskId.trim().toUpperCase();
  const dir = `${repoRoot}/.ai/tasks/${id}`;

  let raw: unknown;
  try {
    const target = await ctx.fs.resolve(`${dir}/state.yaml`, resolveOptions(exec));
    const info = await ctx.fs.stat(target, signal);
    if (info === undefined || info.type !== 'file') {
      throw new Error(
        `任务 ${id} 没有 state.yaml（${dir}/state.yaml）。先用 sdlc_task_create 建任务，` +
          '或去掉 task_id 参数。',
      );
    }
    // JSON_SCHEMA：默认 schema 会把 ISO 时间戳解析成 Date（见 docs/dsh-pitfalls.md）
    raw = parseYaml(await ctx.fs.readText(target, signal), { schema: JSON_SCHEMA });
  } catch (e) {
    throw new Error(
      `读取任务 ${id} 的 state.yaml 失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const state = raw as { artifacts?: unknown } | null;
  const registered =
    state !== null && typeof state === 'object' && !Array.isArray(state)
      ? coerceArtifactMap(state.artifacts)
      : {};
  const artifacts: Record<string, string> = {};
  for (const [kind, rel] of Object.entries(registered)) {
    artifacts[kind] = `${dir}/${rel}`;
  }
  return { id, dir, artifacts };
}

import { resolveOptions, writePolicy } from '../shared/helpers.js';

/** 子代理终局结果与句柄。用官方类型，不手写重复定义。 */
type VerifierResult = SubagentResult;
type VerifierRun = SubagentActivation;

/**
 * 派发给 spawn 的请求。
 *
 * 0.2.1 起 `label` / `signal` 挪到了 `SubagentActivationSpec` 的外层，
 * `persona` / `toolFilter` 被删除（改由 Agent Preset 承担）。
 */
type VerifierRequest = Omit<SubagentStartRequest, 'label' | 'signal'>;

/** 一次派发尝试的产物。`run` 用于报 session id，`result` 是终局结果。 */
interface VerifierAttempt {
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

async function withVerifierPreset<T>(ctx: Context, run: () => Promise<T>): Promise<T> {
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

async function assertVerifierPreset(ctx: Context): Promise<void> {
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
async function dispatchVerifier(
  ctx: Context,
  provider: string,
  request: VerifierRequest,
  signal: AbortSignal,
  recording: VerificationRecording,
  attempt: number,
): Promise<VerifierAttempt> {
  let run: VerifierAttempt['run'];
  await recording.record('attempt_started', {
    attempt, prompt: request.prompt?.map((block) => 'text' in block ? block.text : '').join('\n') ?? '',
  });
  try {
    signal.throwIfAborted();
    // provider 必须在 spawn（in-process）上：只有它支持独立 preset 且不继承
    // 父级上下文。fork 继承对话历史，0.2.1 会直接拒绝 agentPreset。
    run = await ctx.subagents.startActivation({
      provider,
      label: 'sdlc-verify',
      request,
      signal,
      // caller：结果直接返回给本次工具调用，不再作为消息投递给父会话。
      delivery: 'caller',
    });
    // Observe rejection immediately: recording the session may itself require I/O.
    const pending = run.result.then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );
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
    if (run !== undefined) {
      try {
        await run.dispose();
      } catch {
        /* dispose 失败不应掩盖真正的结果 */
      }
    }
  }
}

/**
 * 重试时追加的指令。
 *
 * 只针对**上一次失败的原因**说话，不重复整份提示词：把裁决写小，
 * 长证据落盘，别再写散文。实测的失败形态就是参数太大/太长写不出来。
 */
const RETRY_GUIDANCE = [
  '',
  '---',
  '',
  '## ⚠️ 上一次提交裁决失败了',
  '',
  '你上一次调用 structured_output 时，**参数流没有生成出来**',
  '（`tool input is invalid JSON`），整个调查成果作废。',
  '那是生成期的失败，不是你的结论有问题——**请只重做提交这一步**：',
  '',
  '- 不要重新调查。你已经查到的结论直接写。',
  '- `evidence` 每条压到 **2-4 行**：一行可复跑的命令 + 关键观测行。',
  '  更长的输出/脚本/日志写进文件（bash 可以写 /tmp），evidence 里写文件路径。',
  '- `summary` 3-6 句：结论 + 最关键的两三条证据，不要复述探索过程。',
  '- `findings` 只保留真正是缺陷的，不要把观察笔记也写进去。',
  '- 先提交**小而完整**的裁决，比追求详尽而提交失败有价值得多。',
].join('\n');

export function apply(ctx: Context, config: SdlcVerifyConfig): void {
  // 加载即自检：工具输出 schema 与裁决 schema 一旦漂移，某条裁决路径会静默失效
  // （实测过：unverified 缺失会让 needs_human 变成工具错误）。
  assertSchemasAligned();

  const cfg = config;

  // ── 验证者的只读组合：0.2.1 起由 Agent Preset 承担 ──────────────
  //
  // `agentPresets` 是**可选**服务：web/desktop 的 dsh-web-app 提供 registry，
  // headless 没有。故意不写进 `inject`——写进去会让插件在 headless 停在
  // pending，连冻结门禁一起消失。缺服务时只影响 `sdlc_verify`，而且它
  // 会 fail closed。
  //
  // ⚠️ preset **不在 apply 时常驻注册**。registry 会把每条声明都列进模式
  // 选择器；常驻注册会让用户看到一个可选的「SDLC Verifier 模式」（实测）。
  // 改为每次 `sdlc_verify` 运行期间临时注册、跑完归还（withVerifierPreset），
  // 空闲时选择器里只有「AI 原生 SDLC」。
  // ────────────────────────────────────────────────────────────── 机制 1
  // 独立验证：新上下文 + 只读 + 强制结构化裁决
  ctx.tools.register(
    defineTool({
      name: 'sdlc_verify',
      description:
        'Run independent verification of a change. Spawns a verifier that never saw your reasoning, ' +
        'has its write/edit tools removed (it keeps bash so it can run your tests, so treat it as ' +
        'read-only by role, not by capability), and must return a machine-readable verdict ' +
        '(approve / reject / needs_human) ' +
        'with evidence for every finding. Use this before claiming a task is complete. ' +
        'The verifier is deliberately NOT you: it re-reads the artifacts and tries to refute the change.',
      parameters: {
        intent_of_change: {
          type: 'string',
          required: true,
          description: 'One or two sentences stating what this change claims to achieve. The verifier checks this claim.',
        },
        artifacts: {
          // 参数 DSL 的 'json' 节点：任意 JSON 值（author-only，投影时变成 annotation-only）。
          // 注意：不能写 'object' —— 那是 wire-level 的 JsonSchemaType，不在作者 DSL 里。
          type: 'json',
          description:
            'Map of artifact kind → path, e.g. {"intent":".ai/tasks/PROJ-1/intent.md","spec":"...","plan":"..."}. ' +
            'The verifier reads these files itself; do not paste their contents.',
        },
        diff: {
          type: 'string',
          description: 'How to obtain the diff, e.g. "git diff main...HEAD" or a path to a patch file.',
        },
        test_evidence: {
          type: 'string',
          description:
            'The exact test command(s) and observed output. The verifier re-checks this rather than trusting it. ' +
            'Omit if you have no evidence — that is itself a finding.',
        },
        scope: {
          type: 'string',
          description: 'Optional narrowing of what to verify (e.g. "only the retry logic").',
        },
        criteria: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Task mode: omit to use ALL registered Spec acceptance criteria. If provided, must repeat the full list without edits or omissions. Standalone mode: the acceptance criteria this check must satisfy. When ' +
            'given, the verifier must return a per-criterion result (met / not_met / cannot_tell). ' +
            'IMPORTANT: approving WITHOUT criteria is not allowed — if criteria are absent, a would-be approve ' +
            'is downgraded to needs_human by the plugin, because "verified" without a stated definition of ' +
            'correct is just an opinion.',
        },
        code_roots: {type:'array',items:{type:'string'},description:'Task mode: workspace-relative Git repository roots included in this verification. Default discovers repositories. Same scope is checked before/after verification and before completion.'},
        additional_criteria: {type:'array',items:{type:'string'},description:'Task mode only: extra checks in addition to every registered Spec criterion. Extras never replace required criteria.'},
        experimental_guidance: {
          type: 'string',
          description: 'Additional verifier guidance for controlled experiments. Does not change criteria, schema, or tool permissions.',
        },
        task_id: {
          type: 'string',
          description:
            'Optional: an sdlc-task task id, e.g. "PROJ-1024". When given, the artifacts registered in ' +
            'that task\'s state.yaml are resolved automatically (you do not have to pass `artifacts`), and the ' +
            'verdict is written to verification.json inside the task directory so the task state machine can see it.',
        },
      },
      output: {
        // 从裁决 schema 派生，不手写——见 verdict.ts 里那处真实漂移缺陷的说明。
        // 收窄理由：转换是运行时总函数，但 TS 无法从循环里推出 DSL 的字面量类型。
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const parentSession = (exec.agent as { session?: { id?: unknown }; id?: unknown } | undefined)?.session?.id;
        let taskRun: TaskVerificationContext | undefined;
        try { return await recordVerificationRun(
          (record, recordExec) => ctx.parallel('sdlc-verify/record', record, recordExec),
          exec,
          {
            call_id: exec.callId, inputs: args, config: cfg, verifier_fingerprint: VERIFIER_FINGERPRINT,
            requested_model: { source: 'requested', model: cfg.verifierModel || null, inherited: cfg.verifierModel === '' },
            ...(typeof parentSession === 'string' ? { parent_session_id: parentSession } : {}),
          },
          async (recording) => withVerifierPreset(ctx, async () => {
            const agent = exec.agent;
            if (agent === undefined) {
              throw new Error('sdlc_verify requires a calling agent');
            }

            // fail closed：没有可用的只读 preset 就不启动验证者，绝不降级。
            await assertVerifierPreset(ctx);

            // 任务身份（可选）：给了就从 state.yaml 解析已登记的制品，
            // 显式传入的 artifacts 优先级更高（允许针对单次验证覆盖）。
            const explicit = coerceArtifactMap(args.artifacts);
            const task = await resolveTask(ctx, exec, args.task_id, exec.signal);
            const artifacts = task === undefined ? explicit : { ...task.artifacts, ...explicit };
            if (task) {
              for (const key of ['intent','spec','plan']) if (explicit[key] && explicit[key] !== task.artifacts[key]) throw new Error('任务验证不能用其他文件覆盖已登记的需求/计划制品');
              taskRun = await startTaskVerification(ctx,exec,task,recording.id,args.code_roots,args.criteria,args.additional_criteria);
            }
            if (!task && args.additional_criteria?.length) throw new Error('无 task_id 时请用 criteria 指定独立检查范围');
            const criteria = taskRun?.criteria ?? coerceStringList(args.criteria);
            const basePrompt = buildVerificationPrompt({
              intentOfChange: args.intent_of_change,
              artifacts,
              diff: args.diff,
              testEvidence: args.test_evidence,
              scope: args.scope,
              criteria,
            });
            const issuePrompt = taskRun?.pending.length ? '\n## 必须独立复验的旧问题\n作者的证据不是结论。issue_results 必须逐项给出 issue_id、resolved/unresolved/cannot_tell、独立证据；不得省略或自造编号。\n' + JSON.stringify(taskRun.pending.map(i => ({issue_id:i.id,description:i.description,author_submission:i.actions.at(-1)}))) : '';
            const prompt = args.experimental_guidance?.trim()
              ? `${basePrompt}${issuePrompt}\n\n## 实验附加指导\n\n${args.experimental_guidance}` : basePrompt + issuePrompt;
            const artifactSnapshots: Record<string, unknown> = {};
            for (const [name, artifactPath] of Object.entries(artifacts)) {
              try {
                const target = await ctx.fs.resolve(artifactPath, resolveOptions(exec));
                const content = await ctx.fs.readText(target, exec.signal);
                artifactSnapshots[name] = {
                  path: artifactPath, content, sha256: createHash('sha256').update(content).digest('hex'),
                };
              } catch (error) {
                artifactSnapshots[name] = { path: artifactPath, error: errorMessages(error).join('; ') };
              }
            }
            await recording.record('prepared', {
              prompt, persona: VERIFIER_PERSONA, outputSchema: VERDICT_SCHEMA, criteria:taskRun ? taskRun.criteria.map(c=>`${c.id}: ${c.text}`) : criteria, artifacts,
              ...(taskRun ? {acceptance:taskRun.acceptance} : {}),
              artifact_snapshots: artifactSnapshots, config: cfg, verifier_fingerprint: VERIFIER_FINGERPRINT,
            });

            // agentOptions 在 SubagentStartRequest 上是 readonly，
            // 所以一次性构造完整请求，而不是先建对象再补字段。
            //
            // maxTokens 只要 >0 就生效，**不依赖** verifierModel 是否设置——
            // 之前把它放在 model 非空的分支里，导致单独配置 maxTokens 静默无效。
            const wantsTokens = cfg.verifierMaxTokens > 0;
            const wantsRoute = cfg.verifierModel !== '';
            const request: VerifierRequest = {
              prompt: [{ type: 'text', text: prompt }],
              parent: agent,
              outputSchema: VERDICT_SCHEMA,
              // 只读工具面 + 独立角色都由这个 preset 提供；详见 src/preset.ts。
              // 不在请求上再传 persona/toolFilter——0.2.1 已删除这两个字段。
              agentPreset: VERIFIER_PRESET_ID,
              ...(wantsRoute || wantsTokens
                ? {
                    agentOptions: {
                      ...(wantsRoute ? { model: cfg.verifierModel } : {}),
                      ...(wantsTokens ? { maxTokens: cfg.verifierMaxTokens } : {}),
                    },
                  }
                : {}),
            };

            // ── 派发 + 失败重试 ────────────────────────────────────────
            //
            // 实测（2026-10-15）：验证者把调查全做完了（72 次工具调用、421 秒），
            // 却在写 structured_output 时**参数流整段为空**，
            // 报 `tool input is invalid JSON`。那是生成期的偶发失败，
            // 不是调查失败——而且调查成果本来就已经花掉了，不重试等于全扔。
            //
            // 所以：结构化裁决没拿到时，**原样重派一次**，prompt 追加一段
            // 「怎么把裁决写小」的指令。注意这不改变任何安全性质——
            // 重试仍然是同一个只读、独立上下文的验证者，只是多给它一次机会。
            // 两次都没拿到 → needs_human（见下方），绝不解析自由文本去猜。
            const maxAttempts = cfg.verifierRetryOnMalformed ? 2 : 1;
            let run: VerifierRun | undefined;
            let result: VerifierResult | undefined;
            let verdict: Verdict | undefined;
            /** 每次尝试的 session id，便于事后从 trace 里复盘哪次失败。 */
            const attemptSessions: string[] = [];

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
              exec.signal?.throwIfAborted();
              const text = attempt === 1 ? prompt : `${prompt}${RETRY_GUIDANCE}`;
              const attemptRequest: VerifierRequest = { ...request, prompt: [{ type: 'text', text }] };
              const got = await dispatchVerifier(
                ctx, cfg.verifierProvider, attemptRequest, exec.signal, recording, attempt,
              );
              run = got.run;
              result = got.result;
              verdict = got.result.structured as Verdict | undefined;
              if (run !== undefined) attemptSessions.push(String(run.childId));
              if (verdict !== undefined) {
                recording.complete = true;
                break;
              }
              if (result.stopReason === 'aborted' || exec.signal?.aborted) {
                recording.cancelled = true;
                break;
              }
              // 重试的事实**刻意不用 ctx.logger 记录**：把 logger 加进 inject 会让
              // 插件停在 `fiberPhase=pending`（那个服务在本机 profile 里不存在），
              // 于是所有工具静默消失。改由裁决里的 `verifier_attempts` /
              // `verifier_sessions` 如实报出——那还会进制品，日志不会。
            }

            const attempts = attemptSessions.length;
            const firstSession = attemptSessions[0];
            const lastSession = attemptSessions[attemptSessions.length - 1];
            if (verdict === undefined) {
              // 结构化捕获失败。**不要**退化成"解析自由文本然后猜"——
              // 那会把一个明确的失败变成一个可能错误的通过。
              // satisfies 而不是类型注解：保留字面量类型（schema 推断要求），
              // 同时仍然校验形状。
              // ⚠️ 这里**不做"解析自由文本再猜"**：那会把一个明确的失败
              // 变成一个可能错误的通过。两次尝试都没拿到就是没拿到。
              const diag = result?.diagnostic;
              const reason = String(result?.stopReason ?? 'unknown');
              const unavailable: Verdict = {
                status: 'needs_human',
                summary:
                  `验证者未产出结构化裁决，无法据此判断。stop_reason=${reason}` +
                  (attempts > 1
                    ? `（已重试，共 ${attempts} 次派发；这是**生成期失败**，不是调查失败——` +
                      '验证者可能已经把活干完了，只是裁决没写出来。' +
                      '从 verifier_sessions 里的会话 trace 能看出它查到了什么。）'
                    : ''),
                findings: [],
                verifier_session: firstSession,
                verifier_sessions: attemptSessions.length > 0 ? attemptSessions : undefined,
                verifier_attempts: attempts,
                ...(typeof diag === 'string' && diag !== '' ? { diagnostic: diag } : {}),
              } satisfies Verdict & {
                verifier_session?: string;
                verifier_sessions?: string[];
                verifier_attempts?: number;
                diagnostic?: string;
              };
              if (taskRun) return await completeTaskVerification(ctx,exec,taskRun,unavailable,{...unavailable,verification_complete:false},{intent_of_change:args.intent_of_change});
              return unavailable;
            }

            // ── 强制策略：**没有验收标准就不许通过** ──────────────────────
            //
            // 这一条由**代码**执行，不是靠提示词请求——本项目已经反复证明
            // 提示词请求没有约束力（"Skill 只是建议性控制"）。
            //
            // 理由：验证者不知道"对"的定义时只能自己推断判据，于是"验证通过"
            // 退化成一句意见。这正是之前每一次验证都出现的弱点——验证者自称
            // "只覆盖了前置条件"，但那只是 summary 里的一句道歉，不是可检查的东西。
            const enforced = enforceCriteriaPolicy(verdict, criteria, lastSession, 'ids');

            // satisfies：保留字面量类型，让 output.schema 的推断成立。
            // 运行时会按 schema 校验该值，形状不一致会直接报错而不是静默通过。
            const finalVerdict = {
              ...enforced,
              verification_complete: recording.complete,
              // 报**做出裁决的那一次**（重试成功时即第二次）。
              verifier_session: lastSession,
              // 重试过就把每次都列出来：这样"第一次失败了"这件事不会消失，
              // 而它正是本项目在测的那个指标（完成率）。
              ...(attempts > 1
                ? { verifier_sessions: attemptSessions, verifier_attempts: attempts }
                : {}),
            } satisfies Verdict & {
              verifier_session?: string;
              verifier_sessions?: string[];
              verifier_attempts?: number;
            };

            if (taskRun) return await completeTaskVerification(ctx,exec,taskRun,verdict,finalVerdict,
              {intent_of_change:args.intent_of_change,...(args.test_evidence ? {test_evidence:args.test_evidence} : {})});

            return finalVerdict;
          }),
        ); } catch (error) {
          if (taskRun) await abandonTaskVerification(ctx,exec,taskRun,error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    }),
  );

  // ────────────────────────────────────────────────────────────── 机制 2
  // 测试冻结：bug 修复期间禁止改动测试资产（单调 guard，不可被后续监听器翻回）

  ctx.tools.register(
    defineTool({
      name: 'sdlc_fix_start',
      description:
        'Enter bug-fix mode and FREEZE test assets **for the whole process**. While frozen, attempts to modify ' +
        'test files (directly, or via common shell forms) are denied — including from subagents, since the freeze ' +
        'is not scoped to one agent. Use this after the failing test reproduces the bug, so the test cannot be ' +
        'weakened later to make the fix look successful. Call sdlc_fix_end when the fix is verified.',
      parameters: {
        reason: {
          type: 'string',
          required: true,
          description: 'Which failing test proves the bug, e.g. "test_status.py::test_partial_claim".',
        },
        task_id: {
          type: 'string',
          description: 'Optional: the sdlc-task task this fix belongs to, e.g. "PROJ-1024". Recorded so the refusal message names the task.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            frozen: { type: 'boolean', required: true },
            reason: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          // schema 已保证形状，但 ValueSchema 在类型上只到 JsonValue。
          { type: 'text', text: `测试资产已冻结：${String((value as { reason?: unknown }).reason ?? '')}` },
        ],
      },
      async execute(args, exec) {
        frozen = { task: args.task_id, reason: args.reason };
        return { frozen: true, reason: args.reason };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'sdlc_fix_end',
      description:
        'Leave bug-fix mode and UNFREEZE test assets. Only call this after the fix is verified with the frozen ' +
        'test passing unchanged. Freezing exists to prove the fix, not to block legitimate test work.',
      parameters: {
        reason: { type: 'string', required: true, description: 'How the fix was verified.' },
        task_id: {
          type: 'string',
          description: 'Must match the task_id given to sdlc_fix_start when one was given.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { frozen: { type: 'boolean', required: true } },
        },
        render: () => [{ type: 'text', text: '测试资产已解冻' }],
      },
      async execute(args, exec) {
        // 换了一个 task 就解冻别人，会让"证明某个修复"这件事失去意义——
        // 所以只允许解冻自己那次冻结。
        if (frozen !== undefined && frozen.task !== undefined && args.task_id !== frozen.task) {
          throw new Error(
            `当前冻结属于任务 ${frozen.task}，不能用 ${args.task_id} 解冻。` +
              '要么用同一个 task_id，要么先确认那次修复已经结束。',
          );
        }
        frozen = undefined;
        return { frozen: false };
      },
    }),
  );

  // 单调 guard：任何匹配的 guard 都可拒绝，且**没有任何后续监听器能把它翻回允许**。
  // 这正是"硬约束"与"提示词请求"的区别所在。
  ctx.tools.guard((exec) => {
    // 不检查 agent：冻结是进程级/仓库级的，子代理同样受限。
    if (frozen === undefined) return undefined;

    const verdict = judgeTestMutation({ name: exec.name, arguments: exec.arguments });
    if (!verdict.blocked) return undefined;

    return [
      verdict.reason,
      '',
      frozen.task !== undefined ? `冻结所属任务：${frozen.task}` : '',
      `冻结理由：${frozen.reason}`,
      '这个测试是修复正确性的证据。若它确实写错了，先 sdlc_fix_end 说明原因，再改测试——',
      '不要让门禁替你决定。',
    ].join('\n');
  });

  // ────────────────────────────────────────────────────────────── 方法论引导
  ctx.systemPrompt.section({
    name: 'sdlc:verification-policy',
    order: 700,
    text: [
      '## 验证（AI 原生 SDLC）',
      '',
      '不要自己宣布任务完成。在报告完成之前，先调用 `sdlc_verify` 取得独立裁决。',
      '',
      '- 验证者是**另一个上下文里的独立验证代理**：没有 write/edit，但保留 shell',
      '  （要跑你的测试），所以它是「按职责只读」，不是「按能力只读」。',
      '- 它的 `evidence` 字段要求可复核——所以不要指望用总结糊弄过去。',
      '- 裁决有三种：`approve` / `reject` / `needs_human`。拿到 `needs_human` 时，',
      '  把问题交给人类，不要自己改判成通过。',
      '',
      '修 bug 时：先用会失败的测试复现，然后 `sdlc_fix_start` 冻结测试资产，再改产品代码，',
      '最后 `sdlc_fix_end`。冻结期间改动测试会被拒绝——这是有意的，',
      '因为一个能被随手改掉的测试证明不了任何事。',
    ].join('\n'),
  });
}
