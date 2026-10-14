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
import { fileURLToPath } from 'node:url';

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
export function compileFiles(rev, repoRelDir, fileNames, work, { as = 'module' } = {}) {
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
