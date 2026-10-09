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
  if (id === 'react') {
    // 客户端半用了 hooks —— 桩必须提供它们，否则组件调用会崩。
    // 这不是"为了测试而加"：真 React 就是有这些，桩缺了就是失真。
    return {
      createElement: (t, p, ...c) => ({ $$jsx: true, type: t, props: p, c }),
      useState: (init) => [init, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
    };
  }
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

  // ── 契约（从 live Slot 树查到，不是猜的）：
  //   `main` 是 **keyed**：注册要 {key}，且 side bar 的 list id 必须等于它
  //   `sidebar.panellist` 是 **list**：注册要 {id, order, label}，画的是**图标**
  if (registered.length === 2) ok('apply() 注册了两处（侧栏图标 + main 面板）');
  else bad(`应当注册 2 处，实际 ${registered.length}：${JSON.stringify(registered.map((r) => r.opts))}`);

  const icon = registered.find((r) => r.opts?.name === 'sidebar.panellist');
  const panel = registered.find((r) => r.opts?.name === 'main');

  if (icon) {
    ok("注册了 'sidebar.panellist'");
    if (typeof icon.opts.id === 'string' && icon.opts.id !== '') ok(`图标 id='${icon.opts.id}'`);
    else bad(`图标缺少 id（list 槽的必填项）：${JSON.stringify(icon.opts)}`);
    if (typeof icon.opts.order === 'number') ok(`order=${icon.opts.order}`);
    if (icon.opts.label === 'SDLC') ok("label='SDLC'（侧栏按钮的显示文字）");
    else bad(`label 不对：${JSON.stringify(icon.opts.label)}`);
    // 图标组件的 owner props 是 {size, active}
    const ic = icon.component({ size: 16, active: false });
    if (ic?.$$jsx === true && ic.type === 'svg') ok('图标组件渲染出 svg（owner props {size,active} 被接受）');
    else bad(`图标组件返回值不对：${JSON.stringify(ic?.type)}`);
  } else bad("没有注册 'sidebar.panellist'");

  if (panel) {
    ok("注册了 'main'");
    if (typeof panel.opts.key === 'string' && panel.opts.key !== '') ok(`main key='${panel.opts.key}'`);
    else bad(`main 缺少 key（keyed 槽的必填项）：${JSON.stringify(panel.opts)}`);
    // ⚠️ 关键：两处的 id/key 必须**同一个字符串**，否则按下图标什么都不会出现
    if (icon && panel.opts.key === icon.opts.id) {
      ok(`图标 id 与 main key 一致（'${panel.opts.key}'）—— 这就是配对的全部依据`);
    } else {
      bad(`图标 id(${JSON.stringify(icon?.opts.id)}) 与 main key(${JSON.stringify(panel.opts.key)}) 不一致 —— 按下图标不会有任何反应`);
    }
    const pe = panel.component({});
    if (pe?.$$jsx === true) ok('面板组件能被构造（hooks + 取数逻辑不炸）');
    else bad('面板组件构造失败');
  } else bad("没有注册 'main'（面板没有落点）");
} else {
  bad('apply/inject 不合法，跳过注册断言');
}

console.log('\n== 4b. 取数端点必须与 host 半注册的一致 ==');
{
  const src = fs.readFileSync(bundle, 'utf8');
  const hostSrc = fs.readFileSync(path.join(DIR, 'lib/index.js'), 'utf8');
  const PATH = '/sdlc-ui.tasks';
  // ⚠️ host 半的路径是**完整**的 `/api/...`（注册要求），
  // 而客户端用的是**相对**路径（base href 决定）。
  // 两者必须指向同一个端点 —— 这条断言就是防这个不一致的。
  const FULL = '/api' + PATH;
  if (hostSrc.includes("path: '" + FULL + "'") || hostSrc.includes('path: "' + FULL + '"')) {
    ok(`host 半注册了 ${FULL}`);
  } else bad(`host 半没有注册 ${FULL} —— 客户端取数会 404`);
  // 回归：路径**必须**以 /api/ 开头。少了前缀，connection 会抛
  // "invalid exact Fetch route"，而症状是"插件没激活但服务照起"——
  // 我第一版就是这么错的，只有真跑才抓到。
  if (hostSrc.includes("path: '/api/")) ok("host 路径以 /api/ 开头（connection 的硬要求）");
  else bad("host 路径没有 /api/ 前缀 —— connection 会拒绝注册");
  // 客户端半必须用**相对**路径：页面有 <base href="./">，
  // 而且挂载前缀可能不是根。写死 '/api/...' 在子路径部署下会 404。
  if (src.includes("'./api" + PATH + "'")) ok("客户端用相对路径 './api" + PATH + "'（base href 下解析为 /api" + PATH + "）");
  else bad("客户端半没有用相对路径取数（子路径部署下会 404）");
  if (/fetch\(\s*['"]\/api\//.test(src)) bad("客户端半用了绝对路径 '/api/...'");
  else ok('客户端半没有用绝对路径');
}

console.log('\n== 4c. cwd 的来源必须与兄弟插件一致（防漂移） ==');
{
  const src = fs.readFileSync(bundle, 'utf8');
  const hostSrc = fs.readFileSync(path.join(DIR, 'lib/index.js'), 'utf8');
  // host 半必须**接受** ?cwd= —— 否则多工作区下会看错仓库
  if (hostSrc.includes("searchParams.get('cwd')") || hostSrc.includes('searchParams.get("cwd")')) {
    ok("host 半接受 ?cwd=（多工作区下才不会看错仓库）");
  } else bad("host 半不接受 ?cwd= —— 多工作区下会退回进程 cwd，可能看错仓库");
  // 客户端必须**传**它
  if (/cwd=/.test(src) && /encodeURIComponent/.test(src)) ok('客户端把工作区路径传上去（并做了编码）');
  else bad('客户端没有传工作区路径');
  // ⚠️ 但 cwd 是不能无条件信的外部输入：必须有校验
  if (/startsWith\('\/'\)/.test(hostSrc) && hostSrc.includes("!== '/'")) {
    ok('host 对 cwd 做了校验（只接受非根的绝对路径）—— 不给任意目录读取');
  } else bad('host 没校验 cwd —— 等于开放任意目录读取');
}

console.log('\n== 4d. 客户端调用宿主 hook 的形状（这一条是补的事故） ==');
{
  const src = fs.readFileSync(bundle, 'utf8');
  // ⚠️ 事故：我第一版写 `useWorkspaces()` 取 `snap.activeWorkspace`。
  // 查 dsh-client-runtime 的类型定义后确认两处都错：
  //   · useWorkspaces: <S>(selector: (state) => S) => S  —— 它要 **selector 函数**
  //   · WorkspaceListState = { items: readonly WorkspaceView[] } —— **没有 activeWorkspace**
  // 症状：静默退回 null → 不传 cwd → 面板**空白**。用户看到的就是这个。
  //
  // 客户端半**不经 tsc**，所以这类 API 误用没有任何东西能拦。
  // 这些断言就是那个缺失的检查，能补一点是一点。
  if (/typeof useWs !== 'function'/.test(src)) ok('先检查 useWorkspaces 确实是函数（它是槽传下来的 prop，不是全局）');
  else bad('没有检查 useWorkspaces 是否是函数');
  if (/useWs\(function \(state\)/.test(src)) ok('用 **selector 函数**调用它（真实签名要求）');
  else bad('没有用 selector 函数调用 useWorkspaces —— 签名错了');
  if (/state && state\.items/.test(src)) ok("从 `items` 取（快照里**没有** activeWorkspace）");
  else bad('没有从 items 取 —— 字段名可能又猜错了');
  if (/props\.useWorkspaces/.test(src)) ok('从 props 取 hook（standardProps 是传给组件的）');
  else bad('没有从 props 取 useWorkspaces');
  // 拿不到必须**放弃**而不是崩
  // 拿不到工作区时**不允许崩**：要么退回 null，要么把错误显示出来。
  // （诊断版选择了后者 —— 显示出来比静默退回更有用，因为用户能读到原因。）
  const safeFallback = /catch \(e\) \{\s*return null;/.test(src) || /setDetail\('读工作区失败/.test(src);
  if (safeFallback) ok('取不到时不崩（退回 null 或把错误显示出来）');
  else bad('取不到时没有安全兜底');
}

console.log('\n== 5. 只依赖宿主提供的模块 ==');
if (required.every((r) => r === 'react' || r === 'react/jsx-runtime')) {
  ok(`require 的模块都在宿主白名单内：[${[...new Set(required)].join(', ')}]`);
} else bad(`require 了宿主可能不提供的模块：${required.join(', ')}`);

console.log('');
console.log(`断言总数：${pass + fail}（通过 ${pass}，失败 ${fail}）`);
if (fail > 0) { console.log('有失败项'); process.exit(1); }
console.log('全部通过');
