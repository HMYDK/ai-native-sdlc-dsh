/**
 * SDLC 循环工作台。宿主提供 React；只读查看任务、逐轮验证、修复与证据。
 * 轮次来自独立运行 ID，未结束记录不代表 Agent 仍在执行。
 */
window.__ModuleLoader__.load({
  id: '@ai-native-sdlc/dsh-sdlc',
  factory: (require) => {
    const React = require('react');
    const runtime = require('react/jsx-runtime');
    function h(type, props, children) {
      const merged = Object.assign({}, props);
      const key = merged.key; delete merged.key;
      if (children !== undefined) merged.children = children;
      return (Array.isArray(children) ? runtime.jsxs : runtime.jsx)(type, merged, key);
    }
    const POLL_MS = 15000;
    const ENDPOINT = './api/sdlc-ui.tasks';
    const STAGES = ['INTENT', 'SPEC', 'PLANNED', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'DONE'];
    const STAGE_CN = { INTENT: '意图', SPEC: '规格', PLANNED: '计划', IMPLEMENTING: '实现', VERIFYING: '验证', REVIEWING: '评审', DONE: '完成' };
    const STAGE_ARTIFACT = { INTENT: 'intent', SPEC: 'spec', PLANNED: 'plan', VERIFYING: 'verification', REVIEWING: 'review' };
    const ARTIFACT_CN = { intent: '意图', spec: '规格', plan: '计划', verification: '验证记录', review: '评审', proof: '验证证据' };
    const OUTCOMES = {
      approve: { label: '验证通过', tone: 'success', icon: 'circle-check' },
      reject: { label: '未通过', tone: 'error', icon: 'alert-triangle' },
      needs_human: { label: '需要人工确认', tone: 'warning', icon: 'alert-triangle' },
      error: { label: '执行出错', tone: 'error', icon: 'alert-triangle' },
      cancelled: { label: '已取消', tone: 'muted', icon: 'x' },
      no_verdict: { label: '未形成裁决', tone: 'warning', icon: 'circle-dashed' },
      incomplete: { label: '记录未结束', tone: 'warning', icon: 'circle-dashed' },
    };
    const T = { fg: 'var(--s-fg)', fg2: 'var(--s-muted)', border: 'var(--s-line)', border2: 'var(--s-line)' };
    const F = { mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } };
    const taskKey = t => JSON.stringify([t.repoRoot || '', t.id]);
    const stageName = value => STAGE_CN[value] || value || '未知阶段';
    const outcomeOf = round => OUTCOMES[round && round.outcome] || { label: '尚无裁决', tone: 'muted', icon: 'circle-dashed' };
    const roundName = round => round.source === 'current_verdict' ? '当前裁决' : '第 ' + round.number + ' 轮';
    function shortTime(iso) {
      const d = new Date(iso);
      if (!iso || isNaN(d.getTime())) return '时间未记录';
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
    // Tabler Icons v3.35.0 outline subset, MIT, Copyright (c) 2020-2025 Paweł Kuna.
    // Trusted static library SVG only. User content is never used as markup.
    const ICONS = {"search":"<path d=\"M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0\" />\n  <path d=\"M21 21l-6 -6\" />","refresh":"<path d=\"M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4\" />\n  <path d=\"M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4\" />","file-text":"<path d=\"M14 3v4a1 1 0 0 0 1 1h4\" />\n  <path d=\"M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z\" />\n  <path d=\"M9 9l1 0\" />\n  <path d=\"M9 13l6 0\" />\n  <path d=\"M9 17l6 0\" />","arrow-right":"<path d=\"M5 12l14 0\" />\n  <path d=\"M13 18l6 -6\" />\n  <path d=\"M13 6l6 6\" />","arrow-left":"<path d=\"M5 12l14 0\" />\n  <path d=\"M5 12l6 6\" />\n  <path d=\"M5 12l6 -6\" />","check":"<path d=\"M5 12l5 5l10 -10\" />","x":"<path d=\"M18 6l-12 12\" />\n  <path d=\"M6 6l12 12\" />","alert-triangle":"<path d=\"M12 9v4\" />\n  <path d=\"M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z\" />\n  <path d=\"M12 16h.01\" />","folder":"<path d=\"M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2\" />","sun":"<path d=\"M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0\" />\n  <path d=\"M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7\" />","moon":"<path d=\"M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z\" />","git-branch":"<path d=\"M7 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0\" />\n  <path d=\"M7 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0\" />\n  <path d=\"M17 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0\" />\n  <path d=\"M7 8l0 8\" />\n  <path d=\"M9 18h6a2 2 0 0 0 2 -2v-5\" />\n  <path d=\"M14 14l3 -3l3 3\" />","history":"<path d=\"M12 8l0 4l2 2\" />\n  <path d=\"M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5\" />","chevron-down":"<path d=\"M6 9l6 6l6 -6\" />","chevron-right":"<path d=\"M9 6l6 6l-6 6\" />","circle-check":"<path d=\"M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0\" />\n  <path d=\"M9 12l2 2l4 -4\" />","circle-dashed":"<path d=\"M8.56 3.69a9 9 0 0 0 -2.92 1.95\" />\n  <path d=\"M3.69 8.56a9 9 0 0 0 -.69 3.44\" />\n  <path d=\"M3.69 15.44a9 9 0 0 0 1.95 2.92\" />\n  <path d=\"M8.56 20.31a9 9 0 0 0 3.44 .69\" />\n  <path d=\"M15.44 20.31a9 9 0 0 0 2.92 -1.95\" />\n  <path d=\"M20.31 15.44a9 9 0 0 0 .69 -3.44\" />\n  <path d=\"M20.31 8.56a9 9 0 0 0 -1.95 -2.92\" />\n  <path d=\"M15.44 3.69a9 9 0 0 0 -3.44 -.69\" />","bulb":"<path d=\"M3 12h1m8 -9v1m8 8h1m-15.4 -6.4l.7 .7m12.1 -.7l-.7 .7\" />\n  <path d=\"M9 16a5 5 0 1 1 6 0a3.5 3.5 0 0 0 -1 3a2 2 0 0 1 -4 0a3.5 3.5 0 0 0 -1 -3\" />\n  <path d=\"M9.7 17l4.6 0\" />","flag":"<path d=\"M5 5a5 5 0 0 1 7 0a5 5 0 0 0 7 0v9a5 5 0 0 1 -7 0a5 5 0 0 0 -7 0v-9z\" />\n  <path d=\"M5 21v-7\" />","list-details":"<path d=\"M13 5h8\" />\n  <path d=\"M13 9h5\" />\n  <path d=\"M13 15h8\" />\n  <path d=\"M13 19h5\" />\n  <path d=\"M3 4m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z\" />\n  <path d=\"M3 14m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z\" />","clipboard-check":"<path d=\"M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2\" />\n  <path d=\"M9 3m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v0a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z\" />\n  <path d=\"M9 14l2 2l4 -4\" />","bug":"<path d=\"M9 9v-1a3 3 0 0 1 6 0v1\" />\n  <path d=\"M8 9h8a6 6 0 0 1 1 3v3a5 5 0 0 1 -10 0v-3a6 6 0 0 1 1 -3\" />\n  <path d=\"M3 13l4 0\" />\n  <path d=\"M17 13l4 0\" />\n  <path d=\"M12 20l0 -6\" />\n  <path d=\"M4 19l3.35 -2\" />\n  <path d=\"M20 19l-3.35 -2\" />\n  <path d=\"M4 7l3.75 2.4\" />\n  <path d=\"M20 7l-3.75 2.4\" />","code":"<path d=\"M7 8l-4 4l4 4\" />\n  <path d=\"M17 8l4 4l-4 4\" />\n  <path d=\"M14 4l-4 16\" />","terminal-2":"<path d=\"M8 9l3 3l-3 3\" />\n  <path d=\"M13 15l3 0\" />\n  <path d=\"M3 4m0 2a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z\" />"};
    const ICON_ALIASES = { doc: 'file-text', arrow: 'arrow-right', back: 'arrow-left', close: 'x', warn: 'alert-triangle' };
    function Icon({ name, size = 18 }) {
      const key = ICON_ALIASES[name] || name;
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.65, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        dangerouslySetInnerHTML: { __html: ICONS[key] || ICONS['file-text'] } });
    }
    const CSS = `
.sdlc-app,.sdlc-dialog{--s-bg:#171c1e;--s-side:#14191b;--s-surface:#1d2427;--s-raised:#242e31;--s-fg:#e9efec;--s-muted:#9aa8a8;--s-dim:#6c7c80;--s-line:#2c383b;--s-accent:#b2ddc9;--s-accent-bg:#203c34;--s-coral:#e6a08c;--s-warning:#d8bc83;--s-shadow:0 24px 80px #0006;color:var(--s-fg);background:var(--s-bg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;font-size:14px;line-height:1.6;color-scheme:dark;text-align:left}
.sdlc-app[data-theme=light],.sdlc-dialog[data-theme=light]{--s-bg:#fafbf9;--s-side:#f1f4f0;--s-surface:#fff;--s-raised:#e9efea;--s-fg:#22322d;--s-muted:#60726b;--s-dim:#6e7d76;--s-line:#dce4df;--s-accent:#28664f;--s-accent-bg:#e0efe5;--s-coral:#ae4e38;--s-warning:#81601e;--s-shadow:0 24px 80px #17322622;color-scheme:light}
.sdlc-app{width:100%;height:100%;min-width:0;container-type:inline-size;overflow:auto}
.sdlc-app *,.sdlc-dialog *{box-sizing:border-box}
.sdlc-app button,.sdlc-app input,.sdlc-app select,.sdlc-dialog button{font:inherit;color:inherit}
.sdlc-app button,.sdlc-dialog button{cursor:pointer}
.sdlc-app button:disabled{cursor:wait;opacity:.55}
.sdlc-app button:focus-visible,.sdlc-app input:focus-visible,.sdlc-app select:focus-visible,.sdlc-app summary:focus-visible,.sdlc-dialog button:focus-visible{outline:2px solid var(--s-accent);outline-offset:4px}
.sdlc-app svg,.sdlc-dialog svg{flex-shrink:0;vertical-align:middle}
.sdlc-app h1,.sdlc-app h2,.sdlc-app h3,.sdlc-app p,.sdlc-dialog h2,.sdlc-dialog h3{margin:0}
.sdlc-muted,.sdlc-caption{color:var(--s-muted)}
.sdlc-caption{font-size:12px}
.sdlc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
.sdlc-shell{display:grid;grid-template-columns:226px minmax(0,1fr);min-height:100%;max-width:1800px;margin:0 auto}
.sdlc-sidebar{border-right:1px solid var(--s-line);background:var(--s-side);display:flex;flex-direction:column;min-width:0;padding:28px 14px 18px;gap:20px}
.sdlc-brand{display:flex;align-items:center;gap:12px;padding:0 8px 9px}
.sdlc-brand-mark{color:var(--s-accent);width:34px;height:38px;display:grid;place-items:center;border:1px solid var(--s-line);border-radius:10px}
.sdlc-brand h1{font-size:17px;font-weight:650;letter-spacing:-.3px;line-height:1.4}
.sdlc-brand p{font-size:11px;color:var(--s-muted);letter-spacing:1.4px;margin-top:4px}
.sdlc-workspace{width:100%;border:1px solid var(--s-line);background:var(--s-surface);border-radius:8px;padding:9px 12px;font-size:13px!important;text-overflow:ellipsis;min-width:0}
.sdlc-search{display:flex;align-items:center;gap:8px;padding:8px 11px;border:1px solid var(--s-line);border-radius:7px;color:var(--s-muted)}
.sdlc-search input{border:0;background:transparent;outline:none;width:100%;min-width:0;font-size:12px}
.sdlc-search:focus-within{border-color:var(--s-accent)}
.sdlc-filter-row{display:flex;justify-content:space-between;gap:4px}
.sdlc-filter{border:0;background:transparent;border-radius:5px;color:var(--s-muted)!important;font-size:12px!important;padding:5px 7px;white-space:nowrap}
.sdlc-filter[aria-pressed=true]{background:var(--s-raised);color:var(--s-fg)!important}
.sdlc-count{font-size:11px;margin-left:5px;opacity:.7}
.sdlc-list{display:flex;flex-direction:column;gap:7px;flex:1;min-height:180px}
.sdlc-task{display:flex;align-items:flex-start;gap:11px;padding:14px 11px;text-align:left;background:none;border:1px solid transparent;border-radius:8px;width:100%;position:relative}
.sdlc-task:hover{background:var(--s-surface)}
.sdlc-task[aria-pressed=true]{background:var(--s-accent-bg);border-color:color-mix(in srgb,var(--s-accent) 28%,transparent)}
.sdlc-task[aria-pressed=true]::before{content:"";position:absolute;left:-1px;top:13px;bottom:13px;width:3px;background:var(--s-accent);border-radius:2px}
.sdlc-task-icon{margin-top:5px;color:var(--s-muted)}.sdlc-task[aria-pressed=true] .sdlc-task-icon{color:var(--s-accent)}
.sdlc-task-content{min-width:0;flex:1}.sdlc-task-meta{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11px;color:var(--s-muted)}
.sdlc-task-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:13px;font-weight:550;margin-top:4px}
.sdlc-task-workspace{display:block;color:var(--s-dim);font-size:11px;margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sdlc-sidebar-bottom{border-top:1px solid var(--s-line);padding-top:16px;display:flex;gap:8px;align-items:center;justify-content:space-between}
.sdlc-icon-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;background:none;border:1px solid transparent;border-radius:7px;min-width:32px;min-height:32px;color:var(--s-muted)!important}
.sdlc-icon-button:hover{background:var(--s-raised);color:var(--s-fg)!important}
.sdlc-detail{min-width:0;padding:22px 30px 24px;overflow:hidden}
.sdlc-detail-top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:4px}
.sdlc-detail-top .sdlc-icon-button{min-height:24px}
.sdlc-breadcrumb{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--s-muted)}
.sdlc-detail h2{font-size:27px;letter-spacing:-.7px;font-weight:650;line-height:1.4}
.sdlc-source{display:flex;align-items:center;flex-wrap:wrap;gap:16px;font-size:12px;color:var(--s-muted);margin-top:10px}
.sdlc-source>span{display:inline-flex;align-items:center;gap:6px}
.sdlc-status{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:12px;color:var(--s-muted)}
.sdlc-status::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor}
.sdlc-app .sdlc-tone-success,.sdlc-app .sdlc-tone-accent{color:var(--s-accent)}.sdlc-app .sdlc-tone-error{color:var(--s-coral)}.sdlc-app .sdlc-tone-warning{color:var(--s-warning)}
.sdlc-stage-scroll{overflow-x:auto;padding:29px 0 24px;border-bottom:1px solid var(--s-line)}
.sdlc-stages{display:flex;list-style:none;padding:0;margin:0;min-width:550px}
.sdlc-stage{flex:1;min-width:0;position:relative;text-align:center}
.sdlc-stage:not(:last-child)::after{content:"";position:absolute;left:calc(50% + 19px);right:calc(-50% + 19px);top:16px;height:1px;background:var(--s-line)}
.sdlc-stage.visited:not(:last-child)::after{background:color-mix(in srgb,var(--s-accent) 55%,var(--s-line))}
.sdlc-stage button{position:relative;z-index:1;background:none;border:0;padding:0 12px;color:var(--s-dim);font-size:12px;display:inline-flex;align-items:center;flex-direction:column;gap:8px}
.sdlc-stage-dot{width:33px;height:33px;border:1px solid var(--s-line);border-radius:50%;display:grid;place-items:center;background:var(--s-bg);font-size:12px;font-variant-numeric:tabular-nums}
.sdlc-stage.visited .sdlc-stage-dot{background:var(--s-accent);border-color:var(--s-accent);color:var(--s-bg)}
.sdlc-stage.visited button{color:var(--s-fg)}
.sdlc-stage[aria-current=step] .sdlc-stage-dot{color:var(--s-accent);border:2px solid var(--s-accent);box-shadow:0 0 0 4px var(--s-accent-bg)}
.sdlc-stage[aria-current=step] button{color:var(--s-accent);font-weight:600}
.sdlc-notice{font-size:12px;line-height:1.7;padding:10px 13px;border-left:2px solid var(--s-warning);background:color-mix(in srgb,var(--s-warning) 7%,var(--s-bg));color:var(--s-muted);margin-top:16px;border-radius:0 6px 6px 0}
.sdlc-notice summary{cursor:pointer;color:var(--s-warning)}
.sdlc-notice ul{margin:7px 0 0;padding-left:18px}
.sdlc-workbench{display:grid;grid-template-columns:minmax(370px,1.65fr) minmax(270px,1fr);gap:25px;margin-top:24px}
.sdlc-canvas{min-width:0;display:flex;flex-direction:column}
.sdlc-canvas-heading{display:flex;justify-content:space-between;align-items:center;gap:8px;min-height:28px}
.sdlc-eyebrow{font-size:11px;letter-spacing:1.2px;color:var(--s-muted);font-weight:500}
.sdlc-history-badge{font-size:11px;color:var(--s-warning);display:flex;gap:10px;align-items:center}
.sdlc-loop{position:relative;aspect-ratio:600/520;width:100%;min-height:330px;margin:calc(18px - 14.7%) 0 9px}
.sdlc-loop-lines{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
.sdlc-loop-lines .sdlc-orbit{fill:none;stroke:var(--s-dim);stroke-width:1.7}
.sdlc-loop-lines .sdlc-return{stroke:var(--s-coral)}
.sdlc-loop-lines .sdlc-exit{stroke:var(--s-accent);stroke-dasharray:4 5;opacity:.6}
.sdlc-node{position:absolute;transform:translate(-50%,-50%);width:31%;min-height:76px;padding:14px 11px;background:var(--s-surface);border:1px solid var(--s-line);border-radius:10px;text-align:left;display:flex;gap:11px;align-items:center;transition:border-color .15s}
.sdlc-node:hover{background:var(--s-raised);border-color:var(--s-muted)}
.sdlc-node.is-selected{border-color:var(--s-accent);background:var(--s-accent-bg);box-shadow:inset 0 0 0 1px var(--s-accent)}
.sdlc-node.findings{left:50%;top:17%}.sdlc-node.repair{left:81%;top:51%}.sdlc-node.checks{left:50%;top:86%}.sdlc-node.verify{left:19%;top:51%}
.sdlc-node-icon{width:34px;height:34px;border-radius:50%;background:var(--s-raised);display:grid;place-items:center;color:var(--s-muted)}
.sdlc-node.is-selected .sdlc-node-icon{color:var(--s-bg);background:var(--s-accent)}
.sdlc-node.findings .sdlc-node-icon{color:var(--s-coral)}
.sdlc-node.findings.is-selected .sdlc-node-icon{background:var(--s-raised)}
.sdlc-node-title{font-size:14px;font-weight:600;display:block;white-space:nowrap}
.sdlc-node-caption{font-size:12px;color:var(--s-muted);display:block;line-height:1.5;margin-top:3px}
.sdlc-loop-center{position:absolute;top:46%;left:50%;transform:translate(-50%,-50%);text-align:center;max-width:32%;pointer-events:none}
.sdlc-round-number{font-size:54px;line-height:1.2;letter-spacing:-3px;font-weight:600;color:var(--s-accent);font-variant-numeric:tabular-nums;margin:7px 0!important}
.sdlc-center-label{font-size:17px;font-weight:600;color:var(--s-accent)}
.sdlc-loop-center .sdlc-caption{font-size:11px;margin-top:8px}
.sdlc-loop-return-label{position:absolute;left:9%;top:30%;font-size:12px;color:var(--s-coral);padding:0 4px;background:var(--s-bg)}
.sdlc-loop-exit-label{position:absolute;right:1%;top:74%;font-size:12px;color:var(--s-accent)}
.sdlc-context-line{font-size:11px;color:var(--s-muted);display:flex;justify-content:space-between;gap:10px;border-top:1px solid var(--s-line);padding-top:12px;margin-top:auto}
.sdlc-inspector{border-left:1px solid var(--s-line);padding-left:25px;min-width:0}
.sdlc-inspector h3{font-size:17px;letter-spacing:-.3px;margin-bottom:14px;font-weight:600}
.sdlc-summary{color:var(--s-muted);font-size:14px;line-height:1.75;margin:8px 0 14px!important;overflow-wrap:anywhere}
.sdlc-verdict-line{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px;margin-bottom:9px}
.sdlc-finding-list{display:flex;flex-direction:column;gap:6px;margin-bottom:12px;max-height:190px;overflow:auto}
.sdlc-finding{width:100%;display:flex;gap:9px;align-items:flex-start;text-align:left;background:transparent;border:1px solid transparent;border-radius:6px;padding:9px}
.sdlc-finding[aria-pressed=true]{background:var(--s-surface);border-color:var(--s-line)}
.sdlc-finding-id{color:var(--s-coral);font-size:10px;font-family:ui-monospace,SFMono-Regular,monospace;white-space:nowrap;margin-top:2px}
.sdlc-finding-description{font-size:14px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sdlc-evidence-chain{list-style:none;padding:0;margin:8px 0 20px}
.sdlc-evidence-chain li{position:relative;padding:0 0 16px 20px;margin-left:5px;border-left:1px solid var(--s-line)}
.sdlc-evidence-chain li:last-child{padding-bottom:0;border-left-color:transparent}
.sdlc-evidence-chain li::before{content:"";position:absolute;left:-4px;top:6px;width:7px;height:7px;border-radius:50%;background:var(--s-dim)}
.sdlc-evidence-chain li:first-child::before{background:var(--s-coral)}
.sdlc-evidence-chain li:last-child::before{background:var(--s-accent)}
.sdlc-chain-label{display:block;font-size:12px;color:var(--s-muted);margin-bottom:4px}
.sdlc-chain-text{display:block;font-size:14px;line-height:1.7;overflow-wrap:anywhere}
.sdlc-clamp{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.sdlc-primary{display:flex;width:100%;align-items:center;justify-content:center;gap:9px;padding:10px 16px;background:var(--s-accent);color:var(--s-bg)!important;border:0;border-radius:7px;font-size:12px!important;font-weight:600!important;min-height:39px}
.sdlc-primary:hover{filter:brightness(1.08)}
.sdlc-link{display:inline-flex;align-items:center;gap:6px;padding:0;background:none;border:0;color:var(--s-accent)!important;font-size:11px!important;text-align:left}
.sdlc-trace{margin-top:20px;padding-top:16px;border-top:1px solid var(--s-line)}
.sdlc-trace-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-size:12px;font-weight:550}
.sdlc-trace-list{list-style:none;padding:0;margin:0;max-height:174px;overflow:auto}
.sdlc-trace-list li{display:flex;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--s-line);font-size:11px}
.sdlc-tool-name{background:var(--s-raised);padding:1px 6px;border-radius:4px;color:var(--s-accent);font-size:10px;max-width:120px;overflow:hidden;text-overflow:ellipsis}
.sdlc-tool-summary{color:var(--s-muted);flex:1;min-width:0;font-size:12px}
.sdlc-rounds{margin-top:26px;border-top:1px solid var(--s-line);padding-top:20px}
.sdlc-section-head{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:14px}
.sdlc-section-head h3{font-size:13px;font-weight:550}
.sdlc-round-list{display:flex;gap:10px;overflow-x:auto;padding:1px 1px 8px;scrollbar-width:thin}
.sdlc-round{position:relative;flex:1;min-width:190px;background:transparent;border:1px solid transparent;border-radius:8px;display:flex;gap:12px;text-align:left;padding:10px 12px}
.sdlc-round:hover{background:var(--s-surface)}
.sdlc-round[aria-selected=true]{border-color:var(--s-line);background:var(--s-surface)}
.sdlc-round[aria-selected=true]::before{content:"";position:absolute;top:-1px;left:13px;right:13px;height:2px;background:var(--s-accent);border-radius:2px}
.sdlc-round-index{flex-shrink:0;display:grid;place-items:center;border:1px solid currentColor;border-radius:50%;width:36px;height:36px;font-size:14px;margin-top:2px}
.sdlc-tone-error .sdlc-round-index{background:var(--s-coral);border-color:var(--s-coral);color:var(--s-bg)}
.sdlc-tone-success .sdlc-round-index{background:var(--s-accent);border-color:var(--s-accent);color:var(--s-bg)}
.sdlc-round-title{font-size:14px;font-weight:550;display:block}
.sdlc-round-subtitle{display:block;font-size:12px;color:var(--s-muted);margin-top:5px}
.sdlc-deliverables{display:flex;align-items:center;gap:15px;flex-wrap:wrap;border-top:1px solid var(--s-line);padding-top:17px;margin-top:16px}
.sdlc-deliverables-label{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--s-muted)}
.sdlc-artifact{display:inline-flex;align-items:center;gap:6px;border:0;background:none;padding:3px 0;color:var(--s-fg)!important;font-size:11px!important}
.sdlc-artifact:hover{color:var(--s-accent)!important}
.sdlc-record-health{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:10px;color:var(--s-muted)}
.sdlc-bottom-links{display:flex;justify-content:space-between;gap:14px;margin-top:17px;font-size:11px;color:var(--s-muted)}
.sdlc-record-detail{padding-top:16px;margin-top:17px;border-top:1px solid var(--s-line);color:var(--s-muted);font-size:12px}
.sdlc-record-detail summary{cursor:pointer}
.sdlc-record-detail ul{padding-left:20px;margin:8px 0}
.sdlc-empty{padding:50px 24px;text-align:center;max-width:600px;margin:auto}
.sdlc-empty h2{font-size:20px!important;margin-bottom:10px!important}
.sdlc-empty p{font-size:13px;color:var(--s-muted);margin-bottom:12px!important}
.sdlc-list .sdlc-empty{padding:18px 8px}
.sdlc-list .sdlc-empty h2{font-size:14px!important}
.sdlc-blank-workbench{padding:36px 0}
.sdlc-history{padding:0;margin:0;list-style:none}
.sdlc-history-item{position:relative;padding:0 0 22px 22px;border-left:1px solid var(--s-line);margin-left:6px}
.sdlc-history-item:last-child{border-left:0}
.sdlc-history-item::before{content:"";position:absolute;left:-4px;top:8px;width:7px;height:7px;border-radius:50%;background:var(--s-accent)}
.sdlc-history-heading{display:flex;gap:12px;align-items:center;font-size:13px}
.sdlc-history-heading time{margin-left:auto;color:var(--s-muted);font-size:11px}
.sdlc-history details{font-size:12px;color:var(--s-muted);margin-top:6px}
.sdlc-history summary{cursor:pointer}.sdlc-history details:not([open]) summary span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sdlc-back{display:none}
.sdlc-dialog{padding:0;border:1px solid var(--s-line);border-radius:14px;width:min(760px,calc(100vw - 40px));max-height:calc(100dvh - 64px);box-shadow:var(--s-shadow);margin:auto}
.sdlc-dialog::backdrop{background:#071012aa;backdrop-filter:blur(5px)}
.sdlc-dialog-panel{display:flex;flex-direction:column;max-height:calc(100dvh - 66px);min-width:0}
.sdlc-dialog-head{display:flex;align-items:center;gap:12px;padding:19px 24px;border-bottom:1px solid var(--s-line);font-size:13px}
.sdlc-dialog-head>span{color:var(--s-muted);font-size:11px}
.sdlc-dialog-close{margin-left:auto;display:grid;place-items:center;width:30px;height:30px;border:0;border-radius:6px;background:var(--s-raised)}
.sdlc-document{padding:25px 28px;overflow:auto;font-size:13px;min-height:120px}
.sdlc-document pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;color:var(--s-muted);padding:14px;background:var(--s-surface);border:1px solid var(--s-line);border-radius:7px}
.sdlc-document h3{font-size:13px;margin:22px 0 10px}.sdlc-document h3:first-child{margin-top:0}
.sdlc-document p{color:var(--s-muted);font-size:13px;line-height:1.8;overflow-wrap:anywhere}
.sdlc-evidence-row{padding:13px 0;border-bottom:1px solid var(--s-line)}
.sdlc-evidence-row strong{font-size:13px}.sdlc-evidence-row p{margin:6px 0 0}
.sdlc-evidence-row .sdlc-caption{display:block;margin-top:5px}
@container (min-width:1500px){.sdlc-detail{padding:32px 42px}.sdlc-workbench{gap:36px}.sdlc-inspector{padding-left:36px}.sdlc-node-title{font-size:15px}.sdlc-node-caption{font-size:12px}.sdlc-chain-text{font-size:14px}.sdlc-summary{font-size:14px}}
@container (max-width:1080px){.sdlc-shell{grid-template-columns:200px minmax(0,1fr)}.sdlc-detail{padding:24px}.sdlc-workbench{grid-template-columns:1fr}.sdlc-loop{max-width:650px;margin:0 auto}.sdlc-inspector{border-left:0;border-top:1px solid var(--s-line);padding:20px 0 0;display:grid;grid-template-columns:1.2fr 1fr;gap:24px}.sdlc-inspector-main{min-width:0}.sdlc-trace{margin:0;border-top:0;border-left:1px solid var(--s-line);padding:0 0 0 20px}.sdlc-context-line{margin-top:8px}.sdlc-rounds{margin-top:24px}}
@container (max-width:720px){.sdlc-shell{display:block}.sdlc-sidebar{border:0;min-height:100dvh}.sdlc-shell:not(.is-detail)>.sdlc-detail{display:none}.sdlc-shell.is-detail>.sdlc-sidebar{display:none}.sdlc-detail{padding:19px 16px}.sdlc-back{display:inline-flex}.sdlc-detail h2{font-size:22px}.sdlc-inspector{display:block}.sdlc-trace{margin-top:22px;border-left:0;border-top:1px solid var(--s-line);padding:17px 0 0}.sdlc-loop{min-height:310px;aspect-ratio:600/510}.sdlc-node{padding:10px 7px;gap:7px;min-height:66px;width:32%}.sdlc-node-icon{width:25px;height:25px}.sdlc-node-icon svg{width:16px;height:16px}.sdlc-node-title{font-size:11px}.sdlc-node-caption{font-size:9px}.sdlc-round-number{font-size:41px}.sdlc-center-label{font-size:13px}.sdlc-loop-return-label,.sdlc-loop-exit-label{font-size:9px}.sdlc-loop-center .sdlc-caption{font-size:9px}.sdlc-source{gap:9px}.sdlc-record-health{margin-left:0}.sdlc-bottom-links{flex-wrap:wrap}.sdlc-round{min-width:190px}.sdlc-stage-scroll{padding-top:24px}.sdlc-icon-button{min-height:36px;min-width:36px}.sdlc-primary{min-height:44px}}
@container (max-width:720px){.sdlc-stages{min-width:0}.sdlc-stage button{padding:0 3px;font-size:11px}.sdlc-stage-dot{width:28px;height:28px}.sdlc-stage:not(:last-child)::after{left:calc(50% + 17px);right:calc(-50% + 17px);top:14px}}
@media(prefers-reduced-motion:reduce){.sdlc-app *{transition:none!important}}
`;
    function Empty({ title, message, children }) {
      return h('div', { className: 'sdlc-empty' }, [h('h2', { key: 't' }, title), h('p', { key: 'm' }, message), children]);
    }
    function Status({ task }) {
      const tone = task.status === 'DONE' ? 'success' : task.status === 'VERIFYING' ? 'accent' : 'muted';
      return h('span', { className: 'sdlc-status sdlc-tone-' + tone }, stageName(task.status));
    }
    async function readJson(url, signal) {
      const response = await fetch(url, { credentials: 'same-origin', signal });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || 'HTTP ' + response.status);
      return data;
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
      const [theme, setTheme] = React.useState(() => {
        try { return localStorage.getItem('sdlc.theme.v1') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
      });
      React.useEffect(() => {
        let alive = true, timer;
        const controller = new AbortController();
        async function load() {
          try {
            const result = await readJson(ENDPOINT, controller.signal);
            if (!Array.isArray(result.tasks)) throw new Error('任务列表格式不完整');
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
      const reload = () => { setLoading(true); setRefresh(n => n + 1); };
      const toggleTheme = () => {
        const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next);
        try { localStorage.setItem('sdlc.theme.v1', next); } catch { /* Theme still works for this visit. */ }
      };
      return h('main', { className: 'sdlc-app', 'data-theme': theme, 'aria-label': 'SDLC 循环工作台' }, [
        h('style', { key: 'style' }, CSS),
        h('div', { key: 'shell', className: 'sdlc-shell' + (selected && sel && taskKey(sel) === selected ? ' is-detail' : '') }, [
          h('aside', { key: 'sidebar', className: 'sdlc-sidebar', 'aria-label': '任务导航' }, [
            h('header', { key: 'brand', className: 'sdlc-brand' }, [
              h('span', { key: 'mark', className: 'sdlc-brand-mark' }, h(SdlcIcon, { size: 22, active: true })),
              h('div', { key: 'text' }, [h('h1', { key: 'title' }, 'AI 原生 SDLC'), h('p', { key: 'sub' }, '循环工作台')]),
            ]),
            h('select', { key: 'workspace', className: 'sdlc-workspace', 'aria-label': '工作区', value: workspace, onChange: e => { setWorkspace(e.target.value); setSelected(null); } }, [
              h('option', { key: 'all', value: '' }, '所有工作区'),
              ...roots.map(r => h('option', { key: r.root, value: r.root }, r.label)),
            ]),
            h('label', { key: 'search', className: 'sdlc-search' }, [h(Icon, { key: 'icon', name: 'search', size: 15 }), h('input', { key: 'input', type: 'search', placeholder: '搜索任务 / 编号', 'aria-label': '搜索任务', value: query, onChange: e => { setQuery(e.target.value); setSelected(null); } })]),
            h('nav', { key: 'filters', className: 'sdlc-filter-row', 'aria-label': '任务状态筛选' }, [['all', '全部'], ['active', '进行中'], ['done', '已完成']].map(([value, label]) =>
              h('button', { key: value, type: 'button', className: 'sdlc-filter', 'aria-pressed': filter === value, onClick: () => { setFilter(value); setSelected(null); } }, [label, h('span', { key: 'count', className: 'sdlc-count' }, counts[value])]))),
            h('div', { key: 'list', className: 'sdlc-list', 'aria-label': '任务列表' }, visible.length ? visible.map(t =>
              h(TaskLine, { key: taskKey(t), task: t, active: sel && taskKey(t) === taskKey(sel), onClick: () => setSelected(taskKey(t)) })) :
              data && tasks.length ? h(Empty, { title: '没有匹配的任务', message: '调整关键词或工作区。', children: h('button', { className: 'sdlc-link', onClick: reset }, '清除筛选') }) : null),
            h('footer', { key: 'footer', className: 'sdlc-sidebar-bottom' }, [
              h('span', { key: 'count', className: 'sdlc-caption', role: 'status' }, data ? visible.length + ' 个任务 · ' + roots.length + ' 个工作区' : '读取工作区…'),
              h('button', { key: 'theme', className: 'sdlc-icon-button', 'aria-label': theme === 'dark' ? '切换浅色主题' : '切换深色主题', title: theme === 'dark' ? '切换浅色主题' : '切换深色主题', onClick: toggleTheme }, h(Icon, { name: theme === 'dark' ? 'sun' : 'moon', size: 16 })),
            ]),
          ]),
          !data ? h('section', { key: 'loading', className: 'sdlc-detail' }, h(Empty, { title: error ? '暂时无法读取看板' : '正在读取任务', message: error || '正在整理任务与交付物。', children: error ? h('button', { className: 'sdlc-link', onClick: reload }, '重新读取') : null })) :
            !tasks.length ? h('section', { key: 'empty', className: 'sdlc-detail' }, h(Empty, { title: '还没有任务', message: '在 AI 原生 SDLC 会话中创建任务后，这里会展示整个执行过程。', children: h('details', {}, [h('summary', { key: 's' }, '已检查的工作区'), ...(data.searched || []).map(p => h('p', { key: p }, p))]) })) :
              sel ? h(Detail, { key: taskKey(sel), task: sel, theme, refresh, loading, listError: error, onRefresh: reload, onBack: () => setSelected(null), onOpen: file => setOpened({ task: sel.id, root: sel.repoRoot, file }) }) :
                h('section', { key: 'none', className: 'sdlc-detail' }, h(Empty, { title: '没有匹配的任务', message: '调整左侧筛选后，任务详情会显示在这里。' })),
        ]),
        opened ? h(ArtifactViewer, { key: JSON.stringify(opened), ...opened, theme, onClose: () => setOpened(null) }) : null,
      ]);
    }
    function TaskLine({ task: t, active, onClick }) {
      return h('button', { type: 'button', className: 'sdlc-task', 'aria-pressed': !!active, onClick }, [
        h('span', { key: 'icon', className: 'sdlc-task-icon' }, h(Icon, { name: t.status === 'DONE' ? 'circle-check' : 'refresh', size: 18 })),
        h('span', { key: 'body', className: 'sdlc-task-content' }, [
          h('span', { key: 'meta', className: 'sdlc-task-meta' }, [h('span', { key: 'id' }, t.id), h('span', { key: 'status' }, stageName(t.status))]),
          h('span', { key: 'title', className: 'sdlc-task-title' }, t.title || t.id),
          h('span', { key: 'repo', className: 'sdlc-task-workspace', title: t.repoRoot || '' }, t.repoLabel || '工作区未记录'),
        ]),
      ]);
    }
    function StageRibbon({ task, onSelect }) {
      const visited = new Set((task.timeline || []).flatMap(e => [e.from, e.to]));
      return h('div', { className: 'sdlc-stage-scroll' }, h('ol', { className: 'sdlc-stages', 'aria-label': '任务阶段与交付物' }, STAGES.map((stage, i) => {
        const past = stage !== task.status && visited.has(stage);
        return h('li', { key: stage, className: 'sdlc-stage' + (past ? ' visited' : ''), 'aria-current': stage === task.status ? 'step' : undefined },
          h('button', { type: 'button', onClick: () => onSelect(stage), 'aria-label': '查看' + stageName(stage) + '阶段' }, [
            h('span', { key: 'dot', className: 'sdlc-stage-dot' }, past ? h(Icon, { name: 'check', size: 16 }) : i + 1),
            h('span', { key: 'label' }, stageName(stage)),
          ]));
      })));
    }
    function Detail({ task: t, onOpen, onBack, theme, refresh, loading, listError, onRefresh }) {
      const [executionState, setExecutionState] = React.useState({ data: null, error: null, loading: true });
      const [panel, setPanel] = React.useState(null);
      React.useEffect(() => {
        let alive = true, timer;
        const controller = new AbortController();
        async function load() {
          try {
            const result = await readJson('./api/sdlc-ui.execution?task=' + encodeURIComponent(t.id) + '&root=' + encodeURIComponent(t.repoRoot), controller.signal);
            if (result.taskId !== t.id || result.repoRoot !== t.repoRoot || !Array.isArray(result.rounds) || !Array.isArray(result.repairs)) throw new Error('执行记录的任务归属或格式不正确');
            if (alive) setExecutionState({ data: result, error: null, loading: false });
          } catch (e) {
            if (alive) setExecutionState(prev => ({ ...prev, loading: false, error: String(e.message || e).slice(0, 160) }));
          } finally {
            if (alive) timer = setTimeout(load, POLL_MS);
          }
        }
        load();
        return () => { alive = false; controller.abort(); clearTimeout(timer); };
      }, [t.id, t.repoRoot, refresh]);
      return h('section', { className: 'sdlc-detail', 'aria-label': '任务详情' }, [
        h('div', { key: 'top', className: 'sdlc-detail-top' }, [
          h('div', { key: 'breadcrumb', className: 'sdlc-breadcrumb' }, [
            h('button', { key: 'back', className: 'sdlc-icon-button sdlc-back', 'aria-label': '返回任务列表', onClick: onBack }, h(Icon, { name: 'back', size: 16 })),
            h('span', { key: 'tasks' }, '任务'), h('span', { key: 'sep', 'aria-hidden': true }, '/'), h('span', { key: 'id' }, t.id),
          ]),
          h('button', { key: 'refresh', className: 'sdlc-icon-button', 'aria-label': '刷新看板', title: '刷新看板', disabled: loading, onClick: onRefresh }, [h(Icon, { key: 'i', name: 'refresh', size: 14 }), h('span', { key: 't', className: 'sdlc-caption' }, loading ? '读取中' : '刷新')]),
        ]),
        h('h2', { key: 'title' }, t.title || t.id),
        h('div', { key: 'source', className: 'sdlc-source' }, [
          h('span', { key: 'repo', title: t.repoRoot }, [h(Icon, { key: 'i', name: 'folder', size: 14 }), t.repoLabel]),
          h(Status, { key: 'status', task: t }),
          h('span', { key: 'at' }, shortTime(t.updated) + ' 更新'),
        ]),
        h(StageRibbon, { key: 'stages', task: t, onSelect: stage => setPanel({ kind: 'stage', stage }) }),
        listError ? h('div', { key: 'error', className: 'sdlc-notice', role: 'alert' }, '任务列表刷新失败，当前保留上次结果：' + listError) : null,
        h(LoopWorkbench, { key: 'workbench', task: t, execution: executionState.data, loading: executionState.loading, error: executionState.error, theme }),
        h('div', { key: 'artifacts', className: 'sdlc-deliverables' }, [
          h('span', { key: 'title', className: 'sdlc-deliverables-label' }, [h(Icon, { key: 'i', name: 'doc', size: 15 }), '交付物']),
          ...(t.artifacts || []).map(a => h('button', { key: a.kind + a.file, className: 'sdlc-artifact', onClick: () => onOpen(a.file), title: '查看 ' + a.file }, [ARTIFACT_CN[a.kind] || a.kind, h(Icon, { key: 'arrow', name: 'chevron-right', size: 12 })])),
          !(t.artifacts || []).length ? h('span', { key: 'none', className: 'sdlc-caption' }, '尚未登记') : null,
          h('button', { key: 'health', className: 'sdlc-link sdlc-record-health', onClick: () => setPanel({ kind: 'rsi' }) }, [
            h(Icon, { key: 'icon', name: t.rsi && t.rsi.evidence_complete ? 'circle-check' : 'circle-dashed', size: 15 }),
            t.rsi ? t.rsi.evidence_complete ? '执行记录完整' : '执行记录不完整' : '执行记录未确认',
          ]),
        ]),
        h('div', { key: 'links', className: 'sdlc-bottom-links' }, [
          h('button', { key: 'history', className: 'sdlc-link', onClick: () => setPanel({ kind: 'history' }) }, [h(Icon, { key: 'i', name: 'history', size: 14 }), '查看全部记录']),
          h('button', { key: 'rsi', className: 'sdlc-link', onClick: () => setPanel({ kind: 'rsi' }) }, ['完成后复盘', h(Icon, { key: 'i', name: 'arrow', size: 13 }), '改进任务']),
        ]),
        h('details', { key: 'record-details', className: 'sdlc-record-detail' }, [
          h('summary', { key: 's' }, !t.rsi ? '尚未确认执行记录是否完整' : t.rsi.evidence_complete ? '已登记的执行证据完整' : '执行证据不完整'),
          h('p', { key: 'p' }, '任务完成、验证通过和执行记录完整分别判断。'),
          t.rsi && t.rsi.issues && t.rsi.issues.length ? h('ul', { key: 'issues' }, t.rsi.issues.map((x, i) => h('li', { key: i }, x))) : null,
        ]),
        panel ? h(TaskPanel, { key: panel.kind + (panel.stage || ''), panel, task: t, theme, onClose: () => setPanel(null), onOpen: file => { setPanel(null); onOpen(file); } }) : null,
      ]);
    }
    function LoopWorkbench({ task, execution, loading, error, theme }) {
      const [selectedId, setSelectedId] = React.useState(null);
      const [heldRound, setHeldRound] = React.useState(null);
      const [findingId, setFindingId] = React.useState(null);
      const [node, setNode] = React.useState(null);
      const [evidence, setEvidence] = React.useState(false);
      const rounds = execution && Array.isArray(execution.rounds) ? execution.rounds : [];
      const latest = rounds[rounds.length - 1];
      const found = rounds.find(r => r.id === selectedId);
      const round = found || (selectedId ? heldRound : null) || latest;
      const retained = !!selectedId && !found && !!heldRound;
      const historical = !!round && !!latest && round.id !== latest.id;
      const repairs = execution ? execution.repairs || [] : [];
      const backtracks = repairs.filter(r => r.kind === 'backtrack').length;
      const fixes = repairs.filter(r => r.kind === 'fix_start').length;
      const findings = round ? round.findings || [] : [];
      const finding = findings.find(f => f.id === findingId) || findings[0];
      const outcome = outcomeOf(round);
      const defaultNode = round && round.outcome === 'reject' ? 'findings' : !round && task.status === 'IMPLEMENTING' ? 'repair' : 'verify';
      const selectedNode = node || defaultNode;
      const choose = r => { setSelectedId(r.id === latest.id ? null : r.id); setHeldRound(r); setFindingId(null); setNode(null); };
      const counts = round ? (round.criteria || []).reduce((a, c) => { a[c.status] = (a[c.status] || 0) + 1; return a; }, {}) : {};
      return h('div', { className: 'sdlc-execution' }, [
        error ? h('div', { key: 'error', className: 'sdlc-notice', role: 'alert' }, '执行记录读取失败' + (execution ? '，保留上次结果' : '') + '：' + error) : null,
        retained ? h('div', { key: 'retained', className: 'sdlc-notice', role: 'status' }, '这轮记录已不在本次返回范围内，当前保留你打开时的内容。') : null,
        execution && execution.issues && execution.issues.length ? h('details', { key: 'issues', className: 'sdlc-notice' }, [
          h('summary', { key: 's' }, '部分执行记录未确认 · ' + execution.issues.length + ' 项说明'),
          h('ul', { key: 'list' }, execution.issues.map((x, i) => h('li', { key: i }, x))),
        ]) : null,
        h('div', { key: 'main', className: 'sdlc-workbench' }, [
          h('section', { key: 'canvas', className: 'sdlc-canvas', 'aria-label': '验证与修复循环' }, [
            h('div', { key: 'heading', className: 'sdlc-canvas-heading' }, [
              h('span', { key: 'title', className: 'sdlc-eyebrow' }, '验证与修复'),
              historical ? h('span', { key: 'historical', className: 'sdlc-history-badge' }, ['历史' + roundName(round), h('button', { key: 'back', className: 'sdlc-link', onClick: () => { setSelectedId(null); setNode(null); } }, '返回最新轮次')]) :
                h('span', { key: 'state', className: 'sdlc-caption' }, loading ? '读取执行记录…' : round && round.source === 'current_verdict' ? '历史未记录' : '已记录的执行过程'),
            ]),
            h('div', { key: 'loop', className: 'sdlc-loop', role: 'group', 'aria-label': '发现问题、修复实现、执行检查、独立验证；未通过返回修复，通过后进入评审' }, [
              h('svg', { key: 'lines', className: 'sdlc-loop-lines', viewBox: '0 0 600 470', preserveAspectRatio: 'none', 'aria-hidden': true }, [
                h('defs', { key: 'defs' }, ['muted', 'coral', 'accent'].map((color, i) => h('marker', { key: color, id: 'sdlc-loop-arrow-' + color, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' },
                  h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: ['var(--s-dim)', 'var(--s-coral)', 'var(--s-accent)'][i] })))),
                h('path', { key: 'repair', className: 'sdlc-orbit', d: 'M 377 93 C 430 116 465 150 480 193', markerEnd: 'url(#sdlc-loop-arrow-muted)' }),
                h('path', { key: 'checks', className: 'sdlc-orbit', d: 'M 487 284 C 469 339 442 377 401 397', markerEnd: 'url(#sdlc-loop-arrow-muted)' }),
                h('path', { key: 'verify', className: 'sdlc-orbit', d: 'M 222 395 C 168 377 132 338 114 284', markerEnd: 'url(#sdlc-loop-arrow-muted)' }),
                h('path', { key: 'return', className: 'sdlc-orbit sdlc-return', d: 'M 113 193 C 132 147 155 115 198 91', markerEnd: 'url(#sdlc-loop-arrow-coral)' }),
                h('path', { key: 'exit', className: 'sdlc-orbit sdlc-exit', d: 'M 182 279 C 208 333 366 329 570 329', markerEnd: 'url(#sdlc-loop-arrow-accent)' }),
              ]),
              ...[
                ['findings', 'bug', '发现问题', findings.length ? findings.length + ' 项已记录发现' : '查看验收发现'],
                ['repair', 'code', '修复实现', fixes ? '累计 ' + fixes + ' 次修复开始' : '尚无修复记录'],
                ['checks', 'terminal-2', '执行检查', round && round.testEvidence ? '已提供测试证据' : '测试证据未记录'],
                ['verify', 'search', '独立验证', outcome.label],
              ].map(([id, icon, title, caption]) => h('button', { key: id, type: 'button', className: 'sdlc-node ' + id + (selectedNode === id ? ' is-selected' : ''), 'aria-pressed': selectedNode === id, 'aria-label': '查看' + title, onClick: () => setNode(id) }, [
                h('span', { key: 'icon', className: 'sdlc-node-icon' }, h(Icon, { name: icon, size: 22 })),
                h('span', { key: 'body' }, [h('span', { key: 'title', className: 'sdlc-node-title' }, title), h('span', { key: 'caption', className: 'sdlc-node-caption' }, caption)]),
              ])),
              h('div', { key: 'center', className: 'sdlc-loop-center' }, [
                h('span', { key: 'over', className: 'sdlc-eyebrow' }, round && round.source === 'rsi' ? '验证轮次' : '验证结果'),
                h('p', { key: 'number', className: 'sdlc-round-number', style: round && round.source === 'current_verdict' ? { fontSize: '24px', letterSpacing: 0 } : undefined }, round ? round.source === 'current_verdict' ? '当前裁决' : String(round.number).padStart(2, '0') : '—'),
                h('p', { key: 'label', className: 'sdlc-center-label sdlc-tone-' + outcome.tone }, outcome.label),
                h('p', { key: 'repair', className: 'sdlc-caption' }, backtracks ? '任务累计 ' + backtracks + ' 次阶段回退记录' : fixes ? '任务累计 ' + fixes + ' 次修复开始记录' : '尚无修复记录'),
              ]),
              h('span', { key: 'return-label', className: 'sdlc-loop-return-label' }, '未通过 → 返回修复'),
              h('span', { key: 'exit-label', className: 'sdlc-loop-exit-label' }, '通过后 → 评审'),
            ]),
            h('div', { key: 'context', className: 'sdlc-context-line' }, [
              h('span', { key: 'attempts' }, round ? round.attemptCount ? round.attemptCount + ' 次尝试 · ' + (historical ? '历史记录' : '最新记录') : '尝试次数未记录' : '运行独立验证后，轮次会出现在这里'),
              h('span', { key: 'time' }, round ? shortTime(round.finishedAt || round.startedAt) : stageName(task.status) + '阶段'),
            ]),
          ]),
          h('aside', { key: 'inspector', className: 'sdlc-inspector', 'aria-label': '所选轮次详情' }, [
            h('div', { key: 'main', className: 'sdlc-inspector-main' }, [
              h('h3', { key: 'heading' }, selectedNode === 'repair' ? '任务修复记录' : selectedNode === 'checks' ? '本轮测试证据' : '这一轮为什么发生'),
              round ? [
                h('div', { key: 'verdict', className: 'sdlc-verdict-line sdlc-tone-' + outcome.tone }, [h(Icon, { key: 'icon', name: outcome.icon, size: 17 }), outcome.label]),
                h('p', { key: 'summary', className: 'sdlc-summary sdlc-clamp' }, round.summary),
                round.unverified && round.unverified.length ? h('p', { key: 'unverified', className: 'sdlc-caption sdlc-tone-warning' }, round.unverified.length + ' 项未复核，详见本轮证据') : null,
                selectedNode === 'repair' ? h(RepairList, { key: 'repairs', repairs }) :
                  selectedNode === 'checks' ? h('div', { key: 'test' }, [
                    h('p', { key: 'p', className: 'sdlc-summary' }, round.testEvidence || '本轮未保存测试证据。'),
                    h('p', { key: 'note', className: 'sdlc-caption' }, '测试输出来自验证输入，独立裁决单独确认。'),
                  ]) : [
                    findings.length ? h('div', { key: 'findings', className: 'sdlc-finding-list', 'aria-label': '本轮发现' }, findings.map((f, i) =>
                      h('button', { key: f.id, className: 'sdlc-finding', 'aria-pressed': finding && finding.id === f.id, onClick: () => setFindingId(f.id) }, [
                        h('span', { key: 'id', className: 'sdlc-finding-id' }, 'F-' + String(i + 1).padStart(2, '0')),
                        h('span', { key: 'text', className: 'sdlc-finding-description' }, f.description || '未记录问题说明'),
                      ]))) : h('p', { key: 'no-findings', className: 'sdlc-caption' }, round.outcome === 'approve' ? '本轮验证通过。' : '本轮没有可展示的问题记录。'),
                    h('ol', { key: 'chain', className: 'sdlc-evidence-chain' }, [
                      h('li', { key: 'finding' }, [h('span', { key: 'label', className: 'sdlc-chain-label' }, '发现依据'), h('span', { key: 'text', className: 'sdlc-chain-text sdlc-clamp' }, finding ? finding.evidence || '此项未记录具体证据' : round.summary)]),
                      h('li', { key: 'change' }, [h('span', { key: 'label', className: 'sdlc-chain-label' }, '本轮提交的改动说明'), h('span', { key: 'text', className: 'sdlc-chain-text sdlc-clamp' }, round.changesSummary || '未记录；问题与修复的对应关系尚未确认')]),
                      h('li', { key: 'result' }, [h('span', { key: 'label', className: 'sdlc-chain-label' }, '独立裁决'), h('span', { key: 'text', className: 'sdlc-chain-text' }, (counts.met || 0) + ' 条通过 · ' + (counts.not_met || 0) + ' 条未通过 · ' + (counts.cannot_tell || 0) + ' 条待确认')]),
                    ]),
                  ],
                h('button', { key: 'evidence', className: 'sdlc-primary', onClick: () => setEvidence(true) }, [h(Icon, { key: 'doc', name: 'doc', size: 16 }), '查看本轮证据', h(Icon, { key: 'arrow', name: 'arrow', size: 15 })]),
              ] : [
                h('p', { key: 'none', className: 'sdlc-summary' }, loading ? '正在读取这个任务的执行记录。' : '还没有可核对的验证轮次。创建任务并执行独立验证后，这里会逐轮保留结果。'),
                repairs.length ? h(RepairList, { key: 'repairs', repairs }) : null,
              ],
            ]),
            h('section', { key: 'trace', className: 'sdlc-trace', 'aria-label': 'Agent 执行轨迹' }, [
              h('div', { key: 'heading', className: 'sdlc-trace-header' }, [h('span', { key: 'title' }, 'Agent 执行轨迹'), h('span', { key: 'scope', className: 'sdlc-caption' }, '本轮验证者')]),
              round && round.toolEvents && round.toolEvents.length ? h('ul', { key: 'events', className: 'sdlc-trace-list' }, round.toolEvents.map(event => h('li', { key: event.id, title: shortTime(event.at) }, [
                h('code', { key: 'name', className: 'sdlc-tool-name' }, event.name),
                h('span', { key: 'summary', className: 'sdlc-tool-summary' }, event.summary),
                h(Icon, { key: 'status', name: event.status === 'completed' ? 'check' : event.status === 'error' ? 'warn' : 'circle-dashed', size: 12 }),
              ]))) : h('p', { key: 'empty', className: 'sdlc-caption' }, '尚无可核对的工具调用记录。'),
              h('p', { key: 'loop-hint', className: 'sdlc-caption', style: { marginTop: '12px' } }, '工具结果 → 下一步行动'),
            ]),
          ]),
        ]),
        h('section', { key: 'rounds', className: 'sdlc-rounds', 'aria-label': '验证轮次' }, [
          h('div', { key: 'heading', className: 'sdlc-section-head' }, [h('h3', { key: 'title' }, '验证轮次'), h('span', { key: 'hint', className: 'sdlc-caption' }, '选择一轮，查看当时的问题与证据')]),
          rounds.length ? h('div', { key: 'tabs', className: 'sdlc-round-list', role: 'tablist', 'aria-label': '选择验证轮次' }, rounds.map(r => {
            const status = outcomeOf(r), failed = (r.criteria || []).filter(c => c.status === 'not_met').length;
            return h('button', { key: r.id, type: 'button', role: 'tab', 'data-run-id': r.id, 'aria-selected': round.id === r.id, tabIndex: round.id === r.id ? 0 : -1, className: 'sdlc-round sdlc-tone-' + status.tone, onClick: () => choose(r), onKeyDown: e => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
              e.preventDefault();
              const index = rounds.indexOf(r), next = e.key === 'Home' ? 0 : e.key === 'End' ? rounds.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + rounds.length) % rounds.length;
              choose(rounds[next]);
              e.currentTarget.parentElement.querySelectorAll('[role=tab]')[next].focus();
            } }, [
              h('span', { key: 'index', className: 'sdlc-round-index' }, r.source === 'current_verdict' ? h(Icon, { name: 'doc', size: 15 }) : r.number),
              h('span', { key: 'body' }, [
                h('span', { key: 'title', className: 'sdlc-round-title' }, roundName(r) + ' · ' + status.label),
                h('span', { key: 'caption', className: 'sdlc-round-subtitle' }, r.source === 'current_verdict' ? '历史未记录' : failed ? failed + ' 条验收标准未通过' : shortTime(r.finishedAt || r.startedAt)),
              ]),
            ]);
          })) : h('p', { key: 'empty', className: 'sdlc-caption' }, loading ? '正在读取…' : '暂无验证历史，保留当前任务阶段。'),
        ]),
        evidence && round ? h(RoundEvidence, { key: round.id, round, theme, onClose: () => setEvidence(false) }) : null,
      ]);
    }
    function RepairList({ repairs }) {
      if (!repairs.length) return h('p', { className: 'sdlc-summary' }, '尚无修复记录。验证未通过并不表示已经开始修复。');
      return h('div', {}, [
        h('p', { key: 'note', className: 'sdlc-caption' }, '以下是任务实际记录的操作，尚未与具体发现建立关联。'),
        ...repairs.slice(-8).reverse().map(r => h('div', { key: r.id, className: 'sdlc-evidence-row' }, [
          h('strong', { key: 'kind' }, r.kind === 'fix_start' ? '开始修复' : r.kind === 'fix_end' ? '结束修复' : '阶段回退'),
          h('p', { key: 'text', className: 'sdlc-summary' }, r.summary),
          h('span', { key: 'time', className: 'sdlc-caption' }, shortTime(r.at)),
        ])),
      ]);
    }
    function useDialog(id) {
      React.useEffect(() => {
        const dialog = document.getElementById(id), trigger = document.activeElement;
        if (dialog && !dialog.open) dialog.showModal();
        return () => { if (dialog) dialog.close(); if (trigger && trigger.isConnected && trigger.focus) trigger.focus(); };
      }, [id]);
    }
    function DialogFrame({ id, title, subtitle, theme, onClose, children }) {
      useDialog(id);
      return h('dialog', { id, className: 'sdlc-dialog', 'data-theme': theme || 'dark', 'aria-label': title, onCancel: e => { e.preventDefault(); onClose(); }, onClick: e => { if (e.target === e.currentTarget) onClose(); } },
        h('div', { className: 'sdlc-dialog-panel' }, [
          h('header', { key: 'head', className: 'sdlc-dialog-head' }, [h(Icon, { key: 'icon', name: 'doc', size: 18 }), h('strong', { key: 'title' }, title), subtitle ? h('span', { key: 'sub' }, subtitle) : null,
            h('button', { key: 'close', className: 'sdlc-dialog-close', 'aria-label': '关闭' + title, onClick: onClose }, h(Icon, { name: 'close', size: 16 }))]),
          h('div', { key: 'body', className: 'sdlc-document' }, children),
        ]));
    }
    function RoundEvidence({ round, theme, onClose }) {
      const result = outcomeOf(round);
      return h(DialogFrame, { id: 'sdlc-round-evidence', title: roundName(round) + '证据', subtitle: result.label, theme, onClose }, [
        h('h3', { key: 'summary-title' }, '独立裁决'),
        h('p', { key: 'summary' }, round.summary),
        h('p', { key: 'id', className: 'sdlc-caption' }, '运行 ' + round.id + ' · ' + shortTime(round.finishedAt || round.startedAt)),
        round.unverified && round.unverified.length ? h('section', { key: 'unverified' }, [h('h3', { key: 'title' }, '验证者未复核的事项'), h('ul', { key: 'items' }, round.unverified.map((item, i) => h('li', { key: i }, item)))]) : null,
        h('h3', { key: 'criteria-title' }, '验收标准'),
        ...(round.criteria || []).map((c, i) => h('div', { key: 'criterion' + i, className: 'sdlc-evidence-row' }, [
          h('strong', { key: 'title' }, (i + 1) + '. ' + c.criterion),
          h('span', { key: 'status', className: 'sdlc-caption' }, ({ met: '通过', not_met: '未通过', cannot_tell: '待确认' })[c.status] || '未记录'),
          h('p', { key: 'evidence' }, c.evidence || '未记录证据'),
        ])),
        h('h3', { key: 'findings-title' }, '发现'),
        ...(round.findings || []).map(f => h('div', { key: f.id, className: 'sdlc-evidence-row' }, [h('strong', { key: 'title' }, f.description), h('p', { key: 'evidence' }, f.evidence || '未记录证据')])),
        !(round.findings || []).length ? h('p', { key: 'no-findings' }, '没有单独记录的发现。') : null,
        h('h3', { key: 'changes-title' }, '提交的改动说明'),
        h('p', { key: 'changes' }, round.changesSummary || '未记录'),
        h('h3', { key: 'tests-title' }, '提交的测试证据'),
        h('pre', { key: 'tests' }, round.testEvidence || '未记录'),
      ]);
    }
    function Timeline({ task }) {
      const items = (task.timeline || []).slice().reverse();
      if (!items.length) return h('p', { className: 'sdlc-caption' }, '还没有迁移记录。');
      return h('ol', { className: 'sdlc-history' }, items.map((entry, i) => h('li', { key: i, className: 'sdlc-history-item' }, [
        h('div', { key: 'heading', className: 'sdlc-history-heading' }, [h('strong', { key: 'stage' }, (entry.from ? stageName(entry.from) + ' → ' : '') + stageName(entry.to)), h('time', { key: 'at', dateTime: entry.at }, shortTime(entry.at))]),
        entry.reason ? h('details', { key: 'reason' }, h('summary', {}, h('span', {}, entry.reason))) : null,
      ])));
    }
    function TaskPanel({ panel, task, theme, onClose, onOpen }) {
      const artifact = panel.kind === 'stage' ? (task.artifacts || []).find(a => a.kind === STAGE_ARTIFACT[panel.stage]) : null;
      const history = panel.kind === 'stage' ? (task.timeline || []).filter(e => e.to === panel.stage || e.from === panel.stage) : task.timeline;
      const title = panel.kind === 'history' ? '完整迁移记录' : panel.kind === 'rsi' ? '复盘与改进' : stageName(panel.stage) + '阶段';
      const rsi = task.rsi;
      return h(DialogFrame, { id: 'sdlc-task-panel', title, subtitle: task.id, theme, onClose }, panel.kind === 'rsi' ? [
        h('h3', { key: 'health' }, '执行记录'),
        h('p', { key: 'status' }, !rsi ? '尚未确认执行记录是否完整' : rsi.evidence_complete ? '已登记的执行证据完整' : '执行证据不完整'),
        rsi ? h('p', { key: 'counts' }, rsi.session_count + ' 个会话 · ' + rsi.run_count + ' 次验证 · ' + (rsi.review_status === 'proposed' ? '已提出改进' : rsi.review_status === 'collecting' ? '记录中' : '待复盘')) : null,
        rsi && rsi.issues ? h('ul', { key: 'issues' }, rsi.issues.map((x, i) => h('li', { key: i }, x))) : null,
        h('h3', { key: 'next' }, '下一步'),
        h('p', { key: 'hint' }, task.status === 'DONE' ? '在原 SDLC 会话中继续复盘。确认问题和证据后，改进会作为新任务跟进。' : '先完成当前任务；完成后可在原会话中复盘，并建立有证据支持的改进任务。'),
        h('p', { key: 'boundary' }, '完成任务不会自动触发后台改进。'),
      ] : [
        artifact ? h('button', { key: 'artifact', className: 'sdlc-link', onClick: () => onOpen(artifact.file) }, [h(Icon, { key: 'i', name: 'doc', size: 16 }), '查看 ' + artifact.file]) : panel.kind === 'stage' ? h('p', { key: 'no-artifact' }, '此阶段暂无已登记的交付物。') : null,
        panel.kind === 'stage' ? h('h3', { key: 'history-title' }, '进入与离开这个阶段的记录') : null,
        h(Timeline, { key: 'history', task: { ...task, timeline: history } }),
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
            style: Object.assign({}, F.mono, { fontSize: '13px', padding: '0 3px', borderRadius: '3px', background: 'var(--s-surface)' }),
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
                borderRadius: '6px', background: 'var(--s-surface)',
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
      return h('dialog', { id: 'sdlc-artifact-dialog', className: 'sdlc-dialog', 'data-theme': props.theme || 'dark', 'aria-label': '交付物 ' + props.file, onCancel: e => { e.preventDefault(); props.onClose(); }, onClick: e => { if (e.target === e.currentTarget) props.onClose(); } },
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
