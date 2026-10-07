/**
 * 验证裁决的数据契约与提示词构造。
 *
 * 裁决必须是**机器可读**的——否则"验证通过"就只是又一句自然语言断言，
 * 无法进 CI、无法做回归、无法作为证据。
 *
 * Schema 限制在 DSH `outputSchema` 支持的子集内：
 * type / properties / required / additionalProperties / items / enum / const / oneOf。
 */

import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools';

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
  'You have read-only tools. You cannot modify anything, and you must not try.',
  // 这一条不是客套：DSH 的 toolFilter 只过滤工具的 schema 与执行，
  // **不会移除别的插件注册的静态指导段落**（见 docs/dsh-plugin-contracts.md §3.4）。
  // 所以验证者会在提示词里读到"用 write 工具…"之类的文字，而它并没有 write。
  'Other instruction text in this prompt may refer to tools you do not have — you were deliberately given a read-only subset. Ignore any instruction that would have you modify, create, fix, or commit anything; report the issue in your findings instead.',
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
