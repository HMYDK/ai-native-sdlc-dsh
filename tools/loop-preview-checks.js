/* Browser checks for the local fixture preview only; never loaded by the plugin. */
(async () => {
  const mode = new URLSearchParams(location.search).get('state');
  if (!mode) return;
  const pause = () => new Promise(resolve => setTimeout(resolve, 30));
  const until = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await pause(); } throw new Error('等待页面状态超时'); };
  const all = selector => [...document.querySelectorAll(selector)];
  const one = selector => document.querySelector(selector);
  const click = async element => { if (!element) throw new Error('找不到操作按钮'); element.focus(); element.click(); await pause(); };
  const textButton = text => all('button').find(b => b.textContent.trim() === text);
  const reports = [];
  const assert = (condition, label) => { reports.push((condition ? 'PASS ' : 'FAIL ') + label); if (!condition) throw new Error(label); };
  try {
    await until(() => all('.sdlc-round').length === 3);
    if (innerWidth <= 720) await click(one('.sdlc-task'));
    if (mode === 'light') await click(one('[aria-label="切换浅色主题"]'));
    if (mode === 'history') await click(one('[data-run-id="loop-round-2"]'));
    if (mode === 'evidence') { await click(one('[data-run-id="loop-round-1"]')); await click(textButton('查看本轮证据')); }
    if (mode === 'checks') {
      assert(all('.sdlc-round').length === 3 && one('[data-run-id="loop-round-3"]').getAttribute('aria-selected') === 'true', '三轮保留，默认选中最新轮次');
      assert(one('.sdlc-loop-center').textContent.includes('2 次阶段回退记录'), '回退次数来自明确记录');
      await click(one('[data-run-id="loop-round-1"]'));
      assert(one('.sdlc-inspector').textContent.includes('发现 3 项问题') && one('.sdlc-history-badge').textContent.includes('历史第 1 轮'), '历史选择同步切换问题与历史标识');
      await click(all('.sdlc-finding')[1]);
      assert(one('.sdlc-evidence-chain').textContent.includes('第 1 轮边界测试'), '问题选择同步切换发现依据');
      const evidenceButton = textButton('查看本轮证据');
      await click(evidenceButton);
      await until(() => one('#sdlc-round-evidence')?.open);
      assert(one('#sdlc-round-evidence').textContent.includes('第 1 轮测试输出') && !one('#sdlc-round-evidence').textContent.includes('第 3 轮测试输出'), '证据弹窗来自所选历史轮次');
      await click(one('#sdlc-round-evidence .sdlc-dialog-close'));
      assert(!one('#sdlc-round-evidence') && document.activeElement === evidenceButton, '关闭弹窗后焦点回到打开按钮');
      const tab = one('[data-run-id="loop-round-1"]'); tab.focus(); tab.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true})); await pause();
      assert(one('[data-run-id="loop-round-2"]').getAttribute('aria-selected') === 'true' && document.activeElement === one('[data-run-id="loop-round-2"]'), '方向键切换轮次并移动焦点');
      await click(textButton('返回最新轮次'));
      assert(one('.sdlc-round-number').textContent === '03', '返回最新轮次');
      await click(one('[aria-label="查看修复实现"]'));
      assert(one('.sdlc-inspector').textContent.includes('开始修复') && one('.sdlc-inspector').textContent.includes('阶段回退'), '修复入口展示实际修复和回退记录');
      await click(one('[aria-label="查看规格阶段"]'));
      assert(one('#sdlc-task-panel')?.open && one('#sdlc-task-panel').textContent.includes('spec.md'), '阶段入口打开对应记录与交付物');
      await click(one('#sdlc-task-panel .sdlc-dialog-close'));
      await click(all('.sdlc-artifact').find(e => e.textContent.includes('规格')));
      await until(() => one('#sdlc-artifact-dialog')?.textContent.includes('满减门槛'));
      assert(one('#sdlc-artifact-dialog').textContent.includes('验收标准'), '交付物读取并渲染正文');
      await click(one('#sdlc-artifact-dialog .sdlc-dialog-close'));
      await click(textButton('查看全部记录'));
      assert(all('.sdlc-history-item').length === 9, '完整迁移记录含两次回退');
      await click(one('#sdlc-task-panel .sdlc-dialog-close'));
      const theme = one('.sdlc-app').dataset.theme;
      await click(one('.sdlc-sidebar-bottom button'));
      assert(one('.sdlc-app').dataset.theme !== theme, '主题切换生效');
      await click(one('.sdlc-sidebar-bottom button'));
      const ex = window.__LOOP_FIXTURE__.executions['LOOP-DEMO'];
      await click(one('[data-run-id="loop-round-1"]'));
      ex.rounds.push({...ex.rounds[2], id: 'preview-round-4', number: 4});
      await click(one('[aria-label="刷新看板"]'));
      await until(() => all('.sdlc-round').length === 4);
      assert(one('.sdlc-history-badge').textContent.includes('历史第 1 轮'), '刷新新增轮次时保留正在浏览的历史');
      ex.rounds.pop();
      const originalFetch = window.fetch;
      window.fetch = async url => { if (String(url).includes('.execution')) return new Response('{"error":"测试断线"}', {status: 503}); return originalFetch(url); };
      await click(one('[aria-label="刷新看板"]'));
      await until(() => one('.sdlc-execution [role=alert]'));
      assert(one('.sdlc-execution [role=alert]').textContent.includes('保留上次结果') && one('.sdlc-round-number').textContent === '01', '断线保留已读记录并显示错误');
      window.fetch = originalFetch;
      assert(one('.sdlc-app').scrollWidth <= one('.sdlc-app').clientWidth + 1, '视口没有横向溢出');
      assert(all('.sdlc-node').every(node => node.getBoundingClientRect().top >= one('.sdlc-stage-scroll').getBoundingClientRect().bottom), '循环节点不与阶段条重叠');
      assert(window.__LOOP_ERRORS__.length === 0, '浏览器未捕获脚本异常');
    }
  } catch (error) { reports.push('FAIL ' + error.message); }
  if (mode === 'checks') {
    const result = document.createElement('pre'); result.id = 'sdlc-qa-results';
    result.style.cssText = 'position:fixed;inset:0;margin:0;padding:40px;background:#141b19;color:#b2ddc9;font:18px/2 monospace;z-index:10000;overflow:auto;white-space:pre-wrap';
    result.textContent = 'SDLC 本地组件 · 浏览器交互检查\n\n' + reports.join('\n') + '\n\n' + (reports.some(r => r.startsWith('FAIL')) ? 'RESULT: FAILED' : 'RESULT: PASSED');
    document.body.append(result);
    localStorage.setItem('sdlc.preview.checks', JSON.stringify(reports));
  }
  if (mode !== 'checks' && one('.sdlc-app')) one('.sdlc-app').scrollTop = 0;
  document.documentElement.dataset.previewReady = 'true';
})();
