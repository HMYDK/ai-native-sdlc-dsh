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
  /** health=error 时的原因。 */
  error?: string;
}

export interface ScanInput {
  /** 目录名 → 该任务目录下的文件名集合。 */
  dirs: Array<{ task: string; files: string[] }>;
  /** 读取某个任务目录下某个文件的内容；不存在返回 undefined。 */
  readFile: (task: string, relativePath: string) => string | undefined;
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
  };
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

/**
 * 扫描全部任务。
 *
 * 每个任务独立判定，**任何单个任务的失败都不影响其它任务**——
 * 看板在出问题的时候最需要能看到东西。
 */
export function scanTasks(input: ScanInput): ScanResult {
  const entries: TaskEntry[] = [];

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

    entries.push({
      task,
      health:
        report.missingForStatus.length === 0 && report.missingOnDisk.length === 0
          ? 'ok'
          : 'incomplete',
      status: state.status,
      title: state.title,
      artifacts: state.artifacts,
      missingForStatus: report.missingForStatus.map((k) => `${k}(${relOf(k)})`),
      missingOnDisk: report.missingOnDisk,
      nextRequired: nextRequired.map((k) => `${k}(${relOf(k)})`),
      ...(verdict !== undefined ? { verdict } : {}),
    });
  }

  // 展示顺序：**坏掉的排最前**（需要人处理），然后是正常任务按流程位置，
  // 再按任务名。未验证任务（没跑过 sdlc_verify）的 status 仍存在，
  // 所以它正常参与流程排序，不会和"坏掉"混在一起。
  const rank = (e: TaskEntry): number => {
    if (e.health === 'error') return -1;
    return e.status === undefined ? STATUSES.length : STATUSES.indexOf(e.status);
  };
  entries.sort((a, b) => {
    const d = rank(a) - rank(b);
    return d !== 0 ? d : a.task.localeCompare(b.task);
  });

  const byStatus: Partial<Record<TaskStatus, number>> = {};
  const verdicts = { approve: 0, reject: 0, needs_human: 0, none: 0 };
  for (const e of entries) {
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
    },
  };
}

/** 一行一句话概览，用于渲染。 */
export function summarize(result: ScanResult): string {
  const c = result.counts;
  if (c.total === 0) return '没有任务。';
  const parts = [`${c.total} 个任务`];
  if (c.incomplete > 0) parts.push(`${c.incomplete} 个制品不全`);
  if (c.error > 0) parts.push(`**${c.error} 个读不出来**`);
  const v = c.verdicts;
  const vparts: string[] = [];
  if (v.approve > 0) vparts.push(`approve ${v.approve}`);
  if (v.reject > 0) vparts.push(`reject ${v.reject}`);
  if (v.needs_human > 0) vparts.push(`needs_human ${v.needs_human}`);
  if (v.none > 0) vparts.push(`未验证 ${v.none}`);
  return `${parts.join('，')}（裁决：${vparts.join(' / ') || '无'}）`;
}
