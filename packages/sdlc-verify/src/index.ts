/**
 * @ai-native-sdlc/dsh-sdlc-verify
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

import type { Context } from '@deepseek-ai/cordis';
// 显式 import：ctx.fs 由 dsh-fs 的 declaration merging 提供
import type { FsTarget as _FsTarget } from '@deepseek-ai/dsh-fs';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
// 只为触发 declaration merging：`ctx.sandboxPolicy` 由它提供
import type { SandboxPolicyService as _SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy';
import { JSON_SCHEMA, load as parseYaml } from 'js-yaml';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent';
import { judgeTestMutation } from './test-freeze.js';
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
export const inject = ['tools', 'subagents', 'systemPrompt', 'fs', 'sandboxPolicy'];

/**
 * 验证者允许使用的工具。
 *
 * 用 allow 白名单而不是 deny 黑名单：**继承面**上新增的工具默认不放行。
 *
 * ⚠️ 但 allow **不能**过滤子代理 scope 自注册的工具——`ctx.tools.restrict()`
 * 的语义是"restrictions intersect; scoped registrations remain visible"。
 * 实测：四次验证者会话的 wire 工具面都是
 * `bash glob grep read structured_output subagent` —— write/edit 确实被摘掉了
 * （这是 Actor ≠ Verifier 的核心保证），但 `subagent` 与 `structured_output`
 * 是 scope 自注册残留。所以"只读"是**职责约束**，不是能力事实。
 */
/**
 * 验证者允许使用的工具。
 *
 * ⚠️ **shell 工具必须按平台选**：官方 bundle 里 `tool-bash` 在 win32 禁用、
 * `tool-pwsh` 在非 win32 禁用，所以任一平台上都只有其中一个存在。
 * 而 `ctx.tools.restrict()` 对**不存在的工具名直接抛错**：
 *   `tools.restrict() names unknown global tool "pwsh"`
 * ——把两个都写上会让 macOS 上的验证**整条通路报错**（实测踩到）。
 *
 * 教训：为某个平台做的修复，必须验证它没有弄坏另一个平台。
 */
const BASE_VERIFIER_TOOLS = ['read', 'grep', 'glob', 'skill'] as const;

function verifierToolAllow(): string[] {
  // 与官方 dsh-base 的 cordis.patch.yml 同一判据
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash';
  return [...BASE_VERIFIER_TOOLS, shell];
}

/**
 * ⚠️ `skill` 为什么必须在这个清单里（这是后来补的，原因值得记）
 *
 * `sdlc-workflow` 插件交付的"验证纪律"**是做成 Skill 的**——
 * 于是曾经出现一个荒谬的状态：一份名称里写着"给验证者的"清单，
 * **验证者加载不到它**。因为 `toolFilter` 是**允许清单**，
 * `skill` 不在里面就被摘掉了。
 *
 * 依据（实测读代码）：`dsh-tool-skill` 只做 `ctx.tools.register(skillTool)`，
 * **不注册任何提示词段**——所以 Skill 目录除了这个工具，没有别的通道到达模型。
 * 不给它这个工具，等于那份清单不存在。
 *
 * 这与"摘掉 write/edit"不冲突：`skill` 是**只读**的（读 Skill 正文），
 * 不给验证者任何写能力。
 */

export interface SdlcVerifyConfig {
  /** 承载验证的 subagent provider 名。默认使用内置 in-process spawn。 */
  verifierProvider: string;
  /** 验证者的模型覆盖。留空 = 继承父级。 */
  verifierModel: string;
  /** 单次验证的 token 上限（0 = 不限制）。 */
  verifierMaxTokens: number;
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
/**
 * 把 `verification.json` 登记进任务 state.yaml 的 `artifacts`。
 *
 * 刻意**不 import sdlc-task 的代码**：两个插件只在 `state.yaml` 这个
 * **文件契约**上耦合（与前文 resolveTask 同一原则）。这里做的是最小编辑：
 * 只在 artifacts 映射里加/覆盖一个键，其余内容保持原样——
 * 因为 state.yaml 是人也会手改的文件，重写它风险太大。
 *
 * 失败不抛错：登记失败不该让已经拿到的裁决作废，只记一条警告。
 */
async function registerVerificationArtifact(
  ctx: Context,
  exec: { agent?: unknown; signal?: AbortSignal },
  task: ResolvedTask,
): Promise<string> {
  // 返回值是**给人看的一句话**，会出现在裁决 summary 里。
  // 为什么必须报出来：这个函数有多条"静默放弃"的路径（找不到 anchors、
  // state.yaml 不在），而静默成功与静默失败在制品上**完全无法区分**——
  // 独立验证者指出过这一点。本项目的一条基本纪律是"不要让失败静默"。
  const statePath = `${task.dir}/state.yaml`;
  const policy = await writePolicy(ctx, exec);
  const target = await ctx.fs.resolve(statePath, resolveOptions(exec, policy?.workspaceRoot));
  const info = await ctx.fs.stat(target, exec.signal);
  if (info === undefined || info.type !== 'file') {
    return `⚠ verification 制品未登记：找不到 ${statePath}（裁决本身已落盘）`;
  }

  const text = await ctx.fs.readText(target, exec.signal);
  if (/^\s*verification:/m.test(text)) {
    return '制品登记：verification 已在 state.yaml 中（无需重复登记）';
  }

  // 在 artifacts 段末尾插入一行。artifacts 是我们自己写出来的固定形状，
  // 但用户可能手改过——所以找不到锚点时就放弃（宁可不登记，也不改坏文件）。
  const lines = text.split('\n');
  // 与 sdlc-artifact 同一套：两种形态都要认（见那里的说明）
  const start = lines.findIndex((l) => /^artifacts:\s*(\{\s*\})?\s*$/.test(l));
  if (start >= 0 && /^artifacts:\s*\{\s*\}\s*$/.test(lines[start] ?? '')) {
    lines[start] = `artifacts:\n  verification: "verification.json"`;
      // 复用函数开头已解析好的 target 与 policy——
      // 重复调用 writePolicy 既浪费也容易漏（沙箱接线漏一次就会被拒）
      await ctx.fs.writeText(target, lines.join('\n'), undefined, exec.signal, policy);
    return '制品登记：verification → state.yaml 的 artifacts（artifacts 原为空）';
  }
  if (start < 0) {
    return (
      '⚠ verification 制品未登记：state.yaml 里找不到 `artifacts:` 段' +
      '（可能被手改过）。裁决本身已落盘，请手动登记 verification: "verification.json"'
    );
  }
  let insertAt = start + 1;
  while (insertAt < lines.length && /^\s{2}\S/.test(lines[insertAt] ?? '')) insertAt += 1;
  lines.splice(insertAt, 0, '  verification: "verification.json"');
  await ctx.fs.writeText(target, lines.join('\n'), undefined, exec.signal, policy);
  return '制品登记：verification → state.yaml 的 artifacts（状态机到 REVIEWING 时可见）';
}

interface ResolvedTask {
  id: string;
  dir: string;
  artifacts: Record<string, string>;
}

/**
 * 从 `task_id` 解析任务目录与已登记制品。
 *
 * 刻意**不 import sdlc-task 的类型或函数**：两个插件各自独立发布，
 * 只在 `state.yaml` 这个**文件契约**上耦合。少一层包依赖，就少一类
 * 版本不兼容问题——而 state.yaml 的形状本来就是稳定的公开约定。
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

import { resolveOptions, writePolicy } from './helpers.js';

export function apply(ctx: Context, config: SdlcVerifyConfig): void {
  // 加载即自检：工具输出 schema 与裁决 schema 一旦漂移，某条裁决路径会静默失效
  // （实测过：unverified 缺失会让 needs_human 变成工具错误）。
  assertSchemasAligned();

  const cfg = config;

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
            'The acceptance criteria this change must satisfy (usually lifted verbatim from spec.md). When ' +
            'given, the verifier must return a per-criterion result (met / not_met / cannot_tell). ' +
            'IMPORTANT: approving WITHOUT criteria is not allowed — if criteria are absent, a would-be approve ' +
            'is downgraded to needs_human by the plugin, because "verified" without a stated definition of ' +
            'correct is just an opinion.',
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
        const agent = exec.agent;
        if (agent === undefined) {
          throw new Error('sdlc_verify requires a calling agent');
        }

        // 任务身份（可选）：给了就从 state.yaml 解析已登记的制品，
        // 显式传入的 artifacts 优先级更高（允许针对单次验证覆盖）。
        const explicit = coerceArtifactMap(args.artifacts);
        const task = await resolveTask(ctx, exec, args.task_id, exec.signal);
        const artifacts = task === undefined ? explicit : { ...task.artifacts, ...explicit };

        const criteria = coerceStringList(args.criteria);
        const prompt = buildVerificationPrompt({
          intentOfChange: args.intent_of_change,
          artifacts,
          diff: args.diff,
          testEvidence: args.test_evidence,
          scope: args.scope,
          criteria,
        });

        // agentOptions 在 SubagentStartRequest 上是 readonly，
        // 所以一次性构造完整请求，而不是先建对象再补字段。
        //
        // maxTokens 只要 >0 就生效，**不依赖** verifierModel 是否设置——
        // 之前把它放在 model 非空的分支里，导致单独配置 maxTokens 静默无效。
        const wantsTokens = cfg.verifierMaxTokens > 0;
        const wantsRoute = cfg.verifierModel !== '';
        const request: SubagentStartRequest = {
          label: 'sdlc-verify',
          prompt: [{ type: 'text', text: prompt }],
          parent: agent,
          signal: exec.signal,
          outputSchema: VERDICT_SCHEMA,
          // 只读：摘掉 write/edit。注意 bash 仍在白名单里（验证者需要跑测试来
          // 复核证据），而 bash 技术上能写文件——所以 persona 里如实说明了这一点，
          // 而不是声称"改不了任何东西"。
          toolFilter: { allow: verifierToolAllow() },
          // 独立角色：新上下文 + 明确"你没有写这段代码，也别相信关于它的说法"。
          persona: VERIFIER_PERSONA,
          ...(wantsRoute || wantsTokens
            ? {
                agentOptions: {
                  ...(wantsRoute ? { model: cfg.verifierModel } : {}),
                  ...(wantsTokens ? { maxTokens: cfg.verifierMaxTokens } : {}),
                },
              }
            : {}),
        };

        // SubagentRun 的契约要求消费者**总是** dispose（取消剩余工作、达到静默）。
        // 官方调用方就是这么做的（dsh-tool-subagent 的 settleForegroundRun）。
        // 不 dispose 会在 abort/异常路径上泄漏子代理句柄。
        let run: Awaited<ReturnType<typeof ctx.subagents.start>> | undefined;
        let result: Awaited<ReturnType<typeof ctx.subagents.start>>['result'] extends Promise<
          infer R
        >
          ? R
          : never;
        try {
          run = await ctx.subagents.start(cfg.verifierProvider, request);
          result = await run.result;
        } finally {
          if (run !== undefined) {
            try {
              await run.dispose();
            } catch {
              /* dispose 失败不应掩盖真正的结果 */
            }
          }
        }

        const verdict = result.structured as Verdict | undefined;

        if (verdict === undefined) {
          // 结构化捕获失败。**不要**退化成"解析自由文本然后猜"——
          // 那会把一个明确的失败变成一个可能错误的通过。
          // satisfies 而不是类型注解：保留字面量类型（schema 推断要求），
          // 同时仍然校验形状。
          return {
            status: 'needs_human',
            summary:
              '验证者未产出结构化裁决，无法据此判断。stop_reason=' +
              String(result.stopReason ?? 'unknown'),
            findings: [],
            verifier_session: run !== undefined ? String(run.id) : undefined,
          } satisfies Verdict & { verifier_session?: string };
        }

        // ── 强制策略：**没有验收标准就不许通过** ──────────────────────
        //
        // 这一条由**代码**执行，不是靠提示词请求——本项目已经反复证明
        // 提示词请求没有约束力（"Skill 只是建议性控制"）。
        //
        // 理由：验证者不知道"对"的定义时只能自己推断判据，于是"验证通过"
        // 退化成一句意见。这正是之前每一次验证都出现的弱点——验证者自称
        // "只覆盖了前置条件"，但那只是 summary 里的一句道歉，不是可检查的东西。
        const enforced = enforceCriteriaPolicy(verdict, criteria, run !== undefined ? String(run.id) : undefined);

        // satisfies：保留字面量类型，让 output.schema 的推断成立。
        // 运行时会按 schema 校验该值，形状不一致会直接报错而不是静默通过。
        const finalVerdict = {
          ...enforced,
          verifier_session: run !== undefined ? String(run.id) : undefined,
        } satisfies Verdict & { verifier_session?: string };

        // 落盘到任务目录**并登记进 state.yaml**。
        //
        // 只写文件是不够的：`sdlc_task_advance` 的门槛看的是 state.yaml 的
        // `artifacts`，不是"磁盘上碰巧有这个文件"。不登记的话，状态机到
        // REVIEWING 时会说"缺 verification 制品"——而它明明就在旁边。
        // （这条是独立验证者指出的，它比我更早看到了这个不一致。）
        //
        // 写失败不掩盖裁决本身（裁决已经拿到了，先把它交出去）。
        if (task !== undefined) {
          try {
            const policy = await writePolicy(ctx, exec);
            await ctx.fs.writeText(
              await ctx.fs.resolve(
                `${task.dir}/verification.json`,
                resolveOptions(exec, policy?.workspaceRoot),
              ),
              JSON.stringify(
                {
                  task: task.id,
                  at: new Date().toISOString(),
                  intent_of_change: args.intent_of_change,
                  scope: args.scope,
                  criteria,
                  artifacts,
                  verdict: finalVerdict,
                },
                null,
                2,
              ) + '\n',
              undefined,
              exec.signal,
              policy,
            );
            const registrationNote = await registerVerificationArtifact(ctx, exec, task);
            return {
              ...finalVerdict,
              summary: `${finalVerdict.summary}\n\n${registrationNote}`,
            } satisfies Verdict & { verifier_session?: string };
          } catch (e) {
            return {
              ...finalVerdict,
              summary:
                finalVerdict.summary +
                `\n\n⚠ 裁决未能写入 ${task.dir}/verification.json：` +
                `${e instanceof Error ? e.message : String(e)}`,
            } satisfies Verdict & { verifier_session?: string };
          }
        }

        return finalVerdict;
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
