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

    /**
     * ## 排版与间距刻度
     *
     * ⚠️ 我前两版的毛病是**随手写样式**：字号 10/11/12px 混用、间距凭感觉、
     * 字号小到 10px 还要塞一长串 `·` 分隔的元数据。结果是"一坨密集的小字"，
     * 眼睛没有落脚点。用户的原话是"小学生水平"。
     *
     * 所以这里把刻度**定死**，后面所有地方只准从这里取：
     *   · 字号只用三档：13（标题/正文）/ 12（次要）/ 11（元数据，下限）
     *   · 间距只用 4 的倍数
     *   · 行高给足（1.5 左右），密集的小字是最难看的东西
     */
    /**
     * ## 加载期自检
     *
     * ⚠️ 我在这个文件上**三次**犯了同一类错：重写代码时删掉一个常量或组件，
     * 而它还在被别处引用。React 的表现是**整个面板变成一片空白**
     * （容器挂载了，但里面什么都没有），浏览器只给一句
     * "slot entry crashed in 'main': ReferenceError: X is not defined"。
     *
     * 那些名字本该是**编译期**检查的，但这个文件**不经 tsc**（它是浏览器 bundle）。
     * 所以退而求其次：**在 factory 执行时就检查**，让错误在加载期
     * 带着名字抛出来，而不是等到渲染时变成空白。
     *
     * 加一个常量忘了登记？这里会直接告诉你。
     */
    function selfCheck() {
      // ⚠️ 这里**必须**写显式的 `typeof X === 'undefined'` 判断。
      // 不能写成表驱动 + `eval(name)`：在模块作用域里 eval 一个未声明的标识符
      // 会直接抛 ReferenceError（实测踩到），那样自检本身就成了新的崩溃点。
      // `typeof undeclaredVar` 是 JS 里唯一安全的探测方式 —— 它不抛。
      const missing = [];
      if (typeof POLL_MS === 'undefined') missing.push('POLL_MS');
      if (typeof S === 'undefined') missing.push('S');
      if (typeof F === 'undefined') missing.push('F');
      if (typeof T === 'undefined') missing.push('T');
      if (typeof STAGES === 'undefined') missing.push('STAGES');
      if (typeof STAGE_ARTIFACT === 'undefined') missing.push('STAGE_ARTIFACT');
      if (typeof STAGE_CN === 'undefined') missing.push('STAGE_CN');
      if (typeof SdlcPanel !== 'function') missing.push('SdlcPanel');
      if (typeof SdlcPanelInner !== 'function') missing.push('SdlcPanelInner');
      if (typeof Stepper !== 'function') missing.push('Stepper');
      if (typeof Focus !== 'function') missing.push('Focus');
      if (typeof Timeline !== 'function') missing.push('Timeline');
      if (typeof TaskCard !== 'function') missing.push('TaskCard');
      if (typeof Detail !== 'function') missing.push('Detail');
      if (typeof VariantA !== 'function') missing.push('VariantA');
      if (typeof VariantB !== 'function') missing.push('VariantB');
      if (typeof VariantC !== 'function') missing.push('VariantC');
      if (typeof ArtifactViewer !== 'function') missing.push('ArtifactViewer');
      if (typeof renderMarkdown !== 'function') missing.push('renderMarkdown');
      if (missing.length) {
        throw new Error('sdlc-ui 自检失败，这些名字没有定义 → ' + missing.join(', ') +
          '。（重写代码时被删掉了？这个文件**不经 tsc**，所以只能在这里拦；' +
          '不拦的话表现是一片空白。）');
      }
    }

    /** 轮询间隔。10 秒 —— 端点在本地读几个小文件，开销可忽略；
     *  而任务状态的真实变化频率是分钟到小时级，不需要推送。 */
    const POLL_MS = 10000;

    const S = { xs: '4px', sm: '8px', md: '12px', lg: '16px', xl: '24px' };
    const F = {
      title: { fontSize: '13px', fontWeight: '600', lineHeight: '20px' },
      body: { fontSize: '13px', fontWeight: '400', lineHeight: '20px' },
      meta: { fontSize: '12px', fontWeight: '400', lineHeight: '18px' },
      tiny: { fontSize: '11px', fontWeight: '400', lineHeight: '16px' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
    };
    const mix = (v, pct) => 'color-mix(in srgb, ' + v + ' ' + pct + '%, transparent)';

    /**
     * 内联小图标。
     *
     * 为什么加：纯文字里"文件 / 阶段 / 时长"全靠 `·` 分隔，读起来没有边界。
     * 一个 12px 的图标给的边界，比再加一层括号都强，而且不占宽度。
     */
    function Icon(props) {
      const st = Object.assign(
        { width: props.size || 12, height: props.size || 12, viewBox: '0 0 16 16', fill: 'none',
          stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round',
          style: { flex: '0 0 auto', opacity: props.dim ? '0.7' : '1' } },
        props.style || {},
      );
      const paths = {
        doc: [h('path', { key: 'a', d: 'M4 1.5h5l3 3v10h-8z' }), h('path', { key: 'b', d: 'M9 1.5v3h3' })],
        clock: [h('circle', { key: 'a', cx: '8', cy: '8', r: '6' }), h('path', { key: 'b', d: 'M8 4.5V8l2.5 1.5' })],
        check: [h('path', { key: 'a', d: 'M3 8.5l3.5 3.5L13 5' })],
        warn: [h('path', { key: 'a', d: 'M8 2.5l6 11H2z' }), h('path', { key: 'b', d: 'M8 6.5v3' }), h('path', { key: 'c', d: 'M8 11.5v.01' })],
        block: [h('circle', { key: 'a', cx: '8', cy: '8', r: '6' }), h('path', { key: 'b', d: 'M4 12L12 4' })],
        dot: [h('circle', { key: 'a', cx: '8', cy: '8', r: '3', fill: 'currentColor', stroke: 'none' })],
      };
      return h('svg', st, paths[props.name] || paths.dot);
    }

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
     * 横向进度条。
     *
     * ⚠️ 前一版是**竖排**的：七个阶段各占一行，每行后半段塞一长串
     * `·` 分隔的元数据。结果是"一坨密集的小字"——因为竖排把
     * **线性的流程**画成了一份**清单**。
     *
     * 横向才符合它的本质：左到右 = 先到后，走过的填色、当前的高亮、
     * 未到的留白。**一眼看全程**，不需要读。
     *
     * 每个阶段的可点区域下面才是细节（产出物、耗时、门的结论）。
     */
    function Stepper(props) {
      const t = props.task;
      const onOpen = props.onOpen || function () {};
      const cur = STAGES.indexOf(t.status);
      const cells = STAGES.map(function (stage, i) {
        const done = cur >= 0 && i < cur;
        const active = i === cur;
        const art = (t.artifacts || []).find(function (a) { return a.kind === STAGE_ARTIFACT[stage]; });
        const isGate = stage === 'VERIFYING' || stage === 'REVIEWING';
        // 门的结论：验证看裁决，评审看决定。有结论才画勾/叉。
        let gateOk = null;
        if (stage === 'VERIFYING' && t.verdict) gateOk = t.verdict.status === 'approve';
        if (stage === 'REVIEWING' && t.review && t.review.decision) gateOk = t.review.decision === 'accept';
        const color = active ? T.brand : done ? (gateOk === false ? T.err : T.ok) : T.idle;

        return h('div', {
          key: stage,
          title: (STAGE_CN[stage] || stage) + (art ? ' · ' + art.file : '') + '（' + (done ? '已过' : active ? '当前' : '未到') + '）',
          style: { flex: '1 1 0', minWidth: '0', display: 'flex', flexDirection: 'column', gap: S.xs, alignItems: 'stretch' },
        }, [
          // 条：走过的实心，当前的实心+亮色，未到的淡
          h('div', {
            key: 'bar',
            style: {
              height: '4px', borderRadius: '2px',
              background: !done && !active ? 'transparent' : color,
              border: '1px solid ' + (!done && !active ? T.border2 : color),
            },
          }),
          h('div', {
            key: 'lbl',
            style: {
              display: 'flex', alignItems: 'center', gap: '3px',
              fontSize: '11px', lineHeight: '16px',
              color: active ? T.fg : done ? T.fg : T.fg2,
              fontWeight: active ? '600' : '400',
              whiteSpace: 'nowrap', overflow: 'hidden',
            },
          }, [
            isGate && gateOk !== null
              ? h(Icon, { key: 'i', name: gateOk ? 'check' : 'warn', size: 11, style: { color: color } })
              : null,
            h('span', { key: 't', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, STAGE_CN[stage] || stage),
          ]),
          /**
           * ★ **这一阶段的交付物文件名**，直接显示在流程条上。
           *
           * 用户的原始要求就是这一条："每个阶段都产出了哪些交付物要**可以直接看出来**"。
           * 所以它不该藏在展开的详情里 —— 流程条本身就该说清楚。
           *
           * 可点：点它打开这个交付物的内容。缺制品时显示一条虚线 + 警示色，
           * 让"这一门没有产出"也是一个**看得见**的状态。
           */
          art
            ? h('button', {
                key: 'art',
                title: '查看 ' + art.file + ' 的内容',
                onClick: function (ev) { ev.stopPropagation(); onOpen(art.file); },
                style: Object.assign({}, F.tiny, {
                  textAlign: 'left', cursor: 'pointer', padding: '1px 4px', marginTop: '1px',
                  borderRadius: '4px', background: 'transparent', border: '1px solid transparent',
                  color: T.fg2, fontSize: '10px', lineHeight: '14px',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  textDecoration: 'underline', textDecorationColor: T.border2, textUnderlineOffset: '2px',
                }),
              }, art.file)
            : STAGE_ARTIFACT[stage]
              ? h('div', {
                  key: 'miss',
                  title: '这一门还没有产出物',
                  style: Object.assign({}, F.tiny, {
                    marginTop: '2px', borderTop: '1px dashed ' + T.border2, height: '12px',
                  }),
                })
              : null,
        ]);
      });
      return h('div', {
        style: { display: 'flex', gap: S.sm, marginTop: S.md, marginBottom: S.md },
      }, cells);
    }

    /**
     * 焦点区：**当前阶段的产出物**。
     *
     * 这是"每个阶段的产出物"这个问题的正面回答：
     * 不只是文件名，还有它的**章节骨架** —— 交付物的形状。
     */
    function Focus(props) {
      const t = props.task;
      const stage = t.status;
      const kind = STAGE_ARTIFACT[stage];
      const art = kind ? (t.artifacts || []).find(function (a) { return a.kind === kind; }) : null;
      const dur = (t.durations || []).find(function (d) { return d.stage === STAGES[STAGES.indexOf(stage) - 1]; });
      const rows = [];

      // ⚠️ `DONE` 与 `IMPLEMENTING` **本来就不产出制品**。
      // 前一版在这里写"这一门还没有产出物" —— 而那句话在已完成的任务上
      // 会被读成"缺东西"。**说错话比不说更糟**，所以要分情况。
      const isFinal = stage === 'DONE';
      const isWork = stage === 'IMPLEMENTING';
      const head = [
        h(Icon, {
          key: 'i',
          name: isFinal ? 'check' : art ? 'doc' : 'warn',
          size: 13,
          style: { color: isFinal ? T.ok : art ? T.fg2 : T.warn },
        }),
        h('span', { key: 't', style: Object.assign({}, F.meta, { color: T.fg, fontWeight: '500' }) },
          isFinal
            ? '已交付'
            : isWork
              ? '实现阶段（代码改动，不产生制品文件）'
              : art
                ? art.file
                : '这一门还没有产出物'),
      ];
      if (art && art.bytes) head.push(h('span', { key: 'b', style: Object.assign({}, F.tiny, { color: T.fg2 }) }, Math.round(art.bytes / 100) / 10 + ' KB'));
      if (dur && dur.ms > 2000) {
        head.push(h(Icon, { key: 'c', name: 'clock', size: 11, style: { color: T.fg2, marginLeft: 'auto' } }));
        head.push(h('span', { key: 'd', style: Object.assign({}, F.tiny, { color: T.fg2 }) }, '停留 ' + humanMs(dur.ms)));
      }
      rows.push(h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: '6px' } }, head));

      // 完成的任务：把它**全部**制品列出来 —— 这才是"这个任务交付了什么"
      if (isFinal) {
        rows.push(h('div', { key: 'all', style: { display: 'flex', flexWrap: 'wrap', gap: S.sm, marginTop: S.sm } },
          (t.artifacts || []).map(function (a) {
            return h('div', {
              key: a.kind,
              title: '查看 ' + a.file,
              onClick: function (ev) { ev.stopPropagation(); if (props.onOpen) props.onOpen(a.file); },
              style: {
                cursor: 'pointer',
                flex: '1 1 140px', minWidth: '0', padding: '6px 8px', borderRadius: '6px',
                background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid ' + T.border,
              },
            }, [
              h('div', { key: 'k', style: Object.assign({}, F.tiny, { color: T.fg2 }) }, a.kind),
              h('div', { key: 'f', style: Object.assign({}, F.meta, { color: T.fg }) }, a.file),
            ]);
          })));
      }

      // 章节骨架：这是"交付物长什么样"，用 chip 排开而不是一行 `·` 串
      if (art && art.sections && art.sections.length) {
        rows.push(h('div', {
          key: 's',
          style: { display: 'flex', flexWrap: 'wrap', gap: S.xs, marginTop: S.sm },
        }, art.sections.map(function (sec) {
          return h('span', {
            key: sec,
            style: Object.assign({}, F.tiny, {
              color: T.fg2, padding: '1px 7px', borderRadius: '5px',
              background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid ' + T.border,
            }),
          }, sec);
        })));
      }

      // 门的结论
      if (stage === 'VERIFYING' && t.verdict) {
        const v = t.verdict;
        const tot = v.met + v.notMet + v.cannotTell;
        const line = [
          h(Pill, {
            key: 'p',
            text: v.status === 'approve' ? '通过' : v.status === 'reject' ? '驳回' : '待人工',
            color: VERDICT_COLOR[v.status] || T.idle,
          }),
          h('span', { key: 'n', style: Object.assign({}, F.tiny, { color: T.fg2 }) }, v.met + ' / ' + tot + ' 条判据通过'),
        ];
        if (v.findings) line.push(h('span', { key: 'f', style: Object.assign({}, F.tiny, { color: T.fg2 }) }, v.findings + ' 条发现'));
        if (v.unverified) {
          line.push(h(Icon, { key: 'ui', name: 'warn', size: 11, style: { color: T.warn, marginLeft: 'auto' } }));
          line.push(h('span', { key: 'u', style: Object.assign({}, F.tiny, { color: T.warn }) }, v.unverified + ' 项未复核'));
        }
        rows.push(h('div', { key: 'v', style: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: S.sm } }, line));
      }
      if (stage === 'REVIEWING' && t.review) {
        rows.push(h('div', { key: 'r', style: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: S.sm } }, [
          h(Pill, { key: 'p', text: t.review.decision === 'accept' ? '接受' : t.review.decision || '—', color: t.review.decision === 'accept' ? T.ok : T.warn }),
          h('span', { key: 'n', style: Object.assign({}, F.tiny, { color: T.fg2 }) }, t.review.rounds + ' 轮独立验证'),
          t.review.notAccepted
            ? h('span', { key: 'na', style: Object.assign({}, F.tiny, { color: T.fg2 }) }, t.review.notAccepted + ' 项明确未接受')
            : null,
        ]));
      }
      return h('div', {
        style: {
          padding: S.md, borderRadius: '8px',
          background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid ' + T.border,
        },
      }, rows);
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
     * 迁移轨迹 —— 做成**真正的列表**，不是日志倾倒。
     *
     * ⚠️ 前一版把"时间 + 阶段 + 理由"混在一行再用 `<br>` 断开，读起来像控制台输出。
     * 现在：左边一列固定宽度的**时间轴**（带竖线和小圆点），右边是内容。
     * 时间最不重要，所以给它小字号、但位置固定 —— 眼睛可以整列跳过。
     */
    function Timeline(props) {
      const t = props.task;
      const items = (t.timeline || []).slice(-8).reverse();
      if (!items.length) return null;
      return h('div', { style: { marginTop: S.lg } }, [
        h('div', { key: 'h', style: Object.assign({}, F.tiny, { color: T.fg2, marginBottom: S.sm, fontWeight: '500' }) }, '迁移轨迹'),
        ...items.map(function (e, i) {
          const last = i === items.length - 1;
          return h('div', { key: i, style: { display: 'flex', gap: S.sm } }, [
            h('div', { key: 'ax', style: { flex: '0 0 auto', width: '54px', textAlign: 'right' } },
              h('span', { style: Object.assign({}, F.tiny, { color: T.fg2, fontVariantNumeric: 'tabular-nums' }) }, shortTime(e.at))),
            h('div', { key: 'ln', style: { flex: '0 0 auto', width: '9px', position: 'relative' } }, [
              h('span', { key: 'd', style: { position: 'absolute', left: '2px', top: '5px', width: '5px', height: '5px', borderRadius: '50%', background: last ? T.idle : T.border2 } }),
              last ? null : h('span', { key: 'l', style: { position: 'absolute', left: '4px', top: '12px', bottom: '-4px', width: '1px', background: T.border } }),
            ]),
            h('div', { key: 'c', style: { flex: '1 1 auto', minWidth: '0', paddingBottom: last ? '0' : S.sm } }, [
              h('div', { key: 's', style: Object.assign({}, F.meta, { color: T.fg, fontWeight: '500' }) }, STAGE_CN[e.to] || e.to || '创建'),
              e.reason ? h('div', { key: 'r', style: Object.assign({}, F.tiny, { color: T.fg2, marginTop: '2px' }) }, e.reason) : null,
            ]),
          ]);
        }),
      ]);
    }

    /**
     * 一个任务 = 一张卡。
     *
     * ## 视觉层级（前一版最缺的东西）
     *
     * 一行里所有文字一样重 = 没有层级 = 读不出重点。现在分三层：
     *   1. **id**（13px/600）+ 状态徽章        ← 第一眼
     *   2. 标题（12px/次要色）                 ← 第二眼
     *   3. 元数据（11px/最淡 + 图标，靠右）     ← 需要时才看
     *
     * 展开后是流程视图：横向进度条 → 当前阶段产出物 → 卡点 → 迁移轨迹。
     */
    function TaskCard(props) {
      const t = props.task;
      const [open, setOpen] = React.useState(false);
      const sc = STATUS_COLOR[t.status] || T.idle;
      const v = t.verdict;
      const totalMs = (t.durations || []).reduce(function (a, d) { return a + d.ms; }, 0);
      const idleMs = t.updated ? Date.now() - Date.parse(t.updated) : NaN;
      const done = t.status === 'DONE';

      const l1 = [
        h('span', { key: 'ar', style: Object.assign({}, F.tiny, { color: T.fg2, width: '9px', flex: '0 0 auto' }) }, open ? '▾' : '▸'),
        h('span', { key: 'id', style: Object.assign({}, F.title, { color: T.fg }) }, t.id),
        h(Pill, { key: 's', text: STAGE_CN[t.status] || t.status || '—', color: sc }),
      ];
      if (v) {
        const tot = v.met + v.notMet + v.cannotTell;
        l1.push(h(Pill, {
          key: 'v',
          text: (v.status === 'approve' ? '通过 ' : v.status === 'reject' ? '驳回 ' : '待人工 ') + v.met + '/' + tot,
          color: VERDICT_COLOR[v.status] || T.idle,
        }));
      }
      l1.push(h('span', { key: 'sp', style: { flex: '1 1 auto' } }));
      const meta = [];
      if (Number.isFinite(totalMs) && totalMs > 60000) {
        meta.push(h(Icon, { key: 'ic', name: 'clock', size: 11, style: { color: T.fg2 } }));
        meta.push(h('span', { key: 't', style: Object.assign({}, F.tiny, { color: T.fg2 }) }, humanMs(totalMs)));
      }
      if (Number.isFinite(idleMs) && !done) {
        const stale = idleMs > 86400000;
        meta.push(h('span', { key: 'i', style: Object.assign({}, F.tiny, { color: stale ? T.warn : T.fg2, marginLeft: meta.length ? S.sm : '0' }) }, humanMs(idleMs) + '未动'));
      }
      if (meta.length) l1.push(h('span', { key: 'm', style: { display: 'flex', alignItems: 'center', gap: '4px', flex: '0 0 auto' } }, meta));

      const body = [h('div', { key: 'l1', style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } }, l1)];
      if (t.title) {
        body.push(h('div', {
          key: 'l2',
          style: Object.assign({}, F.meta, {
            color: T.fg2, marginTop: S.xs, paddingLeft: '15px',
            display: '-webkit-box', WebkitLineClamp: '2', WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }),
        }, t.title));
      }
      if (open) {
        body.push(h(Stepper, { key: 'st', task: t, onOpen: props.onOpen }));
        body.push(h(Focus, { key: 'fo', task: t, onOpen: props.onOpen }));
        body.push(h(BlockedBy, { key: 'b', task: t }));
        body.push(h(Timeline, { key: 'tl', task: t }));
      } else if (t.blocked && t.blocked.length) {
        body.push(h(BlockedBy, { key: 'b', task: t }));
      }

      return h('div', {
        onClick: function () { setOpen(!open); },
        style: {
          padding: S.md + ' ' + S.lg,
          borderRadius: '10px',
          background: T.layer1,
          border: '1px solid ' + (open ? T.border2 : T.border),
          marginBottom: S.sm,
          cursor: 'pointer',
          opacity: done && !open ? '0.62' : '1',
        },
      }, body);
    }

    /**
     * 面板入口：包一层 try/catch。
     *
     * ⚠️ React 的渲染异常会让**整个子树消失**，表现就是"什么都不显示"。
     * 用户第一次看到的"空白"很可能就是这个 —— 所以这里自己捕获，
     * 把异常**当成内容画出来**，让错误变成屏幕上能读的一行字。
     *
     * ⚠️ 这个组件本身被我删过一次：重写面板体时替换区间把它一起吃掉了，
     * 于是 `apply` 里注册的 `SdlcPanel` 是 undefined，
     * 客户端半**整包加载失败**（浏览器只有一句 "1 entry did not activate"）。
     * 已加进冒烟：**必须真的调用注册的组件**，否则这种缺失测不出来。
     */
    function SdlcPanel() {
      try {
        return SdlcPanelInner();
      } catch (e) {
        return h('pre', {
          style: {
            padding: S.xl, fontSize: '12px', lineHeight: '18px', whiteSpace: 'pre-wrap',
            color: T.err, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          },
        }, 'SdlcPanel 渲染抛错：\n' + (e && e.stack ? e.stack : String(e)));
      }
    }

    /**
     * ## 三种信息架构（让用户挑）
     *
     * 不是换配色，而是**三种不同的组织方式**：
     *   A 列表 + 详情   —— 左窄列任务、右宽详情（典型 issue tracker）
     *   B 流程总览      —— 五个门 + 全局统计（看整个仓库卡在哪）
     *   C 表格 + 内联流水 —— 高密度扫览，每行内联迷你流水线
     *
     * 用 `localStorage.sdlcUiVariant` 切换，方便对比。
     */
    function SdlcPanelInner() {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [variant, setVariant] = React.useState(function () {
        try { return localStorage.getItem('sdlcUiVariant') || 'B'; } catch (e) { return 'B'; }
      });
      const [selected, setSelected] = React.useState(null);
      // 正在查看的交付物。null = 没打开。
      const [opened, setOpened] = React.useState(null);

      const load = React.useCallback(function () {
        return fetch('./api/sdlc-ui.tasks', { credentials: 'same-origin' })
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(function (d) {
            if (d && d.error) throw new Error(d.error);
            setData(d); setError(null); setLoading(false);
          })
          .catch(function (e) { setError(String(e && e.message ? e.message : e).slice(0, 160)); setLoading(false); });
      }, []);

      React.useEffect(function () {
        let alive = true;
        load();
        const timer = setInterval(function () { if (alive) load(); }, POLL_MS);
        return function () { alive = false; clearInterval(timer); };
      }, [load]);

      const switchTo = function (v) {
        setVariant(v);
        try { localStorage.setItem('sdlcUiVariant', v); } catch (e) { /* 无所谓 */ }
      };

      // 顶栏：标题 + 版本切换 + 刷新
      const bar = h('div', {
        style: { display: 'flex', alignItems: 'center', gap: S.sm, marginBottom: S.lg },
      }, [
        h('span', { key: 't', style: Object.assign({}, F.title, { color: T.fg, fontSize: '14px' }) }, 'AI 原生 SDLC'),
        h('span', { key: 'sp', style: { flex: '1 1 auto' } }),
        ...['A', 'B', 'C'].map(function (v) {
          return h('button', {
            key: v,
            onClick: function () { switchTo(v); },
            style: Object.assign({}, F.tiny, {
              height: '24px', padding: '0 10px', borderRadius: '6px', cursor: 'pointer',
              background: variant === v ? mix(T.brand, 12) : 'transparent',
              color: variant === v ? T.brand : T.fg2,
              border: '1px solid ' + (variant === v ? T.brand : T.border),
              fontWeight: variant === v ? '600' : '400',
            }),
          }, v);
        }),
        h('button', {
          key: 'r',
          onClick: function () { setLoading(true); load(); },
          style: Object.assign({}, F.tiny, {
            height: '24px', padding: '0 10px', borderRadius: '6px', cursor: 'pointer',
            background: 'transparent', color: T.fg2, border: '1px solid ' + T.border2,
          }),
        }, '刷新'),
      ]);

      let content;
      if (error) {
        content = h('div', { style: Object.assign({}, F.meta, { color: T.err }) }, '取数据失败：' + error);
      } else if (loading && !data) {
        content = h('div', { style: Object.assign({}, F.meta, { color: T.fg2 }) }, '读取中…');
      } else if (data && (!data.tasks || data.tasks.length === 0)) {
        const searched = data.searched || [];
        content = h('div', {}, [
          h('div', { key: 'm', style: Object.assign({}, F.meta, { color: T.fg2 }) }, '没有找到任务。查过：'),
          h('ul', { key: 'u', style: Object.assign({}, F.tiny, { margin: S.xs + ' 0 0', paddingLeft: S.lg, color: T.fg2 }) },
            searched.map(function (p) { return h('li', { key: p, style: { wordBreak: 'break-all' } }, p); })),
        ]);
      } else if (data) {
        const tasks = data.tasks;
        const sel = tasks.find(function (t) { return t.id === selected; }) || tasks[0];
        const openArtifact = function (file) { setOpened({ task: sel.id, file: file }); };
        if (variant === 'B') content = h(VariantB, { tasks: tasks, sel: sel, onSelect: setSelected, onOpen: openArtifact });
        else if (variant === 'C') content = h(VariantC, { tasks: tasks, sel: sel, onSelect: setSelected, onOpen: openArtifact });
        else content = h(VariantA, { tasks: tasks, sel: sel, onSelect: setSelected, onOpen: openArtifact });
      }

      return h('div', {
        style: {
          padding: S.xl + ' ' + S.xl, maxWidth: '980px',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          fontSize: '13px', lineHeight: '20px', color: T.fg,
        },
      }, [bar, content, opened ? h(ArtifactViewer, { key: 'av', task: opened.task, file: opened.file, onClose: function () { setOpened(null); } }) : null]);
    }

    /** 一个任务行（三版共用）——紧凑。 */
    function TaskLine(props) {
      const t = props.task, on = props.active;
      const sc = STATUS_COLOR[t.status] || T.idle;
      const v = t.verdict;
      return h('div', {
        onClick: props.onClick,
        style: {
          padding: S.sm + ' ' + S.md, borderRadius: '8px', cursor: 'pointer',
          background: on ? mix(T.brand, 8) : 'transparent',
          border: '1px solid ' + (on ? mix(T.brand, 30) : 'transparent'),
          marginBottom: S.xs,
        },
      }, [
        h('div', { key: 'r1', style: { display: 'flex', alignItems: 'center', gap: '6px' } }, [
          h('span', { key: 'd', style: { width: '6px', height: '6px', borderRadius: '50%', background: sc, flex: '0 0 auto' } }),
          h('span', { key: 'id', style: Object.assign({}, F.meta, { color: T.fg, fontWeight: on ? '600' : '500' }) }, t.id),
          h('span', { key: 'sp', style: { flex: '1 1 auto' } }),
          v ? h('span', { key: 'v', style: Object.assign({}, F.tiny, { color: VERDICT_COLOR[v.status] || T.fg2 }) },
            v.met + '/' + (v.met + v.notMet + v.cannotTell)) : null,
        ]),
        h('div', {
          key: 'r2',
          style: Object.assign({}, F.tiny, {
            color: T.fg2, marginTop: '2px', paddingLeft: '12px',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }),
        }, t.title || ''),
      ]);
    }

    /** A：左列表 + 右详情。 */
    function VariantA(props) {
      return h('div', { style: { display: 'flex', gap: S.xl, alignItems: 'flex-start' } }, [
        h('div', { key: 'L', style: { flex: '0 0 260px' } },
          props.tasks.map(function (t) {
            return h(TaskLine, { key: t.id, task: t, active: props.sel && props.sel.id === t.id, onClick: function () { props.onSelect(t.id); } });
          })),
        h('div', { key: 'R', style: { flex: '1 1 auto', minWidth: '0' } },
          props.sel ? h(Detail, { task: props.sel, onOpen: props.onOpen }) : null),
      ]);
    }

    /** B：统计 + 五个门（看整个仓库卡在哪）。 */
    function VariantB(props) {
      const tasks = props.tasks;
      const byStatus = {};
      tasks.forEach(function (t) { byStatus[t.status] = (byStatus[t.status] || 0) + 1; });
      const stuck = tasks.filter(function (t) { return t.blocked && t.blocked.length; });
      const gates = ['VERIFYING', 'REVIEWING'];
      return h('div', {}, [
          // ⚠️ **不要 flexWrap** —— 卡片是 flex:'1 1 0'，一旦允许换行，
          // 七个统计卡会竖着堆满整屏（实测踩到）。
          h('div', { key: 'stats', style: { display: 'flex', gap: S.sm, marginBottom: S.lg } },
          STAGES.map(function (st) {
            const n = byStatus[st] || 0;
            return h('div', {
              key: st,
              style: {
                // 统计卡：**数字是主角**，所以给它 22px；标签降到 11px 并压低对比。
                // 内边距从四向 12 收到 10×12 —— 原来显得空。
                flex: '1 1 0', minWidth: '84px', padding: '10px 12px', borderRadius: '8px',
                background: n ? mix(T.brand, 7) : 'transparent',
                border: '1px solid ' + (n ? mix(T.brand, 28) : T.border),
                opacity: n ? '1' : '0.55',
              },
            }, [
              h('div', {
                key: 'n',
                style: {
                  fontSize: '22px', lineHeight: '28px', fontWeight: '600',
                  color: n ? T.fg : T.fg2, fontVariantNumeric: 'tabular-nums',
                },
              }, String(n)),
              h('div', { key: 'l', style: Object.assign({}, F.tiny, { color: T.fg2, marginTop: '2px' }) }, STAGE_CN[st] || st),
            ]);
          })),
        stuck.length
          ? h('div', {
              key: 'stuck',
              style: { padding: S.md, borderRadius: '8px', marginBottom: S.lg, background: mix(T.warn, 8), border: '1px solid ' + mix(T.warn, 40) },
            }, [
              h('div', { key: 'h', style: Object.assign({}, F.meta, { color: T.fg, fontWeight: '600' }) }, stuck.length + ' 个任务卡住了'),
              ...stuck.map(function (t) {
                return h('div', { key: t.id, style: Object.assign({}, F.tiny, { color: T.fg2, marginTop: S.xs }) }, t.id + ' —— ' + t.blocked.join('；'));
              }),
            ])
          : null,
        h('div', { key: 'sel', style: { display: 'flex', gap: S.lg, alignItems: 'flex-start' } }, [
          h('div', { key: 'L', style: { flex: '0 0 220px' } },
            tasks.map(function (t) {
              return h(TaskLine, { key: t.id, task: t, active: props.sel && props.sel.id === t.id, onClick: function () { props.onSelect(t.id); } });
            })),
          h('div', { key: 'R', style: { flex: '1 1 auto', minWidth: '0' } },
            props.sel ? h(Detail, { task: props.sel, onOpen: props.onOpen }) : null),
        ]),
      ]);
    }

    /** C：高密度表格，每行内联迷你流水线。 */
    function VariantC(props) {
      const cell = Object.assign({}, F.tiny, { padding: '8px 10px', borderBottom: '1px solid ' + T.border, verticalAlign: 'top' });
      return h('div', { style: { border: '1px solid ' + T.border, borderRadius: '8px', overflow: 'hidden' } }, [
        h('div', { key: 'h', style: { display: 'flex', background: 'var(--dsw-alias-bg-layer-2)' } }, [
          h('div', { key: 'a', style: Object.assign({}, cell, { flex: '0 0 130px', color: T.fg2, fontWeight: '500', borderBottom: 'none' }) }, '任务'),
          h('div', { key: 'b', style: Object.assign({}, cell, { flex: '1 1 auto', color: T.fg2, fontWeight: '500', borderBottom: 'none' }) }, '流程'),
          h('div', { key: 'c', style: Object.assign({}, cell, { flex: '0 0 90px', color: T.fg2, fontWeight: '500', borderBottom: 'none' }) }, '耗时'),
        ]),
        ...props.tasks.map(function (t) {
          const cur = STAGES.indexOf(t.status);
          const ms = (t.durations || []).reduce(function (a, d) { return a + d.ms; }, 0);
          return h('div', {
            key: t.id,
            onClick: function () { props.onSelect(t.id); },
            style: { display: 'flex', cursor: 'pointer', background: props.sel && props.sel.id === t.id ? mix(T.brand, 6) : 'transparent' },
          }, [
            h('div', { key: 'a', style: Object.assign({}, cell) }, [
              h('div', { key: 'i', style: Object.assign({}, F.meta, { color: T.fg, fontWeight: '600' }) }, t.id),
              h('div', { key: 't', style: { color: T.fg2, marginTop: '2px' } }, t.title || ''),
            ]),
            h('div', { key: 'b', style: Object.assign({}, cell, { minWidth: '260px' }) }, [
              h('div', { key: 's', style: { display: 'flex', gap: '3px' } },
                STAGES.map(function (st, i) {
                  const done = i < cur, active = i === cur;
                  // ⚠️ 未到的条不能只靠"淡灰 + 低透明" —— 在浅色主题下它会**消失**，
                  // 于是"进度条"看起来只有一格。用**描边**表示"还没到"，
                  // 这样任何主题下都看得见边界。
                  return h('span', {
                    key: st, title: (STAGE_CN[st] || st) + (active ? '（当前）' : done ? '（已过）' : '（未到）'),
                    style: {
                      flex: '1 1 0', height: '6px', borderRadius: '3px',
                      background: active ? T.brand : done ? T.ok : 'transparent',
                      border: '1px solid ' + (active ? T.brand : done ? T.ok : T.border2),
                      minWidth: '6px',
                    },
                  });
                })),
              t.blocked && t.blocked.length
                ? h('div', { key: 'w', style: { color: T.warn, marginTop: '4px' } }, '卡住：' + t.blocked.join('；'))
                : null,
            ]),
            h('div', { key: 'c', style: Object.assign({}, cell, { color: T.fg2, fontVariantNumeric: 'tabular-nums' }) },
              ms > 60000 ? humanMs(ms) : '—'),
          ]);
        }),
      ]);
    }

    /**
     * ## 交付物查看器
     *
     * 用户的要求："**可以点击查看这些交付物的内容**"。
     *
     * 从 `/api/sdlc-ui.artifact?task=&file=` 取正文，按类型渲染：
     *   · `.md`   → 极简 Markdown：标题分级、列表、引用、代码块、加粗/行内代码
     *   · `.json` → 缩进后的等宽文本（JSON 的可读性靠缩进，不靠高亮）
     *
     * ⚠️ **不引入 Markdown 库**：客户端半是手写、零构建的，拖一个依赖进来
     * 要连打包一起解决。而且这里渲染的是**我自己的**制品（标题/列表/引用/代码块
     * 这四种），不是任意 web 内容。渲染器只覆盖这四种，遇到别的原样显示 ——
     * **宁可少渲染，不要错渲染**。
     */
    function renderMarkdown(md) {
      const out = [];
      let inCode = false;
      let code = [];
      let list = [];
      const flushList = function () {
        if (!list.length) return;
        out.push(h('ul', {
          key: 'ul' + out.length,
          style: { margin: '4px 0 8px', paddingLeft: '18px' },
        }, list.map(function (li, k) { return h('li', { key: k, style: { marginBottom: '2px' } }, li); })));
        list = [];
      };
      const inline = function (text, key) {
        // 只处理 **加粗** 与 `行内代码` —— 够用，而且不会误伤别的字符
        const parts = [];
        const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
        let last = 0, m, k = 0;
        while ((m = re.exec(text))) {
          if (m.index > last) parts.push(text.slice(last, m.index));
          const tok = m[0];
          if (tok.slice(0, 2) === '**') parts.push(h('strong', { key: k++ }, tok.slice(2, -2)));
          else parts.push(h('code', {
            key: k++,
            style: Object.assign({}, F.mono, { fontSize: '11px', padding: '0 3px', borderRadius: '3px', background: 'var(--dsw-alias-bg-layer-2)' }),
          }, tok.slice(1, -1)));
          last = m.index + tok.length;
        }
        if (last < text.length) parts.push(text.slice(last));
        return h('span', { key: key }, parts);
      };

      md.split('\n').forEach(function (line, i) {
        if (/^\s*```/.test(line)) {
          if (inCode) {
            out.push(h('pre', {
              key: 'pre' + i,
              style: Object.assign({}, F.mono, {
                fontSize: '11px', lineHeight: '16px', padding: '8px 10px', margin: '6px 0',
                borderRadius: '6px', background: 'var(--dsw-alias-bg-layer-2)',
                border: '1px solid ' + T.border, overflow: 'auto', whiteSpace: 'pre',
              }),
            }, code.join('\n')));
            code = [];
          }
          inCode = !inCode;
          return;
        }
        if (inCode) { code.push(line); return; }
        const hm = /^(#{1,4})\s+(.*)$/.exec(line);
        if (hm) {
          flushList();
          const lvl = hm[1].length;
          out.push(h('div', {
            key: 'h' + i,
            style: {
              fontSize: lvl <= 2 ? '14px' : '13px', fontWeight: '600', color: T.fg,
              margin: out.length ? '14px 0 6px' : '0 0 6px',
              paddingBottom: lvl <= 2 ? '4px' : '0',
              borderBottom: lvl <= 2 ? '1px solid ' + T.border : 'none',
            },
          }, inline(hm[2], 'i')));
          return;
        }
        if (/^\s*[-*]\s+/.test(line)) { list.push(inline(line.replace(/^\s*[-*]\s+/, ''), i)); return; }
        if (/^>\s?/.test(line)) {
          flushList();
          out.push(h('div', {
            key: 'q' + i,
            style: { borderLeft: '3px solid ' + T.border2, paddingLeft: '10px', margin: '6px 0', color: T.fg2 },
          }, inline(line.replace(/^>\s?/, ''), 'i')));
          return;
        }
        if (!line.trim()) { flushList(); return; }
        flushList();
        out.push(h('div', { key: 'p' + i, style: { margin: '4px 0' } }, inline(line, 'i')));
      });
      flushList();
      return out;
    }

    /** 交付物弹层。 */
    function ArtifactViewer(props) {
      const [state, setState] = React.useState({ phase: 'loading' });
      React.useEffect(function () {
        let alive = true;
        fetch('./api/sdlc-ui.artifact?task=' + encodeURIComponent(props.task) + '&file=' + encodeURIComponent(props.file),
              { credentials: 'same-origin' })
          .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (x) {
            if (!alive) return;
            if (!x.ok) throw new Error(x.d && x.d.error ? x.d.error : 'HTTP 错误');
            setState({ phase: 'ready', text: x.d.text, bytes: x.d.bytes });
          })
          .catch(function (e) {
            if (alive) setState({ phase: 'error', error: String(e && e.message ? e.message : e) });
          });
        return function () { alive = false; };
      }, [props.task, props.file]);

      let body;
      if (state.phase === 'loading') {
        body = h('div', { style: Object.assign({}, F.meta, { color: T.fg2 }) }, '读取中…');
      } else if (state.phase === 'error') {
        // 读不出来要说清原因，不要给一个空框
        body = h('div', { style: Object.assign({}, F.meta, { color: T.err }) }, '读不出来：' + state.error);
      } else if (/\.json$/i.test(props.file)) {
        let pretty = state.text;
        try { pretty = JSON.stringify(JSON.parse(state.text), null, 2); } catch (e) { /* 原样显示 */ }
        body = h('pre', {
          style: Object.assign({}, F.mono, {
            fontSize: '11px', lineHeight: '16px', margin: '0', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }),
        }, pretty);
      } else {
        body = h('div', {}, renderMarkdown(state.text));
      }

      return h('div', {
        onClick: function (ev) { ev.stopPropagation(); },
        style: {
          position: 'fixed', top: '0', left: '0', right: '0', bottom: '0', zIndex: '60',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.32)',
        },
      }, h('div', {
        style: {
          width: '760px', maxWidth: '92vw', maxHeight: '82vh', display: 'flex', flexDirection: 'column',
          background: 'var(--dsw-alias-bg-overlay)', border: '1px solid ' + T.border2,
          borderRadius: '12px', overflow: 'hidden', boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
        },
      }, [
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'center', gap: S.sm, padding: '10px 14px', borderBottom: '1px solid ' + T.border },
        }, [
          h(Icon, { key: 'i', name: 'doc', size: 13, style: { color: T.fg2 } }),
          h('span', { key: 'f', style: Object.assign({}, F.meta, { color: T.fg, fontWeight: '600' }) }, props.file),
          h('span', { key: 't', style: Object.assign({}, F.tiny, { color: T.fg2 }) }, props.task),
          state.bytes ? h('span', { key: 'b', style: Object.assign({}, F.tiny, { color: T.fg2 }) }, Math.round(state.bytes / 100) / 10 + ' KB') : null,
          h('span', { key: 'sp', style: { flex: '1 1 auto' } }),
          h('button', {
            key: 'x',
            title: '关闭',
            onClick: function (ev) { ev.stopPropagation(); props.onClose(); },
            style: Object.assign({}, F.meta, {
              cursor: 'pointer', background: 'transparent', border: '1px solid ' + T.border2,
              borderRadius: '6px', width: '26px', height: '24px', color: T.fg2,
            }),
          }, '✕'),
        ]),
        h('div', {
          key: 'body',
          style: Object.assign({}, F.meta, { padding: '14px 16px', overflow: 'auto', color: T.fg }),
        }, body),
      ]));
    }


    /** 详情面板（A/B 共用）：当前阶段的产出物 + 卡点 + 轨迹。 */
    function Detail(props) {
      const t = props.task;
      const onOpen = props.onOpen;
      return h('div', {}, [
        h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } }, [
          h('span', { key: 'id', style: Object.assign({}, F.title, { color: T.fg, fontSize: '15px' }) }, t.id),
          h(Pill, { key: 's', text: STAGE_CN[t.status] || t.status || '—', color: STATUS_COLOR[t.status] || T.idle }),
          t.verdict ? h(Pill, {
            key: 'v',
            text: (t.verdict.status === 'approve' ? '通过 ' : t.verdict.status === 'reject' ? '驳回 ' : '待人工 ') +
              t.verdict.met + '/' + (t.verdict.met + t.verdict.notMet + t.verdict.cannotTell),
            color: VERDICT_COLOR[t.verdict.status] || T.idle,
          }) : null,
        ]),
        t.title ? h('div', { key: 't', style: Object.assign({}, F.meta, { color: T.fg2, marginTop: S.xs }) }, t.title) : null,
        h(BlockedBy, { key: 'b', task: t, roomy: true }),
        h(Stepper, { key: 'st', task: t, onOpen: props.onOpen }),
        h(Focus, { key: 'fo', task: t, onOpen: props.onOpen }),
        h(Timeline, { key: 'tl', task: t }),
      ]);
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
      selfCheck();
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
