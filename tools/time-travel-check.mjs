#!/usr/bin/env node
/**
 * 时间旅行检查：**测试结果会不会随"今天是几号"改变。**
 *
 * ## 为什么需要它
 *
 * 本项目在这类缺陷上栽过三次，每次都是"写下的当天是对的、之后必然坏"：
 *
 *   · `sdlc-status/smoke.mjs` 夹具的 updated 写死，越过 24h 阈值后
 *     "停滞计数应为 1，实际 4"——已用 `nowForTests` 修掉
 *   · `sdlc-status/src/scan.test.ts` 一条测试不传 `now`，
 *     从 2026-10-10T23:00Z 起自己变红（实测 57/58）
 *   · 两次都是**别人**（独立验证者 / 我自己隔几天再跑）先发现的
 *
 * 共同点：缺陷不在代码里，在**断言与真实时钟的耦合**里。
 * 单测/冒烟全绿不代表它明天还绿。
 *
 * ## 怎么查
 *
 * 把进程内的 `Date.now()` 与 `new Date()`（无参）整体推到**未来若干时点**，
 * 再跑同一套单测。任何"今天通过、未来失败"的断言都会现形。
 *
 * 这是个**假时钟**（不改系统时间、不动文件）。所以它是启发式的：
 * 只覆盖走 `Date.now()` / `new Date()` 的路径。若某处用了
 * `performance.now()` 或外部命令取时间，它看不见——那种情况要人工判断。
 *
 * ## 布局（2026-10-19 合并成单包后）
 *
 * 测试不再平铺在 `packages/*\/lib` 下，而是 `packages/sdlc/lib/<comp>/*.test.js`。
 * 所以这里**递归发现 + 按目录分组**：每组（组件）单独跑一次，报告仍能点名
 * 是哪个组件、哪个时点漂了。对单包递归跑的命令形态就是包自己的
 * `npm test`（`node --test "lib/**\/*.test.js"`），这里再按组拆开以保留可读性。
 *
 * ## 用法
 *
 *     node tools/time-travel-check.mjs                    # 默认 +1/+30/+365/+3650 天（含今天）
 *     node tools/time-travel-check.mjs --days=7,90        # 指定偏移
 *     node tools/time-travel-check.mjs --smoke            # 另外把合并包的冒烟跑一次（见下）
 *
 * ⚠️ **冒烟不参与时间旅行**，这是实测结论，不是没做：冒烟跑在 App 的 Electron
 * 二进制里，而它明确拒绝 `NODE_OPTIONS`：
 *
 *     ERROR:electron/shell/app/node_main.cc:153
 *     Node.js environment variables are disabled because this process is invoked by other apps.
 *
 * 实测确认：`NODE_OPTIONS="--import shim(+3650天)"` 跑冒烟，结果与不传**逐字相同**。
 * 所以"跑两遍冒烟对比"只是跑了两遍**同一时刻**，那不是时间旅行，是一条会骗人的
 * 假断言——本工具早先的版本就有这个毛病，已删掉那些行。
 * 冒烟层的时间依赖改用**静态检查写死日期**（见下）；`--smoke` 只是把冒烟套件
 * **跑一次**作为可用性检查，并明确标注"不是时间旅行"。
 *
 * 退出码 0 = 所有时点结果一致；1 = 有断言随日期改变（会点名是哪个组件、哪个时点）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PKG = path.join(REPO, 'packages', 'sdlc');
const DAY = 86_400_000;

/**
 * 递归收集单包里所有单测，返回**相对 package 根**的路径（`lib/status/scan.test.js`）。
 *
 * 排除 `node_modules`：合并包没有嵌套依赖，但防一手。
 */
function testFiles(dir = path.join(PKG, 'lib'), rel = 'lib') {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      out.push(...testFiles(path.join(dir, e.name), `${rel}/${e.name}`));
    } else if (e.name.endsWith('.test.js')) {
      out.push(`${rel}/${e.name}`);
    }
  }
  return out.sort();
}

/** 按所在目录分组：一个组 = 一个组件（外加 `shared`），各自独立跑。 */
function testGroups() {
  const groups = new Map();
  for (const f of testFiles()) {
    const g = path.dirname(f).replace(/^lib\//, '');
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(f);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** 跑一组单测，返回 {pass, fail} 或 null（该组没有测试）。 */
function runUnitTests(files) {
  if (files.length === 0) return null;
  let out = '';
  try {
    out = execFileSync('node', ['--test', ...files], {
      cwd: PKG,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // 测试失败时 node --test 退出码非 0，输出在 stdout/stderr 上
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const num = (label) => {
    const m = out.match(new RegExp(`^[ℹ#] ${label} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : undefined;
  };
  const pass = num('pass');
  const fail = num('fail');
  if (pass === undefined) return { pass: -1, fail: -1, raw: out.slice(-400) };
  return { pass, fail };
}

const groups = testGroups();
const testCount = groups.reduce((n, [, files]) => n + files.length, 0);
if (testCount === 0) {
  // ⚠️ 没有测试却报告"所有时点一致"是一条恒真断言。宁可失败。
  console.error(`❌ 在 ${path.relative(REPO, PKG)}/lib 下没有找到任何 *.test.js —— 先构建（npm run build --workspace packages/sdlc）。`);
  process.exit(1);
}

const daysArg = process.argv.find((a) => a.startsWith('--days='));
const DAYS = daysArg
  ? daysArg.slice('--days='.length).split(',').map(Number).filter((n) => Number.isFinite(n))
  : [0, 1, 30, 365, 3650];

/**
 * 假时钟的加载器 shim。
 *
 * 在**子进程内**用 `--import` 加载它，把 `Date.now()` 与无参 `new Date()`
 * 整体位移。写成文件而不是 `-e`，是因为要能在 ESM 里替换全局。
 */
function makeShim(offsetMs) {
  const dir = mkdtempSync(path.join(tmpdir(), 'time-travel-'));
  const shim = path.join(dir, 'shim.mjs');
  writeFileSync(
    shim,
    [
      `const OFFSET = ${offsetMs};`,
      'const RealDate = Date;',
      'const RealNow = Date.now;',
      'class FakeDate extends RealDate {',
      '  constructor(...args) {',
      '    if (args.length === 0) super(RealNow.call(RealDate) + OFFSET);',
      '    else super(...args);',
      '  }',
      '  static now() { return RealNow.call(RealDate) + OFFSET; }',
      '}',
      'globalThis.Date = FakeDate;',
      '',
    ].join('\n'),
  );
  return { dir, shim };
}

console.log(
  `时间旅行检查：偏移 ${DAYS.map((d) => `+${d}天`).join(', ')}` +
    `（${path.relative(REPO, PKG)}：${groups.length} 组 / ${testCount} 个测试文件）\n`,
);

/** baseline[label][group] = {pass, fail} */
const results = new Map();
const shims = [];

for (const d of DAYS) {
  const label = d === 0 ? '今天' : `+${d}天`;
  const { dir, shim } = makeShim(d * DAY);
  shims.push(dir);
  const row = {};
  for (const [name, files] of groups) {
    const saved = { ...process.env };
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import ${shim}`.trim();
    try {
      row[name] = runUnitTests(files);
    } finally {
      process.env = saved;
    }
    process.stderr.write(`  ${label} ${name}…\n`);
  }
  results.set(label, row);
}

for (const dir of shims) rmSync(dir, { recursive: true, force: true });

// ── 报告 ──────────────────────────────────────────────────────────
const names = [...results.keys()];
const rows = groups.map(([name]) => name);
const width = Math.max(...rows.map((p) => p.length), 12);

console.log();
console.log(`${'对象'.padEnd(width)}  ${names.map((n) => n.padStart(12)).join('')}`);
let bad = 0;
for (const key of rows) {
  const cells = names.map((n) => {
    const r = results.get(n)[key];
    if (r === undefined) return '—'.padStart(12);
    return r === null ? '（无）'.padStart(12) : `${r.pass}/${r.pass + r.fail}`.padStart(12);
  });
  const today = results.get(names[0])[key];
  const drift = names.some((n) => {
    const r = results.get(n)[key];
    if (r === null || r === undefined || today === null || today === undefined) return false;
    return r.fail !== today.fail;
  });
  if (drift) bad += 1;
  console.log(`${(drift ? '✗ ' : '  ') + key.padEnd(width - 2)}  ${cells.join('')}`);
}

/**
 * 静态检查：夹具文件里有没有写死的 ISO 日期。
 *
 * 这是冒烟层唯一可用的手段（上面说了它为什么不能时间旅行）。
 * 判据很窄，因为写死日期**不一定**是缺陷：
 *
 *   · `updated` / `now` 写死 → 通常有问题："是否停滞"取决于它距今多久
 *   · 纯历史记录（`history[].at`、`created`）→ 通常没关系，不参与时间比较
 *
 * 所以只报警、不判定失败，并提示人去确认那一处属于哪一类。
 */
/**
 * 这个包的产品代码**是否依赖时间**。
 *
 * 用来把静态检查的噪声压下去：一个只做结构检查的包（如 sdlc-artifact）
 * 里写死日期完全无害——那些字段只是数据，没有"距今多久"的比较。
 * 实测：第一版不区分，报了 17 处，**全部是误报**，那种报告没人会看。
 */
function packageUsesTime(pkg) {
  const srcDir = path.join(pkg, 'src');
  if (!existsSync(srcDir)) return false;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (walk(path.join(dir, e.name))) return true;
        continue;
      }
      if (!e.name.endsWith('.ts') || e.name.endsWith('.test.ts')) continue;
      const text = readFileSync(path.join(dir, e.name), 'utf8');
      if (/stale|Date\.now\(\)|staleAfterHours/.test(text)) return true;
    }
    return false;
  };
  return walk(srcDir);
}

function scanHardcodedDates() {
  if (!packageUsesTime(PKG)) return [];
  const hits = [];
  const files = [];
  // 冒烟：合并后都在 `smoke/<comp>.mjs`，入口 run-all 本身没有夹具，排除。
  const smokeDir = path.join(PKG, 'smoke');
  if (existsSync(smokeDir)) {
    for (const f of readdirSync(smokeDir)) {
      if (f.endsWith('.mjs') && f !== 'run-all.mjs') files.push(path.join(smokeDir, f));
    }
  }
  // 单测：递归 `src/**/*.test.ts`
  const walkTests = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walkTests(path.join(dir, e.name));
      else if (e.name.endsWith('.test.ts')) files.push(path.join(dir, e.name));
    }
  };
  walkTests(path.join(PKG, 'src'));
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    text.split('\n').forEach((line, i) => {
      // 形如 updated: "2026-10-07T10:00:00.000Z" 或 at: '2026-…'
      const m = line.match(/^\s*[`'"]?\s*(updated|created|now|at|staleAfterHours)\s*[:=]\s*[`'"]([0-9]{4}-[0-9]{2}-[0-9]{2}T[^`'"]+)/);
      if (m) hits.push({ file: path.relative(REPO, f), line: i + 1, key: m[1], value: m[2] });
    });
  }
  return hits;
}

// ── 冒烟层：静态检查写死的日期（它不能时间旅行）──────────────────
const dates = scanHardcodedDates();
console.log('\n冒烟/单测夹具里的写死日期（静态检查，只覆盖有时间逻辑的包）：');
if (dates.length === 0) {
  console.log('  （无）——所有夹具的时间都是相对当前的');
} else {
  for (const d of dates) {
    const benign = d.key === 'at';
    console.log(`  ${benign ? '·' : '?'} ${d.file}:${d.line}  ${d.key}: ${d.value}` +
      (benign ? '   （历史记录，不参与比较）' : '   ← 它与"现在"的距离会随日期变化'));
  }
  const risky = dates.filter((d) => d.key !== 'at');
  if (risky.length > 0) {
    console.log(`  ${risky.length} 处写死日期。**它们不一定是缺陷**，两种情况：`);
    console.log('    · 测试自己钉了时刻（传 `now:` / 配 `nowForTests`）→ 正常，');
    console.log('      上面"单测时间旅行"那一段会证明它稳定；');
    console.log('    · 靠真实时钟去比 → 就是定时炸弹，改成相对当前或从配置注入。');
    console.log('  怎么分清：看上面表格里该包在不同时点是否一致。一致 = 前者。');
  }
}

// ── 可选：冒烟套件跑一次（**不是**时间旅行）────────────────────────
if (process.argv.includes('--smoke')) {
  const APP = process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app/Contents';
  const APP_BIN = `${APP}/MacOS/DeepSeek Harness`;
  console.log('\n--smoke：把合并包的冒烟套件跑一次（真实时钟；它**不参与**时间旅行，原因见文件头）：');
  const r = spawnSync(APP_BIN, ['--expose-internals', 'smoke/run-all.mjs'], {
    cwd: PKG,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    maxBuffer: 1 << 28,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  console.log(out.trim().split('\n').slice(-6).map((l) => `  ${l}`).join('\n'));
  if (r.status !== 0) {
    console.log('  ❌ 冒烟失败（这与时间旅行无关，是冒烟本身）。');
    bad += 1;
  } else {
    console.log('  ✓ 冒烟通过。再次提醒：这次运行**没有**经过假时钟。');
  }
}

console.log();
if (bad === 0) {
  console.log('✅ 所有时点的结果一致——没有"随日期改变"的断言。');
  console.log('   ⚠️ 假时钟只覆盖 Date.now() / new Date()；用外部命令取时间的路径它看不见。');
  console.log('   ⚠️ 它只证明"今天是几号不影响结果"，不证明断言本身是对的。');
} else {
  console.log(`❌ 有 ${bad} 个对象的结果随日期改变：上面带 ✗ 的行。`);
  console.log('   修法通常是让夹具相对当前时间，或把"现在"从配置/参数注入');
  console.log('   （sdlc-status 的 nowForTests 就是后者，见 dac82db）。');
}
process.exit(bad === 0 ? 0 : 1);
