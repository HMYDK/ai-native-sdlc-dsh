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

    /** 人读的时间：秒/分/时/天。面板上不该出现 "1273000ms"。 */
    function humanMs(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '';
      const s = Math.round(ms / 1000);
      if (s < 60) return s + ' 秒';
      const m = Math.floor(s / 60);
      if (m < 60) return m + ' 分钟';
      const h = Math.floor(m / 60);
      if (h < 24) return h + ' 小时 ' + (m % 60) + ' 分';
      return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时';
    }
    function shortTime(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      const p = (n) => String(n).padStart(2, '0');
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    const STAGES = ['INTENT', 'SPEC', 'PLANNED', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'DONE'];
    /** 阶段的中文名 —— 面板是给人看的，英文枚举名不该出现在正文里。 */
    const STAGE_CN = {
      INTENT: '意图', SPEC: '规格', PLANNED: '计划', IMPLEMENTING: '实现',
      VERIFYING: '验证', REVIEWING: '评审', DONE: '完成',
    };
    const STAGE_ARTIFACT = { INTENT: 'intent', SPEC: 'spec', PLANNED: 'plan', VERIFYING: 'verification', REVIEWING: 'review' };

    /**
     * 阶段轨：一条竖线的流程，每个阶段显示**它的产出物**。
     *
     * 这是这个面板存在的理由。原来我只显示一个状态徽章 ——
     * 而人真正想知道的是"**每个阶段各交付了什么、现在卡在哪一门**"。
     */
    function StageRail(props) {
      const t = props.task;
      const cur = STAGES.indexOf(t.status);
      const byKind = {};
      (t.artifacts || []).forEach(function (a) { byKind[a.kind] = a; });

      const rows = [];
      STAGES.forEach(function (stage, i) {
        const done = cur >= 0 && i < cur;
        const active = i === cur;
        const art = STAGE_ARTIFACT[stage] ? byKind[STAGE_ARTIFACT[stage]] : null;
        const dur = (t.durations || []).find(function (d) { return d.stage === STAGES[i - 1]; });

        // 左边的点与连线
        const dot = h('span', {
          key: 'dot',
          style: {
            position: 'absolute', left: '0', top: '3px',
            width: '9px', height: '9px', borderRadius: '50%',
            border: '2px solid ' + (active ? T.brand : done ? T.ok : T.border2),
            background: done || active ? (active ? T.brand : T.ok) : 'transparent',
            boxSizing: 'border-box',
          },
        });
        const line = i < STAGES.length - 1
          ? h('span', {
              key: 'line',
              style: {
                position: 'absolute', left: '4px', top: '14px', bottom: '-6px', width: '1px',
                background: done ? T.ok : T.border,
              },
            })
          : null;

        const line2 = [];
        line2.push(h('span', {
          key: 'nm',
          style: {
            fontSize: '12px', fontWeight: active ? '600' : '500',
            color: active ? T.fg : done ? T.fg : T.fg2,
            marginRight: '6px',
          },
        }, STAGE_CN[stage] || stage));
        // 这一门待了多久
        if (dur && dur.ms > 2000) {
          line2.push(h('span', { key: 'd', style: { fontSize: '10px', color: T.fg2, marginRight: '6px' } },
            humanMs(dur.ms)));
        }
        // 产出物
        if (art) {
          line2.push(h('span', {
            key: 'a',
            title: (art.sections || []).join('  ·  '),
            style: {
              fontSize: '10px', color: T.fg2, padding: '0 5px', height: '16px', lineHeight: '15px',
              borderRadius: '4px', background: 'var(--dsw-alias-bg-layer-2)',
              border: '1px solid ' + T.border, marginRight: '4px',
            },
          }, art.file + '  ' + (art.bytes ? Math.round(art.bytes / 100) / 10 + 'k' : '')));
          // 章节骨架 —— 这是"交付物长什么样"
          if (art.sections && art.sections.length) {
            line2.push(h('span', { key: 's', style: { fontSize: '10px', color: T.fg2 } },
              art.sections.slice(0, 6).join(' · ') + (art.sections.length > 6 ? ' …' : '')));
          }
        } else if (active && STAGE_ARTIFACT[stage]) {
          line2.push(h('span', { key: 'miss', style: { fontSize: '10px', color: T.warn } },
            '缺 ' + STAGE_ARTIFACT[stage]));
        }
        // 验证门的结论
        if (stage === 'VERIFYING' && t.verdict) {
          const v = t.verdict;
          const total = v.met + v.notMet + v.cannotTell;
          line2.push(h(Pill, {
            key: 'v',
            text: (v.status === 'approve' ? '通过 ' : v.status === 'reject' ? '驳回 ' : '待人工 ') + v.met + '/' + total,
            color: VERDICT_COLOR[v.status] || T.idle,
          }));
          if (v.unverified > 0) {
            line2.push(h('span', { key: 'u', style: { fontSize: '10px', color: T.warn, marginLeft: '4px' } },
              v.unverified + ' 项未复核'));
          }
}
        // 评审门的结论
        if (stage === 'REVIEWING' && t.review) {
          line2.push(h(Pill, {
            key: 'r',
            text: (t.review.decision === 'accept' ? '接受' : t.review.decision || '—') + ' · ' + t.review.rounds + ' 轮',
            color: t.review.decision === 'accept' ? T.ok : T.warn,
          }));
        }

        rows.push(h('div', {
          key: stage,
          style: { position: 'relative', paddingLeft: '20px', paddingBottom: i < STAGES.length - 1 ? '10px' : '0', minHeight: '18px' },
        }, [dot, line, h('div', { key: 'c', style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '2px' } }, line2)]));
      });
      return h('div', { style: { marginTop: '10px' } }, rows);
    }

    /** 迁移轨迹：每次状态变化的时间与**理由**（理由是人写给自己看的，价值高）。 */
    function Timeline(props) {
      const t = props.task;
      const items = (t.timeline || []).slice(-6).reverse();
      if (!items.length) return null;
      return h('div', { style: { marginTop: '10px', paddingTop: '8px', borderTop: '1px solid ' + T.border } }, [
        h('div', { key: 'h', style: { fontSize: '10px', color: T.fg2, marginBottom: '4px' } }, '迁移轨迹'),
        ...items.map(function (e, i) {
          return h('div', { key: i, style: { marginBottom: '6px', fontSize: '11px' } }, [
            h('span', { key: 't', style: { color: T.fg2, fontVariantNumeric: 'tabular-nums', marginRight: '6px' } }, shortTime(e.at)),
            h('span', { key: 's', style: { color: T.fg, fontWeight: '500', marginRight: '6px' } },
              (STAGE_CN[e.to] || e.to || '创建')),
            h('br', { key: 'br' }),
            e.reason
              ? h('span', { key: 'r', style: { color: T.fg2 } }, e.reason)
              : null,
          ]);
        }),
      ]);
    }

    /** 卡点：**为什么过不去**。这是"卡在哪"的直接答案。 */
    function BlockedBy(props) {
      const b = props.task.blocked;
      if (!b || !b.length) return null;
      return h('div', {
        style: {
          marginTop: '8px', padding: '6px 8px', borderRadius: '6px',
          background: 'color-mix(in srgb, ' + T.warn + ' 10%, transparent)',
          border: '1px solid ' + T.warn, fontSize: '11px', color: T.fg,
        },
      }, '卡住：' + b.join('；'));
    }

    /**
     * 一个任务 = 一张卡，**默认收起**。
     *
     * 收起时给"一眼能看到什么"：id、状态、裁决、时长、卡点。
     * 展开时给"交付了什么"：阶段轨 + 制品形状 + 迁移轨迹。
     * 一屏能扫很多任务，而需要细节时又能钻进去。
     */
    function TaskCard(props) {
      const t = props.task;
      const [open, setOpen] = React.useState(false);
      const sc = STATUS_COLOR[t.status] || T.idle;
      const v = t.verdict;
      const totalMs = (t.durations || []).reduce(function (a, d) { return a + d.ms; }, 0);
      const idleMs = t.updated ? Date.now() - Date.parse(t.updated) : NaN;
      const accepted = t.status === 'DONE';

      // 卡片头：把"箭头+id+徽章"与"右侧的时间信息"分成两栏。
      // 用 flex-wrap 而不是一行塞满 —— 否则窄面板下会把标题挤掉。
      const head = [
        h('span', {
          key: 'arrow',
          style: { fontSize: '9px', color: T.fg2, width: '10px', flex: '0 0 auto' },
        }, open ? '▼' : '▶'),
        h('span', { key: 'id', style: { fontSize: '12px', fontWeight: '600', color: T.fg, marginRight: '6px' } }, t.id),
        h(Pill, { key: 's', text: STAGE_CN[t.status] || t.status || '读不出来', color: sc }),
      ];
      if (v) {
        const tot = v.met + v.notMet + v.cannotTell;
        head.push(h(Pill, {
          key: 'v',
          text: (v.status === 'approve' ? '通过 ' : v.status === 'reject' ? '驳回 ' : '待人工 ') + v.met + '/' + tot,
          color: VERDICT_COLOR[v.status] || T.idle,
        }));
      }
      if (t.review && t.review.rounds > 1) {
        head.push(h('span', { key: 'r', style: { fontSize: '10px', color: T.fg2, marginLeft: '4px' } },
          t.review.rounds + ' 轮评审'));
      }
      head.push(h('span', { key: 'sp', style: { flex: '1' } }));
      if (Number.isFinite(totalMs) && totalMs > 60000) {
        head.push(h('span', { key: 'd', style: { fontSize: '10px', color: T.fg2, marginRight: '8px' } },
          '历时 ' + humanMs(totalMs)));
      }
      if (Number.isFinite(idleMs) && t.status !== 'DONE') {
        head.push(h('span', { key: 'i', style: { fontSize: '10px', color: idleMs > 86400000 ? T.warn : T.fg2 } },
          humanMs(idleMs) + '未动'));
      }

      const body = [h('div', {
        key: 'head',
        style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      }, head)];
      if (t.title) {
        body.push(h('div', {
          key: 'ti',
          style: {
            marginTop: '4px', fontSize: '12px', lineHeight: '18px', color: T.fg2,
            // 两行截断：比单行截断保留更多信息，又不会撑高卡片
            display: '-webkit-box', WebkitLineClamp: '2', WebkitBoxOrient: 'vertical', overflow: 'hidden',
          },
        }, t.title));
      }
      body.push(h(BlockedBy, { key: 'b', task: t }));
      if (open) {
        body.push(h(StageRail, { key: 'rail', task: t }));
        body.push(h(Timeline, { key: 'tl', task: t }));
      }

      return h('div', {
        onClick: function () { setOpen(!open); },
        style: {
          padding: '10px 12px',
          borderRadius: '10px',
          background: accepted ? 'transparent' : T.layer1,
          border: '1px solid ' + T.border,
          marginBottom: '8px',
          cursor: 'pointer',
          opacity: accepted && !open ? '0.72' : '1',
        },
      }, body);
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
          padding: '20px 28px',
          maxWidth: '860px',
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
