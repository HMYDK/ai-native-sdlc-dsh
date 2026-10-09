/**
 * @ai-native-sdlc/dsh-sdlc-ui —— **客户端半**（手写，零构建）。
 *
 * 格式见 `@deepseek-ai/dsh-client-ui-brand-official`（官方最小客户端插件，1863 字节）。
 * `Builtin` 的 React 是 "exposed **without JSX transformation**"，
 * 所以 `require("react/jsx-runtime")` 直接调 `jsx(...)` 即可。
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

    let jsx = require('react/jsx-runtime').jsx;
    let React = require('react');

    const ENDPOINT = './api/sdlc-ui.tasks';

    /** 状态 → 颜色。用固定色值而不是主题 token：token 名要查 live Theme，
     *  等面板本身跑通再换（先解决"能不能看到"，再解决"好不好看"）。 */
    const STATUS_COLOR = {
      INTENT: '#94a3b8',
      SPEC: '#60a5fa',
      PLANNED: '#818cf8',
      IMPLEMENTING: '#fbbf24',
      VERIFYING: '#f472b6',
      REVIEWING: '#c084fc',
      DONE: '#34d399',
    };
    const VERDICT_COLOR = { approve: '#34d399', reject: '#f87171', needs_human: '#fbbf24' };

    function Chip(props) {
      return jsx(
        'span',
        {
          style: {
            display: 'inline-block',
            padding: '1px 6px',
            marginRight: '6px',
            borderRadius: '4px',
            fontSize: '10px',
            lineHeight: '16px',
            border: '1px solid ' + props.color,
            color: props.color,
            whiteSpace: 'nowrap',
          },
        },
        props.text,
      );
    }

    function TaskRow(props) {
      const t = props.task;
      const sc = STATUS_COLOR[t.status] || '#94a3b8';
      const children = [
        jsx('span', { key: 'id', style: { fontWeight: '600', marginRight: '6px' } }, t.id),
        jsx(Chip, { key: 'st', text: t.status || '读不出来', color: sc }),
      ];
      if (t.verdict) {
        const v = t.verdict;
        children.push(
          jsx(Chip, {
            key: 'v',
            text:
              v.status +
              ' (' + v.met + '/' + (v.met + v.notMet + v.cannotTell) + ')',
            color: VERDICT_COLOR[v.status] || '#94a3b8',
          }),
        );
      } else {
        children.push(jsx(Chip, { key: 'v', text: '未验证', color: '#64748b' }));
      }
      if (t.artifacts && t.artifacts.length) {
        children.push(
          jsx('span', { key: 'a', style: { color: '#64748b', fontSize: '10px' } },
            t.artifacts.join(' · ')),
        );
      }
      if (t.title) {
        children.push(jsx('div', { key: 'ti', style: { color: '#cbd5e1', marginTop: '2px' } }, t.title));
      }
      return jsx(
        'div',
        {
          style: {
            padding: '6px 8px',
            borderBottom: '1px solid #1e293b',
            fontSize: '11px',
            lineHeight: '16px',
          },
        },
        children,
      );
    }

    /** 面板本体：挂载时取一次数据，带手动刷新。 */
    function SdlcPanel(props) {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null });

      // ⚠️ 把**当前工作区路径**一起传上去 —— 这里我错过两次，都记下来。
      //
      // 为什么必须传：host 半的兄弟插件都按 session 的 cwd 找任务，
      // 而 HTTP 路由请求里没有会话。不传就只能退回 `process.cwd()`，
      // 而桌面 App 的进程 cwd 是 `~/.dsh/profiles/desktop` —— **不是仓库**。
      //
      // ❌ 我第一版写的是：`useWorkspaces()`（无参）取 `snap.activeWorkspace`。
      //    两处都错，查 `dsh-client-runtime` 的类型定义后确认：
      //      · `useWorkspaces: <S>(selector: (state) => S) => S` —— 它要 **selector 函数**
      //      · 快照是 `WorkspaceListState = { items: readonly WorkspaceView[], ... }`
      //        —— **没有 `activeWorkspace` 这个字段**
      //    症状：调用形状错 → 取不到 → 静默退回 null → 不传 cwd →
      //    面板显示 0 个任务（**空白**）。用户看到的就是这个。
      //
      // ⚠️ 而且 `useWorkspaces` 是**槽传下来的 prop**（standardProps），
      // 不是全局变量 —— 所以要从 props 里取。
      //
      // 拿不到就放弃（`null`）：host 会退回进程 cwd，面板至少不崩。
      const workspacePath = (function (props) {
        try {
          const useWs = props && props.useWorkspaces;
          if (typeof useWs !== 'function') return null;
          const items = useWs(function (state) { return state && state.items; });
          if (!Array.isArray(items) || items.length === 0) return null;
          // 哪个是"当前"工作区我们判断不了，所以把**所有**工作区路径都传上去，
          // 由 host 挑第一个真有 .ai/tasks 的。这比赌一个"活动工作区"字段稳。
          const paths = items
            .map(function (w) { return w && typeof w.path === 'string' ? w.path : null; })
            .filter(Boolean);
          return paths.length ? paths.join(',') : null;
        } catch (e) {
          return null;
        }
      })(props);
      const load = React.useCallback(function () {
        setState({ phase: 'loading', data: null, error: null });
        const url = workspacePath
          ? ENDPOINT + '?cwd=' + encodeURIComponent(workspacePath)
          : ENDPOINT;
        fetch(url, { credentials: 'same-origin' })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          })
          .then(function (d) { setState({ phase: 'ready', data: d, error: null }); })
          .catch(function (e) { setState({ phase: 'error', data: null, error: String(e) }); });
      }, []);

      React.useEffect(function () { load(); }, [load]);

      const head = jsx(
        'div',
        {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '6px 8px', borderBottom: '1px solid #334155', fontSize: '11px',
          },
        },
        [
          jsx('span', { key: 'h', style: { fontWeight: '600' } }, 'AI 原生 SDLC'),
          jsx(
            'button',
            {
              key: 'r',
              onClick: load,
              style: {
                background: 'transparent', color: '#94a3b8', border: '1px solid #475569',
                borderRadius: '4px', fontSize: '10px', padding: '1px 6px', cursor: 'pointer',
              },
            },
            '刷新',
          ),
        ],
      );

      let body;
      if (state.phase === 'loading') {
        body = jsx('div', { style: { padding: '8px', color: '#94a3b8', fontSize: '11px' } }, '读取中…');
      } else if (state.phase === 'error') {
        // 失败要**说出来**，不要给一个看起来正常的空看板
        body = jsx('div', { style: { padding: '8px', color: '#f87171', fontSize: '11px' } },
          '取数据失败：' + state.error);
      } else if (!state.data.tasks.length) {
        // ⚠️ 空的看板必须**说清它查了哪里**。
        // 事故：面板曾经一片空白，而"空白"既可能是"真的没任务"，
        // 也可能是"查错了目录"。两者在屏幕上长得一样 —— 这就是最坏的一种失败。
        // 所以把 host 实际试过的路径列出来。
        const searched = state.data.searched || [];
        body = jsx('div', { style: { padding: '8px', color: '#94a3b8', fontSize: '11px' } }, [
          jsx('div', { key: 'm' }, '没有找到任务。查过：'),
          jsx('ul', { key: 'l', style: { margin: '4px 0 0', paddingLeft: '16px' } },
            searched.map(function (p) { return jsx('li', { key: p, style: { wordBreak: 'break-all' } }, p); })),
        ]);
      } else {
        body = jsx('div', {}, state.data.tasks.map(function (t) {
          return jsx(TaskRow, { key: t.id, task: t });
        }));
      }

      return jsx(
        'div',
        {
          style: {
            width: '260px', maxHeight: '60vh', overflow: 'auto',
            background: '#0f172a', color: '#e2e8f0',
            border: '1px solid #334155', borderRadius: '6px',
          },
        },
        [head, body],
      );
    }

    /**
     * 侧栏图标。
     *
     * ⚠️ 槽契约（从 live Slot 树查到，不是我猜的）：
     *   `sidebar.panellist` 是 **list**，注册要 `{id, order, label}`，
     *   owner props 是 `{size, active}` —— 它要的是**一个图标**。
     *   说明原文："Each list id **addresses the matching main panel**;
     *   the sidebar owns the button and resolves its label from list metadata."
     *
     * 所以**按钮由侧栏负责**，我不该自己画按钮、更不该在图标里塞面板。
     * 我第一版把整个面板塞进这里还自己做了 popover —— 架构就是错的。
     */
    function SdlcIcon(props) {
      const size = props && props.size ? props.size : 16;
      const active = !!(props && props.active);
      return jsx(
        'svg',
        {
          width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
          stroke: active ? '#e879f9' : 'currentColor',
          strokeWidth: '1.4', strokeLinecap: 'round', strokeLinejoin: 'round',
        },
        [
          // 三个堆叠的方块 —— 制品链的意思
          jsx('rect', { key: 'a', x: '1.5', y: '1.5', width: '6', height: '4', rx: '1' }),
          jsx('rect', { key: 'b', x: '8.5', y: '6', width: '6', height: '4', rx: '1' }),
          jsx('rect', { key: 'c', x: '1.5', y: '10.5', width: '6', height: '4', rx: '1' }),
        ],
      );
    }

    /**
     * 中央面板本体。
     *
     * 挂到 `main` 槽的 **key=`sdlc``** 上 —— 侧栏那个 `id='sdlc'` 的图标
     * 按下时会 dispatch 同一个 key，于是这里被渲染。
     * 不需要自己做开关：**选中态由侧栏与 main 槽负责**。
     */
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
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
