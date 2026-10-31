/* Browser checks for the local fixture preview only; never loaded by the plugin. */
(async () => {
  const mode = new URLSearchParams(location.search).get('state');
  if (!mode) return;
  const pause = () => new Promise(resolve => setTimeout(resolve, 30));
  const until = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await pause(); } throw new Error('等待页面状态超时'); };
  const all = selector => [...document.querySelectorAll(selector)];
  const one = selector => document.querySelector(selector);
  const click = async element => {
    if (!element) throw new Error('找不到操作按钮');
    if (!element.getClientRects().length) throw new Error('操作按钮不可见：' + (element.getAttribute('aria-label') || element.textContent));
    element.scrollIntoView({block: 'nearest', inline: 'nearest'}); element.focus(); element.click(); await pause();
  };
  const textButton = text => all('button').find(b => b.textContent.trim() === text);
  const selectTask = async id => {
    if (innerWidth <= 720 && one('.sdlc-shell.is-detail')) await click(one('[aria-label="返回任务列表"]'));
    await click(all('.sdlc-task').find(b => b.querySelector('.sdlc-task-meta')?.textContent.includes(id)));
    await until(() => one('.sdlc-breadcrumb')?.textContent.includes(id) && all('.sdlc-round').length === (id === 'FLOW-DEMO' ? 4 : 3));
  };
  const reports = [];
  const assert = (condition, label) => { reports.push((condition ? 'PASS ' : 'FAIL ') + label); if (!condition) throw new Error(label); };
  try {
    await until(() => all('.sdlc-round').length === 4);
    await selectTask('FLOW-DEMO');
    if (mode === 'light') await click(one('[aria-label="切换浅色主题"]'));
    if (mode === 'history' || mode === 'evidence') {
      await selectTask('LOOP-DEMO');
      await click(one('.sdlc-verification-detail > summary'));
      if (mode === 'history') await click(one('[data-run-id="loop-round-2"]'));
      if (mode === 'evidence') { await click(one('[data-run-id="loop-round-1"]')); await click(textButton('查看本轮证据')); }
    }
    if (mode === 'checks') {
      const flowDetail = () => one('.sdlc-flow-inspector').textContent;
      assert(all('.sdlc-return-route').length === 3 && all('.sdlc-return-route').some(b => b.textContent.includes('验证 → 计划')) && all('.sdlc-return-route').some(b => b.textContent.includes('评审 → 规格')), '实际退回路线覆盖验证退计划、评审退规格');
      assert(flowDetail().includes('审核发现多币种的舍入规则没有写进规格') && flowDetail().includes('规格 → 计划 → 实现 → 验证 → 评审'), '默认展开最近退回的原因和完整后续路线');
      assert(flowDetail().includes('已按币种处理精度，新增多币种回归用例') && flowDetail().includes('按时间展示') && flowDetail().includes('已重新提交'), '修改说明有真实记录来源，重新提交不冒充审核通过');
      await click(all('.sdlc-flow-repair button')[0]);
      await until(() => one('#sdlc-round-evidence')?.open);
      assert(one('#sdlc-round-evidence').textContent.includes('24 passed') && !one('#sdlc-round-evidence').textContent.includes('第 1 轮测试输出'), '退回详情打开该时间段内第四轮的历史证据');
      await click(one('#sdlc-round-evidence .sdlc-dialog-close'));
      await click(one('[aria-label="查看退回路线：验证 → 计划，第 2 次"]'));
      assert(flowDetail().includes('计划 → 实现 → 验证') && flowDetail().includes('已再次进入验证') && !flowDetail().includes('已按币种处理精度'), '切换路线后显示对应目标、重新提交和当时的修改范围');
      await click(textButton('只看退回'));
      assert(all('.sdlc-flow-event').length === 3, '只看退回筛选保留三次真实退回');
      await click(one('[aria-label="刷新看板"]'));
      await until(() => !one('[aria-label="刷新看板"]').disabled);
      assert(one('[aria-label="查看退回路线：验证 → 计划，第 2 次"]').getAttribute('aria-pressed') === 'true' && flowDetail().includes('计划 → 实现 → 验证'), '刷新后保留正在查看的退回路线');
      await click(textButton('全部流转'));
      assert(all('.sdlc-flow-event').length === 16, '全部流转保留推进和退回的完整顺序');
      await click(one('[aria-label="查看流转 16：验证 → 评审"]'));
      assert(flowDetail().includes('多币种与原优惠测试均通过，再次提交审核') && !flowDetail().includes('为什么退回'), '普通推进可查看自身原因，不冒充退回');
      await click(one('[aria-label="查看退回路线：评审 → 规格，第 3 次"]'));
      assert(one('.sdlc-stage[data-flow-target=true]').textContent.includes('规格') && one('.sdlc-stage[data-flow-source=true]').textContent.includes('评审'), '阶段条同步标出退回的来源和目标');
      assert(one('.sdlc-app').scrollWidth <= one('.sdlc-app').clientWidth + 1, '阶段流转主视图没有横向溢出');
      await selectTask('LOOP-DEMO');
      await click(one('.sdlc-verification-detail > summary'));
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
      const directFile = one('[aria-label="打开规格阶段的 spec.md"]');
      assert(directFile?.textContent === 'spec.md' && one('.sdlc-stage-files').textContent.includes('intent.md'), '阶段条直接显示真实文件名');
      await click(directFile);
      await until(() => one('#sdlc-artifact-dialog')?.textContent.includes('满减门槛'));
      assert(one('#sdlc-artifact-dialog').open, '阶段文件一次点击即可读取正文');
      await click(one('#sdlc-artifact-dialog .sdlc-dialog-close'));
      assert(document.activeElement === directFile, '关闭文件后焦点回到阶段文件入口');
      await click(one('[aria-label="查看实现阶段"]'));
      assert(one('#sdlc-task-panel').textContent.includes('实现依据') && one('#sdlc-task-panel').textContent.includes('plan.md'), '实现阶段列出计划依据');
      await click(one('#sdlc-task-panel .sdlc-dialog-close'));
      await click(one('[aria-label="查看验证阶段"]'));
      assert(one('#sdlc-task-panel').textContent.includes('verification.json') && one('#sdlc-task-panel').textContent.includes('proof.md') && one('#sdlc-task-panel').textContent.includes('边界测试'), '验证阶段同时显示裁决、证据和章节摘要');
      const proofFile = all('#sdlc-task-panel .sdlc-artifact').find(b => b.textContent.includes('proof.md'));
      await click(proofFile);
      await until(() => one('#sdlc-artifact-dialog')?.textContent.includes('覆盖满减门槛'));
      await click(one('#sdlc-artifact-dialog .sdlc-dialog-close'));
      assert(one('#sdlc-task-panel').open && document.activeElement === proofFile, '从文件返回原阶段面板并恢复焦点');
      await click(one('#sdlc-task-panel .sdlc-dialog-close'));
      await click(one('[aria-label="查看全部交付物"]'));
      assert(all('#sdlc-task-panel .sdlc-artifact').length === 5 && one('#sdlc-task-panel').textContent.includes('proof.md'), '顶部完整清单包含所有登记文件');
      await click(one('#sdlc-task-panel .sdlc-dialog-close'));
      assert(all('.sdlc-deliverables').length === 1, '关闭完整清单后主界面没有重复的交付物区');
      await click(one('[aria-label="查看完成阶段"]'));
      assert(all('#sdlc-task-panel .sdlc-artifact').length === 5, '完成阶段汇总交付清单');
      await click(one('#sdlc-task-panel .sdlc-dialog-close'));
      await click(one('[aria-label="查看评审阶段"]'));
      assert(one('#sdlc-task-panel').textContent.includes('暂无已登记的交付物'), '未登记的阶段如实显示空状态');
      await click(one('#sdlc-task-panel .sdlc-dialog-close'));
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
      if (innerWidth <= 720) await click(one('[aria-label="返回任务列表"]'));
      await click(one('.sdlc-sidebar-bottom button'));
      assert(one('.sdlc-app').dataset.theme !== theme, '主题切换生效');
      await click(one('.sdlc-sidebar-bottom button'));
      if (innerWidth <= 720) await selectTask('LOOP-DEMO');
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
      assert(all('.sdlc-deliverables').length === 1, '轮询刷新后交付物区仍只有一份');
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
  if (mode !== 'checks' && one('.sdlc-app')) { one('.sdlc-app').scrollTop = 0; one('.sdlc-detail').scrollTop = 0; }
  document.documentElement.dataset.previewReady = 'true';
})();
