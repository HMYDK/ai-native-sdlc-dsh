#!/usr/bin/env node
/**
 * 基准用例共用的机制：**两侧对照**。
 *
 * 每个用例都必须是这个形状，缺任何一侧都不算用例：
 *
 *     基线版（有缺陷）  应当违反判据      ← 没有这一侧，用例是恒真断言
 *     当前/修复版       应当满足判据
 *
 * 只用 `git show` 取源码 + 单独编译，**不建 worktree、不碰工作区**。
 * 这样用例可以随便跑，不会有"忘了清理"的残留。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
const require = createRequire(import.meta.url);

export function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
}

/** 该 revision 里是否存在这个路径（**包结构会随提交变化**，不判会 fatal）。 */
export function existsAt(rev, repoRelPath) {
  try {
    sh('git', ['-C', REPO, 'cat-file', '-e', `${rev}:${repoRelPath}`], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 建一个临时编译区（整个用例跑完由 `runCase` 删掉）。
 *
 * ⚠️ `moduleType` 必须在**编译之前**定下来：tsc 按最近的 `package.json`
 * 的 `type` 决定生成 CJS 还是 ESM 形态。编译完再改 `type` 没用——
 * 产物里已经是 `exports.x = …`，在 ESM 作用域下直接报
 * `ReferenceError: exports is not defined`（实测踩到）。
 */
export function makeWorkdir(prefix, { moduleType = 'commonjs' } = {}) {
  const work = mkdtempSync(path.join(tmpdir(), prefix));
  sh('ln', ['-sfn', path.join(REPO, 'node_modules'), path.join(work, 'node_modules')]);
  writeFileSync(path.join(work, 'package.json'), JSON.stringify({ type: moduleType }));
  writeFileSync(
    path.join(work, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
        lib: ['ES2023'], strict: true, skipLibCheck: true,
        outDir: 'lib', rootDir: 'src', types: ['node'],
      },
      include: ['src/**/*.ts'],
    }),
  );
  return work;
}

/**
 * 取某个 revision 下的若干 `.ts` 文件，编译，返回**加载好的模块**。
 *
 * ⚠️ 编译产物的模块形态取决于最近的 `package.json`：
 * 这里统一声明 `commonjs`（`makeWorkdir` 写的那个），所以用 `require` 加载。
 * 实测两种形态都出现过，别假设。
 */
export function compileFiles(rev, repoRelDir, fileNames, work, { as = 'module', noCheck = false } = {}) {
  const dir = path.join(work, `${rev.replace(/[^\w.-]/g, '_')}-${as}`);
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  let copied = 0;
  for (const f of fileNames) {
    const rel = `${repoRelDir}/${f}`;
    if (!existsAt(rev, rel)) continue;
    writeFileSync(path.join(dir, 'src', f), sh('git', ['-C', REPO, 'show', `${rev}:${rel}`]));
    copied += 1;
  }
  if (copied === 0) throw new Error(`${rev} 在 ${repoRelDir} 下一个文件都没取到`);
  // ⚠️ 每个版本要有**自己的** tsconfig：共享那份的 `include` 是相对它自己的目录，
  // 指不到 `rev-xxx/src`（实测报 TS18003 "No inputs were found"）。
  writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
        lib: ['ES2023'], strict: true, skipLibCheck: true,
        outDir: 'lib', rootDir: 'src', types: ['node'],
        // noCheck 只做**转译**、不做类型检查。仅用于历史 revision 的源码：
        // 它们针对当时的运行时类型（如 0.2.0 的 `subagents.start` /
        // `SubagentStartRequest.toolFilter`）编写，拿现在的 node_modules 类型去
        // 检查必然失败，而那与用例要比较的**运行时行为**无关（实测 PWSH-1
        // 的 tsc 失败就是这么来的：TS2353 toolFilter 不存在 / TS2339 start 不存在）。
        // 教训：类型漂移不是用例失败；把编译档位换成"只转译"才是正确处置，
        // 而不是改历史源码去迁就新类型。
        ...(noCheck ? { noCheck: true } : {}),
      },
      include: ['src/**/*.ts'],
    }),
  );
  sh(path.join(REPO, 'node_modules/.bin/tsc'), ['-p', path.join(dir, 'tsconfig.json')], { cwd: dir });
  const lib = path.join(dir, 'lib');
  if (!existsSync(lib)) throw new Error(`${rev}: 编译没有产出 lib/`);
  return lib;
}

/**
 * 这个 revision 的源码是不是**合并后的单包布局**。
 *
 * 2026-10-19 的 959f3ee 把七个包合并成一个 `packages/sdlc`，组件源码从
 * `packages/sdlc-<comp>/src` 搬到了 `packages/sdlc/src/<comp>`。
 * 基准用例的**基线**一律钉在历史提交上，那里旧路径仍然真实存在；
 * 只有"当前/修复版"一侧会走到合并布局。所以按 revision 判形，而不是全局改路径。
 */
export function mergedAt(rev) {
  return existsAt(rev, 'packages/sdlc/src');
}

/**
 * 取合并包的**整棵源码树**并编译，返回 `<work>/<rev>-merged/packages/sdlc/lib`。
 *
 * 为什么不能像旧布局那样只取 `scan.ts` 一个文件：合并后组件之间有了真实的
 * 相对 import（`status/scan.ts` → `../task/state.js`，`verify/index.ts` →
 * `../shared/helpers.js`）。只取单文件会编译失败；`git archive` 取整包最省事，
 * 且足够快（包不大）。
 *
 * 为什么单独处理 `package.json`/`tsconfig.json`：合并包是 `"type": "module"`、
 * 用 NodeNext 编译，和外面 `makeWorkdir` 给旧布局准备的 `commonjs` 冲突。
 * 取出的包里本来就带这两份文件（`git archive` 取的是提交里的真实内容）；
 * 只有将来某个变体缺了才补写一份保守默认值。嵌套的 `package.json` 优先级
 * 更高，于是两种形态可以在**同一个 work 目录**里共存——基线走 `require`，
 * 修复版走 `import()`，`runCase` 不用改。
 */
export function compileMerged(rev, work) {
  const dir = path.join(work, `${rev.replace(/[^\w.-]/g, '_')}-merged`);
  mkdirSync(dir, { recursive: true });
  const tar = sh('git', ['-C', REPO, 'archive', '--format=tar', rev, 'packages/sdlc'], {
    encoding: 'buffer',
  });
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  const pkgDir = path.join(dir, 'packages/sdlc');
  if (!existsSync(path.join(pkgDir, 'src'))) throw new Error(`${rev}: archive 里没有 packages/sdlc/src`);
  if (!existsSync(path.join(pkgDir, 'package.json'))) {
    writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ type: 'module' }));
  }
  if (!existsSync(path.join(pkgDir, 'tsconfig.json'))) {
    writeFileSync(
      path.join(pkgDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
          lib: ['ES2023'], strict: true, skipLibCheck: true,
          outDir: 'lib', rootDir: 'src', types: ['node'],
        },
        include: ['src/**/*.ts'],
      }),
    );
  }
  sh(path.join(REPO, 'node_modules/.bin/tsc'), ['-p', path.join(pkgDir, 'tsconfig.json')], {
    cwd: pkgDir,
  });
  const lib = path.join(pkgDir, 'lib');
  if (!existsSync(lib)) throw new Error(`${rev}: 合并包编译没有产出 lib/`);
  return lib;
}

/** 加载合并包编译出的 ESM 模块（`compileMerged` 的产物是 `"type": "module"`）。 */
export async function loadMerged(libRoot, ...relParts) {
  const file = path.join(libRoot, ...relParts);
  if (!existsSync(file)) throw new Error(`合并产物里没有 ${file}`);
  return import(pathToFileURL(file).href);
}

/**
 * 按产物形态加载模块。
 *
 * ⚠️ 产物的模块形态取决于最近的 `package.json`：`makeWorkdir` 统一声明
 * `commonjs`（用 `require`），但用例若需要 ESM 可以自己 `import(pathToFileURL(...))`。
 * 两种形态实测都出现过，**别假设**。
 */
export function loadModule(libDir, entryName) {
  const names = require('node:fs').readdirSync(libDir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
  const first = entryName && names.includes(entryName) ? entryName : names[0];
  if (!first) throw new Error(`${libDir} 下没有可加载的产物`);
  return require(path.join(libDir, first));
}

export { require };

/**
 * 跑一个用例的两个版本，打印结果并给出结论。
 *
 * `judge(mod)` 返回 `[名称, 是否通过, 观测值]` 数组——**每条都要带观测值**，
 * 否则报告看不出是"没测"还是"测了且过"。
 */
export async function runCase({
  id, title, baselineRev, fixedRev, baselineLabel, fixedLabel,
  compile, judge, json, moduleType,
}) {
  const work = makeWorkdir(`bench-${id}-`, { moduleType });
  let rows;
  try {
    const base = await compile(baselineRev, work);
    const fixed = await compile(fixedRev, work);
    rows = [
      // judge 允许是 async（PWSH-1 要在两个平台上分别派发，必须 await）
      { label: baselineLabel ?? `基线 ${baselineRev}`, checks: await judge(base) },
      { label: fixedLabel ?? `修复 ${fixedRev}`, checks: await judge(fixed) },
    ];
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const baseFails = rows[0].checks.filter((c) => !c[1]).length;
  const fixedFails = rows[1].checks.filter((c) => !c[1]).length;
  const ok = baseFails > 0 && fixedFails === 0;

  if (json) {
    return { id, title, baselineRev, fixedRev, ok, baseFails, fixedFails, rows };
  }

  console.log(`\n### ${id} — ${title}`);
  for (const { label, checks } of rows) {
    const pass = checks.filter((c) => c[1]).length;
    console.log(`\n  ${label}  —  ${pass}/${checks.length} 通过`);
    for (const [name, good, detail] of checks) {
      console.log(`  ${good ? 'PASS' : 'FAIL'}  ${name}  :: ${detail}`);
    }
  }
  console.log(
    ok
      ? `\n  ✅ ${id} 有效：基线违反 ${baseFails} 条，修复版 0 条。`
      : fixedFails > 0
        ? `\n  ❌ ${id}：修复版也违反 ${fixedFails} 条——回归了，或判据不对。`
        : `\n  ❌ ${id}：基线没被任何判据抓住——这些断言是恒真的。`,
  );
  return { id, title, baselineRev, fixedRev, ok, baseFails, fixedFails, rows };
}
