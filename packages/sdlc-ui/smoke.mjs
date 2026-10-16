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
      // ⚠️ useEffect **必须真的跑**。
      // 组件体里的错误（比如引用了没声明的常量）很多只在 effect 里触发，
      // 而"不执行的 useEffect"会让这类错误在冒烟里完全隐形。
      // 实测踩到：`POLL_MS is not defined` —— 客户端半加载失败，
      // 浏览器只给一句 "1 entry did not activate"，而冒烟全绿。
      useEffect: (fn) => {
        try { const r = fn(); if (typeof r === 'function') r(); } catch (e) { /* 由断言报出 */ }
      },
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
  // ⚠️ apply 必须被 try 包住：它内部引用了注册的组件，
  // 而一个 undefined 组件会让 **整个冒烟脚本崩掉** —— 崩溃不是干净的失败，
  // 它连断言报告都打不出来（实测踩到：看起来像"没有输出"）。
  try {
    mod.apply(ctx);
  } catch (e) {
    bad(`apply() 抛错（后面所有 slot 断言都不可信）：${String(e).slice(0, 140)}`);
    registered.length = 0;
  }

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
    // ⚠️ 用**会执行 effect** 的 React 旋钮重新渲染一次，并捕获异常。
    // 这一步就是"POLL_MS 事故"的回归：不跑 effect 就测不出组件体里的自由变量错误。
    {
      // 直接复用上面的 fakeRequire 拿 jsx 运行时，但换一个**会跑 effect** 的 react 桩
      const rt = fakeRequire('react/jsx-runtime');
      let crashed = null;
      const realRequire = (id) => {
        if (id === 'react/jsx-runtime') return rt;
        if (id === 'react') {
          return {
            createElement: (t, p, ...c) => ({ $$jsx: true, type: t, props: p, c }),
            useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
            useEffect: (fn) => { const r = fn(); if (typeof r === 'function') r(); },
            useCallback: (fn) => fn,
          };
        }
        throw new Error('unexpected require ' + id);
      };
      globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ tasks: [], searched: [] }) });
      try {
        const m2 = loaded.factory(realRequire);
        m2.apply({ slots: { inject: (k, cb) => { for (const _ of cb()) {} return () => {}; }, register: () => () => {} } });
      } catch (e) { crashed = e; }
      if (crashed) bad(`apply/渲染（含执行 effect）抛错：${String(crashed).slice(0, 140)}`);
      else ok('apply + 组件构造（**含真的执行 useEffect**）不抛错');
    }
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

console.log('\n== 4c. cwd 由 host 自己解析（客户端不再传）==');
{
  const hostSrc = fs.readFileSync(path.join(DIR, 'lib/index.js'), 'utf8');
  // ⚠️ 架构变过一次，理由要记住：
  // 最初客户端把工作区路径作为 ?cwd= 传上来，靠 `props.useWorkspaces`。
  // 但那个 hook 的签名是 `<S>(selector) => S`、快照里是 `items` 而不是
  // `activeWorkspace` —— 我猜错两次，结果是**静默退回进程 cwd**，
  // 而桌面 App 的进程 cwd 是 `~/.dsh/profiles/desktop`（不是仓库）→ 面板显示 0 个任务。
  //
  // 现在的做法更可靠：**host 直接读 DSH 自己持久化的工作区列表**
  // （`~/.dsh/storages/workspace.json`），不依赖客户端能不能正确读 hook。
  if (hostSrc.includes("'storages'") && hostSrc.includes('workspace.json')) {
    ok('host 读 DSH 持久化的工作区列表（不依赖客户端传参）');
  } else bad('host 没有读工作区持久化 —— 桌面 App 下会退回 profile 目录，找不到任务');
  if (hostSrc.includes("searchParams.get('cwd')")) ok('host 仍然接受 ?cwd=（客户端能传时优先用）');
  else bad('host 不接受 ?cwd=');
  if (hostSrc.includes("!== '/'")) ok('host 对 cwd 做了校验（不给任意目录读取）');
  else bad('host 没校验 cwd');
  // 客户端**不该**再依赖那个 hook
  const src = fs.readFileSync(bundle, 'utf8');
  if (/props\.useWorkspaces|useWorkspaces/.test(src)) {
    bad('客户端还在用 useWorkspaces（那条路已证明不可靠，应删掉）');
  } else ok('客户端不再依赖 useWorkspaces（那条路猜错过两次）');
}

console.log('\n== 4d. 注册的组件必须真的存在（这条是补的事故）==');
{
  // ⚠️ 事故：重写面板体时把 `SdlcPanel` 的定义一起删掉了，
  // 而 `apply` 里注册的正是它 → **客户端半整包加载失败**，
  // 浏览器只给一句 "web boot: 1 entry did not activate"，没有细节。
  //
  // 冒烟当时**没抓到**，因为它调用注册的组件时用的是假 React，
  // 而假 React 的 useState 不检查组件类型 —— 一个 undefined 组件
  // 在假 React 下"能构造成功"。
  //
  // 所以这里改成在**求值 bundle 时**就检查：apply 注册的每个 component
  // 必须是函数。undefined 会让这条直接红。
  const src = fs.readFileSync(bundle, 'utf8');
  if (/function SdlcPanel\(/.test(src)) ok('SdlcPanel 有定义（曾因缺它整包加载失败）');
  else bad('SdlcPanel 没有定义 —— apply 会注册 undefined，客户端半整包加载失败');
  const reg = [];
  const ctx2 = {
    slots: {
      inject(key, cb) { for (const _ of cb()) { /* 迭代以触发注册 */ } return () => {}; },
      register(opts, component) { reg.push({ opts, component }); return () => {}; },
    },
  };
  try {
    mod.apply(ctx2);
    const undef = reg.filter((r) => typeof r.component !== 'function');
    if (undef.length === 0) ok(`apply 注册的 ${reg.length} 个组件都是函数`);
    else bad(`注册了 undefined 组件：${JSON.stringify(undef.map((u) => u.opts))}`);
  } catch (e) {
    bad(`apply() 抛错：${String(e).slice(0, 120)}`);
  }
}

console.log('\n== 4f. 交付物端点的安全（新开了一个读取面，所以要钉住）==');
{
  const hostSrc = fs.readFileSync(path.join(DIR, 'lib/index.js'), 'utf8');
  const src = fs.readFileSync(bundle, 'utf8');
  // 端点存在
  if (hostSrc.includes("'/api/sdlc-ui.artifact'")) ok('注册了 /api/sdlc-ui.artifact');
  else bad('没有注册交付物端点 —— 点开交付物会 404');
  // ⚠️ 白名单必须来自 artifacts 登记表，而不是"临时写的正则"
  if (hostSrc.includes('Object.values(st.artifacts)') && hostSrc.includes('allowed.includes')) {
    ok('白名单来自 artifacts 登记表（事实来源），不是临时正则');
  } else bad('白名单没有走 artifacts 登记表 —— 可能变成任意文件读取器');
  if (hostSrc.includes('不在该任务的 artifacts 登记表里')) ok('越权时明确拒绝并说明可读清单');
  else bad('越权时没有拒绝');
  // 路径穿越
  if (hostSrc.includes("want.includes('..')")) ok('拒绝含 .. 的文件名（路径穿越）');
  else bad('没有拒绝路径穿越');
  if (hostSrc.includes('/^[A-Za-z0-9_-]+$/.test(task)')) ok('task 名有形状校验');
  else bad('task 名没有形状校验');
  // 客户端必须真的会去取内容
  if (src.includes("'./api/sdlc-ui.artifact?task='")) ok('客户端用相对路径取交付物内容');
  else bad('客户端没有取交付物内容');
  // 流程条上必须能直接看到交付物名（用户的原始要求）
  if (/art\.file/.test(src) && /onOpen\(art\.file\)/.test(src)) {
    ok('流程条上的交付物名可点（用户要求"可以直接看出来 + 可以点击查看"）');
  } else bad('流程条上没有可点的交付物名');
}

console.log('\n== 4g. 聚合之后，每个任务必须标出**来源工作区** ==');
{
  // ⚠️ 为什么单开一节：看板现在**跨工作区聚合**。任务不带来源的话，
  // 一列里混着几个仓库的任务就分不清谁是谁 —— 而"看板显示的到底是哪个仓库"
  // 正是这次事故的起点：面板只显示 workspace-a 的残留任务 RSI-1，
  // 另外两个工作区里的 8 个真实任务一条都没出现，用户以为自己的任务没人管。
  //
  // ⚠️ 而且上面 4d 那次渲染用的是**空任务列表**（data 初始为 null），
  // 标签这条渲染路径从来没被执行过。"加载 ≠ 可用"本仓库已经吃过一次亏，
  // 所以这里把 data **预置**成聚合结果，真的把标签画出来再断言。
  const rt2 = fakeRequire('react/jsx-runtime');
  const mk = (id, label, root, status, title) => ({
    id, repoRoot: root, repoLabel: label, status, title,
    // ⚠️ 夹具的形状必须**照抄服务端下发的形状**：`artifacts` 是数组
    // （`{kind,file,sections,bytes}`），不是 state.yaml 里那个 map。
    // 写成对象时 Stepper 会当场 `(t.artifacts||[]).find is not a function` ——
    // 这是夹具的错，不是产品的错，但它照样能把面板变成一屏堆栈。
    artifacts: [], timeline: [], durations: [], blocked: [], verdict: null, review: null,
  });
  const payload = {
    at: '', repoRoot: '/tmp/wsB', searched: [],
    roots: [
      { root: '/tmp/wsB', label: '工作区B', taskCount: 1 },
      { root: '/tmp/wsA', label: '工作区A', taskCount: 1 },
    ],
    tasks: [
      mk('BBB-2', '工作区B', '/tmp/wsB', 'DONE', 'B 的任务'),
      mk('AAA-1', '工作区A', '/tmp/wsA', 'SPEC', 'A 的任务'),
    ],
  };
  globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });

  /** 采集渲染树里的所有文字。 */
  const textsOf = (node, out, depth) => {
    if (depth > 40) return; // 组件互相引用成环时的保险，不是正常路径
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
    if (Array.isArray(node)) { for (const n of node) textsOf(n, out, depth + 1); return; }
    if (node.$$jsx) {
      // ⚠️ 这里的 jsx 桩只产出**元素描述**，不会调用子组件。
      // 不主动展开 `type` 是函数的那种节点，断言就只看得见面板体直接写出来的
      // 文字，看不到 TaskLine / VariantA 里画的任何东西 —— 我第一次就是这么
      // 写出一个"永远红"的断言的。
      if (typeof node.type === 'function') { textsOf(node.type(node.props || {}), out, depth + 1); return; }
      const p = node.props || {};
      textsOf(p.children, out, depth + 1);
      textsOf(node.c, out, depth + 1);
    }
  };

  /**
   * 用**预置 state**渲染面板：data(0) 有值、loading(2)=false、variant(3)=要测的，
   * 于是第一次渲染就走数据分支 —— 标签那条路径真的被执行。
   * 其余 hook 与 4d 一致（`useEffect` 必须真的跑，跑完立刻清理，免得定时器吊住进程）。
   */
  const render = (variant) => {
    const store = [payload, null, false, variant, null, null];
    let i = 0;
    const req = (id) => {
      if (id === 'react/jsx-runtime') return rt2;
      if (id === 'react') {
        return {
          createElement: (t, p, ...c) => ({ $$jsx: true, type: t, props: p, c }),
          useState: (init) => {
            const n = i++;
            if (!(n in store)) store[n] = typeof init === 'function' ? init() : init;
            return [store[n], (v) => { store[n] = typeof v === 'function' ? v(store[n]) : v; }];
          },
          useEffect: (fn) => { const r = fn(); if (typeof r === 'function') r(); },
          useCallback: (fn) => fn,
        };
      }
      throw new Error('unexpected require ' + id);
    };
    const m = loaded.factory(req);
    let comp = null;
    m.apply({
      slots: {
        inject: (k, cb) => { for (const _ of cb()) {} return () => {}; },
        register: (opts, c) => { if (opts.name === 'main') comp = c; return () => {}; },
      },
    });
    if (typeof comp !== 'function') throw new Error('main 槽没拿到组件');
    return comp({});
  };

  for (const v of ['A', 'C']) {
    let tree = null;
    let err = null;
    try { tree = render(v); } catch (e) { err = e; }
    if (err) { bad(`变体 ${v}：带数据渲染抛错（面板会变成一屏错误堆栈）：${String(err).slice(0, 140)}`); continue; }
    const out = [];
    textsOf(tree, out);
    const all = out.join('\n');
    if (all.includes('工作区A') && all.includes('工作区B')) {
      ok(`变体 ${v}：两条任务的**来源工作区**都画出来了`);
    } else bad(`变体 ${v}：来源标签没画出来 —— 聚合之后分不清任务属于哪个仓库`);
    if (all.includes('2 个工作区')) ok(`变体 ${v}：顶栏报出聚合范围（几个工作区 / 几个任务）`);
    else bad(`变体 ${v}：顶栏没报聚合范围 —— 用户无法知道看板在看哪儿`);
  }
}

console.log('\n== 5. 只依赖宿主提供的模块 ==');
if (required.every((r) => r === 'react' || r === 'react/jsx-runtime')) {
  ok(`require 的模块都在宿主白名单内：[${[...new Set(required)].join(', ')}]`);
} else bad(`require 了宿主可能不提供的模块：${required.join(', ')}`);

console.log('');
console.log(`断言总数：${pass + fail}（通过 ${pass}，失败 ${fail}）`);
if (fail > 0) { console.log('有失败项'); process.exit(1); }
console.log('全部通过');
