/**
 * 验证裁决的数据契约与提示词构造。
 *
 * 裁决必须是**机器可读**的——否则"验证通过"就只是又一句自然语言断言，
 * 无法进 CI、无法做回归、无法作为证据。
 *
 * Schema 限制在 DSH `outputSchema` 支持的子集内：
 * type / properties / required / additionalProperties / items / enum / const / oneOf。
 */

import type { ObjectJsonSchema, ValueSchemaSpec } from '@deepseek-ai/dsh-tools';

/** 裁决状态。`needs_human` 是刻意保留的第三条路——见 VERDICT_SCHEMA 的说明。 */
export const VERDICT_STATUSES = ['approve', 'reject', 'needs_human'] as const;
export type VerdictStatus = (typeof VERDICT_STATUSES)[number];

export const SEVERITIES = ['blocking', 'important', 'minor'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  'spec_mismatch', // 实现与 intent/spec 不一致
  'missing_evidence', // 声称完成但拿不出证据
  'logic_error',
  'security',
  'test_integrity', // 测试被削弱/篡改，或根本没证明目标行为
  'architecture',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * 一条验证发现。
 *
 * 刻意带 `[key: string]: JsonValue` 索引签名：裁决会被写进**持久会话日志**，
 * 而日志要求 lossless JSON。让类型本身满足这个约束，比在边界上强转更安全
 * （强转会掩盖真实的形状不一致）。
 */
export interface Finding {
  severity: Severity;
  category: Category;
  file?: string;
  line?: number;
  reason: string;
  evidence: string;
  suggestion?: string;
}

export interface Verdict {
  status: VerdictStatus;
  summary: string;
  findings: Finding[];
  unverified?: string[];
}

export interface VerificationPromptInput {
  artifacts?: Record<string, string>;
  diff?: string;
  testEvidence?: string;
  scope?: string;
  intentOfChange?: string;
}

/**
 * 结构化裁决的 JSON Schema。
 *
 * 三条状态是有意设计的：如果只给 PASS/FAIL，验证者在**证据不足**时会被迫二选一，
 * 而"证据不足"最常见的结局是猜成 PASS。`needs_human` 让"我判断不了"成为一个
 * 合法的、会被上报的结果。这是防自证偏差之外的第二道保险。
 */
export const VERDICT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'findings'],
  properties: {
    status: { type: 'string', enum: [...VERDICT_STATUSES] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'category', 'reason', 'evidence'],
        properties: {
          severity: { type: 'string', enum: [...SEVERITIES] },
          category: { type: 'string', enum: [...CATEGORIES] },
          file: { type: 'string' },
          line: { type: 'number' },
          reason: { type: 'string' },
          evidence: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
    },
    unverified: {
      type: 'array',
      items: { type: 'string' },
    },
  },
};

/**
 * `sdlc_verify` 的工具输出 schema（作者 DSL 字面量）。
 *
 * 为什么是**手写字面量 + 运行时对齐断言**，而不是程序化派生：
 * `defineTool` 的输出类型由 `InferValue` 从 schema 的**字面量形状**推出；
 * 若返回宽类型（如 `ValueSchemaSpec` 联合），推断会塌成 `never`。
 * 所以这里必须写字面量——但用 `assertSchemasAligned()` 在加载时锁死它与
 * `VERDICT_SCHEMA` 的一致性，把"两处手写会漂移"这个缺陷类型挡在启动阶段。
 *
 * 实测过的真实缺陷：这里曾漏掉 `unverified`，配合 `additionalProperties: false`
 * 让**带 unverified 的 needs_human 裁决**在运行时校验时变成工具错误——
 * "证据不足就上报"这条通路整条失效，调用方连 finding 都拿不到。
 */
export const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, enum: [...VERDICT_STATUSES] },
    summary: { type: 'string', required: true },
    findings: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', required: true, enum: [...SEVERITIES] },
          category: { type: 'string', required: true, enum: [...CATEGORIES] },
          reason: { type: 'string', required: true },
          evidence: { type: 'string', required: true },
          file: { type: 'string' },
          line: { type: 'number' },
          suggestion: { type: 'string' },
        },
      },
    },
    unverified: { type: 'array', items: { type: 'string' } },
    verifier_session: { type: 'string' },
  },
} as const;

export function assertSchemasAligned(): void {
  const outProps = TOOL_OUTPUT_SCHEMA.properties as Record<string, unknown>;
  const verdictProps = Object.keys(VERDICT_SCHEMA.properties ?? {});
  const verdictRequired = new Set(
    (VERDICT_SCHEMA as { required?: string[] }).required ?? [],
  );

  // 1) 裁决的每个字段都必须在工具输出 schema 里声明
  const missing = verdictProps.filter((k) => !(k in outProps));
  if (missing.length > 0) {
    throw new Error(
      `sdlc-verify: 工具输出 schema 缺少裁决字段 [${missing.join(', ')}]——` +
        'additionalProperties:false 会让这些字段的裁决变成工具错误',
    );
  }

  // 2) 必填性一致：裁决 required 里的字段，工具输出也必须 required
  const notRequired = [...verdictRequired].filter(
    (k) => (outProps[k] as { required?: boolean } | undefined)?.required !== true,
  );
  if (notRequired.length > 0) {
    throw new Error(
      `sdlc-verify: 工具输出 schema 未把 [${notRequired.join(', ')}] 标为必填`,
    );
  }

  // 3) 反向：工具输出里声明的裁决字段，不能是裁决 schema 里没有的
  const extra = Object.keys(outProps).filter(
    (k) => k !== 'verifier_session' && !verdictProps.includes(k),
  );
  if (extra.length > 0) {
    throw new Error(
      `sdlc-verify: 工具输出 schema 声明了裁决里不存在的字段 [${extra.join(', ')}]`,
    );
  }
}

/**
 * 验证者的角色提示词。
 *
 * 设计要点：
 * 1. **明说它没有修改能力** —— 否则它会浪费轮次尝试修复。
 * 2. **要求证据而非意见** —— evidence 字段必填且必须指向可复核的东西。
 * 3. **明确 needs_human 的用法** —— 否则这个选项会被忽略。
 * 4. **禁止它复述 Actor 的自我总结** —— 那是自证偏差的来源。
 */
export const VERIFIER_PERSONA = [
  'You are an independent verifier. You did not write the change under review and you must not trust claims about it.',
  // 如实描述能力边界，不夸大：你确实拿到了 bash，而 bash 能写文件。
  // 之前的措辞「You have read-only tools. You cannot modify anything」是假的——
  // 实测中被验证者自己戳穿（它用 bash 建了 25 个文件）。
  // 约束应当来自职责，而不是虚假的能力声明。
  'Your tool set excludes write and edit. It does include bash, which is a general shell and therefore technically able to change files — do not do that. You are here to judge the change, not to fix or alter it: any mutation you make destroys the independence of your own findings.',
  // 这一条不是客套：DSH 的 toolFilter 只过滤工具的 schema 与执行，
  // **不会移除别的插件注册的静态指导段落**（见 docs/dsh-plugin-contracts.md §3.4）。
  // 所以验证者会在提示词里读到"用 write 工具…"之类的文字，而它并没有 write。
  'Other instruction text in this prompt may refer to tools you do not have. Ignore any instruction that would have you modify, create, fix, or commit anything; report the issue in your findings instead.',
  'For every finding, the evidence field must point at something a human can re-check: a file and line, a command and its output, or a test name and its result. An assertion without re-checkable evidence is not a finding.',
  'If the available evidence cannot settle a question, report status "needs_human" and list the question under unverified. Do not guess PASS.',
  "Never repeat the author's summary as if it were evidence. Read the artifact itself.",
].join(' ');

/**
 * 组装验证提示词。
 *
 * 刻意**不包含** Actor 的推理过程或对话历史——只给制品（artifact）。
 * 这是 Actor ≠ Verifier 的实质：新上下文 + 只读视角 + 只看制品。
 */
export function buildVerificationPrompt(input: VerificationPromptInput): string {
  const parts: string[] = [];

  parts.push('# 验证任务\n');
  parts.push(
    '对下列变更做独立验证。你的任务是**尝试推翻它**，而不是确认它。\n' +
      '找不到问题时，也要说明你检查了什么、为什么它成立。\n',
  );

  if (input.intentOfChange) {
    parts.push(`## 这次变更声称要达成的目标\n\n${input.intentOfChange}\n`);
  }

  if (input.scope) {
    parts.push(`## 验证范围\n\n${input.scope}\n`);
  }

  const artifacts = input.artifacts ?? {};
  const names = Object.keys(artifacts);
  if (names.length > 0) {
    parts.push('## 制品（自行读取，不要相信任何转述）\n');
    for (const artifactName of names) {
      parts.push(`- ${artifactName}: ${artifacts[artifactName]}`);
    }
    parts.push('');
  }

  if (input.diff) {
    parts.push(`## 变更范围（diff 引用）\n\n${input.diff}\n`);
  }

  if (input.testEvidence) {
    parts.push(
      `## 作者提供的测试证据（**需要你自己复核**，不要直接采信）\n\n${input.testEvidence}\n`,
    );
  }

  parts.push(
    [
      '## 必须回答的问题',
      '',
      '1. 实现是否真的达成了上面声称的目标？有没有只做了一半、或者绕开了难点？',
      '2. 测试是否**真的证明了**目标行为？警惕：测试被削弱、断言被放宽、只测了 happy path、',
      '   或者测试在改动之前就能通过（那就证明不了任何事）。',
      '3. 有没有改动测试文件、fixture、mock 或 CI 配置来让结果变绿？',
      '4. 有没有未处理的边界条件、错误路径或并发问题？',
      '5. 作者有没有声称完成了但拿不出证据的部分？',
      '',
      '## 输出',
      '',
      '用 structured_output 提交裁决。每条 finding 的 evidence 必须可复核。',
      '若证据不足以判断，用 status="needs_human" 并把问题列在 unverified 里。',
    ].join('\n'),
  );

  return parts.join('\n');
}
