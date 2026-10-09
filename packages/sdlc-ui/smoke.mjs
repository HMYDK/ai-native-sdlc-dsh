/**
 * sdlc-ui 的冒烟测试。
 *
 * ## 它证明什么
 *
 * 客户端半不是 ESM、也不是普通 CJS——它是 `window.__ModuleLoader__.load({...})`
 * 的**宿主求值格式**。所以"文件存在"什么都证明不了：
 * 一段语法合法但导错东西的客户端半，加载时会静默地什么都不注册。
 *
 * 这个脚本在 Node 里**真的求值**那个 bundle（提供 `window.__ModuleLoader__`
 * 的桩），然后断言：
 *   1. `load()` 被调用，且 id 与包名一致
 *   2. factory 能被调用（`require` 的桩给了假 react/jsx-runtime）
 *   3. 导出里有 `apply` 与 `inject`，且 `inject` 含 `slots`
 *   4. 调 `apply(ctx)` 之后**真的往 sidebar.panellist 注册了一个组件**
 *   5. 那个组件能被**调用**并返回一个 React 元素（不崩）
 *
 * 第 4、5 条是关键：本仓库的纪律是"加载 ≠ 可用"。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log(`  \u2713 ${m}`); };
const bad = (m) => { fail++; console.log(`  \u2717 ${m}`); };

console.log('== 1. 客户端半的宿主求值格式 ==');
const bundle = path.join(DIR, 'lib/client.js');
if (!fs.existsSync(bundle)) { bad('lib/client.js 不存在（build 没拷过去？）'); process.exit(1); }
ok(`lib/client.js ${fs.statSync(bundle).size} 字节`);

const pkg = JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8'));
if (pkg.exports?.['./client'] === './lib/client.js') ok("exports['./client'] 指向 lib/client.js");
else bad("exports['./client'] 不对");
if (pkg.dsh?.client?.platform === 'web') ok("dsh.client.platform = 'web'");
else bad('dsh.client.platform 不是 web');

// ── 提供 window.__ModuleLoader__ 的桩，真的求值
let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) { loaded = spec; },
  },
};

// ── `require` 的桩：只给这个 bundle 用得着的东西
const required = [];
const fakeRequire = (id) => {
  required.push(id);
  if (id === 'react/jsx-runtime') {
    // 最小 jsx：记录调用，返回一个可断言的对象
    return {
      jsx: (type, props, key) => ({ $$jsx: true, type, props, key }),
      jsxs: (type, props, key) => ({ $$jsx: true, type, props, key }),
    };
  }
  if (id === 'react') return { createElement: (t, p, ...c) => ({ $$jsx: true, type: t, props: p, c }) };
  throw new Error(`bundle 不该 require(${JSON.stringify(id)})——它只能依赖宿主提供的东西`);
};

console.log('\n== 2. 求值 bundle ==');
const src = fs.readFileSync(bundle, 'utf8');
// 直接求值：它是一条 `window.__ModuleLoader__.load({...})` 表达式
new Function(src)();
if (loaded === null) { bad('__ModuleLoader__.load 没被调用'); process.exit(1); }
ok('__ModuleLoader__.load 被调用');
if (loaded.id === '@ai-native-sdlc/dsh-sdlc-ui') ok(`id=${loaded.id}`);
else bad(`id 应为包名，实际 ${JSON.stringify(loaded.id)}`);
if (typeof loaded.factory === 'function') ok('factory 是函数');
else { bad('factory 不是函数'); process.exit(1); }

const mod = loaded.factory(fakeRequire);
console.log(`\n== 3. 导出的形状 ==`);
if (typeof mod.apply === 'function') ok('exports.apply 是函数');
else bad('exports.apply 缺失');
if (Array.isArray(mod.inject)) ok(`exports.inject=[${mod.inject.join(', ')}]`);
else bad('exports.inject 不是数组');
if (Array.isArray(mod.inject) && mod.inject.includes('slots')) ok("inject 含 'slots'（否则 apply 里拿不到 ctx.slots）");
else bad("inject 不含 'slots'");

console.log('\n== 4. 真的注册进 slot（加载 ≠ 可用）==');
const registered = [];
const ctx = {
  slots: {
    // ⚠️ 回调返回的是**生成器**，必须迭代它 `yield` 的注册才会发生。
    // 我第一版只存下回调没迭代，于是 registered 是空的——
    // 冒烟立刻报出来（"应当注册 1 个，实际 0"）。这正是"加载 ≠ 可用"。
    inject(key, cb) {
      const gen = cb();
      for (const _ of gen) { /* 注册发生在 yield 的求值中 */ }
      return () => {};
    },
    register(opts, component) { registered.push({ opts, component }); return () => {}; },
  },
};
if (typeof mod.apply === 'function' && Array.isArray(mod.inject)) {
  mod.apply(ctx);
  if (registered.length === 1) ok('apply() 注册了 1 个组件');
  else bad(`应当注册 1 个，实际 ${registered.length}`);
  const r = registered[0];
  if (r?.opts?.name === 'sidebar.panellist') ok("注册到 'sidebar.panellist'");
  else bad(`注册的 slot 名不对：${JSON.stringify(r?.opts)}`);
  if (typeof r?.component === 'function') {
    ok('注册的是一个组件函数');
    // ── 第 5 条：那个组件必须能被调用而不崩
    const el = r.component({});
    if (el?.$$jsx === true) ok('组件能渲染（调用它返回了一个 React 元素）');
    else bad(`组件返回值不像 React 元素：${JSON.stringify(el)?.slice(0, 80)}`);
    if (el?.props?.style !== undefined) ok('渲染结果带内联样式（探针项肉眼可辨）');
  } else bad('注册的 component 不是函数');
} else {
  bad('apply/inject 不合法，跳过注册断言');
}

console.log('\n== 5. 只依赖宿主提供的模块 ==');
if (required.every((r) => r === 'react' || r === 'react/jsx-runtime')) {
  ok(`require 的模块都在宿主白名单内：[${[...new Set(required)].join(', ')}]`);
} else bad(`require 了宿主可能不提供的模块：${required.join(', ')}`);

console.log('');
console.log(`断言总数：${pass + fail}（通过 ${pass}，失败 ${fail}）`);
if (fail > 0) { console.log('有失败项'); process.exit(1); }
console.log('全部通过');
