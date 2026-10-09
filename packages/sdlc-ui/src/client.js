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
    function SdlcPanel() {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null });

      const load = React.useCallback(function () {
        setState({ phase: 'loading', data: null, error: null });
        fetch(ENDPOINT, { credentials: 'same-origin' })
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
        body = jsx('div', { style: { padding: '8px', color: '#94a3b8', fontSize: '11px' } },
          '这个仓库里还没有任务（.ai/tasks/*）');
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

    /** 侧栏面板列表里的一个按钮，点开才显示面板（不占常驻空间）。 */
    function SdlcPanelButton() {
      const [open, setOpen] = React.useState(false);
      const btn = jsx(
        'button',
        {
          onClick: function () { setOpen(!open); },
          title: 'AI 原生 SDLC 看板',
          style: {
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: open ? '#e879f9' : '#94a3b8', fontSize: '11px', padding: '2px 6px',
          },
        },
        'SDLC',
      );
      if (!open) return btn;
      return jsx('div', { style: { position: 'relative' } }, [
        btn,
        jsx('div', { key: 'p', style: { position: 'absolute', left: '0', top: '20px', zIndex: 50 } },
          jsx(SdlcPanel, {})),
      ]);
    }

    const inject = ['slots'];

    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', function* () {
        yield ctx.slots.register({ name: 'sidebar.panellist' }, SdlcPanelButton);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
