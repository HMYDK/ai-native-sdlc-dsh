#!/usr/bin/env node
/**
 * sdlc-preset 冒烟：**bundle patch 的形状是否正确、七个插件模块是否可装配**。
 *
 * ## 为什么需要它
 *
 * 2026-10-19 起，用户要求"只有明确选择这套 SDLC 时它才工作"。方案 A 的实现是：
 *
 *   宿主行 ① `sdlc-ui`          —— 常驻（浏览器半被发现的前提，见 ui 冒烟）
 *   宿主行 ② `preset-sdlc`      —— 一个 `@deepseek-ai/dsh-agent-preset` 声明
 *   preset 子行                 —— **standard preset 的完整副本 + 六个机制组件**
 *                                  （task / artifact / status / verify / workflow / rsi）
 *
 * 为什么 preset 里要带 standard 副本：preset 不继承、不合并，选了这个模式的会话
 * 需要 read/bash/write 等基础工具才能干活，所以「AI 原生 SDLC」模式 = standard + SDLC。
 * 副本与 App 的对账由 `tools/preset-sync-check.mjs` 负责；这个冒烟只钉形状与装配。
 *
 * 一旦有人把六行搬回宿主层（所有会话又全局生效）、删掉/改错 preset 声明、
 * 或者把 standard 副本丢了（选模式后没有基础工具），这份断言必须变红。
 *
 * ## 它证明什么 / 不证明什么
 *
 * 证明：patch 可解析、宿主行恰好两条、preset 配置合法且包含 standard 基础工具
 *       锚点 + 六个本套件组件、六个 name 都能用 package.json exports 解析到真实
 *       模块，且模块导出 apply / inject / Config。
 * 不证明：preset 选择后在真实会话里的工具可见性（那是运行时作用域，
 *       官方语义见 `@deepseek-ai/dsh-agent-preset-registry`；本仓库在
 *       AGENTS.md 里记录了可复跑的真实会话读数）。
 *
 * 前置条件：与其它冒烟相同，在 App 自带 Electron-as-Node 下运行即可。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

// standard preset 副本里有 `disabled: !!js ...`（Loader 表达式）。冒烟只校验形状，
// 不求值这些表达式——用自定义 scalar 类型把它们读成字符串即可。
const YAML_SCHEMA = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (d) => `!!js ${d}` }),
]);

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.join(DIR, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log(`  \u2713 ${m}`); };
const bad = (m) => { fail++; console.log(`  \u2717 ${m}`); };

const EXPECTED_HOST = ['sdlc-ui', 'preset-sdlc'];
const EXPECTED_PRESET = [
  ['sdlc-task', `${pkg.name}/task`],
  ['sdlc-artifact', `${pkg.name}/artifact`],
  ['sdlc-status', `${pkg.name}/status`],
  ['sdlc-verify', `${pkg.name}/verify`],
  ['sdlc-workflow', `${pkg.name}/workflow`],
  ['sdlc-rsi', `${pkg.name}/rsi`],
];
// standard preset 里必须存在的"基础工具"锚点：少了任何一个，SDLC 模式就残废。
// （完整性由 tools/preset-sync-check.mjs 与 App 逐行对账，这里只钉关键的几个。）
const STANDARD_ANCHORS = [
  'persona',
  'tool-bash',
  'tool-pwsh',
  'tool-fs',
  'tool-fs-search',
  'delegation',
  'skill-filesystem',
  'tool-skill',
  'tool-todo',
  'tool-web',
];

function resolveSpec(spec) {
  if (spec === pkg.name) return pkg.exports?.['.'] ?? pkg.main;
  if (spec.startsWith(`${pkg.name}/`)) return pkg.exports?.[`./${spec.slice(pkg.name.length + 1)}`];
  return undefined;
}

console.log('== 1. patch 形状：两条宿主行 ==');
// 可传旧版 patch 做两侧回归：升级前的组合应当被当前 App 拒绝。
const patchFile = process.env.SDLC_PRESET_PATCH ?? path.join(PKG_DIR, 'cordis.patch.yml');
const patch = yaml.load(fs.readFileSync(patchFile, 'utf8'), { schema: YAML_SCHEMA });
if (Array.isArray(patch) && patch.length === 1 && Array.isArray(patch[0]?.insert)) {
  ok('cordis.patch.yml 是「一条 insert」');
} else {
  bad('cordis.patch.yml 不是预期的单条 insert 结构');
}
const hostRows = Array.isArray(patch?.[0]?.insert) ? patch[0].insert : [];
const hostIds = hostRows.map((r) => r?.id);
if (hostIds.length === EXPECTED_HOST.length && EXPECTED_HOST.every((id) => hostIds.includes(id))) {
  ok(`宿主行恰好 ${EXPECTED_HOST.length} 条：${hostIds.join(', ')}`);
} else {
  bad(`宿主行应为 [${EXPECTED_HOST.join(', ')}]，实际 [${hostIds.join(', ')}]——六个机制组件不能留在宿主层`);
}
const uiRow = hostRows.find((r) => r?.id === 'sdlc-ui');
if (uiRow?.name === pkg.name) ok(`sdlc-ui 脚本行 name 是精确包名 ${pkg.name}`);
else bad(`sdlc-ui 行 name 必须精确等于 ${pkg.name}（否则浏览器半静默消失）`);

console.log('\n== 2. preset 声明：id / 展示名 / standard 副本 + 六个子插件行 ==');
const presetRow = hostRows.find((r) => r?.id === 'preset-sdlc');
if (presetRow?.name === '@deepseek-ai/dsh-agent-preset') {
  ok('preset-sdlc 行 name = @deepseek-ai/dsh-agent-preset');
} else {
  bad(`preset-sdlc 行 name 应为 @deepseek-ai/dsh-agent-preset（实际 ${presetRow?.name}）`);
}
const cfg = presetRow?.config ?? {};
if (cfg.id === 'sdlc') ok("preset config.id = 'sdlc'（会话保存的标识符）");
else bad(`preset config.id 应为 sdlc（实际 ${JSON.stringify(cfg.id)}）`);
if (typeof cfg.name === 'string' && cfg.name.trim() !== '') ok(`preset 展示名 = ${cfg.name}`);
else bad('preset 缺展示名（新会话选择器里没有可读标题）');
if (typeof cfg.description === 'string' && cfg.description.trim() !== '') ok('preset 有描述');
else bad('preset 缺描述');

const presetRows = Array.isArray(cfg.plugins) ? cfg.plugins : [];
const presetIds = presetRows.map((r) => r?.id);
const dupPreset = presetIds.filter((id, i) => presetIds.indexOf(id) !== i);
if (dupPreset.length === 0) ok(`preset 子插件行无重复（共 ${presetRows.length} 行）`);
else bad(`preset 子插件行 id 重复：${[...new Set(dupPreset)].join(', ')}`);

const missingAnchors = STANDARD_ANCHORS.filter((id) => !presetIds.includes(id));
if (missingAnchors.length === 0) {
  ok(`standard 基础工具锚点齐全（${STANDARD_ANCHORS.length} 个关键行）`);
} else {
  bad(`preset 缺 standard 基础工具：${missingAnchors.join(', ')}——选了模式也没有 read/bash 等基础工具`);
}

const tail = presetRows.slice(-EXPECTED_PRESET.length);
const tailIds = tail.map((r) => r?.id);
if (EXPECTED_PRESET.every(([id], i) => tailIds[i] === id)) {
  ok('六个 SDLC 组件行按顺序追加在 preset 末尾');
} else {
  bad(`preset 末尾应为六个 SDLC 行，实际 [${tailIds.join(', ')}]`);
}
const nameMismatch = EXPECTED_PRESET.filter(([id, spec]) => {
  const row = presetRows.find((r) => r?.id === id);
  return row?.name !== spec;
});
if (nameMismatch.length === 0) ok('六个子插件行 name 都指向本包子路径导出');
else bad(`子插件行 name 不对：${nameMismatch.map(([id, spec]) => `${id} 应为 ${spec}`).join('；')}`);

console.log('\n== 3. 模块装配：每个 name 都能解析并导出 apply/inject/Config ==');
for (const [id, spec] of EXPECTED_PRESET) {
  const row = presetRows.find((r) => r?.id === id);
  const rel = row && resolveSpec(row.name);
  if (!rel) { bad(`${id}: name 无法用 package.json exports 解析`); continue; }
  const file = path.join(PKG_DIR, rel);
  if (!fs.existsSync(file)) { bad(`${id}: exports 指向的文件不存在（${rel}）`); continue; }
  try {
    const mod = await import(pathToFileURL(file).href);
    const problems = [];
    if (typeof mod.apply !== 'function') problems.push('缺 apply');
    if (!Array.isArray(mod.inject) || mod.inject.length === 0) problems.push('inject 不是非空数组');
    if (typeof mod.Config?.['~standard']?.validate !== 'function') problems.push('Config 不是 Standard Schema');
    if (mod.name !== id) problems.push(`导出 name=${JSON.stringify(mod.name)} 与行 id=${id} 不一致`);
    if (problems.length === 0) ok(`${id} → ${rel}（apply / inject / Config / name 就绪）`);
    else bad(`${id}: ${problems.join('，')}`);
  } catch (e) {
    bad(`${id}: import 失败：${e.message}`);
  }
}

console.log('\n== 4. 与宿主层的边界 ==');
if (!hostRows.some((r) => EXPECTED_PRESET.some(([id]) => r?.id === id))) {
  ok('六个机制组件都不在宿主行里（标准会话不会加载它们）');
} else {
  bad('有机制组件仍出现在宿主行——这会让所有会话全局生效');
}
if (pkg.dsh?.client?.platform === 'web' && typeof pkg.dsh?.bundle?.patch === 'string') {
  ok(`dsh.bundle.patch=${pkg.dsh.bundle.patch}, dsh.client.platform=web`);
} else {
  bad('package.json 的 dsh.bundle / dsh.client 声明不完整');
}

console.log('\n== 5. standard 副本引用的组件仍由当前 App 导出 ==');
const runtimeRequire = createRequire(path.join(
  process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app',
  'Contents/Resources/app.asar/dsh/node_modules/noop.js',
));
function checkRuntimeRows(rows) {
  for (const row of rows) {
    if (row.disabled === true) continue;
    if (row.group && Array.isArray(row.config)) checkRuntimeRows(row.config);
    if (!row.name?.startsWith('@deepseek-ai/')) continue;
    try {
      runtimeRequire.resolve(row.name);
      ok(`${row.id}: 当前 App 可解析 ${row.name}`);
    } catch (error) {
      bad(`${row.id}: 当前 App 无法解析 ${row.name}（${error.code ?? error.message}）`);
    }
  }
}
checkRuntimeRows(presetRows);

console.log(`\n断言总数：${pass + fail}（通过 ${pass}，失败 ${fail}）`);
if (fail > 0) process.exit(1);
