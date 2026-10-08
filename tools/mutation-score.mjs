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

    // ⚠️ 必须逐字符扫，判断每个位置**是否在字符串/注释里**。
    //
    // 原来我只做"紧邻引号"的粗筛，于是 tsc 把多行模板字符串合并成一行之后，
    // 字符串**内部**的比较符被当成了代码——工具报告里出现了
    // `src:354 [const-true] '要用 overwrite: true 明确覆盖…'` 这种
    // "改注释/改字符串"的假存活点。**那是最典型的等价变异**，会直接把
    // 存活数抬高、把结论带偏（我第一版结论就被它带偏了）。
    const mask = stringAndCommentMask(line);
    let idx = line.indexOf(op.from);
    while (idx >= 0) {
      const clean = !mask.slice(idx, idx + op.from.length).includes(true);
      if (clean) {
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


/**
 * 由编译产物的行号推回**源码**行号。
 *
 * tsc 会重排行与合并类型声明，所以这不是精确映射。做法是：把该行的
 * **代码文本**（去掉缩进与尾随空白）拿到 `src/` 同名文件里去找第一处匹配。
 * 找不到就返回 undefined —— 报告里如实标"未定位"，不猜。
 */
function srcLineOf(libFile, libLine) {
  const srcFile = path.join(
    path.dirname(path.dirname(libFile)),
    'src',
    path.basename(libFile).replace(/\.js$/, '.ts'),
  );
  if (!fs.existsSync(srcFile)) return undefined;
  const needle = fs.readFileSync(libFile, 'utf8').split('\n')[libLine - 1]?.trim();
  if (needle === undefined || needle === '') return undefined;
  const lines = fs.readFileSync(srcFile, 'utf8').split('\n');
  const hit = lines.findIndex((l) => l.trim() === needle);
  if (hit >= 0) return hit + 1;
  // 退化匹配：去空格后包含关系（tsc 可能合并了空格）
  const flat = (t) => t.replace(/\s+/g, '');
  const want = flat(needle);
  const loose = lines.findIndex((l) => l.trim() !== '' && flat(l).includes(want));
  return loose >= 0 ? loose + 1 : undefined;
}



/**
 * 给一行 JS 做"位置 → 是否在字符串或注释里"的掩码。
 *
 * 这是变异测试里最容易被忽略、但影响最大的一个细节：**改注释、改字符串
 * 是最典型的等价变异**——行为完全不变，却会被记为"存活"。而存活数直接
 * 决定结论，所以这些假信号必须在一开始就挡掉。
 *
 * （我第一版只做"紧邻引号"的粗筛，工具报告里因此出现了
 *   `src:354 [const-true] '要用 overwrite: true 明确覆盖…'` 这种
 *   改字符串的假存活点，把结论带偏了。）
 *
 * 处理：单引号、双引号、反引号、`//` 行注释。`${}` 内插按代码处理。
 */
function stringAndCommentMask(line) {
  const mask = new Array(line.length).fill(false);
  let i = 0;
  let quote = null;
  while (i < line.length) {
    const c = line[i];
    if (quote === null) {
      if (c === Q_SLASH && line[i + 1] === Q_SLASH) {
        for (let j = i; j < line.length; j += 1) mask[j] = true;
        break;
      }
      if (c === Q_SQ || c === Q_DQ || c === Q_BT) {
        quote = c;
        mask[i] = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (c === Q_BS) {
      mask[i] = true;
      if (i + 1 < line.length) mask[i + 1] = true;
      i += 2;
      continue;
    }
    mask[i] = true;
    if (c === quote) quote = null;
    // 模板字符串里的 ${...} 是**代码**，不是字符串内容。
    // 不处理它会把 `\`${o.ok === true ? 'A' : 'B'}\`` 里的 `===` 也掩掉，
    // 而那是真代码——正好是 sdlc-artifact 里有一批的形态。
    if (quote === Q_BT && c === Q_DOLLAR && line[i + 1] === Q_LB) {
      mask[i] = false;
      mask[i + 1] = false;
      i += 2;
      let depth = 1;
      while (i < line.length && depth > 0) {
        if (line[i] === Q_LB) depth += 1;
        else if (line[i] === Q_RB) depth -= 1;
        if (depth > 0) mask[i] = false;
        i += 1;
      }
      if (i < line.length) mask[i] = false; // 收尾的 }
      i += 1;
      continue;
    }
    i += 1;
  }
  return mask;
}

const Q_SQ = String.fromCharCode(39);
const Q_DQ = String.fromCharCode(34);
const Q_BT = String.fromCharCode(96);
const Q_SLASH = String.fromCharCode(47);
const Q_BS = String.fromCharCode(92);
const Q_DOLLAR = String.fromCharCode(36);
const Q_LB = String.fromCharCode(123);
const Q_RB = String.fromCharCode(125);

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


/** 规范化一行，用作清单的键：去缩进、压空白、去掉尾随注释。 */
function normalizeForList(line) {
  return line
    .replace(/\/\/.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 读/写"已评审的存活变异"清单。
 *
 * ## 为什么用清单而不是得分阈值
 *
 * 得分会随**代码**浮动（加一个分支就多几个变异点），所以阈值会变成噪声门：
 * 要么经常误报，要么被调松到失去意义。
 *
 * 清单逼的是另一件事：**每一个存活变异都必须写明它为什么可接受**。
 * 于是"测试看不见的地方"从一堆数字变成一份**要维护的、有理由的清单**——
 * 新出现的存活变异就是门禁失败，得当场解释（修掉、或写明等价/不可达）。
 */
const ALLOWLIST = path.join(ROOT, 'tools', 'mutation-survivors.json');

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST)) return { entries: [] };
  return JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8'));
}

function keyOf(entry) {
  return [entry.pkg, entry.op, entry.file, entry.site].join(' | ');
}

// ─────────────────────────────────────────────── 主流程

const argv = process.argv.slice(2);
const flag = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const listOnly = argv.includes('--list');
const gate = argv.includes('--gate');
const updateList = argv.includes('--update-allowlist');
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
      // 记下**源代码行**：编译产物（lib）的行号没法直接读，报告要能长期对比
      // 就必须给出 src 里的位置，否则下一轮没人看得懂存活点在哪。
      survivors.push({
        pkg,
        file: path.relative(ROOT, s.file),
        line: s.line,
        src: srcLineOf(s.file, s.line),
        // 行号会随无关编辑漂移，所以清单的键用**原始行的规范化文本**。
        // 这样"这处存活我评审过了"在行号移动后依然成立，而真正的新存活
        // （代码变了）会失配 → 门禁报出来。
        site: normalizeForList(s.original),
        op: s.op,
      });
      const srcLoc = survivors[survivors.length - 1].src;
      console.log(
        `  ⚠ 存活  ${s.op.id.padEnd(12)} ${path.relative(ROOT, s.file)}:${s.line}` +
          (srcLoc !== undefined ? ` (src:${srcLoc})` : ' (src:未定位)') +
          `  ${s.op.what}`,
      );
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

// ─────────────────────────────────────────────── 门禁 / 清单维护

if (updateList && !listOnly) {
  const entries = survivors
    .map((x) => ({
      pkg: x.pkg,
      op: x.op.id,
      file: x.file,
      line: x.line,
      site: x.site,
      src: x.src ?? null,
      reason: 'unclassified',
      note: '',
    }))
    .sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  const existing = loadAllowlist();
  // 保留已经写好的分类（按 key 对齐），新增的标 unclassified
  const byKey = new Map((existing.entries ?? []).map((e) => [keyOf(e), e]));
  const merged = entries.map((e) => {
    const old = byKey.get(keyOf(e));
    return old ? { ...e, reason: old.reason, note: old.note } : e;
  });
  fs.writeFileSync(
    ALLOWLIST,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), entries: merged }, null, 2)}\n`,
  );
  const unclassified = merged.filter((e) => e.reason === 'unclassified').length;
  console.log(`\n  清单已写入 ${path.relative(ROOT, ALLOWLIST)}（${merged.length} 条，其中 ${unclassified} 条未分类）`);
  console.log('  ⚠️ 未分类的条目必须逐条写明 reason，否则这份清单没有意义。');
}

if (gate) {
  const allow = loadAllowlist();
  // ⚠️ 清单不全时**只报告不阻断**。
  // 原因：清单里 66 条是"待核实"——拿一份没核实完的清单去卡人，
  // 结果一定是"把新存活直接加进清单了事"，那清单就变成了纸面。
  // 等分类补齐后再切成阻断。（这是这个项目一贯的做法：先诚实，再变严。）
  const reportOnly = typeof allow.status === 'string' && allow.status.startsWith('INCOMPLETE');
  if ((allow.entries ?? []).length === 0 && survivors.length > 0) {
    console.error(
      `\n🔴 门禁失败：有 ${survivors.length} 个存活变异，但没有清单。\n` +
        '  先跑 `node tools/mutation-score.mjs --update-allowlist`，然后**逐条**写明 reason。',
    );
    process.exitCode = 1;
  } else {
    const known = new Set((allow.entries ?? []).map(keyOf));
    const unlisted = survivors.filter((x) =>
      !known.has([x.pkg, x.op.id, x.file, x.site].join(' | ')),
    );
    const stillListed = survivors.length;
    console.log(`\n  门禁：${stillListed} 个存活，${unlisted.length} 个**不在清单里**`);
    if (unlisted.length > 0) {
      console.error('\n🔴 门禁失败：以下存活变异是新的 —— 要么修掉，要么写进清单并说明理由：');
      for (const u of unlisted) {
        console.error(`    ${u.pkg}  ${u.op.id}  ${u.file}:${u.line}`);
        console.error(`      ${u.site}`);
      }
      console.error(
        '\n  没有第三种选择：**不允许直接把新存活加进清单了事**。\n' +
          '  可以接受的理由只有三类：① 等价变异（改了行为不变，需给出实证）\n' +
          '  ② 不可达（被 schema/类型保证挡住，需指出保证来自哪里）\n' +
          '  ③ 已知待补（写清补它的条件）',
      );
      if (reportOnly) {
        console.error('\n  ⚠️ 清单标记为 INCOMPLETE，本次**只报告不阻断**（不判失败）。');
      } else {
        process.exitCode = 1;
      }
    } else {
      console.log('  ✓ 门禁通过：没有未登记的存活变异');
    }
  }
}

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
