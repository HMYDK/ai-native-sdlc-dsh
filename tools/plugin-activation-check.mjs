#!/usr/bin/env node
/**
 * 检查：**App 真的会加载我这一版插件吗**——以及加载得了吗。
 *
 * ## 为什么需要这个脚本
 *
 * 2026-10-15 我在这件事上连栽两次，各浪费一轮重启：
 *
 * ① **装的位置不对。** desktop profile 用的是 `file:.../*.tgz`，
 *    即 **tgz 解出来的副本**，不是指向仓库的符号链接。改了 `lib/` 再重启，
 *    跑的还是旧副本。（`docs/dsh-pitfalls.md` §12.1 写的"重启就生效"
 *    前提是 `dsh plugin add` 建的**符号链接**，tgz 安装不满足。）
 *
 * ② **inject 里多写一个服务 → 插件静默不激活。**
 *    我加了 `logger`，插件就停在 `fiberPhase: "pending"`，三个工具全部消失，
 *    而没有报错、没有日志、App 照常启动。
 *
 * 这两件事都有同一个特点：**看起来一切正常，实际没在跑我的代码**。
 * 所以必须能机械地查出来，不能靠"我重启了"这种说法。
 *
 * ## 查三件事
 *
 * 1. **漂移**：profile 里装的那份，与仓库刚构建的那份，逐字节是否一致。
 *    不一致 = App 跑的不是这一版，重启也没用。
 * 2. **可解析**：每个插件 `inject` 里的服务名，宿主的服务集合里有没有。
 *    没有 = 该插件会停在 pending，而且**静默**。
 * 3. **可加载**：模块能被 import、导出 `apply`。
 *
 * 用法：
 *
 *     node tools/plugin-activation-check.mjs
 *     DSH_PROFILE=/path/to/profile node tools/plugin-activation-check.mjs
 *
 * 退出码 0 = 全部就绪；1 = 有插件不会生效（会点名是哪一件、为什么）。
 *
 * ⚠️ 它**不能**替代运行时验证。它证明的是"制品对、能激活"；
 *    进程里到底加载了哪一版，只有运行时可见物能证明
 *    （`plugin_manager list_plugins` 的 fiberPhase，或新行为本身）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
/**
 * profile 目录。
 *
 * ⚠️ 环境里 `DSH_PROFILE` 是 **`desktop`**（一个名字，不是路径）。
 * 第一版写成 `path.join(process.env.HOME, '.dsh/profiles/' + DSH_PROFILE)` 时
 * 我没读到它；第二版直接用它当路径，于是解析出 `desktop/node_modules/...`
 * ——一个相对路径，被当绝对路径用，报"没装"而实际装了。
 * 这正是本项目记过的"相对路径从启动目录解析"那类坑。
 *
 * 正确的顺序：先用环境给的**绝对**路径（`DSH_PROFILE_DIR` /
 * `DSH_HOME`），再退回 `~/.dsh/profiles/<name>`。
 */
function resolveProfile() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR;
  const name = process.env.DSH_PROFILE_NAME ?? process.env.DSH_PROFILE ?? 'desktop';
  const home = process.env.DSH_HOME ?? path.join(process.env.HOME ?? '', '.dsh');
  return path.isAbsolute(name) ? name : path.join(home, 'profiles', name);
}
const PROFILE = resolveProfile();
/** profile 里**装插件的那一层**（`<profile>/node_modules/@ai-native-sdlc`）。 */
const PROFILE_NM = path.join(PROFILE, 'node_modules/@ai-native-sdlc');

/**
 * 宿主提供的服务集合。
 *
 * 这是**唯一一处需要手工维护的输入**：Cordis 没有"列出所有已提供服务"的接口，
 * 而在裸 Context 上 `ctx.get(任何名字)` 都是 undefined。
 *
 * 怎么得到这个名单：从**已经在真实 App 里 active** 的插件反推——
 * 它们的 inject 一定全是宿主提供的。目前是六个 SDLC 插件的并集
 * （`skills` 来自 sdlc-workflow、`connection` 来自 sdlc-ui，
 *  两者在 App 里都是 active，所以它们确实由宿主提供）。
 *
 * 正因如此，这个名单**本身也要防漂移**：新增插件用到别的服务时，
 * 这里会报"解析不到"——那正是要人来看一眼的时刻：
 * 要么宿主确实没提供（那插件真的不会激活），要么只是名单该补。
 * 补名单时务必先确认那个服务在 App 里真的有插件提供。
 */
const HOST_SERVICES = [
  'tools',
  'subagents',
  'systemPrompt',
  'fs',
  'sandboxPolicy',
  'skills',
  'connection',
];

/** 仓库里的 SDLC 插件包（有 lib/ 的那些）。 */
function packages() {
  const dir = path.join(REPO, 'packages');
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(dir, d.name, 'package.json')))
    .map((d) => path.join(dir, d.name))
    .filter((p) => existsSync(path.join(p, 'lib/index.js')))
    .sort();
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);

/** 收集一个包 lib/ 下的所有 .js（排除测试），返回相对路径 → 绝对路径。 */
function libFiles(pkg) {
  const out = new Map();
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.set(r, path.join(dir, e.name));
    }
  };
  walk(path.join(pkg, 'lib'), '');
  return out;
}

const results = [];
let problems = 0;

for (const pkg of packages()) {
  const pkgJson = JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8'));
  const name = pkgJson.name;
  const issues = [];

  // ── 1. 漂移：profile 那份 vs 仓库这份 ──────────────────────────
  //
  // ⚠️ 包名是 scoped（`@ai-native-sdlc/dsh-sdlc-verify`），**不能直接
  // `path.join(PROFILE_NM, name)`**——那会拼出
  // `node_modules/@ai-native-sdlc/@ai-native-sdlc/dsh-sdlc-verify`
  // 多一层目录，于是永远报"没装"。取最后一个 `/` 之后那段。
  const installed = path.join(PROFILE_NM, name.split('/').pop() ?? name);
  if (!existsSync(installed)) {
    issues.push(`profile 里没装（${installed}）`);
  } else {
    const mine = libFiles(pkg);
    const theirs = existsSync(path.join(installed, 'lib')) ? libFiles(installed) : new Map();
    const missing = [...mine.keys()].filter((k) => !theirs.has(k));
    const differ = [...mine.keys()].filter(
      (k) => theirs.has(k) && sha(mine.get(k)) !== sha(theirs.get(k)),
    );
    if (missing.length > 0) issues.push(`profile 里缺文件：${missing.join(', ')}`);
    if (differ.length > 0) issues.push(`profile 里是旧代码（不一致：${differ.join(', ')}）`);
  }

  // ── 2. 可解析：inject 的每个名字 ───────────────────────────────
  let inject = [];
  try {
    const mod = await import(pathToFileURL(path.join(pkg, 'lib/index.js')).href);
    if (typeof mod.apply !== 'function') issues.push('未导出 apply（不会激活）');
    inject = Array.isArray(mod.inject) ? mod.inject : [];
    const unknown = inject.filter((s) => !HOST_SERVICES.includes(s));
    if (unknown.length > 0) {
      issues.push(
        `inject 里有宿主没有的服务：${unknown.join(', ')}——` +
          '真实运行时不会激活这个插件，而且**静默**（fiberPhase=pending，工具全部消失）',
      );
    }
  } catch (e) {
    issues.push(`import 失败：${e.message}`);
  }

  results.push({ name, inject, issues });
  if (issues.length > 0) problems += issues.length;
}

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));

console.log(`profile: ${PROFILE}\n`);
for (const r of results) {
  const mark = r.issues.length === 0 ? '✓' : '✗';
  console.log(`${mark} ${pad(r.name, 42)} inject=[${r.inject.join(', ')}]`);
  for (const i of r.issues) console.log(`    ↳ ${i}`);
}

console.log();
if (problems === 0) {
  console.log('✅ 全部就绪：制品一致、inject 可解析、可加载。');
  console.log('   注意：这只证明"会加载这一版"，不证明"进程已经加载了"。');
  console.log('   要证明后者，重启后看运行时可见物（plugin_manager 的 fiberPhase 或新行为）。');
} else {
  console.log(`❌ 有 ${problems} 处问题：上面点名了。`);
  console.log('   最可能的原因：改完没同步进 profile（App 不从仓库 lib/ 加载）。');
  console.log('   同步方式：把 <pkg>/lib/*.js 拷进 profile 的 node_modules/<pkg>/lib/，再重启。');
}
process.exit(problems === 0 ? 0 : 1);
