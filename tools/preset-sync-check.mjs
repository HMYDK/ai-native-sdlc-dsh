#!/usr/bin/env node
/**
 * 门禁：`preset-sdlc` 里内嵌的 **standard preset 副本**是否还和当前 App 一致。
 *
 * ## 为什么需要它
 *
 * 方案 A 把六个 SDLC 组件放进一个 Agent Preset。preset **不继承、不合并**
 * （官方：覆盖会替换完整子插件列表），所以「AI 原生 SDLC」模式必须自带一份
 * **完整的 standard preset 插件列表**，否则选了这个模式的会话连
 * read / bash / write 这些基础工具都没有，整个流程无法工作。
 *
 * 这意味着我们复制了一份 DSH 内置 `standard` preset。App 升级时 standard 可能
 * 新增/改名/调整插件（例如加一个新工具），而我们的副本不会自动跟进——这就是
 * 一个会**静默退化**的接缝：模式还能选、也能用，只是少了新工具或带着旧配置。
 *
 * 所以把判据写成可执行检查：读**这台机器真实 App** 里的
 * `dsh-web-app/presets/standard.patch.yml`，与我们 patch 中标记区域逐行比对。
 *
 * ## 用法
 *
 *     node tools/preset-sync-check.mjs          # 只检查，退出码 1 = 已漂移
 *     node tools/preset-sync-check.mjs --write  # 用 App 当前 standard 重新生成副本
 *
 * 普通 Node 读不了 `app.asar`，脚本会自己用 App 的 Electron-as-Node 重入
 * （与 `compat-check.mjs` 同一手法）。
 *
 * ⚠️ 它只证明「副本与 App 一致」，不证明「preset 选得到、工具可见」——
 * 后者要靠真实会话（见 AGENTS.md 的验证边界说明）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app';
const APP_BIN = path.join(APP, 'Contents/MacOS/DeepSeek Harness');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_PATCH = path.join(ROOT, 'packages/sdlc/cordis.patch.yml');
const STD_PATCH = path.join(
  APP,
  'Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml',
);

// 普通 Node 进不了 app.asar；用 App 自己的 Electron-as-Node 重入一次。
if (process.env.DSH_PRESET_SYNC_CHILD !== '1') {
  try {
    execFileSync(APP_BIN, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, DSH_PRESET_SYNC_CHILD: '1', ELECTRON_RUN_AS_NODE: '1' },
    });
    process.exit(0);
  } catch (error) {
    process.exit(typeof error.status === 'number' ? error.status : 1);
  }
}

const yaml = (await import('js-yaml')).default;
// standard preset 里有 `disabled: !!js ...`；用自定义 scalar 类型把它读成原样字符串，
// 比对时也按字符串比（不需要在这里求值 Loader 表达式）。
const jsType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data) => `!!js ${data}`,
});
const schema = yaml.DEFAULT_SCHEMA.extend([jsType]);
const parse = (text) => yaml.load(text, { schema });

const SDLC_ROWS = [
  ['sdlc-task', '@ai-native-sdlc/dsh-sdlc/task'],
  ['sdlc-artifact', '@ai-native-sdlc/dsh-sdlc/artifact'],
  ['sdlc-status', '@ai-native-sdlc/dsh-sdlc/status'],
  ['sdlc-verify', '@ai-native-sdlc/dsh-sdlc/verify'],
  ['sdlc-workflow', '@ai-native-sdlc/dsh-sdlc/workflow'],
  ['sdlc-rsi', '@ai-native-sdlc/dsh-sdlc/rsi'],
];

const stdText = readFileSync(STD_PATCH, 'utf8');
const stdRows = parse(stdText)[0].insert[0].config.plugins;

const normalize = (row) =>
  JSON.stringify({ id: row.id, name: row.name, disabled: row.disabled ?? null, config: row.config ?? null });
const rowKey = (row) => (row && typeof row.id === 'string' ? row.id : `(无 id: ${JSON.stringify(row)})`);

const startMarker = '==== 以下为 DSH standard preset 的副本';
const endMarker = '==== standard 副本结束';

if (process.argv.includes('--write')) {
  const stdLines = stdText.split('\n');
  const pIdx = stdLines.findIndex((l) => l === '        plugins:');
  if (pIdx < 0) {
    console.error('❌ 在 App 的 standard.patch.yml 里找不到 `plugins:` 行，无法同步');
    process.exit(1);
  }
  const stdBlock = stdLines.slice(pIdx + 1);
  while (stdBlock.length > 0 && stdBlock[stdBlock.length - 1].trim() === '') stdBlock.pop();
  const ours = readFileSync(PKG_PATCH, 'utf8').split('\n');
  const start = ours.findIndex((l) => l.includes(startMarker));
  const end = ours.findIndex((l) => l.includes(endMarker));
  if (start < 0 || end <= start) {
    console.error(`❌ 仓库 patch 里找不到同步标记（${startMarker} / ${endMarker}），拒绝盲写`);
    process.exit(1);
  }
  writeFileSync(PKG_PATCH, [...ours.slice(0, start + 1), ...stdBlock, ...ours.slice(end)].join('\n'));
  console.log(`✅ 已用 App 的 standard preset（${stdRows.length} 行）重写副本区域；请重跑检查并复跑冒烟。`);
  process.exit(0);
}

const ours = parse(readFileSync(PKG_PATCH, 'utf8'))[0].insert.find((r) => r.id === 'preset-sdlc');
const allRows = ours?.config?.plugins ?? [];
const tail = allRows.slice(-SDLC_ROWS.length);
const copy = allRows.slice(0, allRows.length - SDLC_ROWS.length);

const problems = [];
if (tail.length !== SDLC_ROWS.length) {
  problems.push(`preset 里本套件的 ${SDLC_ROWS.length} 行不完整（实际尾部 ${tail.length} 行）`);
}
SDLC_ROWS.forEach(([id, name], i) => {
  const row = tail[i];
  if (row?.id !== id || row?.name !== name) {
    problems.push(`第 ${i + 1} 个尾部行应为 ${id} → ${name}，实际 ${rowKey(row)} → ${row?.name}`);
  }
});

if (copy.length !== stdRows.length) {
  problems.push(`standard 副本行数 ${copy.length} ≠ App 当前 standard 的 ${stdRows.length} 行`);
}
const max = Math.max(copy.length, stdRows.length);
for (let i = 0; i < max; i++) {
  const a = stdRows[i];
  const b = copy[i];
  if (a === undefined) {
    problems.push(`副本多出第 ${i + 1} 行：${rowKey(b)}（App 的 standard 里没有）`);
    continue;
  }
  if (b === undefined) {
    problems.push(`副本缺第 ${i + 1} 行：${rowKey(a)} → ${a.name}`);
    continue;
  }
  if (normalize(a) !== normalize(b)) {
    const fields = ['id', 'name', 'disabled', 'config'].filter(
      (f) => JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null),
    );
    problems.push(`第 ${i + 1} 行（${rowKey(a)}）不一致：字段 ${fields.join(', ')}`);
  }
}

console.log(`App standard preset: ${stdRows.length} 行（${STD_PATCH}）`);
console.log(`本套件 preset: ${copy.length} 行副本 + ${tail.length} 行 SDLC 组件 = ${allRows.length} 行`);

if (problems.length === 0) {
  console.log('\n✅ preset-sdlc 内嵌的 standard 副本与当前 App 一致（行序、id、name、disabled、config 逐行相同）。');
  console.log('   注意：这只证明副本没漂移，不证明 preset 选得到 / 工具在会话里可见。');
  process.exit(0);
}
console.log(`\n❌ 副本已漂移（${problems.length} 处）：`);
for (const p of problems.slice(0, 20)) console.log(`  - ${p}`);
if (problems.length > 20) console.log(`  …还有 ${problems.length - 20} 处`);
console.log('\n处置：`node tools/preset-sync-check.mjs --write` 重新同步副本，然后复跑冒烟并提交。');
process.exit(1);
