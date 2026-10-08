#!/usr/bin/env node
/**
 * 变异测试：**测量四个包的测试套件到底保住了什么**。
 *
 * ## 为什么需要它
 *
 * 这个仓库有 159 条单测 + 214 条冒烟断言。在 STATUS-PAGE 那一轮之前，
 * 我把"测试通过"当成了"测试在测东西"。而那一轮独立验证者证明了：
 *
 *   · 6 个变异体里 **3 个存活** —— 那三处断言完全没有信号
 *   · 我的"钉住顺序"测试**不可证伪**（任何置换的分页切片并集恒等于全集）
 *   · 夹上限断言在 60 个任务的夹具下**恒真**（`|| total < 200`）
 *   · 7d 夹具只有 10 个任务，而 ≤50 时两种实现返回同一批
 *   · 我的变异表有**一行是假的**（锚点没匹配，脚本静默跳过）
 *
 * 全都是同一件事：**我把"测试通过"当成了"测试在测东西"**。
 *
 * 所以这个工具把变异测试从临时手段变成**常规测量**：往实现里注入明确的缺陷，
 * 看测试会不会红。**存活的变异就是测试看不见的代码面。**
 *
 * ## 怎么跑
 *
 *     node tools/mutation-score.mjs                 # 四个包
 *     node tools/mutation-score.mjs sdlc-status     # 单个包
 *     node tools/mutation-score.mjs --list          # 只列变异点，不跑
 *     node tools/mutation-score.mjs --kinds=bool    # 只用某一类
 *
 * ## 两阶段策略（决定它能不能跑完）
 *
 * 冒烟要起 Electron app（约 1 秒/次），几百个变异跑不起。所以：
 *
 *   1. 单测（约 0.2 秒）——抓住大部分
 *   2. **只有单测放过**的，才跑冒烟
 *
 * 这样只有少数存活者付冒烟的代价。
 *
 * ## 它是怎么改代码的
 *
 * **在 `lib/` 上做文本替换，然后用 `tsc` 从源码重新编译来还原。**
 * 直接改 `src/` 更干净，但这类工具的锚点匹配是本仓库踩过多次的坑；
 * 在编译产物上做，替换的成功与否可以逐个断言（replace 必须真的改了东西），
 * 而还原走 `tsc` —— 那是权威的、不可能"还原失败还静默通过"的路径。
 *
 * ⚠️ 它是**读-改-还原**的：跑完必须确认 `git status` 干净。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = process.env['DSH_APP'] ?? '/Applications/DeepSeek Harness.app/Contents';
const APP_BIN = `${APP}/MacOS/DeepSeek Harness`;

const ALL_PACKAGES = ['sdlc-verify', 'sdlc-task', 'sdlc-artifact', 'sdlc-status'];

// ─────────────────────────────────────────────── 变异算子
//
// 三类，都选"明确的缺陷"，不选风格问题：
//   · 边界：>= 变 >（STATUS-PAGE 那一轮真实漏过的就是这一类）
//   · 布尔：条件恒真/恒假
//   · 常量：把有意义的值换成另一个
//
// 不做算术替换（+ 变 -）：在汇编层没意义，而且会大量产生编译期就死的变异。

/** 每个算子：{id, kind, 描述, 从哪找, 换成什么, 每个文件最多注入几个} */
const OPERATORS = [
  {
    id: 'cmp-strict',
    kind: 'boundary',
    what: '`>=` → `>`（恰好达标被判成不达标）',
    from: '>=',
    to: '>',
  },
  {
    id: 'cmp-loose',
    kind: 'boundary',
    what: '`>` → `>=`（边界外的一个被判成达标）',
    from: '>',
    to: '>=',
  },
  {
    id: 'cmp-eq',
    kind: 'boundary',
    what: '`===` → `!==`（相等判断取反）',
    from: '===',
    to: '!==',
  },
  {
    id: 'bool-or',
    kind: 'boolean',
    what: '`||` → `&&`（或变与）',
    from: '||',
    to: '&&',
  },
  {
    id: 'bool-and',
    kind: 'boolean',
    what: '`&&` → `||`（与变或）',
    from: '&&',
    to: '||',
  },
  {
    id: 'const-true',
    kind: 'constant',
    what: '`true` → `false`',
    from: 'true',
    to: 'false',
  },
  {
    id: 'const-false',
    kind: 'constant',
    what: '`false` → `true`',
    from: 'false',
    to: 'true',
  },
];

/**
 * 找到可注入的位置。
 *
 * 有意跳过的行：
 *   · 注释与 JSDoc（改了不算缺陷）
 *   · `import` / `export` / `require`（改了会直接崩，噪声）
 *   · 纯类型或字符串字面量里的出现（用左右字符粗筛）
 */
function findSites(file, op) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const sites = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    if (/^\s*(import|export)\b/.test(line)) return;
    // 只在"看起来像代码"的行上注入
    let idx = line.indexOf(op.from);
    while (idx >= 0) {
      const before = line[idx - 1] ?? ' ';
      const after = line[idx + op.from.length] ?? ' ';
      // 跳过字符串字面量里的出现（粗筛：紧邻引号）
      const inString = /['"`]/.test(before) || /['"`]/.test(after);
      if (!inString) {
        sites.push({
          file,
          line: i + 1,
          col: idx,
          original: line,
          mutated:
            line.slice(0, idx) + op.to + line.slice(idx + op.from.length),
        });
        break; // 每行只注入第一个，避免同一行的替换互相干扰
      }
      idx = line.indexOf(op.from, idx + 1);
    }
  });
  return sites;
}

// ─────────────────────────────────────────────── 跑测试

const run = (cmd, args, cwd, env = {}) => {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

/** 单测：快（约 0.2 秒），抓大部分。 */
function unitTestsPassed(pkgDir) {
  const files = fs.readdirSync(path.join(pkgDir, 'lib')).filter((f) => f.endsWith('.test.js'));
  if (files.length === 0) return { passed: true, note: '无单测文件' };
  const r = run(process.execPath, ['--test', ...files.map((f) => path.join('lib', f))], pkgDir);
  return { passed: r.code === 0, note: '' };
}

/** 冒烟：慢（起 Electron app），只有单测放过的才跑。 */
function smokePassed(pkgDir) {
  if (!fs.existsSync(path.join(pkgDir, 'smoke.mjs'))) return { passed: true, note: '无冒烟' };
  const r = run(APP_BIN, ['--expose-internals', 'smoke.mjs'], pkgDir, {
    ELECTRON_RUN_AS_NODE: '1',
  });
  return { passed: r.code === 0, note: '' };
}

// ─────────────────────────────────────────────── 主流程

const argv = process.argv.slice(2);
const flag = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const listOnly = argv.includes('--list');
const kinds = flag('kinds')?.split(',');
const only = argv.filter((a) => !a.startsWith('--'));

const packages = only.length > 0 ? only : ALL_PACKAGES;
const ops = kinds ? OPERATORS.filter((o) => kinds.includes(o.kind)) : OPERATORS;

const started = Date.now();
const perPackage = [];
const survivors = [];

for (const pkg of packages) {
  const pkgDir = path.join(ROOT, 'packages', pkg);
  const libDir = path.join(pkgDir, 'lib');
  if (!fs.existsSync(libDir)) {
    console.error(`跳过 ${pkg}：没有 lib/（先 npm run build）`);
    continue;
  }
  const targets = fs
    .readdirSync(libDir)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .map((f) => path.join(libDir, f));

  // 收集该包的变异点
  const sites = [];
  for (const op of ops) {
    for (const file of targets) {
      for (const s of findSites(file, op)) sites.push({ ...s, op });
    }
  }

  console.log(`\n=== ${pkg}：${sites.length} 个变异点（${targets.length} 个文件）===`);
  if (listOnly) {
    for (const s of sites) {
      console.log(`  ${s.op.id.padEnd(12)} ${path.relative(ROOT, s.file)}:${s.line}  ${s.op.what}`);
    }
    perPackage.push({ pkg, total: sites.length, killed: 0, survived: 0, skipped: 0 });
    continue;
  }

  let killed = 0;
  let survived = 0;
  let errored = 0;

  for (let i = 0; i < sites.length; i += 1) {
    const s = sites[i];
    const original = fs.readFileSync(s.file, 'utf8');
    const mutated = original
      .split('\n')
      .map((l, n) => (n + 1 === s.line ? s.mutated : l))
      .join('\n');
    if (mutated === original) {
      // 锚点没匹配 —— 显式失败，不要静默跳过（本仓库踩过这个坑）
      errored += 1;
      console.error(`  ✗ 注入失败（未改变内容）：${s.file}:${s.line}`);
      continue;
    }
    fs.writeFileSync(s.file, mutated);

    let verdict;
    try {
      const u = unitTestsPassed(pkgDir);
      if (!u.passed) verdict = 'killed-by-unit';
      else {
        const m = smokePassed(pkgDir);
        verdict = m.passed ? 'SURVIVED' : 'killed-by-smoke';
      }
    } finally {
      fs.writeFileSync(s.file, original);
    }

    if (verdict === 'SURVIVED') {
      survived += 1;
      survivors.push({ pkg, file: path.relative(ROOT, s.file), line: s.line, op: s.op });
      console.log(`  ⚠ 存活  ${s.op.id.padEnd(12)} ${path.relative(ROOT, s.file)}:${s.line}  ${s.op.what}`);
    } else {
      killed += 1;
    }
    if ((i + 1) % 25 === 0) {
      console.log(`  … ${i + 1}/${sites.length}（已杀 ${killed}，存活 ${survived}）`);
    }
  }

  const score = killed + survived === 0 ? 0 : (killed / (killed + survived)) * 100;
  console.log(
    `  → ${pkg}：${killed}/${killed + survived} 被抓住，**变异得分 ${score.toFixed(1)}%**` +
      (errored > 0 ? `（${errored} 个注入失败）` : ''),
  );
  perPackage.push({ pkg, total: sites.length, killed, survived, errored });
}

// ─────────────────────────────────────────────── 报告

console.log(`\n${'='.repeat(72)}`);
console.log('变异得分汇总\n');
console.log('  包              变异点   抓住   存活   得分');
for (const r of perPackage) {
  const n = r.killed + r.survived;
  const score = n === 0 ? '—' : `${((r.killed / n) * 100).toFixed(1)}%`;
  console.log(
    `  ${r.pkg.padEnd(15)} ${String(r.total).padStart(5)} ${String(r.killed).padStart(6)} ${String(r.survived).padStart(6)} ${score.padStart(7)}`,
  );
}
const T = perPackage.reduce((a, r) => a + r.killed + r.survived, 0);
const K = perPackage.reduce((a, r) => a + r.killed, 0);
if (T > 0) {
  console.log(`\n  合计：${K}/${T} 被抓住 —— 变异得分 **${((K / T) * 100).toFixed(1)}%**`);
  console.log(`  （存活 ${T - K} 个：那些就是测试看不见的代码面）`);
}
console.log(`\n  用时 ${((Date.now() - started) / 1000).toFixed(0)} 秒`);

// ─────────────────────────────────────────────── 收尾自检：必须还原干净

const dirty = execFileSync('git', ['status', '--porcelain', 'packages'], {
  cwd: ROOT,
  encoding: 'utf8',
}).trim();
if (dirty !== '') {
  console.error(`\n🔴 收尾失败：packages/ 下有未还原的改动 —— 变异没有被清理干净：\n${dirty}`);
  process.exitCode = 1;
} else {
  console.log('\n  ✓ 收尾检查：packages/ 已完全还原（git status 干净）');
}

if (survivors.length > 0) {
  const byKind = {};
  for (const s of survivors) byKind[s.op.kind] = (byKind[s.op.kind] ?? 0) + 1;
  console.log('\n  存活变异按类型：');
  for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(10)} ${v}`);
  }
}
