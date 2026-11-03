/** Component interaction checks. Real DOM, effects, focus and layout are checked in DSH Web. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(process.argv[2] || new URL('../lib/ui/client.js', import.meta.url), 'utf8');
const task = (root, status, title) => ({ id: 'SAME-1', repoRoot: root, repoLabel: root.slice(1), title, status,
  updated: '2026-10-16T10:00:00Z', artifacts: [{ kind: 'intent', file: 'intent.md' }], timeline: [], durations: [], blocked: [], verdict: null });
const payload = { roots: [{ root: '/alpha', label: 'alpha' }, { root: '/beta', label: 'beta' }], tasks: [
  task('/alpha', 'DONE', '已完成的第一个同名任务'), task('/beta', 'SPEC', '另一个工作区的同名任务'),
] };

function mount(data = payload, componentProps = {}, componentState = {}) {
  let spec, component, current, initial = true;
  const stores = new Map();
  const jsx = (type, props, key) => ({ type, props: props || {}, key });
  const react = {
    useState(init) {
      const { values } = current;
      const slot = current.index++;
      if (!(slot in values)) {
        values[slot] = initial ? data : componentState[current.name]?.[slot] ?? (typeof init === 'function' ? init() : init);
        initial = false;
      }
      return [values[slot], v => { values[slot] = typeof v === 'function' ? v(values[slot]) : v; }];
    },
    useCallback: fn => fn,
    useEffect() {}, // This harness tests interactions, not effects. No fake network/lifecycle claims.
  };
  new Function('window', 'localStorage', source)(
    { __ModuleLoader__: { load: s => { spec = s; } } }, { getItem: () => 'A', setItem() {} });
  spec.factory(id => id === 'react' ? react : { jsx, jsxs: jsx }).apply({ slots: {
    inject: (_, fn) => { for (const _ of fn()) {} },
    register: (opts, c) => { if (opts.name === 'main') component = c; return () => {}; },
  } });
  function expand(node, path) {
    if (node == null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((n, i) => expand(n, path + '/' + (n?.key ?? i)));
    if (typeof node.type === 'function') {
      // Supply component inputs directly; network/effect behavior is verified in the browser.
      const extra = componentProps[node.type.name];
      const props = extra ? { ...node.props, ...(typeof extra === 'function' ? extra(node.props) : extra) } : node.props;
      const id = path + ':' + node.type.name;
      const values = stores.get(id) || [];
      stores.set(id, values); current = { values, index: 0, name:node.type.name };
      const result = node.type(props);
      return { component: node.type.name, props, child: expand(result, id) };
    }
    return { ...node, child: expand(node.props.children, path + '/children') };
  }
  let tree;
  const render = () => { tree = expand(jsx(component, {}), 'root'); return tree; };
  function find(predicate, start = tree) {
    const result = [];
    const walk = n => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(walk); if (predicate(n)) result.push(n); walk(n.child); };
    walk(start); return result;
  }
  render();
  return { render, find, rows: () => find(n => n.component === 'TaskLine'), detail: () => find(n => n.component === 'Detail')[0],
    click: n => { assert.ok(n, 'control exists'); n.props.onClick(); render(); } };
}
const text = n => n == null ? '' : typeof n !== 'object' ? String(n) : Array.isArray(n) ? n.map(text).join('') : text(n.child);

function openDocument(doc, kind, file = kind + '.json', criteria, acceptance) {
  const raw = typeof doc === 'string' ? doc : JSON.stringify(doc);
  const ui = mount(payload, {}, {ArtifactViewer:[{phase:'ready',text:raw,kind,criteria,acceptance}]});
  ui.detail().props.onOpen(file); ui.render();
  return {ui,raw,viewer:()=>ui.find(n=>n.component === 'ArtifactViewer')[0]};
}
test('验收报告显示任务完整范围和缺项，原始 approve 不冒充完整验收',()=>{
  const acceptance={status:'incomplete',expected:3,answered:1,met:1,missing:['AC-002','AC-003'],errors:['缺少验收结果：AC-002, AC-003']};
  const {ui,viewer}=openDocument({schema_version:3,verdict:{status:'approve',criteria_results:[{criterion_id:'AC-001',result:'met',evidence:'probe'}]}},'verification','verification.json',[],acceptance);
  for(const label of ['应验 3 项','已答 1 项','AC-002','AC-003','验收覆盖未通过核对','原始裁决：通过'])assert.ok(text(viewer()).includes(label),label);
  const heading=ui.find(n=>n.props.className==='sdlc-report-heading',viewer())[0];
  assert.equal(ui.find(n=>n.props.className?.includes('is-pass'),heading).length,0);
});
test('旧裁决按原文展示并明确提示未核对完整范围',()=>{
  const {viewer}=openDocument({schema_version:2,verdict:{status:'approve',criteria_results:[{criterion:'历史标准',result:'met',evidence:'历史证据'}]}},'verification');
  assert.ok(text(viewer()).includes('历史裁决未核对完整验收范围'));
  assert.ok(text(viewer()).includes('历史标准'));
});
test('嵌套验证文件默认展示结论、逐条证据、发现和复验，原始 JSON 按需展开', () => {
  const doc = {criteria:['先提交的第一条','先提交的第二条'],verdict:{status:'reject',summary:'重复请求仍扣款',verification_run_id:'run-b',
    criteria_results:[{criterion_id:'AC-second',criterion:'重排后的第二条',result:'not_met',evidence:'重复请求扣款两次'}],
    findings:[{severity:'blocking',reason:'扣款不幂等',evidence:'余额变化两次',suggestion:'按请求号去重'}],
    issue_results:[{issue_id:'F1',result:'unresolved',evidence:'复验仍失败'}],unverified:['尚未检查退款'],
  },raw_verdict:{summary:'内部原始结构'}};
  const {ui,raw,viewer} = openDocument(doc,'verification','verifications/run-b.json');
  for (const label of ['验证报告','不通过','重复请求仍扣款','重排后的第二条','重复请求扣款两次','阻断','按请求号去重','问题复验结果','未解决','尚未检查退款']) assert.ok(text(viewer()).includes(label),label);
  assert.equal(ui.find(n=>n.type === 'pre',viewer()).length,0,'默认没有 JSON 代码块');
  assert.ok(!text(viewer()).includes('内部原始结构'));
  ui.click(ui.find(n=>n.type === 'button' && text(n)==='查看原始 JSON')[0]);
  assert.equal(text(ui.find(n=>n.type === 'pre',viewer())[0]),raw);
  ui.click(ui.find(n=>n.type === 'button' && text(n)==='收起原始 JSON')[0]);
  assert.equal(ui.find(n=>n.type === 'pre',viewer()).length,0);
});
test('评审报告兼容任意字段和多轮结构，风险、未采纳与未知内容不会消失', () => {
  const {ui,viewer} = openDocument({decision:'accept',lead_review:'变更范围符合规格',rounds:[{reviewer:'reviewer-1',result:'changes_requested',issues:['遗漏并发'],resolution:'保留测试后修复'}],
    not_accepted:['不扩大本轮改动'],honest_notes:['仅复查本次改动'],residual_risks:['上线后需复核'],future_custom:{detail:'额外记录保留',items:[false,0,null]},
  },'review','evidence/acceptance-v2.json');
  for(const label of ['评审报告','接受','变更范围符合规格','评审过程','需要修改','遗漏并发','保留测试后修复','未采纳事项','仅复查本次改动','剩余风险','上线后需复核','future_custom','额外记录保留']) assert.ok(text(viewer()).includes(label),label);
  assert.equal(ui.find(n=>n.type === 'pre',viewer()).length,0);
});
test('没有评审结论不能借验证通过；未完成裁决也不能显示通过徽章', () => {
  const review = openDocument({verification:{verdict:'approve'},lead_review:'待负责人审阅'},'review');
  assert.ok(text(review.viewer()).includes('未记录评审结论'));
  const verification = openDocument({verdict:{status:'approve',verification_complete:false,summary:'中途结束'}},'verification');
  assert.ok(text(verification.viewer()).includes('未形成完整裁决'));
  assert.equal(verification.ui.find(n=>n.props.className?.includes('is-pass'),verification.viewer()).length,0);
});
test('省略标准正文且结果重排时按稳定 ID 显示完整标准，未知 ID 不借用别的标准', () => {
  const {ui,viewer} = openDocument({verdict:{status:'needs_human',criteria_results:[{criterion_id:'second',result:'met',evidence:'第二条结果'},{criterion_id:'unknown',result:'cannot_tell'}]}},'verification','verification.json',[
    {id:'first',text:'标准一完整正文'},{id:'second',text:'标准二完整正文'},
  ]);
  const cards = ui.find(n=>n.props.className === 'sdlc-report-card',viewer());
  assert.ok(text(cards[0]).includes('标准二完整正文')); assert.ok(!text(cards[0]).includes('标准一完整正文'));
  assert.ok(text(cards[1]).includes('unknown')); assert.ok(!text(cards[1]).includes('标准二完整正文'));
});
test('旧验证、损坏 JSON 和普通 JSON 均能读，内容按文本渲染', () => {
  const legacy = openDocument({criteria:['已有标准'],verdict:{status:'needs_human',summary:'证据不足',criteria_results:[{result:'cannot_tell',evidence:'服务未启动'}]}},undefined,'verification.json');
  assert.ok(text(legacy.viewer()).includes('验证报告')); assert.ok(text(legacy.viewer()).includes('无法确认'));
  const broken = openDocument('{"verdict":', 'verification');
  assert.ok(text(broken.viewer()).includes('不是完整有效的 JSON')); assert.equal(text(broken.ui.find(n=>n.type === 'pre')[0]),'{"verdict":');
  const normal = openDocument({message:'<img src=x onerror=alert(1)>',url:'javascript:alert(1)'},'custom','data.json');
  assert.ok(text(normal.viewer()).includes('<img src=x onerror=alert(1)>'));
  assert.equal(normal.ui.find(n=>n.type === 'img' || n.type === 'a',normal.viewer()).length,0);
});

test('同名任务各自留在列表里，带有自己的工作区', () => {
  const ui = mount();
  assert.equal(ui.rows().length, 2);
  assert.ok(text(ui.rows()[0]).includes('alpha'));
  assert.ok(text(ui.rows()[1]).includes('beta'));
});
test('选中第二个工作区的同名任务，详情与唯一选中态一起切换', () => {
  const ui = mount();
  ui.click(ui.rows()[1]);
  assert.equal(ui.detail().props.task.repoRoot, '/beta');
  assert.deepEqual(ui.rows().map(n => n.props.active), [false, true]);
});
test('点交付物沿用所选任务的工作区，不读到另一个同名文件', () => {
  const ui = mount();
  ui.click(ui.rows()[1]);
  ui.detail().props.onOpen('intent.md'); ui.render();
  const viewer = ui.find(n => n.component === 'ArtifactViewer')[0];
  assert.equal(viewer.props.root, '/beta');
  assert.equal(viewer.props.task, 'SAME-1');
  assert.equal(viewer.props.file, 'intent.md');
});
test('阶段条直接展示文件，点击即可打开所选工作区的交付物', () => {
  const data = structuredClone(payload);
  data.tasks[1].artifacts.push({ kind: 'spec', file: 'requirements.md', sections: ['验收标准', '范围'] });
  const ui = mount(data);
  ui.click(ui.rows()[1]);
  const stages = ui.find(n => n.component === 'StageRibbon')[0];
  const file = ui.find(n => n.type === 'button' && text(n).includes('requirements.md'), stages)[0];
  assert.ok(file, '阶段条应直接展示实际登记的文件名');
  ui.click(file);
  const viewer = ui.find(n => n.component === 'ArtifactViewer')[0];
  assert.equal(viewer.props.root, '/beta');
  assert.equal(viewer.props.file, 'requirements.md');
});
test('验证阶段展示裁决和证据的全部文件及摘要，实现阶段保留计划依据', () => {
  const data = structuredClone(payload);
  data.tasks[0].artifacts.push(
    { kind: 'plan', file: 'plan.md', sections: ['改动步骤', '测试计划'] },
    { kind: 'verification', file: 'verification.json', sections: ['verdict'] },
    { kind: 'proof', file: 'proof.md', sections: ['边界测试', '复验结果'] },
  );
  const ui = mount(data);
  ui.click(ui.find(n => n.props['aria-label'] === '查看验证阶段')[0]);
  let panel = ui.find(n => n.component === 'TaskPanel')[0];
  for (const expected of ['verification.json', 'proof.md', '边界测试', '复验结果', '当前文件']) assert.ok(text(panel).includes(expected), expected);
  ui.click(ui.find(n => n.type === 'button' && text(n).includes('proof.md'), panel)[0]);
  assert.equal(ui.find(n => n.component === 'ArtifactViewer')[0].props.file, 'proof.md');
  assert.ok(ui.find(n => n.component === 'TaskPanel').length, '打开文件后保留阶段面板，方便返回继续查看');
  ui.click(ui.find(n => n.props['aria-label'] === '关闭交付物')[0]);
  ui.find(n => n.component === 'TaskPanel')[0].props.onClose(); ui.render();
  ui.click(ui.find(n => n.props['aria-label'] === '查看实现阶段')[0]);
  panel = ui.find(n => n.component === 'TaskPanel')[0];
  assert.ok(text(panel).includes('实现依据'));
  assert.ok(text(panel).includes('plan.md'));
  assert.ok(text(panel).includes('测试计划'));
});
test('完整交付物清单保留自定义文件，完成阶段可回看全部登记内容', () => {
  const data = structuredClone(payload);
  data.tasks[0].artifacts.push({ kind: 'release_notes', file: 'release-notes.md', sections: ['交接说明'] });
  const ui = mount(data);
  ui.click(ui.find(n => n.props['aria-label'] === '查看全部交付物')[0]);
  let panel = ui.find(n => n.component === 'TaskPanel')[0];
  assert.ok(text(panel).includes('intent.md'));
  assert.ok(text(panel).includes('release-notes.md'));
  assert.ok(text(panel).includes('交接说明'));
  panel.props.onClose(); ui.render();
  ui.click(ui.find(n => n.props['aria-label'] === '查看完成阶段')[0]);
  panel = ui.find(n => n.component === 'TaskPanel')[0];
  assert.ok(text(panel).includes('release-notes.md'));
  assert.ok(!text(panel).includes('暂无已登记的交付物'));
  panel.props.onClose(); ui.render();
  ui.click(ui.find(n => n.props['aria-label'] === '查看评审阶段')[0]);
  assert.ok(text(ui.find(n => n.component === 'TaskPanel')[0]).includes('暂无已登记的交付物'));
});

const flowAt = minute => new Date(Date.UTC(2026, 9, 30, 8, minute)).toISOString();
const flowEntry = (minute, from, to, reason) => ({at: flowAt(minute), from, to, reason});
function flowData() {
  const data = structuredClone(payload);
  data.tasks[0].status = 'REVIEWING';
  data.tasks[0].timeline = [
    flowEntry(0, '', 'INTENT', '创建任务'), flowEntry(1, 'INTENT', 'SPEC', '确认重试问题'),
    flowEntry(2, 'SPEC', 'PLANNED', '形成验收标准'), flowEntry(3, 'PLANNED', 'IMPLEMENTING', '按计划实现'),
    flowEntry(4, 'IMPLEMENTING', 'VERIFYING', '提交测试'), flowEntry(5, 'VERIFYING', 'REVIEWING', '提交评审'),
    flowEntry(6, 'REVIEWING', 'SPEC', '审核发现重复请求的处理规则不清楚'),
    flowEntry(7, 'SPEC', 'PLANNED', '补齐重复请求验收规则'), flowEntry(8, 'PLANNED', 'IMPLEMENTING', '确认幂等改动方案'),
    flowEntry(9, 'IMPLEMENTING', 'VERIFYING', '按请求号去重并补并发回归'),
    flowEntry(10, 'VERIFYING', 'REVIEWING', '并发与重试测试通过，重新提交评审'),
  ];
  return data;
}
const flowDetail = ui => ui.find(n => n.props['aria-label'] === '本次流转详情')[0];
test('评审退回规格时，主视图串起原因、修改经过和重新提交评审的完整路线', () => {
  const data = flowData();
  const ui = mount(data, {FlowWorkbench: {execution: {rounds: [
    {id: 'run-a', number: 1, source: 'rsi', startedAt: flowAt(8), changesSummary: '先提交并发用例的第一版修改'},
  ], repairs: [
    {id: 'fix-a', kind: 'fix_end', at: flowAt(9), summary: '按 request_id 去重，保留已有失败测试', source: 'author'},
  ]}}});
  assert.ok(ui.find(n => n.type === 'button' && n.props['aria-label'] === '查看退回路线：评审 → 规格，第 1 次').length);
  const detail = text(flowDetail(ui));
  for (const expected of ['审核发现重复请求的处理规则不清楚', '补齐重复请求验收规则', '按请求号去重并补并发回归', '按 request_id 去重', '已再次进入评审']) assert.ok(detail.includes(expected), expected);
  assert.ok(detail.includes('规格 → 计划 → 实现 → 验证 → 评审'));
  assert.ok(detail.includes('按时间展示'));
  const changes = ui.find(n => n.props.className === 'sdlc-flow-repair', flowDetail(ui)).map(text);
  assert.ok(changes[0].includes('先提交并发用例'));
  assert.ok(changes[1].includes('按 request_id 去重'));
});
test('验收退回哪里由真实迁移决定，不能固定画成退回实现', () => {
  const data = flowData(); data.tasks[0].status = 'VERIFYING';
  data.tasks[0].timeline = data.tasks[0].timeline.slice(0, 5).concat([
    flowEntry(5, 'VERIFYING', 'PLANNED', '验收发现测试方案遗漏异常恢复'),
    flowEntry(6, 'PLANNED', 'IMPLEMENTING', '重排异常恢复的实现和测试步骤'),
    flowEntry(7, 'IMPLEMENTING', 'VERIFYING', '补上恢复逻辑并再次提交验收'),
  ]);
  const ui = mount(data, {FlowWorkbench: {loading: false, execution: {rounds: [], repairs: []}}});
  assert.ok(ui.find(n => n.props['aria-label'] === '查看退回路线：验证 → 计划，第 1 次').length);
  assert.ok(text(flowDetail(ui)).includes('计划 → 实现 → 验证'));
  assert.ok(text(flowDetail(ui)).includes('已再次进入验证'));
  assert.ok(text(flowDetail(ui)).includes('尚无可归入这段时间的修复操作记录'));
});
test('历史中断不能自动接上后续阶段，也不能混入中断后的修复说明', () => {
  const data = flowData(); data.tasks[0].timeline.splice(7, 2);
  const ui = mount(data, {FlowWorkbench: {execution: {rounds: [], repairs: [
    {id: 'wrong', kind: 'fix_end', at: flowAt(9), summary: '不应挂到这条中断路线的说明'},
  ]}}});
  const detail = text(flowDetail(ui));
  assert.ok(detail.includes('流转记录不连续'));
  assert.ok(!detail.includes('已再次进入评审'));
  assert.ok(!detail.includes('不应挂到这条中断路线的说明'));
});
test('没有流转历史时不从 reject 或最新阶段编造退回路线', () => {
  const data = flowData(); data.tasks[0].timeline = [];
  data.tasks[0].verdict = {status: 'reject'};
  const ui = mount(data, {FlowWorkbench: {execution: {rounds: [{outcome: 'reject'}], repairs: []}}});
  const flow = ui.find(n => n.component === 'FlowWorkbench')[0];
  assert.ok(text(flow).includes('尚无阶段流转记录'));
  assert.equal(ui.find(n => n.props['aria-label']?.startsWith('查看退回路线')).length, 0);
});
test('时间缺失或倒序时保留阶段路线，但不关联修复或验证记录', () => {
  for (const invalidTime of [undefined, flowAt(4)]) {
    const data = flowData(); data.tasks[0].timeline[8].at = invalidTime;
    const ui = mount(data, {FlowWorkbench: {execution: {rounds: [
      {id: 'wrong-run', source: 'rsi', startedAt: flowAt(9), changesSummary: '不能按异常时间关联的验证提交'},
    ], repairs: [{id: 'wrong-fix', kind: 'fix_end', at: flowAt(9), summary: '不能按异常时间关联的修改'}]}}});
    const detail = text(flowDetail(ui));
    assert.ok(detail.includes('规格 → 计划 → 实现 → 验证 → 评审'));
    assert.ok(detail.includes('时间缺失、顺序异常'));
    assert.ok(!detail.includes('不能按异常时间关联'));
  }
});
test('流转刷新不切走正在查看的路线，所选记录消失后明确提示', () => {
  const data = flowData(), ui = mount(data);
  ui.click(ui.find(n => n.props['aria-label'] === '查看退回路线：评审 → 规格，第 1 次')[0]);
  data.tasks[0].timeline.push(flowEntry(11, 'REVIEWING', 'PLANNED', '后来发现需要修订方案'));
  data.tasks[0].status = 'PLANNED'; ui.render();
  assert.ok(text(flowDetail(ui)).includes('审核发现重复请求的处理规则不清楚'));
  assert.ok(!text(flowDetail(ui)).includes('后来发现需要修订方案'));
  data.tasks[0].timeline.splice(6, 1); ui.render();
  assert.equal(flowDetail(ui), undefined);
  assert.ok(ui.find(n => text(n).includes('你选择的流转已不在当前记录中')).length);
});
test('状态筛选显示真实任务行，完成和未完成互斥', () => {
  const ui = mount();
  ui.click(ui.find(n => n.type === 'button' && text(n).startsWith('进行中'))[0]);
  assert.deepEqual(ui.rows().map(n => n.props.task.repoRoot), ['/beta']);
  ui.click(ui.find(n => n.type === 'button' && text(n).startsWith('已完成'))[0]);
  assert.deepEqual(ui.rows().map(n => n.props.task.repoRoot), ['/alpha']);
});
test('工作区筛选改变列表及默认详情，保留同名任务的正确来源', () => {
  const ui = mount();
  ui.find(n => n.type === 'select' && n.props['aria-label'] === '工作区')[0].props.onChange({ target: { value: '/beta' } }); ui.render();
  assert.equal(ui.rows().length, 1);
  assert.equal(ui.detail().props.task.repoRoot, '/beta');
});
test('关键词查标题和编号，无匹配时清除筛选可恢复', () => {
  const ui = mount();
  const search = () => ui.find(n => n.type === 'input' && n.props.type === 'search')[0];
  search().props.onChange({ target: { value: '  另一个  ' } }); ui.render();
  assert.equal(ui.rows().length, 1);
  assert.equal(ui.detail().props.task.repoRoot, '/beta');
  search().props.onChange({ target: { value: '没有这个任务' } }); ui.render();
  assert.equal(ui.rows().length, 0); assert.equal(ui.detail(), undefined);
  ui.click(ui.find(n => n.type === 'button' && text(n) === '清除筛选')[0]);
  assert.equal(ui.rows().length, 2);
});
test('迁移记录包含全部历史，长记录可按需展开', () => {
  const data = structuredClone(payload);
  data.tasks[0].timeline = Array.from({ length: 12 }, (_, i) => ({ to: 'SPEC', at: '2026-10-16T10:00:00Z', reason: '记录 ' + i + ' 完整内容' }));
  const ui = mount(data);
  ui.click(ui.find(n => n.type === 'button' && text(n) === '查看全部记录')[0]);
  const entries = ui.find(n => n.type === 'details' && text(n).includes('完整内容'));
  assert.equal(entries.length, 12);
  assert.ok(text(entries[0]).includes('记录 11')); assert.ok(text(entries[11]).includes('记录 0'));
  assert.ok(entries.every(n => !n.props.open));
});
test('空工作区能说明没有任务和检查过哪些位置', () => {
  const ui = mount({ tasks: [], roots: [], searched: ['/alpha/.ai/tasks'] });
  assert.ok(ui.find(n => n.type === 'h2' && text(n) === '还没有任务').length);
  assert.ok(ui.find(n => n.type === 'details' && text(n).includes('/alpha/.ai/tasks')).length);
});

test('完成的业务任务仍显示 RSI 记录缺口，旧任务显示未确认', () => {
  const data = structuredClone(payload);
  data.tasks[0].rsi = {evidence_complete:false,run_count:6,session_count:7,issues:['验证者记录为空'],review_status:'pending'};
  const ui = mount(data);
  assert.ok(text(ui.detail()).includes('执行证据不完整'));
  assert.ok(text(ui.detail()).includes('验证者记录为空'));
  ui.click(ui.rows()[1]);
  assert.ok(text(ui.detail()).includes('尚未确认执行记录是否完整'));
});

const round = (number, outcome) => ({ id: 'run-' + number, number, source: 'rsi', outcome,
  startedAt: '2026-10-28T10:00:00Z', finishedAt: outcome === 'incomplete' ? null : '2026-10-28T10:05:00Z',
  attemptCount: number === 1 ? 2 : 1, summary: '第 ' + number + ' 轮的独立结论',
  criteria: [{ criterion: '折扣边界正确', status: outcome === 'approve' ? 'met' : 'not_met', evidence: '第 ' + number + ' 轮证据' }],
  findings: [{ id: 'finding-' + number, severity: 'important', description: '第 ' + number + ' 轮发现的问题', evidence: '问题证据 ' + number }],
  testEvidence: '第 ' + number + ' 轮测试输出', changesSummary: '第 ' + number + ' 轮改动', toolEvents: [],
});
const execution = () => ({ taskId: 'SAME-1', repoRoot: '/alpha', status: 'recorded', issues: [],
  rounds: [round(1, 'reject'), round(2, 'reject'), round(3, 'approve')], repairs: [] });
function loopMount(ex = execution()) {
  const data = structuredClone(payload); data.tasks[0].status = 'VERIFYING';
  return mount(data, { LoopWorkbench: { execution: ex, loading: false, error: null } });
}
test('三轮验证各自保留，选择历史轮次同时切换问题与结论', () => {
  const ui = loopMount();
  const tabs = () => ui.find(n => n.type === 'button' && n.props.role === 'tab' && n.props['data-run-id']);
  assert.equal(tabs().length, 3);
  assert.ok(text(ui.detail()).includes('第 3 轮发现的问题'));
  ui.click(tabs()[0]);
  assert.ok(text(ui.detail()).includes('第 1 轮发现的问题'));
  assert.ok(!text(ui.detail()).includes('第 3 轮发现的问题'));
  assert.equal(tabs()[0].props['aria-selected'], true);
  assert.ok(text(ui.detail()).includes('历史第 1 轮'));
});
test('历史轮次的证据入口打开该轮快照，而不是最新版文件', () => {
  const ui = loopMount();
  ui.click(ui.find(n => n.type === 'button' && n.props['data-run-id'] === 'run-1')[0]);
  ui.click(ui.find(n => n.type === 'button' && text(n).includes('查看本轮证据'))[0]);
  const modal = ui.find(n => n.component === 'RoundEvidence')[0];
  assert.equal(modal.props.round.id, 'run-1');
  assert.ok(text(modal).includes('第 1 轮测试输出'));
});
test('验证内部重试显示为尝试次数，不新增验证轮次', () => {
  const ui = loopMount();
  ui.click(ui.find(n => n.type === 'button' && n.props['data-run-id'] === 'run-1')[0]);
  assert.ok(text(ui.detail()).includes('2 次尝试'));
  assert.equal(ui.find(n => n.type === 'button' && n.props['data-run-id']).length, 3);
});
test('未结束记录标为未知，不声称 Agent 正在复验', () => {
  const ex = execution(); ex.rounds[2] = round(3, 'incomplete');
  const ui = loopMount(ex);
  assert.ok(text(ui.detail()).includes('记录未结束'));
  assert.ok(!text(ui.detail()).includes('正在复验'));
  assert.ok(!text(ui.detail()).includes('独立验证中'));
});
test('两次 reject 不会在没有修复记录时显示两次返工', () => {
  const ui = loopMount();
  assert.ok(text(ui.detail()).includes('尚无修复记录'));
  assert.ok(!text(ui.detail()).includes('已返工 2 次'));
});
test('只有当前裁决的旧任务明确说明历史缺失，不伪造第一轮', () => {
  const ex = execution(); ex.rounds = [{ ...round(1, 'reject'), source: 'current_verdict' }];
  ex.status = 'partial'; ex.issues = ['历史未记录'];
  const ui = loopMount(ex);
  assert.ok(text(ui.detail()).includes('当前裁决'));
  assert.ok(text(ui.detail()).includes('历史未记录'));
  assert.ok(ui.find(n => n.props.role === 'tab').every(n => !text(n).includes('第 1 轮')));
});
test('新一轮到达时保留手动选择的历史，可返回最新轮次', () => {
  const ex = execution(); const ui = loopMount(ex);
  ui.click(ui.find(n => n.type === 'button' && n.props['data-run-id'] === 'run-1')[0]);
  ex.rounds.push(round(4, 'approve')); ui.render();
  assert.ok(text(ui.detail()).includes('历史第 1 轮'));
  ui.click(ui.find(n => n.type === 'button' && text(n).includes('返回最新轮次'))[0]);
  assert.ok(text(ui.detail()).includes('第 4 轮发现的问题'));
});
test('历史轮次超出服务端展示范围后保留已打开快照，不静默换成最新', () => {
  const ex = execution(), ui = loopMount(ex);
  ui.click(ui.find(n => n.props['data-run-id'] === 'run-1')[0]);
  ex.rounds.shift(); ui.render();
  assert.ok(text(ui.detail()).includes('第 1 轮发现的问题'));
  assert.ok(text(ui.detail()).includes('当前保留你打开时的内容'));
});
test('通过结论下的未复核事项仍可看见，并进入本轮证据', () => {
  const ex = execution(); ex.rounds[2].unverified = ['尚未复核线上环境'];
  const ui = loopMount(ex);
  assert.ok(text(ui.detail()).includes('1 项未复核'));
  ui.click(ui.find(n => n.type === 'button' && text(n).includes('查看本轮证据'))[0]);
  assert.ok(text(ui.find(n => n.component === 'RoundEvidence')[0]).includes('尚未复核线上环境'));
});

test('问题处理展示明确退回、作者证据与独立复验，并可打开对应轮次', () => {
  const execution={status:'recorded',issues:[],rounds:[{id:'run-2',number:2,source:'task_record',outcome:'approve',summary:'独立验证通过',criteria:[],findings:[],toolEvents:[]}],repairs:[],findingTotal:1,findingOffset:0,findingNext:null,findings:[{
    id:'finding-1',source:'review',description:'非目标场景被改变',evidence:'consumer probe failed',status:'resolved',blocking:true,actions:[
      {id:'start',kind:'started',from:'REVIEWING',to:'IMPLEMENTING',reason:'修正错误分支',evidence:'',actor:'author',at:'2026-10-31T00:00:00Z'},
      {id:'submit',kind:'submitted',from:'IMPLEMENTING',to:'IMPLEMENTING',reason:'修正并补测试',evidence:'tests/consumer PASS',actor:'author',at:'2026-10-31T00:01:00Z'},
      {id:'confirm',kind:'resolved',from:'VERIFYING',to:'VERIFYING',reason:'独立复验确认',evidence:'independent probe PASS',actor:'verifier',run_id:'run-2',at:'2026-10-31T00:02:00Z'},
    ],
  }]};
  const ui=mount(payload,{IssueFlow:{execution,loading:false,onPage(){}}}); ui.click(ui.rows()[0]);
  const panel=ui.find(n=>n.component==='IssueFlow')[0];const body=text(panel);
  assert.match(body,/复验通过/);assert.match(body,/修正错误分支/);assert.match(body,/作者提供，等待独立确认/);assert.match(body,/independent probe PASS/);
  ui.click(ui.find(n=>n.type==='button'&&text(n).includes('独立裁决'),panel)[0]);
  assert.equal(ui.find(n=>n.component==='RoundEvidence')[0].props.round.id,'run-2');
});
test('缺失记录明确显示无法确认，历史文件操作不能冒充正式退回', () => {
  const execution={status:'partial',issues:['missing'],rounds:[],repairs:[],findings:[],findingTotal:0,activities:[{id:'old-edit',at:null,summary:'作者修改文件：src/app.ts'}]};
  const ui=mount(payload,{IssueFlow:{execution,loading:false}});ui.click(ui.rows()[0]);
  const body=text(ui.find(n=>n.component==='IssueFlow')[0]);
  assert.match(body,/记录不完整，无法确认/);assert.match(body,/不补造当时未登记的退回/);assert.match(body,/src\/app.ts/);
});
test('问题分页请求实际偏移，待复验与延期不会显示成已经解决', () => {
  let offset=null;
  const execution={status:'recorded',issues:[],rounds:[],repairs:[],findingTotal:21,findingOffset:0,findingNext:20,findings:[{id:'pending',source:'verification',description:'等待复验',evidence:'author only',status:'submitted',actions:[]},{id:'later',source:'review',description:'稍后补充',evidence:'',status:'deferred',actions:[]}]};
  const ui=mount(payload,{IssueFlow:{execution,loading:false,onPage:n=>{offset=n;}}});ui.click(ui.rows()[0]);
  const panel=ui.find(n=>n.component==='IssueFlow')[0];assert.match(text(panel),/待独立复验/);assert.match(text(panel),/延期处理/);
  ui.click(ui.find(n=>n.type==='button'&&text(n)==='下一页问题',panel)[0]);assert.equal(offset,20);
});
