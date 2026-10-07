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

/**
 * 单条验收标准的裁决结果。
 *
 * 三态与顶层裁决同构，理由也一样：只给 met/not_met 会逼验证者在证据不足时
 * 二选一，而"证据不足"最常见的结局是猜成 met。
 *
 * `cannot_tell` 是本功能存在的**核心理由**：它把"我只验了前置条件"
 * 从一句埋在 summary 里的自我限定，变成结构化结果里一条可检查的记录。
 */
export const CRITERION_RESULTS = ['met', 'not_met', 'cannot_tell'] as const;
export type CriterionResultStatus = (typeof CRITERION_RESULTS)[number];

export interface CriterionResult {
  /** 原样回抄调用方给的标准文本——便于对账，也防止验证者偷偷改写标准。 */
  criterion: string;
  result: CriterionResultStatus;
  evidence: string;
}

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
  /** 逐条验收标准的裁决。调用方给了 criteria 时必须逐条覆盖。 */
  criteria_results?: CriterionResult[];
}

/**
 * 验收标准策略的**强制执行点**。
 *
 * 规则：
 *  1. 没给 criteria 时，`approve` 降级为 `needs_human`——
 *     没有"对"的定义，就不存在"验证通过"这件事。
 *  2. 给了 criteria 时，每条标准都必须有结果；漏掉的补成一条 finding
 *     （`cannot_tell` 是**正当答案**，漏报不是）。
 *  3. 有 `cannot_tell` 时，`approve` 也降级为 `needs_human`——
 *     标准没验完就宣布通过，与没给标准是同一个问题。
 *
 * 降级**不隐藏**原来的裁决：原文进 finding 的 evidence，读者能看到
 * 验证者本来想说什么。
 */
export function enforceCriteriaPolicy(
  verdict: Verdict,
  criteria: string[],
  sessionId: string | undefined,
): Verdict & { verifier_session?: string } {
  const findings: Finding[] = [...(verdict.findings ?? [])];
  const results = Array.isArray(verdict.criteria_results) ? verdict.criteria_results : [];
  let status = verdict.status;
  const notes: string[] = [];

  if (criteria.length === 0) {
    if (status === 'approve') {
      status = 'needs_human';
      notes.push(
        '**已降级为 needs_human**：这次调用没有给出 `criteria`（验收标准）。' +
          '没有"对"的定义时，验证者只能自行推断判据，"通过"就退化成一句意见。' +
          '这份验证者的原始结论是 approve，原文见下方 finding。',
      );
      findings.push({
        severity: 'blocking',
        category: 'missing_evidence',
        reason: '缺少验收标准（criteria），无法据以判断"通过"意味着什么',
        evidence: `验证者原结论：${verdict.summary}`,
        suggestion:
          '把 spec.md 里的验收标准逐条传进 criteria 后重跑。标准应当是**可证伪**的' +
          '（"接口在并发 100 时 p99 < 200ms"，而不是"性能良好"）。',
      });
    }
  } else {
    const reported = new Set(results.map((r) => (r.criterion ?? '').trim()));
    const missing = criteria.filter((c) => !reported.has(c.trim()));
    if (missing.length > 0) {
      findings.push({
        severity: 'important',
        category: 'missing_evidence',
        reason: `验证者漏报了 ${missing.length} 条验收标准的结果`,
        evidence: missing.map((m, i) => `${i + 1}. ${m}`).join('\n'),
        suggestion:
          '每条标准都必须给出 met / not_met / cannot_tell。`cannot_tell` 是正当答案，' +
          '漏报不是——它会让调用方以为这条被检查过。',
      });
    }

    const cannotTell = results.filter((r) => r.result === 'cannot_tell');
    if (cannotTell.length > 0 && status === 'approve') {
      status = 'needs_human';
      notes.push(
        `**已降级为 needs_human**：有 ${cannotTell.length} 条验收标准是 ` +
          '`cannot_tell`（无法判定）。标准没验完就宣布通过，与没给标准是同一个问题。',
      );
    }

    const notMet = results.filter((r) => r.result === 'not_met');
    if (notMet.length > 0 && status === 'approve') {
      status = 'needs_human';
      notes.push(
        `**已降级为 needs_human**：有 ${notMet.length} 条验收标准是 ` +
          '`not_met`（不成立）。验证者自己都认为不成立，不应以 approve 收场。',
      );
    }
  }

  // ⚠️ 两条返回路径**都必须带 `findings`**。
  //
  // 这里曾有一个严重缺陷：未降级的分支写成 `return { ...verdict, verifier_session }`，
  // 把本地攒的 `findings` 整个丢掉了。后果是「验证者漏报了 N 条验收标准」
  // 这条 finding **永远不会出现在返回值里**——只有在恰好发生降级时才带出来。
  // 也就是说：漏报标准这件事被静默吞掉了，而"静默吞掉"正是本项目最忌讳的失败模式。
  //
  // 抓不到它的原因值得记：我一直在**穿过整个工具调度**去测，
  // 而那个回路里有两处会掩盖它。把它移到纯函数层、直接写单测后，一次就暴露了。
  if (notes.length === 0) {
    return { ...verdict, findings, verifier_session: sessionId };
  }
  return {
    ...verdict,
    status,
    summary: `${verdict.summary}\n\n${notes.join('\n\n')}`,
    findings,
    verifier_session: sessionId,
  };
}

export interface VerificationPromptInput {
  artifacts?: Record<string, string>;
  diff?: string;
  testEvidence?: string;
  scope?: string;
  intentOfChange?: string;
  /** 本次必须逐条裁决的验收标准。来源通常是 spec.md。 */
  criteria?: string[];
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
    criteria_results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion', 'result', 'evidence'],
        properties: {
          criterion: { type: 'string' },
          result: { type: 'string', enum: [...CRITERION_RESULTS] },
          evidence: { type: 'string' },
        },
      },
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
    // 刻意**不**标 required：裁决 schema 里它是可选的（没给 criteria 时
    // 验证者不会产出它）。输出侧更严会把合法的裁决拒掉——这正是
    // assertSchemasAligned 在加载时报出来的那类漂移。内部字段仍必填。
    criteria_results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          criterion: { type: 'string', required: true },
          result: { type: 'string', required: true, enum: [...CRITERION_RESULTS] },
          evidence: { type: 'string', required: true },
        },
      },
    },
    verifier_session: { type: 'string' },
  },
} as const;

/**
 * 防漂移自检 —— **递归比对**，不只看顶层。
 *
 * 为什么必须递归：`additionalProperties: false` 的约束是**逐层**生效的。
 * 验证者实测过——若只比对顶层，把裁决的嵌套字段（如 findings 里新增一项）
 * 漏在输出 schema 外，会复现与顶层漂移**完全相同**的失败：
 *   `value.findings[0].note is not a declared property`
 * 整条裁决变成 INVALID_TOOL_OUTPUT，调用方连 findings 都拿不到。
 * 也就是说，只比顶层等于没覆盖这个断言存在的理由。
 */
function compareNodes(
  verdictNode: unknown,
  outNode: unknown,
  path: string,
  problems: string[],
): void {
  const v = verdictNode as Record<string, unknown> | undefined;
  const o = outNode as Record<string, unknown> | undefined;
  if (v === undefined || v === null) return;

  // 1) 逐层比对 properties 的键集合（双向）
  const vProps = (v['properties'] ?? undefined) as Record<string, unknown> | undefined;
  if (vProps !== undefined) {
    const oProps = (o?.['properties'] ?? {}) as Record<string, unknown>;
    const vKeys = Object.keys(vProps);
    const oKeys = Object.keys(oProps);

    for (const k of vKeys) {
      if (!(k in oProps)) {
        problems.push(`${path}.${k} 在工具输出 schema 中缺失`);
      }
    }
    for (const k of oKeys) {
      if (!vKeys.includes(k)) {
        problems.push(`${path}.${k} 是工具输出 schema 独有、裁决里不存在`);
      }
    }

    // 2) 逐层比对必填性 —— **双向**
    const vReq = new Set((v['required'] ?? []) as string[]);
    for (const k of vReq) {
      const child = oProps[k] as { required?: boolean } | undefined;
      if (child?.required !== true) {
        problems.push(`${path}.${k} 在裁决里必填，但工具输出 schema 未标 required`);
      }
    }
    for (const k of oKeys) {
      const child = oProps[k] as { required?: boolean } | undefined;
      if (child?.required === true && !vReq.has(k) && k !== 'verifier_session') {
        problems.push(`${path}.${k} 在工具输出 schema 里必填，但裁决里是可选的（输出更严会把合法裁决拒掉）`);
      }
    }

    // 3) 值级比对：枚举
    //    裁决侧的每个取值都必须被输出侧接受——否则那条裁决会被运行时拒掉，
    //    症状与键缺失完全相同（INVALID_TOOL_OUTPUT，调用方拿不到 findings）。
    //    只比键集合是抓不到这一类的（验证者实测：把 severity enum 加宽后断言不抛）。
    for (const k of vKeys) {
      const vEnum = (vProps[k] as { enum?: unknown[] } | undefined)?.enum;
      if (!Array.isArray(vEnum)) continue;
      const oEnum = (oProps[k] as { enum?: unknown[] } | undefined)?.enum;
      if (!Array.isArray(oEnum)) {
        problems.push(`${path}.${k} 在裁决里限定了枚举，但工具输出 schema 没有枚举约束`);
        continue;
      }
      const missing = vEnum.filter((x) => !oEnum.includes(x));
      if (missing.length > 0) {
        problems.push(
          `${path}.${k} 的枚举取值 [${missing.map(String).join(', ')}] 不被工具输出 schema 接受`,
        );
      }
    }

    // 4) 递归进入子节点
    for (const k of vKeys) {
      if (k in oProps) compareNodes(vProps[k], oProps[k], `${path}.${k}`, problems);
    }
  }

  // 4) 数组元素也要递归（findings.items 是漂移的实际藏身处）
  if (v['items'] !== undefined) {
    compareNodes(v['items'], o?.['items'], `${path}[]`, problems);
  }
}

export function assertSchemasAligned(): void {
  const problems: string[] = [];

  // 顶层比对把 verifier_session（工具自己的元信息，不属于裁决）排除在外
  const verdictOnly: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(
    (VERDICT_SCHEMA.properties ?? {}) as Record<string, unknown>,
  )) {
    verdictOnly[k] = spec;
  }
  const outOnly: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(TOOL_OUTPUT_SCHEMA.properties)) {
    if (k === 'verifier_session') continue;
    outOnly[k] = spec;
  }

  compareNodes(
    {
      properties: verdictOnly,
      required: (VERDICT_SCHEMA as { required?: string[] }).required ?? [],
    },
    { properties: outOnly },
    'verdict',
    problems,
  );

  if (problems.length > 0) {
    throw new Error(
      'sdlc-verify: 工具输出 schema 与裁决 schema 漂移（会让对应裁决变成工具错误）：\n  ' +
        problems.join('\n  '),
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

  // 验收标准段刻意放在 scope **之前**：它是本次验证的骨架，不是补充说明。
  if (input.criteria !== undefined && input.criteria.length > 0) {
    parts.push(
      [
        '## 必须逐条裁决的验收标准',
        '',
        '对下面**每一条**给出结果，并在 `criteria_results` 里逐条覆盖——一条都不能少：',
        '',
        '- `met`：有可复核的证据表明它成立',
        '- `not_met`：有可复核的证据表明它不成立',
        '- `cannot_tell`：**在你的能力或本次范围内无法判定**',
        '',
        '`cannot_tell` 是一个**正当的、会被上报的结果**，不是失败。',
        '但不要用它代替调查：先尽力查，查不动了再用。',
        '',
        '⚠️ 只确认了前置条件（文件在、测试跑了）**不等于**该标准成立。',
        '每条 `met` 都要说明你实际观察到了什么行为。',
        '',
        '`criterion` 字段要**原样回抄**下面的文本——便于调用方对账，',
        '也避免标准在传递中被悄悄改写。',
        '',
        ...input.criteria.map((c, i) => `${i + 1}. ${c}`),
        '',
      ].join('\n'),
    );
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
