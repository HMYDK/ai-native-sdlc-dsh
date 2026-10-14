#!/usr/bin/env node
/**
 * 基准：`sdlc-status` 默认页语义（STATUS-PAGE 那两次 reject 的核心）
 *
 * ## 为什么有这个东西
 *
 * 这套 SDLC 是照着真实任务逐步优化出来的，但**优化之后效果如何验证**一直缺一环。
 * 缺的不是更多单测，而是「**同一条判据，在新旧两版代码上给出不同答案**」这种东西。
 * 缺了它，为修复写的断言会向修复方案归一化，变成恒真——本项目实测发生过一次
 * （STATUS-PAGE 第三轮，验证者发现新加的冒烟夹具只有 10 个任务，
 * 而被 reject 的实现在同一个夹具上同样全绿）。
 *
 * 所以本工具做的是**两侧对照**：
 *
 *     基线版（有缺陷）  应当违反判据
 *     当前版（已修复）  应当满足判据
 *
 * 只有单侧的用例是恒真断言，不算基准。
 *
 * ## 判据的来源
 *
 * 不是这里编的，是从**当时的制品**里搬来的：intent 写着「不改变默认行为」，
 * spec R1 是「向后兼容（逐字）」。而 `60825a2` 的实现把默认路径也改成了
 * 按 task id 排序切窗——**它自己违反了 R1**。CI 与仓库自带测试都看不见，
 * 因为夹具是**同质**的（id 序恰好等于紧迫序）。
 *
 * ## 用法
 *
 *     node tools/bench-status-page.mjs          # 跑全部用例
 *     node tools/bench-status-page.mjs --json   # 机器可读
 *
 * 退出码：0 = 新旧两版行为符合预期；1 = 不符合（基线没被抓住，或当前版也违反了判据）。
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/** 基线 = 第一版分页实现（默认页也按 id 切窗）。当前 = HEAD。 */
const BASELINE_REV = '60825a2';
const BASELINE_LABEL = `基线 ${BASELINE_REV}（默认页也按 id 序切窗）`;
const CURRENT_LABEL = '当前 HEAD';

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
}

/** 取出某个 revision 的 scan.ts 并单独编译（不碰工作区，不需要 git worktree）。 */
function compileRevision(rev, work) {
  const dir = path.join(work, `rev-${rev.replace(/[^\w.-]/g, '_')}`);
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  const src = sh('git', ['-C', REPO, 'show', `${rev}:packages/sdlc-status/src/scan.ts`]);
  writeFileSync(path.join(dir, 'src', 'scan.ts'), src);
  writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
        lib: ['ES2023'], strict: true, skipLibCheck: true,
        outDir: 'out', rootDir: 'src', types: ['node'],
      },
      include: ['src/**/*.ts'],
    }),
  );
  // 编译产物是 ESM 还是 CJS 取决于最近的 package.json。
  // 这里显式声明 CJS，让探针的 require 形态稳定（实测两种都出现过）。
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  // js-yaml 是 scan.ts 唯一的运行期依赖。
  const nm = path.join(REPO, 'node_modules');
  if (existsSync(nm)) cpSync(nm, path.join(work, 'node_modules'), { recursive: true, dereference: false });
  sh(path.join(REPO, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], { cwd: dir });
  return path.join(dir, 'out', 'scan.js');
}

/**
 * 探针。每个断言都返回 [名称, 是否通过, 观测到的值]。
 *
 * ⚠️ 每条都必须**可证伪**：夹具里要同时存在"该被看见的"和"不该被看见的"，
 *    而且规模要越过默认页上限（50）。否则两种实现返回一样，断言恒真。
 */
function runProbe(scan, { now, later }) {
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

function main() {
  const json = process.argv.includes('--json');
  const now = Date.parse('2026-10-08T12:00:00.000Z');
  const later = now + 60 * 60_000;

  const work = mkdtempSync(path.join(tmpdir(), 'sdlc-bench-'));
  let results;
  try {
    const mods = {
      [BASELINE_LABEL]: require(compileRevision(BASELINE_REV, work)),
      [CURRENT_LABEL]: require(compileRevision('HEAD', work)),
    };
    results = Object.entries(mods).map(([label, scan]) => ({ label, checks: runProbe(scan, { now, later }) }));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  if (json) {
    console.log(JSON.stringify({ baselineRev: BASELINE_REV, results }, null, 2));
  } else {
    for (const { label, checks } of results) {
      const pass = checks.filter((c) => c[1]).length;
      console.log(`\n### ${label}  —  ${pass}/${checks.length} 通过`);
      for (const [name, ok, detail] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  :: ${detail}`);
    }
  }

  // 判定：基线必须至少违反一条判据；当前版必须全部满足。
  // 两侧都成立，这组用例才算基准；否则它证明不了任何事。
  const base = results[0], cur = results[1];
  const baseFails = base.checks.filter((c) => !c[1]).length;
  const curFails = cur.checks.filter((c) => !c[1]).length;
  const ok = baseFails > 0 && curFails === 0;
  if (!json) {
    console.log('\n=== 结论 ===');
    console.log(`基线违反 ${baseFails} 条判据，当前版违反 ${curFails} 条。`);
    console.log(ok
      ? '✅ 这是一组有效基准：基线被证伪，当前版满足判据。'
      : curFails > 0
        ? '❌ 当前版也违反了判据 —— 要么回归了，要么判据本身不对。'
        : '❌ 基线没有被任何判据抓住 —— 这些断言是恒真的，证明不了任何事。');
  }
  process.exit(ok ? 0 : 1);
}

main();
