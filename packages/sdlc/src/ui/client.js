/**
 * SDLC 客户端：宿主提供 React，插件提供单一的列表 / 详情工作台。
 * 不把列表的固有内容宽度交给 flex 算：长标题不应挤掉详情。
 * 所有样式限于 .sdlc-app / .sdlc-dialog，不影响宿主或其他插件。
 */
window.__ModuleLoader__.load({
  id: '@ai-native-sdlc/dsh-sdlc',
  factory: (require) => {
    const React = require('react');
    const runtime = require('react/jsx-runtime');
    function h(type, props, children) {
      const merged = Object.assign({}, props);
      const key = merged.key;
      delete merged.key;
      if (children !== undefined) merged.children = children;
      return (Array.isArray(children) ? runtime.jsxs : runtime.jsx)(type, merged, key);
    }
    const POLL_MS = 10000;
    const ENDPOINT = './api/sdlc-ui.tasks';
    const STAGES = ['INTENT', 'SPEC', 'PLANNED', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'DONE'];
    const STAGE_CN = { INTENT: '意图', SPEC: '规格', PLANNED: '计划', IMPLEMENTING: '实现', VERIFYING: '验证', REVIEWING: '评审', DONE: '完成' };
    const STAGE_ARTIFACT = { INTENT: 'intent', SPEC: 'spec', PLANNED: 'plan', VERIFYING: 'verification', REVIEWING: 'review' };
    const ARTIFACT_CN = { intent: '意图', spec: '规格', plan: '计划', verification: '验证', review: '评审', proof: '验证证据' };
    const T = {
      fg: 'var(--dsw-alias-label-primary)', fg2: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)', border2: 'var(--dsw-alias-border-l2)',
    };
    const F = { mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } };
    // 任务编号只在一个工作区内唯一。选中、React key、制品请求共用这个身份。
    const taskKey = (t) => JSON.stringify([t.repoRoot || '', t.id]);
    const stageName = (s) => STAGE_CN[s] || s || '未知状态';
    const toneOf = (t) => t.status === 'DONE' ? 'success' : t.status === 'VERIFYING' ? 'accent' : t.status === 'IMPLEMENTING' || t.status === 'REVIEWING' ? 'warning' : 'muted';
    function shortTime(iso) {
      const d = new Date(iso);
      if (!iso || isNaN(d.getTime())) return '时间未记录';
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
    function Icon({ name, size = 16 }) {
      const paths = {
        search: ['M10.5 10.5 14 14', 'M12 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0'],
        refresh: ['M13 5a5.5 5.5 0 1 0 .5 5', 'M13 1v4H9'],
        doc: ['M4 1.5h5l3 3v10H4z', 'M9 1.5v3h3', 'M6 8h4M6 11h4'],
        arrow: ['M3 8h10M9 4l4 4-4 4'], back: ['M13 8H3m4-4L3 8l4 4'],
        check: ['m3 8 3 3 7-7'], close: ['m4 4 8 8M12 4l-8 8'],
        warn: ['M8 2 14 14H2z', 'M8 6v4m0 2v.1'], folder: ['M2 4h5l1.5 2H14v7H2z'],
      };
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        (paths[name] || paths.doc).map((d, i) => h('path', { key: i, d })));
    }
    const CSS = `
.sdlc-app,.sdlc-dialog{--sdlc-fg:var(--dsw-alias-label-primary,#17202e);--sdlc-muted:var(--dsw-alias-label-secondary,#637083);--sdlc-bg:var(--dsw-alias-bg-layer-1,#fff);--sdlc-soft:color-mix(in srgb,var(--sdlc-fg) 2.4%,var(--sdlc-bg));--sdlc-border:color-mix(in srgb,var(--sdlc-fg) 11%,transparent);--sdlc-accent:var(--dsw-alias-state-info-primary,#2563eb);--sdlc-success:color-mix(in srgb,var(--dsw-alias-state-success-primary,#21805b) 70%,var(--sdlc-fg));--sdlc-warning:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b7791f) 65%,var(--sdlc-fg));--sdlc-error:var(--dsw-alias-state-error-primary,#d04444);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;font-size:14px;line-height:1.6;color:var(--sdlc-fg);text-align:left}
body[data-ds-dark-theme] .sdlc-app,body[data-ds-dark-theme] .sdlc-dialog{--sdlc-accent:#8baaff;color-scheme:dark}
.sdlc-app{container-type:inline-size;width:100%;min-width:0;height:100%;overflow:auto;background:var(--sdlc-bg)}
.sdlc-app *,.sdlc-dialog *{box-sizing:border-box}
.sdlc-app button,.sdlc-app input,.sdlc-app select,.sdlc-dialog button{font:inherit;color:inherit}
.sdlc-app button,.sdlc-dialog button{cursor:pointer}
.sdlc-app button:disabled{cursor:wait;opacity:.6}
.sdlc-app svg,.sdlc-dialog svg{flex-shrink:0}
.sdlc-app :focus-visible,.sdlc-dialog :focus-visible{outline:2px solid var(--sdlc-accent);outline-offset:3px}
.sdlc-page{max-width:1500px;margin:0 auto;padding:28px 32px 32px}
.sdlc-header{display:flex;align-items:center;gap:18px;margin-bottom:22px}
.sdlc-header h1{font-size:24px;letter-spacing:-.5px;line-height:1.4;margin:0;font-weight:650}
.sdlc-caption{color:var(--sdlc-muted);font-size:13px}
.sdlc-refresh{margin-left:auto}
.sdlc-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:1px solid var(--sdlc-border);border-radius:7px;background:var(--sdlc-bg);padding:7px 12px;min-height:36px}
.sdlc-button:hover{background:var(--sdlc-soft)}
.sdlc-toolbar{display:flex;align-items:center;gap:16px;margin-bottom:20px;border-bottom:1px solid var(--sdlc-border);min-width:0}
.sdlc-filters{display:flex;gap:24px;min-width:0}
.sdlc-filter,.sdlc-tab{border:0;border-bottom:2px solid transparent;padding:10px 1px 12px;background:transparent;color:var(--sdlc-muted)!important;white-space:nowrap}
.sdlc-filter[aria-pressed=true],.sdlc-tab[aria-pressed=true]{color:var(--sdlc-accent)!important;border-bottom-color:var(--sdlc-accent);font-weight:600}
.sdlc-count{font-size:12px;margin-left:7px;font-variant-numeric:tabular-nums;opacity:.8}
.sdlc-workspace{margin-left:auto;max-width:230px;min-width:0;margin-bottom:8px;border:1px solid var(--sdlc-border);border-radius:7px;background:var(--sdlc-bg);padding:7px 28px 7px 10px;font-size:13px!important;text-overflow:ellipsis}
.sdlc-board{display:grid;grid-template-columns:minmax(260px,32%) minmax(0,1fr);border:1px solid var(--sdlc-border);border-radius:12px;overflow:hidden;height:calc(100dvh - 166px);min-height:480px;max-height:1100px;background:var(--sdlc-bg)}
.sdlc-list{min-width:0;background:var(--sdlc-soft);border-right:1px solid var(--sdlc-border);display:flex;flex-direction:column;overflow:hidden}
.sdlc-search{display:flex;align-items:center;gap:9px;margin:16px;padding:8px 11px;border:1px solid var(--sdlc-border);border-radius:7px;background:var(--sdlc-bg);color:var(--sdlc-muted)}
.sdlc-search:focus-within{border-color:var(--sdlc-accent)}
.sdlc-search input{width:100%;min-width:0;border:0;background:transparent;outline:none;font-size:13px}
.sdlc-search input::placeholder{color:var(--sdlc-muted)}
.sdlc-rows{overflow:auto;min-height:0;flex:1}
.sdlc-task{width:100%;text-align:left;border:0;border-bottom:1px solid var(--sdlc-border);border-left:3px solid transparent;background:transparent;display:block;padding:16px 18px;transition:background .15s}
.sdlc-task:hover{background:color-mix(in srgb,var(--sdlc-fg) 4%,transparent)}
.sdlc-task[aria-pressed=true]{background:color-mix(in srgb,var(--sdlc-accent) 8%,var(--sdlc-bg));border-left-color:var(--sdlc-accent)}
.sdlc-task-meta{display:flex;align-items:center;gap:8px;justify-content:space-between;margin-bottom:6px;font-size:12px;color:var(--sdlc-muted)}
.sdlc-task-id{overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.sdlc-task-title{font-size:14px;font-weight:550;line-height:1.65;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sdlc-task-workspace{display:flex;align-items:center;gap:5px;color:var(--sdlc-muted);font-size:12px;margin-top:7px;overflow:hidden}
.sdlc-task-workspace span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sdlc-status{display:inline-flex;align-items:center;gap:5px;border-radius:5px;padding:1px 7px;font-size:12px;font-weight:500;white-space:nowrap;color:var(--tone,var(--sdlc-muted));background:color-mix(in srgb,var(--tone,var(--sdlc-muted)) 9%,transparent)}
.sdlc-tone-accent{--tone:var(--sdlc-accent)}.sdlc-tone-success{--tone:var(--sdlc-success)}.sdlc-tone-warning{--tone:var(--sdlc-warning)}.sdlc-tone-error{--tone:var(--sdlc-error)}.sdlc-tone-muted{--tone:var(--sdlc-muted)}
.sdlc-list-footer{font-size:12px;color:var(--sdlc-muted);padding:10px 18px;border-top:1px solid var(--sdlc-border)}
.sdlc-detail{padding:26px 28px 36px;min-width:0;overflow:auto;scrollbar-gutter:stable}
.sdlc-detail-meta{display:flex;align-items:center;gap:12px;font-size:13px;color:var(--sdlc-muted)}
.sdlc-detail h2{font-size:22px;line-height:1.5;font-weight:650;letter-spacing:-.3px;margin:12px 0 10px;overflow-wrap:anywhere}
.sdlc-source{display:flex;align-items:center;flex-wrap:wrap;gap:6px 14px;color:var(--sdlc-muted);font-size:12px}
.sdlc-source-name{display:inline-flex;align-items:center;gap:6px}
.sdlc-step-scroll{overflow-x:auto;margin:28px 0 18px;padding-bottom:6px}
.sdlc-steps{display:grid;grid-template-columns:repeat(7,minmax(70px,1fr));list-style:none;padding:0;margin:0;gap:8px;min-width:560px}
.sdlc-step{text-align:center;min-width:0;color:var(--sdlc-muted);font-size:12px}
.sdlc-step-label{font-weight:550}
.sdlc-step-bar{display:block;height:3px;border-radius:2px;margin:12px 0;background:var(--sdlc-border)}
.sdlc-step.is-done .sdlc-step-bar{background:color-mix(in srgb,var(--sdlc-muted) 65%,transparent)}
.sdlc-step[aria-current=step]{color:var(--sdlc-accent)}.sdlc-step[aria-current=step] .sdlc-step-bar{background:var(--sdlc-accent)}
.sdlc-step button{border:0;background:transparent;font-size:11px;color:var(--sdlc-muted);padding:2px 0;overflow-wrap:anywhere;line-height:1.5}
.sdlc-step button:hover{color:var(--sdlc-accent);text-decoration:underline}
.sdlc-step-missing{font-size:11px;opacity:.7}
.sdlc-tabs{display:flex;gap:26px;border-bottom:1px solid var(--sdlc-border);margin-bottom:24px}
.sdlc-tab{font-size:13px!important}
.sdlc-section{margin:0 0 26px}
.sdlc-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.sdlc-section h3{font-size:14px;font-weight:600;margin:0}
.sdlc-link{display:inline-flex;align-items:center;gap:5px;border:0;padding:0;background:transparent;color:var(--sdlc-accent)!important;font-size:12px!important}
.sdlc-verdict{display:flex;gap:12px;align-items:flex-start;background:color-mix(in srgb,var(--tone,var(--sdlc-muted)) 6%,var(--sdlc-bg));border:1px solid color-mix(in srgb,var(--tone,var(--sdlc-muted)) 22%,transparent);border-radius:8px;padding:14px 16px}
.sdlc-verdict>svg{color:var(--tone);margin-top:3px}
.sdlc-verdict-title{font-size:14px;font-weight:550;color:var(--tone)}
.sdlc-verdict .sdlc-link{margin-top:8px}.sdlc-verdict p{margin:4px 0 0;font-size:13px;color:var(--sdlc-muted);overflow-wrap:anywhere}
.sdlc-artifacts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.sdlc-artifact{display:flex;align-items:center;gap:12px;text-align:left;padding:12px 14px;min-width:0;border:1px solid var(--sdlc-border);border-radius:7px;background:var(--sdlc-bg)}
.sdlc-artifact:hover{border-color:var(--sdlc-accent);background:color-mix(in srgb,var(--sdlc-accent) 3%,var(--sdlc-bg))}
.sdlc-artifact>svg{color:var(--sdlc-muted)}.sdlc-artifact>span{min-width:0}
.sdlc-artifact-name{display:block;font-size:13px;font-weight:550}.sdlc-artifact-file{display:block;font-size:12px;color:var(--sdlc-muted);overflow-wrap:anywhere}
.sdlc-artifact-sections{display:block;font-size:12px;color:var(--sdlc-muted);margin-top:6px;overflow-wrap:anywhere}
.sdlc-progress{font-size:13px;color:var(--sdlc-muted);margin:0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;line-height:1.8}
.sdlc-history{list-style:none;padding:0;margin:0}
.sdlc-history-item{padding:0 0 20px 22px;border-left:1px solid var(--sdlc-border);position:relative;margin-left:5px}
.sdlc-history-item::before{content:'';position:absolute;left:-4px;top:6px;width:7px;height:7px;border-radius:50%;background:var(--sdlc-muted)}
.sdlc-history-item:last-child{border-left-color:transparent;padding-bottom:0}
.sdlc-history-heading{display:flex;gap:12px;align-items:center;margin-bottom:6px;font-size:13px}
.sdlc-history time{font-size:12px;color:var(--sdlc-muted);margin-left:auto;white-space:nowrap}
.sdlc-history summary{font-size:13px;color:var(--sdlc-muted);cursor:pointer}.sdlc-history summary span{display:inline;overflow-wrap:anywhere}
.sdlc-history details:not([open]) summary span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sdlc-history details[open] summary{line-height:1.8}
.sdlc-empty{padding:42px 24px;text-align:center;color:var(--sdlc-muted);font-size:13px}.sdlc-empty h2{font-size:17px;color:var(--sdlc-fg);margin:0 0 8px}.sdlc-empty p{margin:0 0 14px;overflow-wrap:anywhere}
.sdlc-notice{padding:10px 14px;margin-bottom:16px;border:1px solid var(--sdlc-border);border-radius:7px;color:var(--sdlc-muted);font-size:13px}
.sdlc-back{display:none;margin-bottom:18px}
.sdlc-dialog{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);padding:24px}
.sdlc-dialog-panel{width:860px;max-width:100%;max-height:88dvh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay,var(--sdlc-bg));border:1px solid var(--sdlc-border);border-radius:12px;box-shadow:0 20px 80px #0003;overflow:hidden}
.sdlc-dialog-head{display:flex;align-items:center;gap:12px;padding:16px 22px;border-bottom:1px solid var(--sdlc-border)}
.sdlc-dialog-head strong{font-size:14px;overflow-wrap:anywhere}.sdlc-dialog-head span{font-size:12px;color:var(--sdlc-muted)}
.sdlc-dialog-close{margin-left:auto;border:1px solid var(--sdlc-border);background:transparent;border-radius:6px;display:flex;padding:6px}
.sdlc-document{overflow:auto;padding:24px 30px;font-size:14px;line-height:1.85;overflow-wrap:anywhere}
.sdlc-document pre{font-size:13px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
@container (max-width:1000px){.sdlc-page{padding:24px}.sdlc-board{grid-template-columns:minmax(240px,32%) minmax(0,1fr)}.sdlc-detail{padding:22px}.sdlc-detail h2{font-size:20px}.sdlc-header{gap:12px}.sdlc-artifact{padding:10px}}
@container (max-width:760px){.sdlc-page{padding:18px 16px}.sdlc-header{flex-wrap:wrap;gap:6px 12px;margin-bottom:14px}.sdlc-header h1{font-size:22px}.sdlc-caption{order:3;width:100%}.sdlc-toolbar{gap:12px;flex-wrap:wrap}.sdlc-filters{gap:20px}.sdlc-workspace{margin-left:0;max-width:100%;width:100%}.sdlc-board{display:block;height:calc(100dvh - 224px);min-height:420px}.sdlc-list{height:100%;border:0}.sdlc-detail{display:none;height:100%;padding:20px}.sdlc-board.is-detail .sdlc-list{display:none}.sdlc-board.is-detail .sdlc-detail{display:block}.sdlc-back{display:inline-flex}.sdlc-detail h2{font-size:19px}.sdlc-artifacts{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){.sdlc-task{transition:none}}
`;

    function Status({ task }) {
      return h('span', { className: 'sdlc-status sdlc-tone-' + toneOf(task) }, stageName(task.status));
    }
    function Empty({ title, message, children }) {
      return h('div', { className: 'sdlc-empty' }, [h('h2', { key: 't' }, title), h('p', { key: 'm' }, message), children]);
    }
    function SdlcPanel() { return h(SdlcPanelInner, {}); }
    function SdlcPanelInner() {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [filter, setFilter] = React.useState('all');
      const [selected, setSelected] = React.useState(null);
      const [opened, setOpened] = React.useState(null);
      const [query, setQuery] = React.useState('');
      const [workspace, setWorkspace] = React.useState('');
      const [refresh, setRefresh] = React.useState(0);
      React.useEffect(function () {
        let alive = true;
        let timer;
        const controller = new AbortController();
        async function load() {
          try {
            const response = await fetch(ENDPOINT, { credentials: 'same-origin', signal: controller.signal });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const result = await response.json();
            if (result.error) throw new Error(result.error);
            if (alive) { setData(result); setError(null); }
          } catch (e) {
            if (alive) setError(String(e.message || e).slice(0, 160));
          } finally {
            if (alive) { setLoading(false); timer = setTimeout(load, POLL_MS); }
          }
        }
        load();
        return () => { alive = false; controller.abort(); clearTimeout(timer); };
      }, [refresh]);
      const tasks = data && Array.isArray(data.tasks) ? data.tasks : [];
      const roots = data && Array.isArray(data.roots) ? data.roots : [];
      const scoped = tasks.filter(t => !workspace || t.repoRoot === workspace);
      const counts = { all: scoped.length, active: scoped.filter(t => t.status !== 'DONE').length, done: scoped.filter(t => t.status === 'DONE').length };
      const needle = query.trim().toLocaleLowerCase();
      const visible = scoped.filter(t => (filter === 'all' || (filter === 'done' ? t.status === 'DONE' : t.status !== 'DONE')) &&
        (!needle || [t.id, t.title, t.repoLabel].join(' ').toLocaleLowerCase().includes(needle)));
      const sel = visible.find(t => taskKey(t) === selected) || visible[0];
      const reset = () => { setQuery(''); setWorkspace(''); setFilter('all'); setSelected(null); };
      return h('main', { className: 'sdlc-app', 'aria-label': 'SDLC 任务看板' }, [
        h('style', { key: 'css' }, CSS),
        h('div', { key: 'page', className: 'sdlc-page' }, [
          h('header', { key: 'header', className: 'sdlc-header' }, [
            h('h1', { key: 'title' }, '任务看板'),
            h('span', { key: 'scope', className: 'sdlc-caption' }, data ? roots.length + ' 个工作区 · ' + tasks.length + ' 个任务' : '加载任务与交付物'),
            h('button', { key: 'refresh', type: 'button', className: 'sdlc-button sdlc-refresh', disabled: loading, onClick: () => { setLoading(true); setRefresh(n => n + 1); } }, [h(Icon, { key: 'i', name: 'refresh' }), loading ? '读取中…' : '刷新']),
          ]),
          error ? h('div', { key: 'error', role: 'alert', className: 'sdlc-notice' }, '刷新失败：' + error + (data ? '。当前保留上次读取的结果。' : '。请重试。')) : null,
          data ? h('div', { key: 'tools', className: 'sdlc-toolbar' }, [
            h('nav', { key: 'filters', className: 'sdlc-filters', 'aria-label': '任务状态筛选' }, [['all', '全部'], ['active', '进行中'], ['done', '已完成']].map(([value, label]) =>
              h('button', { key: value, type: 'button', className: 'sdlc-filter', 'aria-pressed': filter === value, onClick: () => { setFilter(value); setSelected(null); } }, [label, h('span', { key: 'n', className: 'sdlc-count' }, counts[value])]))),
            h('select', { key: 'workspace', className: 'sdlc-workspace', 'aria-label': '工作区', value: workspace, onChange: e => { setWorkspace(e.target.value); setSelected(null); } }, [
              h('option', { key: 'all', value: '' }, '所有工作区'),
              ...roots.map(r => h('option', { key: r.root, value: r.root }, r.label)),
            ]),
          ]) : null,
          !data ? h(Empty, { key: 'loading', title: error ? '暂时无法读取看板' : '正在读取任务', message: error ? '点击刷新，再试一次。' : '正在整理工作区中的任务与交付物。' }) :
            !tasks.length ? h(Empty, { key: 'empty', title: '还没有任务', message: '创建第一个 SDLC 任务后，它会出现在这里。', children: h('details', {}, [h('summary', { key: 's' }, '已检查的工作区'), ...(data.searched || []).map(p => h('p', { key: p }, p))]) }) :
              h('div', { key: 'board', className: 'sdlc-board' + (selected && sel && taskKey(sel) === selected ? ' is-detail' : '') }, [
                h('aside', { key: 'list', className: 'sdlc-list', 'aria-label': '任务列表' }, [
                  h('label', { key: 'search', className: 'sdlc-search' }, [h(Icon, { key: 'i', name: 'search' }), h('input', { key: 'input', type: 'search', placeholder: '搜索任务…', 'aria-label': '搜索任务', value: query, onChange: e => { setQuery(e.target.value); setSelected(null); } })]),
                  h('div', { key: 'rows', className: 'sdlc-rows' }, visible.length ? visible.map(t => h(TaskLine, { key: taskKey(t), task: t, active: sel && taskKey(t) === taskKey(sel), onClick: () => setSelected(taskKey(t)) })) : h(Empty, { title: '没有匹配的任务', message: '试试其他关键词或工作区。', children: h('button', { className: 'sdlc-link', onClick: reset }, '清除筛选') })),
                  h('div', { key: 'footer', className: 'sdlc-list-footer', role: 'status' }, '显示 ' + visible.length + ' 个任务'),
                ]),
                sel ? h(Detail, { key: taskKey(sel), task: sel, onBack: () => setSelected(null), onOpen: file => setOpened({ task: sel.id, root: sel.repoRoot, file }) }) : h('div', { key: 'none', className: 'sdlc-detail' }, h(Empty, { title: '没有匹配的任务', message: '调整左侧筛选后，任务详情会显示在这里。' })),
              ]),
        ]),
        opened ? h(ArtifactViewer, { key: JSON.stringify(opened), ...opened, onClose: () => setOpened(null) }) : null,
      ]);
    }
    function TaskLine({ task: t, active, onClick }) {
      return h('button', { type: 'button', className: 'sdlc-task', 'aria-pressed': !!active, onClick }, [
        h('span', { key: 'meta', className: 'sdlc-task-meta' }, [h('span', { key: 'id', className: 'sdlc-task-id' }, t.id), h(Status, { key: 'status', task: t })]),
        h('span', { key: 'title', className: 'sdlc-task-title' }, t.title || t.id),
        h('span', { key: 'source', className: 'sdlc-task-workspace', title: t.repoRoot || '' }, [h(Icon, { key: 'i', name: 'folder', size: 12 }), h('span', { key: 'label' }, t.repoLabel || '工作区未记录')]),
      ]);
    }
    function Stepper({ task: t, onOpen }) {
      const cur = STAGES.indexOf(t.status);
      return h('div', { className: 'sdlc-step-scroll', 'aria-label': '任务阶段与交付物' }, h('ol', { className: 'sdlc-steps' }, STAGES.map((stage, i) => {
        const art = (t.artifacts || []).find(a => a.kind === STAGE_ARTIFACT[stage]);
        return h('li', { key: stage, className: 'sdlc-step' + (i < cur ? ' is-done' : ''), 'aria-current': i === cur ? 'step' : undefined }, [
          h('span', { key: 'label', className: 'sdlc-step-label' }, stageName(stage)), h('span', { key: 'bar', className: 'sdlc-step-bar', 'aria-hidden': true }),
          art ? h('button', { key: 'file', type: 'button', title: '查看 ' + art.file, onClick: () => onOpen(art.file) }, art.file) : STAGE_ARTIFACT[stage] ? h('span', { key: 'missing', className: 'sdlc-step-missing' }, '未登记') : null,
        ]);
      })));
    }
    function ArtifactList({ task, onOpen, expanded }) {
      const order = Object.keys(ARTIFACT_CN);
      const artifacts = (task.artifacts || []).slice().sort((a, b) => {
        const rank = kind => order.includes(kind) ? order.indexOf(kind) : order.length;
        return rank(a.kind) - rank(b.kind);
      });
      return artifacts.length ? h('div', { className: 'sdlc-artifacts' }, artifacts.map(a => h('button', { key: a.kind + ':' + a.file, type: 'button', className: 'sdlc-artifact', onClick: () => onOpen(a.file) }, [
        h(Icon, { key: 'i', name: 'doc', size: 24 }),
        h('span', { key: 'text' }, [h('span', { key: 'kind', className: 'sdlc-artifact-name' }, ARTIFACT_CN[a.kind] || a.kind), h('span', { key: 'file', className: 'sdlc-artifact-file' }, a.file),
          expanded ? h('span', { key: 'sections', className: 'sdlc-artifact-sections' }, [a.bytes ? (a.bytes / 1024).toFixed(1) + ' KB' : '', ...(a.sections || [])].filter(Boolean).join(' · ')) : null]),
      ]))) : h('p', { className: 'sdlc-caption' }, '还没有登记交付物。');
    }
    function Verdict({ task: t, onOpen }) {
      const v = t.verdict;
      const tone = v ? v.status === 'approve' ? 'success' : v.status === 'reject' ? 'error' : 'warning' : 'muted';
      const title = v ? v.status === 'approve' ? '验证通过' : v.status === 'reject' ? '验证未通过' : '需要人工确认' : '尚无验证结论';
      return h('div', { className: 'sdlc-verdict sdlc-tone-' + tone }, [
        h(Icon, { key: 'i', name: v ? v.status === 'approve' ? 'check' : 'warn' : 'doc', size: 20 }),
        h('div', { key: 'body' }, [h('div', { key: 'title', className: 'sdlc-verdict-title' }, title),
          h('p', { key: 'numbers' }, v ? (v.met || 0) + ' 条通过 · ' + (v.notMet || 0) + ' 条未通过 · ' + (v.cannotTell || 0) + ' 条待确认' : '运行独立验证后，在这里查看结论。'),
          v && v.summary ? h('p', { key: 'summary', className: 'sdlc-progress' }, v.summary) : null,
          v && (t.artifacts || []).some(a => a.kind === 'verification') ? h('button', { key: 'full', className: 'sdlc-link', onClick: () => onOpen(t.artifacts.find(a => a.kind === 'verification').file) }, '查看完整裁决') : null,
          v && (v.findings || v.unverified) ? h('p', { key: 'findings' }, (v.findings || 0) + ' 条发现 · ' + (v.unverified || 0) + ' 项未复核') : null,
        ]),
      ]);
    }
    function Timeline({ task }) {
      const items = (task.timeline || []).slice().reverse();
      if (!items.length) return h('p', { className: 'sdlc-caption' }, '还没有迁移记录。');
      return h('ol', { className: 'sdlc-history' }, items.map((e, i) => h('li', { key: i, className: 'sdlc-history-item' }, [
        h('div', { key: 'head', className: 'sdlc-history-heading' }, [h('strong', { key: 'stage' }, stageName(e.to)), h('time', { key: 'time', dateTime: e.at }, shortTime(e.at))]),
        e.reason ? h('details', { key: 'reason' }, h('summary', { title: '展开或收起完整记录' }, h('span', {}, e.reason))) : null,
      ])));
    }
    function Detail({ task: t, onOpen, onBack }) {
      const [tab, setTab] = React.useState('overview');
      const latest = (t.timeline || []).slice(-1)[0];
      return h('section', { className: 'sdlc-detail', 'aria-label': '任务详情' }, [
        h('button', { key: 'back', className: 'sdlc-button sdlc-back', onClick: onBack }, [h(Icon, { key: 'i', name: 'back' }), '返回任务列表']),
        h('div', { key: 'meta', className: 'sdlc-detail-meta' }, [h('span', { key: 'id' }, t.id), h(Status, { key: 's', task: t })]),
        h('h2', { key: 'title' }, t.title || t.id),
        h('div', { key: 'source', className: 'sdlc-source' }, [h('span', { key: 'repo', className: 'sdlc-source-name', title: t.repoRoot || '' }, [h(Icon, { key: 'i', name: 'folder', size: 14 }), t.repoLabel || '工作区未记录']), h('span', { key: 'updated' }, shortTime(t.updated) + ' 更新')]),
        h(Stepper, { key: 'steps', task: t, onOpen }),
        h('nav', { key: 'tabs', className: 'sdlc-tabs', 'aria-label': '任务详情视图' }, [['overview', '概览'], ['artifacts', '交付物'], ['history', '迁移记录']].map(([value, label]) => h('button', { key: value, className: 'sdlc-tab', 'aria-pressed': tab === value, onClick: () => setTab(value) }, label))),
        tab === 'overview' ? h('div', { key: 'overview' }, [
          t.blocked && t.blocked.length ? h('section', { key: 'blocked', className: 'sdlc-section' }, h('div', { className: 'sdlc-verdict sdlc-tone-warning' }, [h(Icon, { key: 'i', name: 'warn' }), h('div', { key: 'b' }, [h('strong', { key: 'title' }, '还需要完成'), h('p', { key: 'text' }, t.blocked.join('；'))])])) : null,
          h('section', { key: 'verdict', className: 'sdlc-section' }, [h('div', { key: 'head', className: 'sdlc-section-head' }, h('h3', {}, '验证结论')), h(Verdict, { key: 'body', task: t, onOpen })]),
          t.review && (t.review.decision || t.review.rounds) ? h('p', { key: 'review', className: 'sdlc-caption' }, '评审：' + (t.review.decision === 'accept' ? '接受' : t.review.decision || '尚无结论') + ' · ' + (t.review.rounds || 0) + ' 轮独立验证' + (t.review.notAccepted ? ' · ' + t.review.notAccepted + ' 项未接受' : '')) : null,
          h('section', { key: 'rsi', className: 'sdlc-section' }, [
            h('div', { key: 'head', className: 'sdlc-section-head' }, h('h3', {}, '执行记录与插件改进')),
            h('p', { key: 'status' }, !t.rsi ? '尚未确认执行记录是否完整' : t.rsi.evidence_complete ? '已登记的执行证据完整' : '执行证据不完整'),
            t.rsi ? h('p', { key: 'counts', className: 'sdlc-caption' }, t.rsi.session_count + ' 个会话 · ' + t.rsi.run_count + ' 次验证 · ' + (t.rsi.review_status === 'proposed' ? '已提出插件改进' : t.rsi.review_status === 'collecting' ? '记录中' : '待复盘')) : h('p', { key: 'legacy', className: 'sdlc-caption' }, '任务完成不代表执行过程已记录；旧任务需要补查原始会话。'),
            t.rsi && t.rsi.issues.length ? h('details', { key: 'issues' }, [h('summary', { key: 's' }, '查看记录缺口'), h('ul', { key: 'list' }, t.rsi.issues.map((issue, i) => h('li', { key: i }, issue)))]) : null,
            t.rsi && t.rsi.updated_at ? h('p', { key: 'at', className: 'sdlc-caption' }, '最近核对：' + shortTime(t.rsi.updated_at)) : null,
          ]),
          h('section', { key: 'artifacts', className: 'sdlc-section' }, [h('div', { key: 'head', className: 'sdlc-section-head' }, h('h3', {}, '交付物')), h(ArtifactList, { key: 'body', task: t, onOpen })]),
          latest ? h('section', { key: 'latest', className: 'sdlc-section' }, [h('div', { key: 'head', className: 'sdlc-section-head' }, [h('h3', { key: 'title' }, '最新进展'), h('button', { key: 'all', className: 'sdlc-link', onClick: () => setTab('history') }, ['查看全部记录', h(Icon, { key: 'i', name: 'arrow', size: 14 })])]), h('p', { key: 'text', className: 'sdlc-progress' }, latest.reason || stageName(latest.to))]) : null,
        ]) : tab === 'artifacts' ? h(ArtifactList, { key: 'artifacts', task: t, onOpen, expanded: true }) : h(Timeline, { key: 'history', task: t }),
      ]);
    }
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
            style: Object.assign({}, F.mono, { fontSize: '13px', padding: '0 3px', borderRadius: '3px', background: 'var(--dsw-alias-bg-layer-2)' }),
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
                fontSize: '13px', lineHeight: '22px', padding: '8px 10px', margin: '6px 0',
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


    /** 原生 dialog 提供焦点圈定和 Escape；关闭后归还触发按钮焦点。 */
    function ArtifactViewer(props) {
      const [state, setState] = React.useState({ phase: 'loading' });
      React.useEffect(() => {
        let alive = true;
        const controller = new AbortController();
        const qs = './api/sdlc-ui.artifact?task=' + encodeURIComponent(props.task) + '&file=' + encodeURIComponent(props.file) + (props.root ? '&root=' + encodeURIComponent(props.root) : '');
        fetch(qs, { credentials: 'same-origin', signal: controller.signal })
          .then(r => r.json().then(d => { if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status); return d; }))
          .then(d => { if (alive) setState({ phase: 'ready', text: d.text, bytes: d.bytes }); })
          .catch(e => { if (alive) setState({ phase: 'error', error: String(e.message || e) }); });
        return () => { alive = false; controller.abort(); };
      }, [props.task, props.root, props.file]);
      React.useEffect(() => {
        const dialog = document.getElementById('sdlc-artifact-dialog');
        const trigger = document.activeElement;
        if (dialog && !dialog.open) dialog.showModal();
        return () => { if (dialog) dialog.close(); if (trigger && trigger.isConnected && trigger.focus) trigger.focus(); };
      }, []);
      let body;
      if (state.phase === 'loading') body = h('p', { role: 'status' }, '读取中…');
      else if (state.phase === 'error') body = h('p', { role: 'alert' }, '读不出来：' + state.error);
      else if (/\.json$/i.test(props.file)) {
        let text = state.text;
        try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* 非 JSON 内容原样展示。 */ }
        body = h('pre', { style: F.mono }, text);
      } else body = h('div', {}, renderMarkdown(state.text || ''));
      return h('dialog', { id: 'sdlc-artifact-dialog', className: 'sdlc-dialog', 'aria-label': '交付物 ' + props.file, onCancel: e => { e.preventDefault(); props.onClose(); }, onClick: e => { if (e.target === e.currentTarget) props.onClose(); }, style: { width: '100%', height: '100%', maxWidth: 'none', maxHeight: 'none', margin: 0, border: 0 } },
        h('div', { className: 'sdlc-dialog-panel' }, [
          h('header', { key: 'header', className: 'sdlc-dialog-head' }, [h(Icon, { key: 'i', name: 'doc', size: 20 }), h('strong', { key: 'file' }, props.file), h('span', { key: 'task' }, props.task), h('button', { key: 'close', className: 'sdlc-dialog-close', 'aria-label': '关闭交付物', onClick: props.onClose }, h(Icon, { name: 'close' }))]),
          h('div', { key: 'body', className: 'sdlc-document' }, body),
        ]));
    }
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

    const inject = ['slots'];
    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', function* () {
        yield ctx.slots.register({ name: 'sidebar.panellist', id: 'sdlc', order: 30, label: 'SDLC' }, SdlcIcon);
      });
      ctx.slots.inject('main', function* () {
        yield ctx.slots.register({ name: 'main', key: 'sdlc' }, SdlcPanel);
      });
    }
    return { apply, inject };
  },
});
