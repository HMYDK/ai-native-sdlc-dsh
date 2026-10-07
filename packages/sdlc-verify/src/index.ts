/**
 * @ai-native-sdlc/dsh-sdlc-verify
 *
 * AI 原生 SDLC 的**独立验证**能力。这个插件只做一件事：让"验证"成为一个
 * 不由实现者自己宣布的、有证据要求的、机器可读的动作。
 *
 * 两条机制：
 *
 * 1. `sdlc_verify` —— 以**新上下文 + 只读工具 + 强制结构化输出**启动一个验证子代理。
 *    这是 Actor ≠ Verifier 的实质：验证者看不到 Actor 的推理过程，只看制品；
 *    它改不了任何东西；它必须提交机器可读裁决，而不是一段自然语言。
 *
 * 2. 测试冻结（`sdlc_fix_start` / `sdlc_fix_end` + guard）—— bug 修复期间
 *    禁止改动测试资产。手册要求"用于证明缺陷的测试不能被 Actor 改写"，
 *    在 DSH 里这必须由**单调的 guard** 保证：提示词里请求没有约束力。
 *
 * 设计上刻意不做的事：不重新定义 Agent Loop（DSH 官方 loop 已足够好），
 * 不把流程状态存在插件里（制品与状态属于 Git）。
 */

import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent';
import { judgeTestMutation } from './test-freeze.js';
import type { Verdict } from './verdict.js';
import { buildVerificationPrompt, VERDICT_SCHEMA, VERIFIER_PERSONA } from './verdict.js';

export const name = 'sdlc-verify';

/**
 * 依赖的 Cordis 服务。
 *
 * ⚠️ **每个访问到的服务都必须在这里列出。** Cordis 对未声明的服务访问会抛
 * `cannot get property "<name>" without inject`——而插件激活失败是
 * "警告后继续"，所以症状只是 `fiberPhase: failed`，不仔细看会以为装上了。
 */
export const inject = ['tools', 'subagents', 'systemPrompt'];

/** 声明本插件追加的持久会话事件（与 hook/invoked 同样的 log-only 用法）。 */
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'sdlc/freeze-started': { reason: string };
    'sdlc/freeze-ended': { reason: string };
  }
}

/**
 * 验证者允许使用的工具。**只读**。
 *
 * 用 allow 白名单而不是 deny 黑名单：新增工具时默认不放行，
 * 避免"某个新工具恰好能改文件"这种漏洞。
 */
const VERIFIER_TOOL_ALLOW = ['read', 'grep', 'glob', 'bash'];

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
 * 冻结状态：按 agent 会话 id 记录。
 *
 * ⚠️ 已知限制（v1 有意如此）：这是**内存态**，进程重启后清空。
 * 持久会话事件仍会写入（`sdlc/freeze-started` / `sdlc/freeze-ended`），
 * 因此审计链完整；但 guard 的即时判定依赖内存。
 * 理由：重启本身即中断了修复工作，冻结随之中止是安全的方向
 * （失败方向是"不再保护"，而不是"错误保护"，两者都会导致拒绝而非放行）。
 */
const frozen = new Map<string, string>();

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
export function apply(ctx: Context, config: SdlcVerifyConfig): void {
  const cfg = config;

  // ────────────────────────────────────────────────────────────── 机制 1
  // 独立验证：新上下文 + 只读 + 强制结构化裁决
  ctx.tools.register(
    defineTool({
      name: 'sdlc_verify',
      description:
        'Run independent verification of a change. Spawns a verifier that never saw your reasoning, ' +
        'has read-only tools, and must return a machine-readable verdict (approve / reject / needs_human) ' +
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
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
            summary: { type: 'string', required: true },
            findings: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  severity: { type: 'string' },
                  category: { type: 'string' },
                  file: { type: 'string' },
                  line: { type: 'number' },
                  reason: { type: 'string' },
                  evidence: { type: 'string' },
                  suggestion: { type: 'string' },
                },
              },
            },
            verifier_session: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const agent = exec.agent;
        if (agent === undefined) {
          throw new Error('sdlc_verify requires a calling agent');
        }

        const prompt = buildVerificationPrompt({
          intentOfChange: args.intent_of_change,
          artifacts: coerceArtifactMap(args.artifacts),
          diff: args.diff,
          testEvidence: args.test_evidence,
          scope: args.scope,
        });

        // agentOptions 在 SubagentStartRequest 上是 readonly，
        // 所以一次性构造完整请求，而不是先建对象再补字段。
        const request: SubagentStartRequest = {
          label: 'sdlc-verify',
          prompt: [{ type: 'text', text: prompt }],
          parent: agent,
          signal: exec.signal,
          outputSchema: VERDICT_SCHEMA,
          // 只读：验证者改不了任何东西，这是 Actor ≠ Verifier 的一半。
          toolFilter: { allow: VERIFIER_TOOL_ALLOW },
          // 独立角色：新上下文 + 明确"你没有写这段代码，也别相信关于它的说法"。
          persona: VERIFIER_PERSONA,
          ...(cfg.verifierModel !== ''
            ? {
                agentOptions: {
                  model: cfg.verifierModel,
                  ...(cfg.verifierMaxTokens > 0 ? { maxTokens: cfg.verifierMaxTokens } : {}),
                },
              }
            : {}),
        };

        const run = await ctx.subagents.start(cfg.verifierProvider, request);
        const result = await run.result;

        const verdict = result.structured as Verdict | undefined;

        if (verdict === undefined) {
          // 结构化捕获失败。**不要**退化成"解析自由文本然后猜"——
          // 那会把一个明确的失败变成一个可能错误的通过。
          return {
            status: 'needs_human',
            summary:
              '验证者未产出结构化裁决，无法据此判断。stop_reason=' +
              String(result.stopReason ?? 'unknown'),
            findings: [],
            verifier_session: String(run.id),
          };
        }

        // 唯一一处显式类型收窄，理由：
        //   返回值形状由上面声明的 `output.schema` 在**运行时**强制
        //   （框架会按 schema 校验规范化后的值），而 `defineTool` 的推断类型
        //   带 `additionalProperties: true` 产生的索引签名，TypeScript 无法
        //   从 `Verdict` 接口反推出来。这不是掩盖形状不一致——运行时已经校验过了。
        return { ...verdict, verifier_session: String(run.id) } as never;
      },
    }),
  );

  // ────────────────────────────────────────────────────────────── 机制 2
  // 测试冻结：bug 修复期间禁止改动测试资产（单调 guard，不可被后续监听器翻回）

  ctx.tools.register(
    defineTool({
      name: 'sdlc_fix_start',
      description:
        'Enter bug-fix mode and FREEZE test assets. While frozen, any attempt to modify a test file ' +
        '(directly or via shell) is denied. Use this after the failing test reproduces the bug, so the test ' +
        'cannot be weakened later to make the fix look successful. Call sdlc_fix_end when the fix is verified.',
      parameters: {
        reason: {
          type: 'string',
          required: true,
          description: 'Which failing test proves the bug, e.g. "test_status.py::test_partial_claim".',
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
        const agent = exec.agent;
        if (agent === undefined) throw new Error('sdlc_fix_start requires a calling agent');
        frozen.set(String(agent.id), args.reason);
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
        const agent = exec.agent;
        if (agent === undefined) throw new Error('sdlc_fix_end requires a calling agent');
        frozen.delete(String(agent.id));
        return { frozen: false };
      },
    }),
  );

  // 单调 guard：任何匹配的 guard 都可拒绝，且**没有任何后续监听器能把它翻回允许**。
  // 这正是"硬约束"与"提示词请求"的区别所在。
  ctx.tools.guard((exec) => {
    const agent = exec.agent;
    if (agent === undefined) return undefined;
    const reason = frozen.get(String(agent.id));
    if (reason === undefined) return undefined;

    const verdict = judgeTestMutation({ name: exec.name, arguments: exec.arguments });
    if (!verdict.blocked) return undefined;

    return [
      verdict.reason,
      '',
      `冻结理由：${reason}`,
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
      '- 验证者是**另一个上下文里的只读代理**，它看不到你的推理过程，只看制品。',
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
