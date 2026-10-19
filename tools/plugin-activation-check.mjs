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
 * ## 布局（2026-10-19 合并成单包后）
 *
 * 七个插件合成了一个 npm 包 `@ai-native-sdlc/dsh-sdlc`，但**执行仍是七个
 * Cordis 行**（`packages/sdlc/cordis.patch.yml` 一条 insert + 七行）。
 * 所以检查对象从"七个包"变成"一个包 + 七行"：
 *
 * 1. **七行可解析**：从 patch 里读出 `{id, name}`，用 package.json 的
 *    `exports` 把 name 解析成仓库里的模块文件，逐个 import 校验
 *    `apply` / `inject` / `Config`（Standard Schema）。
 *    ⚠️ **不要假设 name 去掉包名前缀就是 `lib/<comp>/index.js`**：
 *    `sdlc-ui` 行刻意指向**精确包名**（包根 `lib/index.js`），因为
 *    `@deepseek-ai/dsh-client-modules` 只扫描精确包名的 loader 行来发现
 *    `dsh.client`；写成 `./ui` 子路径会让浏览器半**静默消失**（本轮实测踩过，
 *    a6ac82d）。所以映射必须走 exports，不能靠字符串拼接。
 * 2. **inject 可解析**：七行 inject 的**并集**里每个服务名，宿主服务集合里有没有。
 *    没有 = 该行会停在 pending，而且**静默**。
 * 3. **漂移**：profile 里装的 `@ai-native-sdlc/dsh-sdlc` 与仓库刚构建的
 *    `packages/sdlc` 整棵树是否一致——`lib/` 下每个发布文件（`.js`、
 *    排除 `*.test.js`；`.d.ts` 不发布所以也不比）逐文件 sha256，
 *    外加 `cordis.patch.yml`（App 实际按**装进去的那份** patch 挂载行）。
 *    不一致 = App 跑的不是这一版，重启也没用。
 *
 * 用法：
 *
 *     node tools/plugin-activation-check.mjs
 *     DSH_PROFILE_DIR=/path/to/profile node tools/plugin-activation-check.mjs
 *
 * profile 解析顺序：`DSH_PROFILE_DIR` > `DSH_PROFILE_NAME`/`DSH_PROFILE`+`DSH_HOME`
 * > `~/.dsh/profiles/desktop`。
 *
 * 退出码 0 = 全部就绪；1 = 有问题（会点名是哪一行/哪个文件、为什么）。
 *
 * ⚠️ 它**不能**替代运行时验证。它证明的是"制品对、能激活"；
 *    进程里到底加载了哪一版，只有运行时可见物能证明
 *    （`plugin_manager list_plugins` 的 fiberPhase，或新行为本身）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PKG_DIR = path.join(REPO, 'packages/sdlc');
const PKG_JSON_PATH = path.join(PKG_DIR, 'package.json');
const PATCH_PATH = path.join(PKG_DIR, 'cordis.patch.yml');

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
 * 它们的 inject 一定全是宿主提供的。合并后是七个行的并集
 * （`skills` 来自 sdlc-workflow、`connection` 来自 sdlc-ui，
 *  两者在 App 里都是 active，所以它们确实由宿主提供）。
 *
 * 正因如此，这个名单**本身也要防漂移**：新增服务时这里会报"解析不到"——
 * 那正是要人来看一眼的时刻：要么宿主确实没提供（那行真的不会激活），
 * 要么只是名单该补。补名单时务必先确认那个服务在 App 里真的有插件提供。
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

/** 合并后 bundle 里的七行 id。少一行/多一行/改名都算漂移。 */
const EXPECTED_ROWS = [
  'sdlc-task',
  'sdlc-artifact',
  'sdlc-status',
  'sdlc-verify',
  'sdlc-workflow',
  'sdlc-rsi',
  'sdlc-ui',
];

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** 收集 lib/ 下所有**会发布**的文件：`.js` 且非 `*.test.js`（`.d.ts` 不在 files 里）。 */
function publishedFiles(pkgDir) {
  const out = new Map();
  const root = path.join(pkgDir, 'lib');
  if (!existsSync(root)) return out;
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.set(r, path.join(dir, e.name));
    }
  };
  walk(root, '');
  return out;
}

/**
 * 把 loader 行里的 `name` 解析成仓库里对应的文件。
 *
 * 走 package.json `exports`，**不靠字符串拼接**——`sdlc-ui` 行指向精确包名，
 * `@ai-native-sdlc/dsh-sdlc` 解析到 `./lib/index.js`（包根重新导出 ui 插件定义）。
 */
function resolveLoaderName(pkgJson, spec) {
  if (spec === pkgJson.name) return pkgJson.exports?.['.'] ?? pkgJson.main;
  if (spec.startsWith(`${pkgJson.name}/`)) {
    const sub = `./${spec.slice(pkgJson.name.length + 1)}`;
    return pkgJson.exports?.[sub];
  }
  return undefined;
}

const results = [];
const issuesAll = [];
const addIssue = (where, msg) => {
  issuesAll.push(`${where}: ${msg}`);
};

// ── 1. 读包与七行 ──────────────────────────────────────────────────
const pkgJson = JSON.parse(readFileSync(PKG_JSON_PATH, 'utf8'));
let rows = [];
try {
  // js-yaml 是本包的运行时依赖（仓库根 node_modules 里就有）。用动态 import
  // 而不是 createRequire，$DSH 两套模块系统下都能拿到同一份。
  const yaml = await import('js-yaml');
  const patch = yaml.load(readFileSync(PATCH_PATH, 'utf8'));
  const list = Array.isArray(patch) ? patch : [patch];
  for (const entry of list) {
    for (const row of entry?.insert ?? []) {
      if (row && typeof row.id === 'string') rows.push({ id: row.id, name: row.name });
    }
  }
} catch (e) {
  addIssue('patch', `读取/解析 cordis.patch.yml 失败：${e.message}`);
}

const rowIds = rows.map((r) => r.id);
const missingRows = EXPECTED_ROWS.filter((id) => !rowIds.includes(id));
const extraRows = rowIds.filter((id) => !EXPECTED_ROWS.includes(id));
const dupRows = rowIds.filter((id, i) => rowIds.indexOf(id) !== i);
if (missingRows.length > 0) addIssue('patch', `缺行：${missingRows.join(', ')}`);
if (extraRows.length > 0) addIssue('patch', `多出未知行：${extraRows.join(', ')}`);
if (dupRows.length > 0) addIssue('patch', `重复行 id：${[...new Set(dupRows)].join(', ')}`);

// ── 2. 逐行 import、校验 apply / inject / Config ──────────────────
const injectUnion = new Set();
for (const row of rows) {
  const issues = [];
  const add = (msg) => issues.push(msg);
  const rel = resolveLoaderName(pkgJson, row.name);
  if (rel === undefined) {
    add(`name ${row.name} 无法用 package.json exports 解析（loader 会找不到模块）`);
  } else {
    const file = path.join(PKG_DIR, rel);
    if (!existsSync(file)) {
      add(`exports 指向的文件不存在：${path.relative(REPO, file)}`);
    } else {
      try {
        const mod = await import(pathToFileURL(file).href);
        if (typeof mod.apply !== 'function') add('未导出 apply（不会激活）');
        if (!Array.isArray(mod.inject)) {
          add('未导出 inject 数组（访问服务会在加载时报 "without inject"）');
        } else {
          if (mod.inject.length === 0) add('inject 是空数组（这个组件不可能访问任何服务）');
          for (const s of mod.inject) {
            if (typeof s !== 'string') add(`inject 里有非字符串项：${JSON.stringify(s)}`);
            else {
              injectUnion.add(s);
              if (!HOST_SERVICES.includes(s)) {
                add(
                  `inject 里有宿主没有的服务：${s}——` +
                    '真实运行时不会激活这一行，而且**静默**（fiberPhase=pending，工具全部消失）',
                );
              }
            }
          }
        }
        if (typeof mod.Config?.['~standard']?.validate !== 'function') {
          add('Config 不是 Standard Schema 校验器（没有 ~standard.validate，Cordis 会拒绝挂载）');
        }
        if (typeof mod.name !== 'string' || mod.name === '') {
          add('未导出 name（loader 元数据缺失）');
        } else if (mod.name !== row.id) {
          add(`导出 name=${mod.name} 与 patch 行 id=${row.id} 不一致（行级覆盖/诊断会对不上）`);
        }
      } catch (e) {
        add(`import 失败：${e.message}`);
      }
    }
  }
  results.push({ row, rel, issues });
  for (const i of issues) addIssue(row.id, i);
}

/**
 * ⚠️ 单独钉住 UI 行的形态：`sdlc-ui` 必须指向**精确包名**。
 *
 * 这一条是有来历的，不是风格检查：`@deepseek-ai/dsh-client-modules` 只扫描
 * 精确包名的 loader 行来发现 `dsh.client`，写成 `@ai-native-sdlc/dsh-sdlc/ui`
 * 时 host 半照常工作、`/api/sdlc-ui.tasks` 照常 200，但浏览器半不会进
 * `window.__DSH_BOOT__`——面板不出现，日志无错（a6ac82d 实测抓到）。
 */
const uiRow = rows.find((r) => r.id === 'sdlc-ui');
if (!uiRow) {
  addIssue('sdlc-ui', 'patch 里没有 sdlc-ui 行');
} else {
  if (uiRow.name !== pkgJson.name) {
    addIssue(
      'sdlc-ui',
      `name 必须是精确包名 ${pkgJson.name}（当前 ${uiRow.name}）——` +
        '子路径会让 dsh-client-modules 发现不到 dsh.client，浏览器半静默消失',
    );
  }
  if (!pkgJson.dsh?.client) addIssue('package.json', '缺 dsh.client 声明（浏览器半不会被挂载）');
}

// ── 3. 漂移：profile 装的那份 vs 仓库刚构建的这份 ──────────────────
const PROFILE_PKG = path.join(PROFILE_NM, pkgJson.name.split('/').pop() ?? pkgJson.name);
const drift = { installed: false, missing: [], differ: [], extra: [], version: null };
if (!existsSync(PROFILE_PKG)) {
  addIssue(
    'profile',
    `没装 ${pkgJson.name}（找的是 ${PROFILE_PKG}）——App 不会加载仓库里的 lib/，` +
      '先把构建产物用 tarball 装进 profile（或改用隔离 profile）',
  );
} else {
  drift.installed = true;
  try {
    const installedPkg = JSON.parse(readFileSync(path.join(PROFILE_PKG, 'package.json'), 'utf8'));
    drift.version = installedPkg.version;
    if (installedPkg.version !== pkgJson.version) {
      addIssue(
        'profile',
        `版本不一致：仓库 ${pkgJson.version} / profile ${installedPkg.version}——App 跑的不是这一版`,
      );
    }
  } catch (e) {
    addIssue('profile', `读不出已安装包的 package.json：${e.message}`);
  }

  const mine = publishedFiles(PKG_DIR);
  const theirs = publishedFiles(PROFILE_PKG);
  drift.missing = [...mine.keys()].filter((k) => !theirs.has(k));
  drift.extra = [...theirs.keys()].filter((k) => !mine.has(k));
  drift.differ = [...mine.keys()].filter(
    (k) => theirs.has(k) && sha(mine.get(k)) !== sha(theirs.get(k)),
  );
  if (drift.missing.length > 0) addIssue('profile', `缺文件：${drift.missing.join(', ')}`);
  if (drift.differ.length > 0) addIssue('profile', `是旧代码（sha256 不一致）：${drift.differ.join(', ')}`);
  if (drift.extra.length > 0) {
    addIssue('profile', `有多余的旧文件（仓库构建里不存在）：${drift.extra.join(', ')}`);
  }

  // patch 也要比：App 实际按**装进去的那份**挂载七行。
  const installedPatch = path.join(PROFILE_PKG, 'cordis.patch.yml');
  if (!existsSync(installedPatch)) {
    addIssue('profile', '装了包但里面没有 cordis.patch.yml（bundle 行不会挂载）');
  } else if (sha(installedPatch) !== sha(PATCH_PATH)) {
    addIssue('profile', 'cordis.patch.yml 与仓库不一致——App 挂的行不是仓库这一版');
  }
}

// ── 报告 ───────────────────────────────────────────────────────────
const pad = (s, n) =>
  s + ' '.repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));

console.log(`profile: ${PROFILE}`);
console.log(`仓库包: ${pkgJson.name}@${pkgJson.version}`);
console.log(`bundle 行: ${rows.length} 行（期望 ${EXPECTED_ROWS.length}）\n`);
for (const r of results) {
  const mark = r.issues.length === 0 ? '✓' : '✗';
  console.log(`${mark} ${pad(r.row.id, 14)} → ${pad(r.row.name, 34)} ${r.rel ? path.relative(REPO, path.join(PKG_DIR, r.rel)) : '（解析失败）'}`);
  for (const i of r.issues) console.log(`    ↳ ${i}`);
}
console.log(`\ninject 并集: [${[...injectUnion].join(', ')}]`);
const unknownInject = [...injectUnion].filter((s) => !HOST_SERVICES.includes(s));
if (unknownInject.length === 0) console.log('  ✓ 并集里每个服务都在 HOST_SERVICES 名单里');
else console.log(`  ✗ 不在 HOST_SERVICES 里的服务：${unknownInject.join(', ')}`);

if (drift.installed) {
  const total = drift.missing.length + drift.differ.length + drift.extra.length;
  const fileCount = publishedFiles(PKG_DIR).size;
  console.log(
    `\nprofile 副本: 已安装 @${drift.version}，逐文件 sha256 比对 ${fileCount} 个发布文件` +
      (total === 0 ? ' ✓ 完全一致' : ` ✗ ${total} 处不一致`),
  );
}

console.log();
if (issuesAll.length === 0) {
  console.log('✅ 全部就绪：七行可解析、inject 可解析、制品与 profile 一致。');
  console.log('   注意：这只证明"会加载这一版"，不证明"进程已经加载了"。');
  console.log('   要证明后者，重启后看运行时可见物（plugin_manager 的 fiberPhase 或新行为）。');
  process.exit(0);
}
console.log(`❌ 有 ${issuesAll.length} 处问题：`);
for (const i of issuesAll) console.log(`  - ${i}`);
console.log('   最可能的原因：改完没同步进 profile（App 不从仓库 lib/ 加载）。');
console.log('   同步方式：重新 npm pack 并把新 tarball 装进 profile，再重启。');
process.exit(1);
