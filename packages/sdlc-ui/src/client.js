/**
 * @ai-native-sdlc/dsh-sdlc-ui —— **客户端半**（手写，零构建）。
 *
 * 格式见 `@deepseek-ai/dsh-client-ui-brand-official`（官方最小客户端插件，1863 字节）。
 * `Builtin` 的 React 是 "exposed **without JSX transformation**"，
 * 所以 `require("react/jsx-runtime")` 直接调 `h(...)` 即可。
 *
 * ## 数据从哪来
 *
 * 从本包 **host 半**注册的认证路由取：`GET ./sdlc-ui.tasks`
 *（注册在已认证的 `/api` 通道上，见 `src/index.ts` 的说明）。
 *
 * 相对路径（`./api/...`）而不是绝对路径：页面有 `<base href="./">`，
 * 所以相对写法在任何挂载前缀下都对。
 */
window.__ModuleLoader__.load({
  id: '@ai-native-sdlc/dsh-sdlc-ui',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    // ⚠️ 必须同时拿 jsx 与 jsxs，**不能只用 jsx**。
    //
    // 事故：面板渲染出一个**空的 div**，零错误、零警告。
    // 根因：React 的 `h(type, props)` 是**两参数**的 ——
    // `jsx(type, props, key)` 的第三个位置是 **key**，而 `children` 必须放在
    // props 里。我写 `h('div', { style }, rows)` 把 children 放在了第三个位置，
    // 于是 React **静默丢弃**了整个 children。不报错，只是什么都不画。
    //
    // `h(type, props, key)` 是**接受数组 children** 的那个变体。
    // 官方包用的是命名空间调用 `runtime.h(...)` 并把 children 放进 props ——
    // 两种都对，但**不能**把数组塞进 `jsx` 的第三个参数。
    let jsxRuntime = require('react/jsx-runtime');

    /**
     * `h(type, props, children)` —— **children 放进 props**，不依赖第三个参数。
     *
     * 为什么不直接用 runtime 的 `jsx`：它的签名是 `h(type, props, key)`，
     * 第三个位置是 **key**，`children` **必须在 props 里**。
     * 我原来的代码把 children 放在第三个位置，React **静默丢弃**——
     * 面板渲染出一个空 div，零错误零警告。这个助手就是为了让那种写法不可能再出现。
     *
     * children 是数组时走 `jsxs`（它才是接受数组的那个变体）。
     */
    function h(type, props, children) {
      const merged = props ? Object.assign({}, props) : {};
      if (children !== undefined) merged.children = children;
      const use = Array.isArray(children) ? jsxRuntime.jsxs : jsxRuntime.jsx;
      return use(type, merged);
    }
    let React = require('react');

    const ENDPOINT = './api/sdlc-ui.tasks';

    /**
     * ## 样式：全部走主题 token，不写死任何颜色
     *
     * ⚠️ 我第一版写死了深色（`#0f172a` 那套），结果在浅色主题下是一块
     * **突兀的黑块**——用户的原话是"一点审美都没有"。那不是设计，
     * 那只是先让它能跑。而硬编码颜色的必然结果就是：**它只在一个主题下成立。**
     *
     * 这些 `--dsw-alias-*` token 由主题在 `<body>` 上解析，
     * 所以**浅色/深色自动都对**，不需要我判断当前主题。
     * 官方取值（浅色）：标题 `#0f1115`，次要 `#61666b`，
     * 边框 `#0000000a`/`#0000001a`，成功 `#22c55e`，警告 `#f59e0b`，错误 `#ec1313`。
     */
    const T = {
      fg: 'var(--dsw-alias-label-primary)',
      fg2: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      brand: 'var(--dsw-alias-brand-primary)',
    };

    /** 状态 → token。用**状态色 token**，不是自己挑的紫绿蓝。 */
    const STATUS_COLOR = {
      INTENT: T.idle,
      SPEC: T.fg2,
      PLANNED: T.fg2,
      IMPLEMENTING: T.warn,
      VERIFYING: T.brand,
      REVIEWING: T.brand,
      DONE: T.ok,
    };
    const VERDICT_COLOR = { approve: T.ok, reject: T.err, needs_human: T.warn };

    /**
     * 小标签。
     *
     * 刻意做得**轻**：透明底 + 同色描边，字号比正文小一档。
     * 一屏要放三个标签（状态/裁决/制品），实心底会糊成一片。
     */
    function Pill(props) {
      return h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center',
          padding: '0 6px', height: '18px',
          borderRadius: '9px',
          border: '1px solid ' + props.color,
          color: props.color,
          fontSize: '11px', lineHeight: '18px', fontWeight: '500',
          whiteSpace: 'nowrap',
          // 同色 10% 底：够看出是个"块"，又不抢眼
          background: 'color-mix(in srgb, ' + props.color + ' 10%, transparent)',
        },
      }, props.text);
    }

    /** 一个任务 = 一张卡。用卡片而不是"一条一条带下划线"，让边界自然成立。 */
    function TaskCard(props) {
      const t = props.task;
      const sc = STATUS_COLOR[t.status] || T.idle;
      const v = t.verdict;

      const badges = [h(Pill, { key: 's', text: t.status || '读不出来', color: sc })];
      if (v) {
        const total = v.met + v.notMet + v.cannotTell;
        badges.push(h(Pill, {
          key: 'v',
          text: v.status === 'approve' ? '通过 ' + v.met + '/' + total
            : v.status === 'reject' ? '驳回'
            : '待人工 ' + v.met + '/' + total,
          color: VERDICT_COLOR[v.status] || T.idle,
        }));
      } else {
        badges.push(h(Pill, { key: 'v', text: '未验证', color: T.idle }));
      }

      const rows = [
        h('div', { key: 'top', style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } }, [
          h('span', { key: 'id', style: { fontSize: '12px', fontWeight: '600', color: T.fg, letterSpacing: '0.01em' } }, t.id),
          ...badges,
        ]),
      ];
      if (t.title) {
        rows.push(h('div', {
          key: 'ti',
          style: { marginTop: '4px', fontSize: '12px', lineHeight: '18px', color: T.fg2 },
        }, t.title));
      }
      if (t.artifacts && t.artifacts.length) {
        rows.push(h('div', {
          key: 'ar',
          style: { marginTop: '6px', display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' },
        }, [
          h('span', { key: 'l', style: { fontSize: '10px', color: T.fg2, marginRight: '2px' } }, '制品'),
          ...t.artifacts.map(function (a) {
            return h('span', {
              key: a,
              style: {
                fontSize: '10px', color: T.fg2, padding: '0 5px', height: '16px', lineHeight: '16px',
                borderRadius: '4px', background: 'var(--dsw-alias-bg-layer-2)',
                border: '1px solid ' + T.border,
              },
            }, a);
          }),
        ]));
      }

      return h('div', {
        style: {
          padding: '10px 12px',
          borderRadius: '10px',
          background: T.layer1,
          border: '1px solid ' + T.border,
          marginBottom: '8px',
        },
      }, rows);
    }

    /**
     * 面板本体。
     *
     * ## ⚠️ 为什么它是"分阶段"的
     *
     * 用户报告点开之后**完全空白**，而我看不到浏览器控制台。
     * 一个空白可能是很多原因：hooks 抛错、fetch 被拒、结果处理崩了、
     * 或者**根本没被挂载**。它们在屏幕上长得一样。
     *
     * 所以这个组件**先画静态内容，再逐步加东西**——每一步都可能把
     * 当前进度写进自己那行文字里。这样"空白"就有了位置：
     *   · 连 "阶段 1" 都看不到 → 槽没渲染我，问题在注册契约
     *   · 停在 "阶段 2/3" → hooks 或取数挂了，错误会显示出来
     *   · 走到 "阶段 4" → 挂载与取数都好，问题在渲染数据那一步
     *
     * **这个设计是临时的**：等确认了是哪一段，就删掉这些标记。
     * 它存在的理由只有一个——让"空白"变成一句能读的话。
     */
    /**
     * ⚠️ 包一层 try/catch —— React 的渲染异常会让**整个子树消失**，
     * 表现就是"什么都不显示"。用户看到的"空白"很可能就是这个。
     *
     * 所以：**自己捕获，把异常当成内容画出来**。
     * 错误就变成了屏幕上能读的一行字，而不是一片空白。
     */
    function SdlcPanel(props) {
      try {
        return SdlcPanelInner(props);
      } catch (e) {
        return h('pre', {
          style: { padding: '20px 24px', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
        }, 'SdlcPanel 渲染抛错：\n' + (e && e.stack ? e.stack : String(e)));
      }
    }

    /**
     * 面板本体。
     *
     * ## 数据什么时候更新
     *
     * **每 10 秒轮询一次**，另外有手动「刷新」按钮。
     *
     * 为什么选轮询而不是"实时"：端点在本地读几个小文件，开销可忽略；
     * 而任务状态的**真实变化频率很低**（分钟到小时级），
     * 为它上 SSE/WebSocket 是拿复杂度换一个用不上的指标。
     *
     * ⚠️ 轮询必须在卸载时清掉，否则每次开关面板都多一个定时器。
     */
    const POLL_MS = 10000;

    function SdlcPanelInner(props) {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(true);

      const load = React.useCallback(function () {
        // 工作区路径：能拿到就传（host 会优先用；拿不到 host 自己会去读
        // DSH 持久化的工作区列表，所以这里失败不影响结果）。
        let paths = '';
        try {
          const useWs = props && props.useWorkspaces;
          if (typeof useWs === 'function') {
            const items = useWs(function (state) { return state && state.items; });
            if (Array.isArray(items)) {
              paths = items
                .map(function (w) { return w && typeof w.path === 'string' ? w.path : null; })
                .filter(Boolean)
                .join(',');
            }
          }
        } catch (e) { /* host 侧有兜底，这里静默 */ }

        const url = './api/sdlc-ui.tasks' + (paths ? '?cwd=' + encodeURIComponent(paths) : '');
        return fetch(url, { credentials: 'same-origin' })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          })
          .then(function (d) {
            if (d && d.error) throw new Error(d.error);
            setData(d);
            setError(null);
            setLoading(false);
          })
          .catch(function (e) {
            setError(String(e && e.message ? e.message : e).slice(0, 160));
            setLoading(false);
          });
      }, []);

      React.useEffect(function () {
        let alive = true;
        load();
        const timer = setInterval(function () { if (alive) load(); }, POLL_MS);
        return function () { alive = false; clearInterval(timer); };
      }, [load]);

      const rows = [];
      rows.push(h('div', {
        key: 'h',
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' },
      }, [
        h('span', { key: 't', style: { fontWeight: '600' } }, 'AI 原生 SDLC'),
        h('button', {
          key: 'r',
          onClick: function () { setLoading(true); load(); },
          style: {
            background: 'transparent', color: T.fg2, border: '1px solid ' + T.border2,
            borderRadius: '6px', fontSize: '11px', height: '24px', padding: '0 10px', cursor: 'pointer',
          },
        }, '刷新'),
      ]));

      if (error) {
        rows.push(h('div', { key: 'e', style: { color: T.err } }, '取数据失败：' + error));
      } else if (loading && !data) {
        rows.push(h('div', { key: 'l', style: { color: T.fg2 } }, '读取中…'));
      } else if (data && (!data.tasks || data.tasks.length === 0)) {
        // ⚠️ 空看板**必须说清查了哪里**：事故里"空白"既可能是真没任务、
        // 也可能是查错了目录，两者在屏幕上长得一样。
        const searched = data.searched || [];
        rows.push(h('div', { key: 'm', style: { color: T.fg2 } }, '没有找到任务。查过：'));
        rows.push(h('ul', { key: 'u', style: { margin: '4px 0 0', paddingLeft: '16px', color: T.fg2 } },
          searched.map(function (p) { return h('li', { key: p, style: { wordBreak: 'break-all' } }, p); })));
      } else if (data) {
        rows.push(h('div', { key: 'n', style: { color: T.fg2, marginBottom: '10px', fontSize: '11px' } },
          data.tasks.length + ' 个任务'));
        data.tasks.forEach(function (t) { rows.push(h(TaskCard, { key: t.id, task: t })); });
      }

      return h('div', {
        style: {
          padding: '20px 24px',
          maxWidth: '760px',
          margin: '0 auto',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          fontSize: '12px',
          lineHeight: '18px',
          color: T.fg,
        },
      }, rows);
    }

    /**
     * 侧栏图标。
     *
     * ⚠️ 槽契约（从 live Slot 树查到，不是猜的）：
     *   `sidebar.panellist` 是 **list**，注册要 `{id, order, label}`，
     *   owner props 是 `{size, active}` —— 它要的是**一个图标**。
     *   说明原文："Each list id **addresses the matching main panel**;
     *   the sidebar owns the button and resolves its label from list metadata."
     *
     * 所以**按钮由侧栏负责**，我不该自己画按钮、更不该在图标里塞面板。
     */
    function SdlcIcon(props) {
      const size = props && props.size ? props.size : 16;
      const active = !!(props && props.active);
      return h(
        'svg',
        {
          width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '1.4', strokeLinecap: 'round', strokeLinejoin: 'round',
        },
        [
          // 三个堆叠的方块 —— 制品链的意思
          h('rect', { key: 'a', x: '1.5', y: '1.5', width: '6', height: '4', rx: '1' }),
          h('rect', { key: 'b', x: '8.5', y: '6', width: '6', height: '4', rx: '1' }),
          h('rect', { key: 'c', x: '1.5', y: '10.5', width: '6', height: '4', rx: '1' }),
        ],
      );
    }

    /** 需要的服务：slot 注册表。 */
    const inject = ['slots'];

    /** 面板的 key。侧栏的 `id` 与 `main` 的 `key` **必须是同一个字符串**。 */
    const PANEL_ID = 'sdlc';

    function apply(ctx) {
      // 两处注册，两个槽：侧栏一个图标，主列一个面板。
      // 图标与面板靠 **同一个 id/key** 配对 —— 这是槽契约规定的，
      // 不是我自己连的。
      ctx.slots.inject('sidebar.panellist', function* () {
        yield ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: 'SDLC' },
          SdlcIcon,
        );
      });
      ctx.slots.inject('main', function* () {
        yield ctx.slots.register({ name: 'main', key: PANEL_ID }, SdlcPanel);
      });
      // ⚠️ 这一行是**故意的诊断**，别删。
      // 用户报告"点击之后完全空白"，而我看不到浏览器控制台。
      // `console` 是 Builtin 明确提供的出口（"Package-tagged browser logging"），
      // 所以它会在控制台打出**带包名前缀**的行。
      // 连这行都没有 ⇒ 客户端半**根本没被执行**，问题在加载而不是我组件里。
      console.log('apply() 已运行：注册了 sidebar.panellist + main，key=' + PANEL_ID);
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
