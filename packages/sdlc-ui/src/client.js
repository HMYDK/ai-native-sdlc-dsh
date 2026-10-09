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
        return jsx('pre', {
          style: { padding: '10px', fontSize: '11px', color: '#f87171', whiteSpace: 'pre-wrap' },
        }, 'SdlcPanel 渲染抛错：\n' + (e && e.stack ? e.stack : String(e)));
      }
    }

    function SdlcPanelInner(props) {
      // ── 阶段 1：渲染了没有？（纯静态，不碰任何 hook 或 IO）
      const [phase, setPhase] = React.useState('1: 已挂载');
      const [detail, setDetail] = React.useState('');
      const [tasks, setTasks] = React.useState(null);

      React.useEffect(function () {
        // ── 阶段 2：hooks 跑起来了吗？
        setPhase('2: effect 已运行');
        let paths = '';
        try {
          const useWs = props && props.useWorkspaces;
          if (typeof useWs !== 'function') {
            setDetail('props.useWorkspaces 不可用（不是函数）');
          } else {
            const items = useWs(function (state) { return state && state.items; });
            if (Array.isArray(items)) {
              paths = items
                .map(function (w) { return w && typeof w.path === 'string' ? w.path : null; })
                .filter(Boolean)
                .join(',');
              setDetail('工作区 ' + items.length + ' 个');
            } else {
              setDetail('useWorkspaces 返回的不是数组');
            }
          }
        } catch (e) {
          setDetail('读工作区失败：' + String(e).slice(0, 80));
        }

        // ── 阶段 3：取数通不通？
        setPhase('3: 正在取数');
        const url = './api/sdlc-ui.tasks' + (paths ? '?cwd=' + encodeURIComponent(paths) : '');
        fetch(url, { credentials: 'same-origin' })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          })
          .then(function (d) {
            setPhase('4: 取数成功');
            setTasks(d && d.tasks ? d.tasks : []);
            setDetail((d && d.tasks ? d.tasks.length : 0) + ' 个任务 · ' + String(d && d.searched));
          })
          .catch(function (e) {
            setPhase('3x: 取数失败');
            setDetail(String(e).slice(0, 120));
          });
      }, []);

      const rows = [];
      rows.push(jsx('div', { key: 'h', style: { fontWeight: '600', marginBottom: '4px' } }, 'AI 原生 SDLC'));
      rows.push(jsx('div', { key: 'p', style: { color: '#fbbf24' } }, phase));
      if (detail) rows.push(jsx('div', { key: 'd', style: { color: '#94a3b8', marginTop: '2px' } }, detail));
      if (tasks) {
        if (tasks.length === 0) {
          rows.push(jsx('div', { key: 'e', style: { marginTop: '6px' } }, '（任务列表为空）'));
        } else {
          tasks.forEach(function (t) {
            rows.push(jsx(TaskRow, { key: t.id, task: t }));
          });
        }
      }
      return jsx(
        'div',
        { style: { padding: '10px', fontSize: '11px', lineHeight: '16px', color: '#e2e8f0' } },
        rows,
      );
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
