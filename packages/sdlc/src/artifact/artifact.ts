/**
 * 制品类型、手册规定的必需章节，以及结构检查。
 *
 * ## 这个模块**只查结构，不查质量**
 *
 * 这一点必须说清楚，因为夸大一个检查的能力比不做更危险：
 * **结构合规的废话照样能通过。** 一段把 `## Problem` 填成"我们要做得更好"的
 * intent.md 在结构上完全合法。本模块不会、也不能发现它。
 *
 * 那为什么还值得做？因为手册给每种制品规定的章节**都是下游的输入**，
 * 不是装饰：
 *   · intent 的 `Open questions` → spec 阶段必须逐条回答或延续（手册阶段 02 第 3 步）
 *   · spec 的 `Areas of concern` → 产品负责人要逐项找策略负责人解决
 *   · plan 的 `Proof`         → 验证阶段拿它和实际证据对账
 * 章节缺失会让下游**静默地少掉一个输入**——这才是要防的。
 *
 * ## 已知的检查不了的东西（写在这里，也会出现在工具描述与拒绝信息里）
 *   · 内容是否真的回答了章节名要求的问题
 *   · 是否与 intent 一致
 *   · 验收标准是否可证伪
 */

export const ARTIFACT_KINDS = ['intent', 'spec', 'plan'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** 每种制品的默认文件名（与 sdlc-task 的 KNOWN_ARTIFACTS 一致）。 */
export const ARTIFACT_FILENAMES: Record<ArtifactKind, string> = {
  intent: 'intent.md',
  spec: 'spec.md',
  plan: 'plan.md',
};

export interface SectionSpec {
  /** 规范名（写进提示词与报告）。 */
  readonly name: string;
  /** 大小写不敏感的同义词。写制品的人可能用不同措辞表达同一件事。 */
  readonly aliases: readonly string[];
  /** 为什么必需——会出现在"缺了这一节"的错误信息里。 */
  readonly why: string;
}

/**
 * 手册规定的章节。
 *
 * 别名表是刻意宽松的：`Files that change` 与 `Files changed` 是同一件事，
 * 因为措辞不同就拒绝，只会让人绕过检查（本项目的既定教训是——
 * **误伤会降低门禁的实际效力，因为人会想办法绕开它**）。
 * 但**不为缺失的语义发明章节**：`Proof` 与 `Tests` 不是一回事
 * （前者要能证明目标行为，后者只说明跑了什么）。
 */
export const REQUIRED_SECTIONS: Record<ArtifactKind, readonly SectionSpec[]> = {
  intent: [
    {
      name: 'Problem',
      aliases: ['problem', 'the problem', '问题'],
      why: '下游要靠它判断这份意图解不解决问题；只写方案会让规格阶段无从对照',
    },
    {
      name: 'Proposed outcome',
      aliases: ['proposed outcome', 'outcome', 'expected outcome', '预期结果', '预期成果'],
      why: '没有可观察的结果，就没人能在最后判断这件事做成了没有',
    },
    {
      name: 'Affected users and systems',
      aliases: ['affected users and systems', 'affected users', 'affected systems', '影响范围', '受影响的用户与系统'],
      why: '爆炸半径要提前知道——评审和发布都要据此判断风险',
    },
    {
      name: 'Constraints',
      aliases: ['constraints', 'constraint', '约束', '约束条件'],
      why:
        '手册要求把"不做什么"也写进来；缺了它，后续阶段会自行发明边界。' +
        '⚠️ 约束是**边做边发现**的：探索期一碰到硬边界（环境限制、共享依赖、' +
        '不能碰的东西），就**当场补进这一节，不要等根因**——' +
        '约束不需要根因就能写。不补的话它会变成 plan 里的一条**假设**，' +
        '而假设通常在验证阶段被打掉，那时返工最贵。',
    },
    {
      name: 'Open questions',
      aliases: ['open questions', 'open issues', '未决问题', '待解决问题'],
      why: '它是 spec 阶段的输入（手册阶段 02 第 3 步要逐条回答或延续）；留空会被误读成"没有疑问"',
    },
  ],
  spec: [
    {
      name: 'Requirements',
      aliases: ['requirements', 'requirement', '需求', '功能需求'],
      why: '规格的主体；没有它，工程团队无法据此规划',
    },
    {
      name: 'Design',
      aliases: ['design', 'design decisions', 'technical design', '设计', '方案设计'],
      why: '手册把需求与设计合并到同一份制品；只有需求没有设计等于少了一半',
    },
    {
      name: 'Areas of concern',
      aliases: [
        'areas of concern',
        'concerns',
        'areas of concern / policy conflicts',
        '关注点',
        '需要关注的领域',
        '风险点',
      ],
      why:
        '手册明确要求"标注出需要关注的领域，尤其是无法同时满足相互冲突的策略时"；' +
        '这一节是产品负责人转交策略负责人的清单，也是验证阶段最该盯的地方',
    },
  ],
  plan: [
    {
      name: 'Files that change',
      aliases: ['files that change', 'files changed', 'files', 'affected files', '变更文件', '改动文件'],
      why: '评审要靠它判断爆炸半径；"改了一堆文件"无法评审',
    },
    {
      name: 'Order of work',
      aliases: ['order of work', 'order', 'steps', 'implementation order', '实施顺序', '工作顺序'],
      why: '顺序里藏着依赖与可回滚点；手册的计划模板把它单列是有原因的',
    },
    {
      name: 'Risks',
      aliases: ['risks', 'risk', '风险'],
      why: '写"没有风险"是可以的，但**必须显式写**——沉默会被当成没想过',
    },
    {
      name: 'Proof',
      aliases: ['proof', 'evidence', 'verification', '证明', '证据'],
      why:
        '这一节是验证阶段的输入，也是"计划里承诺的证据"与实际证据对账的依据；' +
        '没有它，验证只能凭一句话推断什么叫"对"',
    },
  ],
};

/** 手册模板里用尖括号表示待填的占位符；制品里残留它们说明还没写完。 */
const PLACEHOLDER_RE = /<[^<>\n]{2,80}>/;

export interface SectionFinding {
  /** 缺失、空、或仍是占位符。 */
  kind: 'missing' | 'empty' | 'placeholder';
  section: string;
  detail: string;
}

export interface ArtifactCheck {
  kind: ArtifactKind;
  ok: boolean;
  /** 实际存在的章节名（原样，便于报告与 diff）。 */
  found: string[];
  findings: SectionFinding[];
}

/** 从 markdown 里抽出二级标题（`## X`），保留原样文本。 */
export function extractSections(markdown: string): string[] {
  const out: string[] = [];
  for (const line of markdown.split('\n')) {
    const m = /^\s{0,3}##\s+(.+?)\s*#*\s*$/.exec(line);
    if (m?.[1] !== undefined && m[1] !== '') out.push(m[1]);
  }
  return out;
}

/** 取某个二级标题下的正文（到下一个 `## ` 或文末为止）。 */
export function sectionBody(markdown: string, sectionName: string): string {
  const lines = markdown.split('\n');
  const want = sectionName.trim().toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s{0,3}##\s+(.+?)\s*#*\s*$/.exec(lines[i] ?? '');
    if (m?.[1]?.trim().toLowerCase() === want) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return '';
  const body: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    if (/^\s{0,3}##\s+/.test(lines[i] ?? '')) break;
    body.push(lines[i] ?? '');
  }
  return body.join('\n').trim();
}

/** 章节名是否匹配某个规范章节（大小写不敏感 + 别名）。 */
function matches(spec: SectionSpec, heading: string): boolean {
  const h = heading.trim().toLowerCase();
  return spec.aliases.some((a) => a.toLowerCase() === h) || spec.name.toLowerCase() === h;
}

/**
 * 检查一份制品文档的结构。
 *
 * 三种缺陷都报，因为处置方式不同：
 *   · `missing`     —— 整节没写：下游会少一个输入
 *   · `empty`       —— 写了标题但正文为空：最危险，因为它**看起来**写过了
 *   · `placeholder` —— 正文还是 `<>` 占位符：没写完
 */
export function checkArtifact(kind: ArtifactKind, markdown: string): ArtifactCheck {
  const heads = extractSections(markdown);
  const findings: SectionFinding[] = [];

  for (const spec of REQUIRED_SECTIONS[kind]) {
    const heading = heads.find((h) => matches(spec, h));
    if (heading === undefined) {
      findings.push({
        kind: 'missing',
        section: spec.name,
        detail: `缺少「## ${spec.name}」章节。为什么需要它：${spec.why}`,
      });
      continue;
    }
    const body = sectionBody(markdown, heading);
    if (body === '') {
      findings.push({
        kind: 'empty',
        section: spec.name,
        detail:
          `「## ${heading}」有标题但正文为空——这比不写更危险，因为它看起来写过了。` +
          `为什么需要它：${spec.why}`,
      });
      continue;
    }
    const ph = PLACEHOLDER_RE.exec(body);
    if (ph !== null) {
      findings.push({
        kind: 'placeholder',
        section: spec.name,
        detail: `「## ${heading}」正文里还有未填的占位符 ${ph[0]}——这一节还没写完`,
      });
    }
  }

  return { kind, ok: findings.length === 0, found: heads, findings };
}

/**
 * 判断磁盘上的内容是不是**未经修改的骨架**。
 *
 * 逐行比对，忽略一级标题（`# Intent: ...`）——因为骨架的标题由
 * `sdlc_task_create` 填的是真实标题，而这里不知道标题是什么。
 * 其余每一行必须完全一致：任何人工补充（哪怕只填了一节）都会让它返回 false，
 * 于是仍然需要显式 overwrite。
 */
export function isUnmodifiedSkeleton(kind: ArtifactKind, existing: string): boolean {
  const ref = skeletonFor(kind, 'x');
  const strip = (text: string) =>
    text
      .split('\n')
      .filter((l) => !/^#\s/.test(l)) // 去掉一级标题
      .map((l) => l.trimEnd());
  const a = strip(existing);
  const b = strip(ref);
  if (a.length !== b.length) return false;
  return a.every((line, i) => line === b[i]);
}

export function isArtifactKind(v: unknown): v is ArtifactKind {
  return typeof v === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(v);
}

/** 生成某个制品类型的骨架，章节名与顺序都按手册模板。 */
export function skeletonFor(kind: ArtifactKind, title: string): string {
  const lines = [`# ${kind === 'intent' ? 'Intent' : kind === 'spec' ? 'Spec' : 'Plan'}: ${title}`, ''];
  for (const spec of REQUIRED_SECTIONS[kind]) {
    lines.push(`## ${spec.name}`, '', `<!-- ${spec.why} -->`, '');
  }
  return lines.join('\n');
}

/**
 * 转义正则元字符，让一个字符串能被安全地拼进 `new RegExp()`。
 *
 * 用在两处构造正则的地方（检查 state.yaml 里是否已登记某制品、
 * 以及在 artifacts 段里定位某个键）。**没有它，一个含 `.` 或 `*` 的
 * 制品名会把正则变成别的东西**——例如 `verification` 里的 `.` 会匹配
 * 任意字符。
 *
 * 它原来住在 `index.ts` 里且**完全没有测试**——而它是这条链路上
 * 唯一"把一个字符串变成正则"的地方。变异测试的存活清单里它出现过
 * （`?` `+` `|` 等被从字符类里删掉时全套测试仍然全绿）。
 * 搬到纯函数层并直接单测。
 */
export function escapeRe(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
