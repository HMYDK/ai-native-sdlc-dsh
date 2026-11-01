#!/usr/bin/env node
/**
 * 基准用例 STATUS-PAGE-1：sdlc_status 的**默认页语义**。
 *
 * 两侧对照：
 *   基线 80d8edc   默认页也按 task id 排序切窗 → 卡住的任务被挤出默认页
 *   当前 HEAD      两种模式分开：默认按呈现序、显式分页按码元序
 *
 * ## 判据的来源（不是这里编的）
 *
 * 从**当时的制品**搬来：intent 写着「不改变默认行为」，spec R1 是
 * 「向后兼容（逐字）」。而 80d8edc 的实现把默认路径也改成按 id 排序切窗——
 * **它自己违反了 R1**。CI 与仓库自带测试都看不见，因为夹具是**同质**的
 * （id 序恰好等于紧迫序）。
 *
 * ## 判据
 *
 *   C1  默认页第一条是紧迫任务（坏/停滞/在等人）
 *   C2  默认页含全部紧迫任务
 *   C3  默认路径 == 呈现序取前 50      ← 也抓得住基线（见下面的注释）
 *   C4  同一 offset 跨时间给同一批（部分任务跨过停滞阈值 → 呈现序重排）
 *   C5  码元序区分 localeCompare 判等的 id
 *
 * ⚠️ 写这个探针时我三次写出恒真断言，都记在对应注释里——那正是基准要防的东西。
 */
import { compileFiles, compileMerged, loadMerged, loadModule, mergedAt, runCase } from './lib.mjs';

const BASELINE_REV = '80d8edc';
const CURRENT_REV = 'HEAD';
const BASELINE_LABEL = `基线 ${BASELINE_REV}（默认页也按 id 序切窗）`;
const CURRENT_LABEL = '当前 HEAD';

/**
 * ⚠️ 两个版本的**源码布局不同**：基线 80d8edc 在七个独立包时代
 * （`packages/sdlc-status/src/scan.ts`），修复版 HEAD 在合并后的单包时代
 * （`packages/sdlc/src/status/scan.ts`，且 `scan.ts` 现在 import `../task/state.js`）。
 * 所以按 revision 判形：合并布局走整包编译 + ESM 加载，旧布局保持原路径。
 * **基线一侧的旧路径必须保留**——历史提交里的路径是真实存在的。
 */
const compile = async (rev, work) => {
  if (mergedAt(rev)) {
    const lib = compileMerged(rev, work);
    return loadMerged(lib, 'status', 'scan.js');
  }
  return loadModule(compileFiles(rev, 'packages/sdlc-status/src', ['scan.ts'], work));
};

function probe(scan, { now, later }) {
  const HOUR = 3600_000;
  const dirs = [];
  const files = new Map();
  // ⚠️ state.yaml 必须写成**真的 YAML 文本**，不能靠 JSON.stringify 拼。
  //    实测：用对象字段拼出来的内容 status 解析不出来，于是所有任务都被当成
  //    「健康」，紧迫任务不再排在前面 —— 这条夹具缺陷会让判据静默失效。
  const state = (id, { status = 'SPEC', updated, artifacts = { intent: 'intent.md', spec: 'spec.md', plan: 'plan.md' } }) =>
    [
      `task: "${id}"`,
      `title: "任务 ${id}"`,
      `status: ${status}`,
      `created: "2026-09-01T00:00:00.000Z"`,
      `updated: "${updated}"`,
      'artifacts:',
      ...Object.entries(artifacts).map(([k, v]) => `  ${k}: "${v}"`),
      'history: []',
      '',
    ].join('\n');
  const mk = (id, content, extra = {}) => {
    dirs.push({ task: id, files: ['state.yaml', ...Object.keys(extra)] });
    files.set(id, { 'state.yaml': content, ...extra });
  };
  const iso = (ageH) => new Date(now - ageH * HOUR).toISOString();

  // 57 个健康任务，**故意分成两半**，让"跨时间稳定性"能真的观察到重排：
  //   AA-000..AA-029  now-1h     （远期没有动作）
  //   AA-030..AA-056  now-23.5h  （贴着阈值，now 之后 1 小时跨过去）
  // 跨越阈值的是 id 较大的那一半，跨过去后插到已停滞任务的前面 → 呈现序确实改变。
  for (let i = 0; i < 57; i++) {
    const id = `AA-${String(i).padStart(3, '0')}`;
    mk(id, state(id, { updated: iso(i < 30 ? 1 : 23.5) }));
  }
  // 紧迫任务，id 故意排在字母表**后面**（关键：同质夹具看不见这个缺陷）
  mk('ZZ-001', state('ZZ-001', { status: 'BOGUS', updated: iso(24 * 30) }));
  mk('ZZ-002', state('ZZ-002', { status: 'IMPLEMENTING', updated: iso(5 * 24), artifacts: { intent: 'intent.md' } }));
  mk('ZZ-003', state('ZZ-003', { status: 'REVIEWING', updated: iso(3 * 24), artifacts: { intent: 'intent.md', verification: 'verification.json' } }),
    { 'verification.json': JSON.stringify({ verdict: { status: 'needs_human' } }) });

  const readFile = (task, rel) => {
    const f = files.get(task);
    if (!f || !(rel in f)) return undefined;
    const v = f[rel];
    if (typeof v === 'string') return v;
    return Object.entries(v).map(([k, val]) =>
      typeof val === 'object' && val !== null
        ? `${k}:\n` + Object.entries(val).map(([k2, v2]) => `  ${k2}: ${JSON.stringify(v2)}`).join('\n')
        : `${k}: ${JSON.stringify(val)}`).join('\n') + '\n';
  };

  const URGENT = new Set(['ZZ-001', 'ZZ-002', 'ZZ-003']);
  const scanAt = (t) => scan.scanTasks({ dirs, readFile, now: t, staleAfterHours: 24 });
  const base = scanAt(now);
  const out = [];
  const total = base.tasks.length;

  const def = scan.selectTasks(base.tasks);
  const got = def.entries.map((e) => e.task);
  const urgentSeen = got.filter((id) => URGENT.has(id)).length;

  out.push(['夹具越过默认页上限', total > 50, `共 ${total} 个任务`]);
  out.push(['默认页第一条是紧迫任务', got.length > 0 && URGENT.has(got[0]), `第一条=${got[0]}`]);
  out.push([`默认页含全部紧迫任务`, urgentSeen === URGENT.size, `${urgentSeen}/${URGENT.size}`]);
  // R1 的实质：默认路径 = 「改动前实现」会取的那一批（scanTasks 的呈现序前 50）。
  // ⚠️ 我一开始以为这条是**守恒断言**（基线版自己就按 id 序切，两边该一致）——**错了**。
  //    基线版返回的是「id 序切窗之后、按呈现序排回来」的那一批：30 个 AA-* 和
  //    3 个 ZZ-* 里，紧迫任务 id 更大，于是被挤出 id 序的前 50 → 真的违反。
  //    所以这条**也是**一条能抓住基线的证伪断言。
  const naive = base.tasks.slice(0, 50).map((e) => e.task);
  out.push(['默认路径 == 呈现序取前 50', JSON.stringify(naive) === JSON.stringify(got), `${got.length} 条`]);

  // 分页不重不漏：同一 offset 跨时间给同一批（部分任务跨过阈值 → 呈现序重排）
  const exIds = scan.selectTasks(base.tasks, { offset: 0, limit: 5, explicit: true }).entries.map((e) => e.task);
  const lat = scanAt(later);
  const reordered = lat.tasks.map((e) => e.task).join() !== base.tasks.map((e) => e.task).join();
  const latIds = scan.selectTasks(lat.tasks, { offset: 0, limit: 5, explicit: true }).entries.map((e) => e.task);
  out.push([
    '同一 offset 跨时间给同一批',
    reordered && JSON.stringify(exIds) === JSON.stringify(latIds),
    `呈现序${reordered ? '已' : '未'}重排 ${latIds.join(',')}`,
  ]);

  // 码元序：localeCompare 判等的两个 id 必须仍被区分
  const a = 'K-1', b = 'K-\u200B1';
  const pair = [
    { task: a, health: 'ok', status: 'SPEC', staleness: { class: 'active' } },
    { task: b, health: 'ok', status: 'SPEC', staleness: { class: 'active' } },
  ];
  const w1 = scan.selectTasks(pair, { offset: 0, limit: 1, explicit: true }).entries[0]?.task;
  const w2 = scan.selectTasks([...pair].reverse(), { offset: 0, limit: 1, explicit: true }).entries[0]?.task;
  out.push([
    '码元序区分 localeCompare 判等的 id',
    a.localeCompare(b) === 0 && w1 === a && w2 === a,
    `判等=${a.localeCompare(b) === 0} 序1→${w1} 序2→${w2}`,
  ]);

  return out;
}

export async function main({ json } = {}) {
  const now = Date.parse('2026-10-08T12:00:00.000Z');
  const later = now + 60 * 60_000;
  return runCase({
    id: 'STATUS-PAGE-1',
    title: 'sdlc_status 的默认页不再显示"该动手的"任务',
    baselineRev: BASELINE_REV,
    fixedRev: CURRENT_REV,
    baselineLabel: BASELINE_LABEL,
    fixedLabel: CURRENT_LABEL,
    compile,
    judge: (scan) => probe(scan, { now, later }),
    json,
  });
}

const isMain = process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (isMain) {
  const r = await main({ json: process.argv.includes('--json') });
  process.exit(r.ok ? 0 : 1);
}
