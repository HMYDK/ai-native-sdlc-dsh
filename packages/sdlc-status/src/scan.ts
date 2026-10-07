/**
 * 跨任务扫描与聚合。
 *
 * ## 为什么是纯函数
 *
 * 本项目的实测教训：一个函数如果只能**穿过整个工具调度**去测，它的 bug 会藏很久。
 * `sdlc-verify` 的 `enforceCriteriaPolicy` 就因此把一个"findings 被丢掉"的
 * 严重缺陷藏到了最后——移到纯函数层直接单测后一次就暴露了。
 *
 * 所以这里把**最容易出错、又最有价值**的部分（跨任务解析与聚合）做成纯函数：
 * 输入是"目录名 → 文件内容"的映射，输出是结构化的扫描结果。文件 IO 在边界上做。
 *
 * ## 一条刻意的设计：扫描**绝不因为单个任务坏掉而整体失败**
 *
 * 一个团队里只要有一个任务的 `state.yaml` 被手改坏了，整个状态看板就报不出东西
 * 是最糟的结果——恰恰在出问题的时候你看不到全局。所以每个任务单独判定，
 * 坏掉的降级为 `error` 条目并**如实呈现**，而不是抛错。
 */

import { JSON_SCHEMA, load as parseYaml } from 'js-yaml';
/**
 * ## 与 sdlc-task 的关系：**共享文件契约，不共享代码**
 *
 * 状态机的**权威定义**在 `packages/sdlc-task/src/state.ts`。这里有一份副本，
 * 原因是一次实测的安装失败：dsh 插件是**独立 bundle**，而 pnpm 从 registry
 * 安装——`dependencies: {"@ai-native-sdlc/dsh-sdlc-task": "0.1.0"}` 解析不到，
 * `dsh plugin add` 直接失败。所以跨包 import 这条路走不通。
 *
 * 剩下两个选择都不好，但有一个明显更诚实：
 *   · 静默复制 → 漂移了没人知道（本项目已经吃过一次"两份真相漂移"的亏）
 *   · **复制 + 显式契约 + 漂移能被发现** ← 选这个
 *
 * 具体做法：副本带上"权威在这里"的指针，并由**契约测试**对照
 * `packages/sdlc-task/src/state.ts` 的实际文本校验——改了那边没改这边，
 * 测试会红。这样漂移是**可见的**，而不是静默的。
 *
 * 只读的部分（`parseTaskState`/`checkConsistency`）本来就不该跨包复用：
 * 它们只是"读 YAML 并判断"，逻辑简单且被本包的单测覆盖。
 */
const STATUSES = [
  'INTENT',
  'SPEC',
  'PLANNED',
  'IMPLEMENTING',
  'VERIFYING',
  'REVIEWING',
  'DONE',
] as const;
type TaskStatus = (typeof STATUSES)[number];

/** 与 sdlc-task 的 KNOWN_ARTIFACTS 一致。 */
const KNOWN_ARTIFACTS: Record<string, string> = {
  intent: 'intent.md',
  spec: 'spec.md',
  plan: 'plan.md',
  verification: 'verification.json',
  review: 'review.json',
};

/** 与 sdlc-task 的 REQUIRED_ARTIFACTS 一致。 */
const REQUIRED_ARTIFACTS: Record<TaskStatus, readonly string[]> = {
  INTENT: ['intent'],
  SPEC: ['intent', 'spec'],
  PLANNED: ['intent', 'spec', 'plan'],
  IMPLEMENTING: ['intent', 'spec', 'plan'],
  VERIFYING: ['intent', 'spec', 'plan'],
  REVIEWING: ['intent', 'spec', 'plan', 'verification'],
  DONE: ['intent', 'spec', 'plan', 'verification', 'review'],
};

function isStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (STATUSES as readonly string[]).includes(v);
}

interface TaskState {
  task: string;
  title: string;
  status: TaskStatus;
  artifacts: Record<string, string>;
  updated?: string;
}

/**
 * 从解析好的 YAML 构造任务状态。
 *
 * ⚠️ 刻意**比 sdlc-task 宽松**：那边是写入路径，形状错了必须拒绝；
 * 这里是**只读的看板**，目标是"尽量把能读的读出来并如实标注"。
 * 所以缺 title 不致命，坏掉的条目由调用方标成 error/unverified。
 */
function parseTaskStateLoose(taskId: string, raw: unknown): TaskState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('state.yaml 顶层必须是一个映射');
  }
  const o = raw as Record<string, unknown>;
  const status = o['status'];
  if (!isStatus(status)) {
    throw new Error(
      `state.yaml 的 status 非法：${JSON.stringify(status)}。允许值：${STATUSES.join(' / ')}`,
    );
  }
  const artifactsRaw = o['artifacts'];
  const artifacts: Record<string, string> = {};
  if (artifactsRaw !== null && typeof artifactsRaw === 'object' && !Array.isArray(artifactsRaw)) {
    for (const [k, v] of Object.entries(artifactsRaw as Record<string, unknown>)) {
      if (typeof v === 'string' && v !== '') artifacts[k] = v;
    }
  }
  return {
    task: taskId,
    title: typeof o['title'] === 'string' ? o['title'] : '',
    status,
    artifacts,
    ...(typeof o['updated'] === 'string' ? { updated: o['updated'] } : {}),
  };
}

/** 与 sdlc-task 的 checkConsistency 同语义（只读版本）。 */
function checkConsistency(
  state: TaskState,
  exists: (rel: string) => boolean,
): { missingForStatus: string[]; missingOnDisk: string[] } {
  const required = REQUIRED_ARTIFACTS[state.status];
  const missingForStatus = required.filter((k) => state.artifacts[k] === undefined);
  const missingOnDisk: string[] = [];
  for (const rel of Object.values(state.artifacts)) {
    if (!exists(rel)) missingOnDisk.push(rel);
  }
  return { missingForStatus: [...missingForStatus], missingOnDisk };
}

/** 一个任务的状态分类。 */
export type TaskHealth =
  | 'ok' // 制品齐备且都在磁盘上
  | 'incomplete' // 状态要求某些制品，但没登记或文件不在
  | 'error'; // state.yaml 缺失/无法解析/形状不合法

export interface TaskVerdict {
  status: string;
  at?: string;
  /** 有没有给验收标准、给了几条。 */
  criteria: number;
  /** 逐条裁决的结果统计（有 criteria_results 时才有）。 */
  met: number;
  notMet: number;
  cannotTell: number;
}

/**
 * 停滞判定。
 *
 * ## 为什么"等人"与"停滞"必须分开
 *
 * 两者在时间上看一样（都没动），但含义完全相反：
 *   · `needs_human` 的裁决是验证者**明确说"我判断不了，交给人"**——
 *     任务在等人，这是流程正常运转，不该被标成故障。
 *   · 一个 `IMPLEMENTING` 的任务三天没动，才是真的**停滞**。
 *
 * 混在一起会把真正的问题淹掉：看板上全是"等人"的条目，
 * 那条真正卡住的就看不见了。
 *
 * ## 取数口径与它的边界
 *
 * 用 `state.yaml` 的 `updated`。⚠️ 它是**状态机的时间**，不是"最后一次
 * 有人干活的时间"：手改制品内容不会动它。所以"很新"不代表在推进，
 * 但"很久没动"仍然是有意义的信号——状态机没动，意味着流程没往前走。
 */
export type StalenessClass = 'closed' | 'waiting' | 'stale' | 'active' | 'unknown';

export interface Staleness {
  class: StalenessClass;
  /** 距 `updated` 的毫秒数；拿不到 updated 时为 undefined。 */
  ageMs?: number;
  /** 超过这个小时数就算停滞（closed/waiting 不适用）。 */
  thresholdHours: number;
}

export interface TaskEntry {
  task: string;
  health: TaskHealth;
  /** state.yaml 里的状态；坏掉的条目为 undefined。 */
  status?: TaskStatus;
  title?: string;
  /** 已登记的制品（键 → 相对路径）。 */
  artifacts: Record<string, string>;
  /** 进入当前状态本应有的制品，实际缺失。 */
  missingForStatus: string[];
  /** 已登记但磁盘上找不到的文件。 */
  missingOnDisk: string[];
  /** 当前状态之后，前进到下一状态还缺什么（用来回答"下一步做什么"）。 */
  nextRequired: string[];
  verdict?: TaskVerdict;
  /** state.yaml 里的 updated（ISO 字符串）；坏掉的条目为 undefined。 */
  updated?: string;
  staleness?: Staleness;
  /** health=error 时的原因。 */
  error?: string;
}

export interface ScanInput {
  /** 目录名 → 该任务目录下的文件名集合。 */
  dirs: Array<{ task: string; files: string[] }>;
  /** 读取某个任务目录下某个文件的内容；不存在返回 undefined。 */
  readFile: (task: string, relativePath: string) => string | undefined;
  /** 判"多久没动"的基准时刻；默认现在。传进来是为了可单测。 */
  now?: number;
  /** 超过这个小时数算停滞；默认 24。 */
  staleAfterHours?: number;
}

export interface ScanResult {
  tasks: TaskEntry[];
  /** 统计，给一句话概览用。 */
  counts: {
    total: number;
    ok: number;
    incomplete: number;
    error: number;
    byStatus: Partial<Record<TaskStatus, number>>;
    verdicts: { approve: number; reject: number; needs_human: number; none: number };
    staleness: Record<StalenessClass, number>;
  };
}

export const DEFAULT_STALE_AFTER_HOURS = 24;

/**
 * 判定一个任务的停滞类别。
 *
 * 顺序很重要：先排除终态与"明确在等人"，再看时间。
 */
export function classifyStaleness(input: {
  status?: TaskStatus;
  verdictStatus?: string;
  updated?: string;
  health: TaskHealth;
  now: number;
  staleAfterHours: number;
}): Staleness {
  const { status, verdictStatus, updated, health, now, staleAfterHours } = input;

  if (health === 'error' || updated === undefined) {
    return { class: 'unknown', thresholdHours: staleAfterHours };
  }

  const t = Date.parse(updated);
  if (Number.isNaN(t)) return { class: 'unknown', thresholdHours: staleAfterHours };
  const ageMs = Math.max(0, now - t);

  // 终态：已经完成，不存在"停滞"
  if (status === 'DONE') return { class: 'closed', ageMs, thresholdHours: staleAfterHours };

  // "在等人" = **真的**需要人来做点什么，不动是流程设计如此，不是故障。
  //
  // ⚠️ 这里曾经写成 `verdictStatus === 'needs_human' || status === 'REVIEWING'`，
  // 把**所有** REVIEWING 都算成 waiting。于是在真实仓库里实测到：
  // 一个已经 `approve`、一行命令就能推进到 DONE 的任务被标成「在等人」——
  // 那是**假的求助信号**，会让人以为有事要处理。
  // （见测试场 PLAY-2；当时的输出是「2 个任务，1 个在等人」。）
  //
  // 现在按"下一步该谁动"来分：
  //   needs_human  验证者明确说"我判断不了" → 人
  //   REVIEWING + reject         → 人（要决定接不接受）
  //   REVIEWING + needs_human    → 人
  //   REVIEWING + 无裁决         → 人（还没验证就先评审了，得有人看）
  //   REVIEWING + approve        → **不是等人**：推进是机械动作，往下走 stale/active
  const humanNeeded =
    verdictStatus === 'needs_human' ||
    (status === 'REVIEWING' && verdictStatus !== 'approve');
  if (humanNeeded) return { class: 'waiting', ageMs, thresholdHours: staleAfterHours };

  const stale = ageMs > staleAfterHours * 3600_000;
  return { class: stale ? 'stale' : 'active', ageMs, thresholdHours: staleAfterHours };
}

/** 人类可读的时长（1 天内给小时，超过给天）。 */
export function humanAge(ms: number): string {
  const hours = ms / 3600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} 分钟`;
  if (hours < 48) return `${Math.round(hours)} 小时`;
  return `${Math.round(hours / 24)} 天`;
}

/** 从 `verification.json` 的内容里提取裁决摘要。坏内容返回 undefined。 */
export function summarizeVerdict(raw: string | undefined): TaskVerdict | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const o = parsed as Record<string, unknown>;
  const v = o['verdict'];
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const verdict = v as Record<string, unknown>;
  const status = typeof verdict['status'] === 'string' ? verdict['status'] : undefined;
  if (status === undefined) return undefined;

  const results = Array.isArray(verdict['criteria_results']) ? verdict['criteria_results'] : [];
  const count = (want: string) =>
    results.filter(
      (r) => r !== null && typeof r === 'object' && (r as Record<string, unknown>)['result'] === want,
    ).length;

  const criteriaRaw = o['criteria'];
  return {
    status,
    at: typeof o['at'] === 'string' ? o['at'] : undefined,
    criteria: Array.isArray(criteriaRaw) ? criteriaRaw.length : 0,
    met: count('met'),
    notMet: count('not_met'),
    cannotTell: count('cannot_tell'),
  };
}

/** `selectTasks` 的默认页大小。与工具默认值一致。 */
export const DEFAULT_PAGE_LIMIT = 50;

/**
 * `selectTasks` 允许的最大页大小。
 *
 * 上限必须存在：看板的用处是把状态**压进上下文**，而不是把 10000 条灌进去。
 * 但超限时要说出来（`note`），不能静默夹住。
 */
export const MAX_PAGE_LIMIT = 200;

export interface Selection {
  /** 被选中的任务（保持传入顺序）。 */
  entries: TaskEntry[];
  /** 选项在 `entries` 里的起始下标（0 基）。`taskId` 命中时为该任务的位置。 */
  start: number;
  /** 命中的单个任务在全集里的下标（0 基）；非单任务详情时为 -1。 */
  singleIndex: number;
  /** 是否显示了全部任务（没有因为分页而遗漏）。 */
  complete: boolean;
  /** `limit` 被夹到 `MAX_PAGE_LIMIT` 时的原始请求值；没被夹为 undefined。 */
  clampedFrom?: number;
  /** 还有多少个没显示（`complete` 为 true 时为 0）。 */
  remaining: number;
}

/**
 * 从扫描结果里取一个**窗口**——按 id 取单个，或按 offset/limit 分页。
 *
 * ## 为什么是纯函数
 *
 * 这是本任务的主要新增逻辑，也是本项目最该被直接单测的一层。
 * 既定教训：`enforceCriteriaPolicy` 的"findings 被静默丢掉"就是因为
 * 一直**穿过整个工具调度**被测，藏到最后一轮才暴露；移到纯函数层一次暴露。
 *
 * ## 语义（与 spec 的 R2-R5 一一对应）
 *
 * - `taskId` **优先于** offset/limit（返回 `singleIndex` 供调用方说明位置）
 * - `taskId` 找不到 → **抛错**。"明确要一个东西却没有"与"列表为空"是两件事；
 *   返回空数组会让调用方分不清"任务不存在"与"扫描坏了"
 * - `offset >= 总数` → 空数组 + 明确说"没有更多"，不是沉默的空
 * - `limit > MAX_PAGE_LIMIT` → 夹住，并在 `clampedFrom` 里带上原始请求值
 * - `complete` 是**程序化**的"是否看全了"，调用方不必解析文字
 *
 * ## 为什么不产出给用户看的文案
 *
 * 原来的版本在这里拼 `note`，结果是**空仓库**也会得到一句
 * 「没有更多了：offset=0 已越过总数 0」——没有任务却报"已越过总数"。
 * 而且默认路径（不传任何新参数）本应逐字不变，却多出一行。
 *
 * 所以文案移到工具层，由它按"调用方到底传了什么"决定说什么。
 * 这里只给**结构化事实**。
 *
 * ## 前置条件
 *
 * 参数校验（非整数、负数）由**调用方**做——工具层要在那里返回 `isError`
 * 并指出是哪个参数不对。这里假设 `offset` / `limit` 已是合法值。
 */
export function selectTasks(
  entries: readonly TaskEntry[],
  opts: { taskId?: string; offset?: number; limit?: number; explicit?: boolean } = {},
): Selection {
  const total = entries.length;

  const explicit = opts.explicit ?? false;

  // ── 单任务详情：不受分页影响
  if (opts.taskId !== undefined) {
    const idx = entries.findIndex((e) => e.task === opts.taskId);
    // ⚠️ 位置口径：下面返回的 `singleIndex` 是**分页那根轴**（id 码元序）上的位置，
    // 而不是 `entries` 的呈现序位置。两者在"紧迫序 ≠ id 序"的仓库里不同，
    // 用呈现序位置去换算 `offset` 会取错页——独立验证者指出过这一点
    // （task_id=AA-001 报成"第 4 个"，而 offset=0,limit=1 返回的第一条正是它）。
    // 既然 `offset` 是 id 序的，位置也必须报 id 序的。
    if (idx < 0) {
      throw new Error(
        `找不到任务 ${opts.taskId}（已扫描 ${total} 个任务，第 1-${total} 个）。` +
          '若确认该任务存在，检查 tasks_dir 是否指向了正确的目录。',
      );
    }
    const target = entries[idx] as TaskEntry;
    // 同 id 的唯一性由调用方保证（扫描出的目录名唯一）。若有并列，
    // 按出现顺序稳定排列——与切窗用的比较器同一套规则。
    const idRank = entries.filter((e) => e.task < target.task).length;
    return {
      entries: [target],
      start: idRank,
      singleIndex: idRank,
      complete: true,
      remaining: 0,
    };
  }

  // ── 分页
  const offset = opts.offset ?? 0;
  const requested = opts.limit ?? DEFAULT_PAGE_LIMIT;
  const limit = Math.min(requested, MAX_PAGE_LIMIT);
  const clamped = requested > MAX_PAGE_LIMIT;

  // ── 切窗：两种模式，取决于调用方**有没有显式要求分页**
  //
  // ⚠️ 这里我犯过两次错，都被独立验证者抓住，都记在案：
  //
  // 错 1（原来的缺陷）：直接按传入顺序 `entries.slice(...)` 切。而
  // `scanTasks` 的排序首键是**停滞分组**（error > stale > waiting > 其余），
  // "是否 stale"由 now 与 updated 之差决定。两次翻页之间只要有任务跨过阈值，
  // 它的位置就整体前移 → 同一 offset 返回不同任务、某任务重复、另一个取不到。
  // （验证者用 3 个任务、0.5 秒间隔实测复现。）
  //
  // 错 2（我修错 1 时引入的）：把**整页**改成按 task id 字典序选人。于是
  // 默认调用（不传参数）不再显示最该看的 50 个——60 任务仓库里旧首行是
  // `✗ ZZ-001 — 读不出来`，新首行是 `· AA-001 [SPEC]`，**一个坏任务都不在里面**。
  // 看板存在的理由就是"一眼看到要动手的"，这等于把它拆了。
  // 而且我的冒烟夹具是同质的（id 序恰好等于紧迫序），天然看不见。
  //
  // 现在的做法：
  //   · 没传参数        → 按传入顺序取前 limit 个（= 改动前的行为，R1 逐字兼容）
  //   · 传了参数        → 按 task id 的**码元**序切窗（与时间无关，可反复翻页）
  // 两种模式分工明确：默认调用回答"最该看的是什么"，显式分页回答"把所有都看一遍"。
  //
  // 用码元比较而不是 localeCompare：localeCompare 不是全序——两个不同 id
  // 在 ICU 下可能比较为 0（零宽空格 U+200B、软连字符 U+00AD 等会被忽略），
  // 那时稳定排序退回传入顺序，缺陷原样回来。验证者用 `K-1` 与 `K-\u200B1`
  // 在纯函数层与真实工具端到端都复现了。码元比较保证任意两个不同 id 都不并列。
  const window = explicit
    ? entries
        .map((e, i) => ({ e, i }))
        .sort((a, b) => (a.e.task < b.e.task ? -1 : a.e.task > b.e.task ? 1 : a.i - b.i))
        .slice(offset, offset + limit)
        .sort((a, b) => a.i - b.i) // 页内恢复呈现顺序（保留"哪些该先看"）
        .map((x) => x.e)
    : entries.slice(offset, offset + limit);
  const end = offset + window.length; // 已显示到第几个（从 1 计）
  const remaining = Math.max(0, total - end);
  const complete = remaining === 0;

  return {
    entries: window,
    start: offset,
    singleIndex: -1,
    complete,
    ...(clamped ? { clampedFrom: requested } : {}),
    remaining,
  };
}

/**
 * 扫描全部任务。
 *
 * 每个任务独立判定，**任何单个任务的失败都不影响其它任务**——
 * 看板在出问题的时候最需要能看到东西。
 */
export function scanTasks(input: ScanInput): ScanResult {
  const entries: TaskEntry[] = [];
  const now = input.now ?? Date.now();
  const staleAfterHours = input.staleAfterHours ?? DEFAULT_STALE_AFTER_HOURS;

  for (const { task, files } of input.dirs) {
    const has = (name: string) => files.includes(name);
    const relOf = (kind: string) => KNOWN_ARTIFACTS[kind] ?? `${kind}.md`;

    // state.yaml 缺失 → 这个目录不是任务（或任务被建坏了）
    if (!has('state.yaml')) {
      // 只有真的存在别的文件时才算"坏掉的任务"；空目录直接跳过。
      if (files.length === 0) continue;
      entries.push({
        task,
        health: 'error',
        artifacts: {},
        missingForStatus: [],
        missingOnDisk: [],
        nextRequired: [],
        staleness: { class: 'unknown', thresholdHours: staleAfterHours },
        error: '目录里没有 state.yaml（不是一个任务，或任务被建坏了）',
      });
      continue;
    }

    const stateText = input.readFile(task, 'state.yaml');
    if (stateText === undefined) {
      entries.push({
        task,
        health: 'error',
        artifacts: {},
        missingForStatus: [],
        missingOnDisk: [],
        nextRequired: [],
        staleness: { class: 'unknown', thresholdHours: staleAfterHours },
        error: 'state.yaml 读不到内容',
      });
      continue;
    }

    let state: TaskState;
    try {
      // JSON_SCHEMA：默认 schema 会把 ISO 时间戳解析成 Date（实测踩过）
      state = parseTaskStateLoose(task, parseYaml(stateText, { schema: JSON_SCHEMA }));
    } catch (e) {
      entries.push({
        task,
        health: 'error',
        artifacts: {},
        missingForStatus: [],
        missingOnDisk: [],
        nextRequired: [],
        staleness: { class: 'unknown', thresholdHours: staleAfterHours },
        error: `state.yaml 无法解析：${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    // 存在性用目录列表判定，不额外做 IO——这样扫描是纯粹的。
    const report = checkConsistency(state, (rel) => {
      // 递归路径（如 sub/spec.md）用最后一段判断是否出现在列表里不够准，
      // 所以对于含 / 的路径，退化为"问一次 readFile 是否存在"。
      if (rel.includes('/')) return input.readFile(task, rel) !== undefined;
      return has(rel);
    });

    const idx = STATUSES.indexOf(state.status);
    const nextStatus = idx >= 0 && idx + 1 < STATUSES.length ? STATUSES[idx + 1] : undefined;
    const nextRequired =
      nextStatus === undefined
        ? []
        : REQUIRED_ARTIFACTS[nextStatus].filter((k) => state.artifacts[k] === undefined);

    const verdict = summarizeVerdict(
      has('verification.json') ? input.readFile(task, 'verification.json') : undefined,
    );

    const health: TaskHealth =
      report.missingForStatus.length === 0 && report.missingOnDisk.length === 0
        ? 'ok'
        : 'incomplete';

    entries.push({
      task,
      health,
      status: state.status,
      title: state.title,
      artifacts: state.artifacts,
      missingForStatus: report.missingForStatus.map((k) => `${k}(${relOf(k)})`),
      missingOnDisk: report.missingOnDisk,
      nextRequired: nextRequired.map((k) => `${k}(${relOf(k)})`),
      ...(verdict !== undefined ? { verdict } : {}),
      ...(state.updated !== undefined ? { updated: state.updated } : {}),
      staleness: classifyStaleness({
        status: state.status,
        verdictStatus: verdict?.status,
        updated: state.updated,
        health,
        now,
        staleAfterHours,
      }),
    });
  }

  // 展示顺序：**坏掉的排最前**（需要人处理），然后是正常任务按流程位置，
  // 再按任务名。未验证任务（没跑过 sdlc_verify）的 status 仍存在，
  // 所以它正常参与流程排序，不会和"坏掉"混在一起。
  // 排序优先级：**坏掉 > 真正停滞 > 在等人 > 其余（按流程位置）**。
  // 理由：看板要让人一眼看到"需要我动手"的东西。坏掉的和停滞的都在此列；
  // "在等人"的（needs_human 等）不动是流程正常，排在它们后面。
  const group = (e: TaskEntry): number => {
    if (e.health === 'error') return 0;
    if (e.staleness?.class === 'stale') return 1;
    if (e.staleness?.class === 'waiting') return 2;
    return 3;
  };
  const rank = (e: TaskEntry): number =>
    e.status === undefined ? STATUSES.length : STATUSES.indexOf(e.status);
  entries.sort((a, b) => {
    const g = group(a) - group(b);
    if (g !== 0) return g;
    // 同组内：停滞的按"越久越前"，其余按流程位置
    if (a.staleness?.class === 'stale' && b.staleness?.class === 'stale') {
      const d = (b.staleness.ageMs ?? 0) - (a.staleness.ageMs ?? 0);
      if (d !== 0) return d;
    }
    const d = rank(a) - rank(b);
    return d !== 0 ? d : a.task.localeCompare(b.task);
  });

  const byStatus: Partial<Record<TaskStatus, number>> = {};
  const verdicts = { approve: 0, reject: 0, needs_human: 0, none: 0 };
  const staleness: Record<StalenessClass, number> = {
    closed: 0,
    waiting: 0,
    stale: 0,
    active: 0,
    unknown: 0,
  };
  for (const e of entries) {
    if (e.staleness !== undefined) staleness[e.staleness.class] += 1;
    if (e.status !== undefined && isStatus(e.status)) {
      byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    }
    const vs = e.verdict?.status;
    if (vs === 'approve') verdicts.approve += 1;
    else if (vs === 'reject') verdicts.reject += 1;
    else if (vs === 'needs_human') verdicts.needs_human += 1;
    else verdicts.none += 1;
  }

  return {
    tasks: entries,
    counts: {
      total: entries.length,
      ok: entries.filter((e) => e.health === 'ok').length,
      incomplete: entries.filter((e) => e.health === 'incomplete').length,
      error: entries.filter((e) => e.health === 'error').length,
      byStatus,
      verdicts,
      staleness,
    },
  };
}

/** 一行一句话概览，用于渲染。 */
export function summarize(result: ScanResult): string {
  const c = result.counts;
  if (c.total === 0) return '没有任务。';
  const parts = [`${c.total} 个任务`];
  // 停滞与坏掉放最前：这两个是"需要人动手"的信号
  if (c.staleness.stale > 0) parts.push(`**${c.staleness.stale} 个停滞**`);
  if (c.error > 0) parts.push(`**${c.error} 个读不出来**`);
  if (c.incomplete > 0) parts.push(`${c.incomplete} 个制品不全`);
  if (c.staleness.waiting > 0) parts.push(`${c.staleness.waiting} 个在等人`);
  const v = c.verdicts;
  const vparts: string[] = [];
  if (v.approve > 0) vparts.push(`approve ${v.approve}`);
  if (v.reject > 0) vparts.push(`reject ${v.reject}`);
  if (v.needs_human > 0) vparts.push(`needs_human ${v.needs_human}`);
  if (v.none > 0) vparts.push(`未验证 ${v.none}`);
  return `${parts.join('，')}（裁决：${vparts.join(' / ') || '无'}）`;
}
