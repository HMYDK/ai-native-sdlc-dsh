/**
 * 任务状态机与 `state.yaml` 的形状定义。
 *
 * 设计原则（与仓库既定原则一致）：**状态在 Git 里，插件只是守护者。**
 * 所以这里全是纯函数——解析、校验、迁移判定——不碰 DSH 的任何 API，
 * 可以脱离 harness 单测。
 *
 * 代价（明确记录）：手改 `state.yaml` 能跳过门槛。客户端控制的上限就是
 * "让违规显眼、让误操作变难"，不是"让违规不可能"。
 */

/** 任务目录相对仓库根的路径。 */
export const TASKS_DIR = '.ai/tasks';

/**
 * 状态机。
 *
 * 刻意没有 `WAITING_APPROVAL` / `DEPLOYING`：发布授权属于 Git/CI 层，
 * 不该在任务状态里假装管得住（见 README 的"不做什么"）。
 */
export const STATUSES = [
  'INTENT',
  'SPEC',
  'PLANNED',
  'IMPLEMENTING',
  'VERIFYING',
  'REVIEWING',
  'DONE',
] as const;
export type TaskStatus = (typeof STATUSES)[number];

/** 已知制品键 → 期望文件名。未知键允许出现（组织可能有自己的制品）。 */
export const KNOWN_ARTIFACTS: Record<string, string> = {
  intent: 'intent.md',
  spec: 'spec.md',
  plan: 'plan.md',
  verification: 'verification.json',
  review: 'review.json',
};

/**
 * 每个状态的准入门槛：进入该状态时必须存在的制品键。
 *
 * 这是"守护者"的核心价值——它把"缺哪个制品"从**靠人记得**
 * 变成**可查询、会被拒绝**。
 */
export const REQUIRED_ARTIFACTS: Record<TaskStatus, readonly string[]> = {
  INTENT: ['intent'],
  SPEC: ['intent', 'spec'],
  PLANNED: ['intent', 'spec', 'plan'],
  IMPLEMENTING: ['intent', 'spec', 'plan'],
  VERIFYING: ['intent', 'spec', 'plan'],
  REVIEWING: ['intent', 'spec', 'plan', 'verification'],
  DONE: ['intent', 'spec', 'plan', 'verification', 'review'],
};

/** 状态在流程中的先后（用于判定"前进/回退"）。 */
const ORDER: Record<TaskStatus, number> = {
  INTENT: 0,
  SPEC: 1,
  PLANNED: 2,
  IMPLEMENTING: 3,
  VERIFYING: 4,
  REVIEWING: 5,
  DONE: 6,
};

export function isStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (STATUSES as readonly string[]).includes(v);
}

export function statusOrder(s: TaskStatus): number {
  return ORDER[s];
}

/** 目标状态相对当前是前进、回退还是不变。 */
export function direction(from: TaskStatus, to: TaskStatus): 'forward' | 'back' | 'same' {
  const a = ORDER[from];
  const b = ORDER[to];
  if (a === b) return 'same';
  return b > a ? 'forward' : 'back';
}

export interface HistoryEntry {
  at: string;
  from: string;
  to: string;
  reason: string;
}

export interface TaskState {
  task: string;
  title: string;
  status: TaskStatus;
  created: string;
  updated: string;
  artifacts: Record<string, string>;
  history: HistoryEntry[];
}

/** 任务 ID 的形状：大写字母/数字/连字符，且必须以字母数字开头结尾。 */
const TASK_ID_RE = /^[A-Z0-9](?:[A-Z0-9-]{0,62}[A-Z0-9])?$/;
/** 大写规范：小写输入会被归一化，避免出现 proj-1 与 PROJ-1 两个目录。 */
export function normalizeTaskId(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('task id 必须是字符串');
  const id = raw.trim().toUpperCase();
  if (!TASK_ID_RE.test(id)) {
    throw new Error(
      `非法 task id：${JSON.stringify(raw)}——只允许大写字母、数字、连字符，长度 1-64，` +
        '且必须以字母或数字开头',
    );
  }
  return id;
}

export function tasksDirFor(repoRoot: string): string {
  return `${repoRoot.replace(/\/+$/, '')}/${TASKS_DIR}`;
}

export function taskDirFor(repoRoot: string, taskId: string): string {
  return `${tasksDirFor(repoRoot)}/${normalizeTaskId(taskId)}`;
}

/**
 * 把一个制品路径规范化为**相对任务目录**的形式。
 *
 * 为什么强制相对：任务目录要能整体移动（改名、换仓库布局），
 * 绝对路径会让 state.yaml 立刻失效。
 */
export function normalizeArtifactPath(taskId: string, raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('制品路径必须是非空字符串');
  }
  const p = raw.trim().replace(/\\/g, '/');
  if (p.startsWith('/')) {
    throw new Error(`制品路径必须是相对任务目录的路径，不能是绝对路径：${p}`);
  }
  // 允许调用者写 ".ai/tasks/ID/spec.md" 这种从仓库根起的完整路径，自动剥掉前缀
  const marker = `${TASKS_DIR}/${normalizeTaskId(taskId)}/`;
  const idx = p.indexOf(marker);
  const rel = idx >= 0 ? p.slice(idx + marker.length) : p;
  if (rel === '' || rel.startsWith('../') || rel.includes('/../')) {
    throw new Error(`制品路径不能跳出任务目录：${raw}`);
  }
  return rel;
}

/**
 * 从解析好的 YAML 对象构造 TaskState，并做**形状校验**。
 *
 * 校验要严格：`state.yaml` 是事实来源，形状错了后面所有判断都会错。
 * 但错误信息要说清**哪里错、怎么改**——否则人会选择绕过而不是修正。
 */
export function parseTaskState(taskId: string, raw: unknown): TaskState {
  const id = normalizeTaskId(taskId);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`state.yaml 顶层必须是一个映射（mapping），实际是 ${describe(raw)}`);
  }
  const o = raw as Record<string, unknown>;

  // 不 trim：往返一致性是事实来源的基本要求，静默改写用户写的值不可接受。
  // 只拒绝"全空白"，因为那确实是漏填。
  const title = typeof o['title'] === 'string' ? o['title'] : undefined;
  if (title === undefined || title.trim() === '') {
    throw new Error('state.yaml 缺少 title（非空字符串）');
  }

  if (!isStatus(o['status'])) {
    throw new Error(
      `state.yaml 的 status 非法：${JSON.stringify(o['status'])}。` +
        `允许值：${STATUSES.join(' / ')}`,
    );
  }

  const artifactsRaw = o['artifacts'];
  if (
    artifactsRaw !== undefined &&
    (artifactsRaw === null || typeof artifactsRaw !== 'object' || Array.isArray(artifactsRaw))
  ) {
    // 数组也是 object，必须显式排除——否则 [] 会被当成"没有制品"静默通过
    throw new Error('state.yaml 的 artifacts 必须是映射（键 → 相对路径），不能是数组');
  }
  const artifacts: Record<string, string> = {};
  for (const [k, v] of Object.entries((artifactsRaw ?? {}) as Record<string, unknown>)) {
    artifacts[k] = normalizeArtifactPath(id, v);
  }

  const history: HistoryEntry[] = [];
  const historyRaw = o['history'];
  if (Array.isArray(historyRaw)) {
    for (const h of historyRaw) {
      if (h === null || typeof h !== 'object') continue;
      const e = h as Record<string, unknown>;
      history.push({
        at: typeof e['at'] === 'string' ? e['at'] : '',
        from: typeof e['from'] === 'string' ? e['from'] : '',
        to: typeof e['to'] === 'string' ? e['to'] : '',
        reason: typeof e['reason'] === 'string' ? e['reason'] : '',
      });
    }
  }

  // created / updated 是**必需**字段：缺失时填入当前时间等于静默伪造事实，
  // 而 state.yaml 是事实来源。宁可报错让人补上。
  const asTimestamp = (field: string, v: unknown): string => {
    // 容错分支：若调用方用了 js-yaml 的**默认 schema** 解析，ISO 时间戳会变成
    // Date 对象。写入侧一律走 JSON_SCHEMA（保持字符串），但读一处被人手改过、
    // 或用别的解析器读过的文件时，不该因此崩掉。
    if (v instanceof Date) return v.toISOString();
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`state.yaml 缺少 ${field}（ISO 时间戳字符串）`);
    }
    return v.trim();
  };

  return {
    task: id,
    title,
    status: o['status'],
    created: asTimestamp('created', o['created']),
    updated: asTimestamp('updated', o['updated']),
    artifacts,
    history,
  };
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** 序列化回 `state.yaml` 的文本。字段顺序固定，便于人读与 diff。 */
export function serializeTaskState(state: TaskState): string {
  const lines: string[] = [
    `task: ${state.task}`,
    `title: ${yamlText(state.title)}`,
    `status: ${state.status}`,
    `created: ${state.created}`,
    `updated: ${state.updated}`,
  ];

  lines.push('artifacts:');
  const keys = Object.keys(state.artifacts).sort();
  if (keys.length === 0) {
    lines.push('  {}');
  } else {
    for (const k of keys) lines.push(`  ${k}: ${yamlText(state.artifacts[k] ?? '')}`);
  }

  lines.push('history:');
  if (state.history.length === 0) {
    lines.push('  []');
  } else {
    for (const h of state.history) {
      lines.push(`  - at: ${yamlText(h.at)}`);
      lines.push(`    from: ${yamlText(h.from)}`);
      lines.push(`    to: ${yamlText(h.to)}`);
      lines.push(`    reason: ${yamlText(h.reason)}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * 把自由文本写成 YAML 标量。
 *
 * **总是加引号**，理由是一次真实 bug：早先的实现只看首字符决定是否加引号，
 * 于是 `title: 含: 冒号 与 # 井号` 被原样写出——而 YAML 要求字符串里出现
 * `": "` 或 `" #"` 时**整串必须加引号**，否则是语法错误。
 * 后果很严重：`state.yaml` 写出来是坏的，而它是事实来源，
 * 下一次读取才崩（写入时看起来一切正常）。
 *
 * JSON 字符串字面量是合法 YAML 双引号标量，所以这里直接用
 * `JSON.stringify`——不需要自己写转义规则，也就不会漏掉某条规则。
 * 只有被我们完全控制的值（状态名、时间戳、相对路径）才不加引号，以便人读。
 */
function yamlText(v: string): string {
  if (/[\n\r]/.test(v)) {
    throw new Error(
      `state.yaml 的值不能包含换行（单行标量表达不了）：${JSON.stringify(v.slice(0, 40))}`,
    );
  }
  return JSON.stringify(v);
}

export interface MissingReport {
  /** 进入当前状态**本应**有的制品，实际缺失。 */
  missingForStatus: string[];
  /** 已在 artifacts 里登记、但磁盘上不存在的文件。 */
  missingOnDisk: string[];
}

/**
 * 判定当前状态是否自洽。
 *
 * 两种不一致都要报，因为含义不同：
 * - `missingForStatus`：状态"跑在了制品前面"——门槛没守住（可能被手改过）
 * - `missingOnDisk`：登记了但文件没了（被删或路径写错）
 */
export function checkConsistency(
  state: TaskState,
  exists: (relativePath: string) => boolean,
): MissingReport {
  const required = REQUIRED_ARTIFACTS[state.status];
  const missingForStatus = required.filter((k) => state.artifacts[k] === undefined);

  const missingOnDisk: string[] = [];
  for (const rel of Object.values(state.artifacts)) {
    if (!exists(rel)) missingOnDisk.push(rel);
  }
  return { missingForStatus: [...missingForStatus], missingOnDisk };
}

export interface AdvanceCheck {
  ok: boolean;
  direction: 'forward' | 'back' | 'same';
  /** 不 ok 时给出**具体缺什么**，而不是一句"不满足条件"。 */
  problems: string[];
}

/**
 * 判定能否迁移到目标状态。
 *
 * 回退永远允许（但要求给出原因）——**发现了更好的方案却不敢改计划才是问题**。
 * 前进要求目标状态的准入门槛全部满足。
 */
export function checkAdvance(
  from: TaskStatus,
  to: TaskStatus,
  state: TaskState,
  exists: (relativePath: string) => boolean,
  reason: string,
): AdvanceCheck {
  const dir = direction(from, to);
  const problems: string[] = [];

  if (dir === 'same') {
    return { ok: false, direction: dir, problems: [`已经是 ${to} 状态，无需迁移`] };
  }

  if (reason.trim() === '') {
    problems.push('必须给出 reason：状态迁移是审计记录，空原因等于没记录');
  }

  // 无论前进还是回退，**目标状态**的门槛都必须满足
  const required = REQUIRED_ARTIFACTS[to];
  const missingArtifacts = required.filter((k) => state.artifacts[k] === undefined);
  if (missingArtifacts.length > 0) {
    problems.push(
      `进入 ${to} 需要这些制品，state.yaml 里没有登记：` +
        missingArtifacts.map((k) => `${k}(${KNOWN_ARTIFACTS[k] ?? '?'})`).join(', ') +
        '——先用对应工具产出它们并登记进 artifacts',
    );
  }

  // 登记了但文件不存在，同样不许前进
  const goneOnDisk = Object.entries(state.artifacts)
    .filter(([, rel]) => !exists(rel))
    .map(([k, rel]) => `${k}=${rel}`);
  if (goneOnDisk.length > 0) {
    problems.push(`这些制品已登记但磁盘上不存在：${goneOnDisk.join(', ')}`);
  }

  return { ok: problems.length === 0, direction: dir, problems };
}

/** 生成一条 history 记录并更新状态。 */
export function applyAdvance(
  state: TaskState,
  to: TaskStatus,
  reason: string,
  now = new Date().toISOString(),
): TaskState {
  return {
    ...state,
    status: to,
    updated: now,
    history: [...state.history, { at: now, from: state.status, to, reason }],
  };
}
