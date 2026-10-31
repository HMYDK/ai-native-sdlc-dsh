#!/usr/bin/env node
/** Deterministic browser fixture, confined to the repository's ignored verification home. */
import fs from 'node:fs/promises';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const root = path.join(repo, '.verify-home', 'loop-workspace');
const task = 'LOOP-DEMO';
const when = n => new Date(Date.UTC(2026, 9, 28, 8, n)).toISOString();
const write = async (relative, value) => {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};
const state = (id, title, status, history, artifacts = '  intent: "intent.md"', updated = id === task ? 58 : 1) => [
  `task: ${id}`, `title: "${title}"`, `status: ${status}`, `created: "${when(0)}"`, `updated: "${when(updated)}"`,
  'artifacts:', artifacts, 'history:', ...history.flatMap(([at, from, to, reason]) => [`  - at: "${when(at)}"`, `    from: "${from}"`, `    to: "${to}"`, `    reason: "${reason}"`]), '',
].join('\n');
await write(`.ai/tasks/${task}/state.yaml`, state(task, '修复订单优惠计算', 'VERIFYING', [
  [0, '', 'INTENT', '明确优惠叠加的边界'], [3, 'INTENT', 'SPEC', '补齐满减与会员折扣的验收标准'],
  [6, 'SPEC', 'PLANNED', '确认最小改动与测试范围'], [9, 'PLANNED', 'IMPLEMENTING', '开始实现'],
  [12, 'IMPLEMENTING', 'VERIFYING', '提交第一轮验证'], [21, 'VERIFYING', 'IMPLEMENTING', '修复第一轮发现的优惠叠加问题'],
  [28, 'IMPLEMENTING', 'VERIFYING', '保留原测试，提交第二轮验证'], [37, 'VERIFYING', 'IMPLEMENTING', '修复会员折扣边界'],
  [45, 'IMPLEMENTING', 'VERIFYING', '提交第三轮验证'],
], '  intent: "intent.md"\n  spec: "spec.md"\n  plan: "plan.md"\n  verification: "verification.json"\n  proof: "proof.md"'));
for (const [name, body] of Object.entries({
  intent: '# 订单优惠计算\n\n这是界面验证夹具，不是业务执行结果。\n\n## 问题\n满减与会员折扣叠加时，计算结果需要保持一致。',
  spec: '# 验收标准\n\n- 满减门槛按统一顺序计算。\n- 会员折扣边界有测试。\n- 不削弱已有测试。',
  plan: '# 修复计划\n\n1. 先复现边界。\n2. 冻结失败测试。\n3. 修复优惠叠加顺序。\n4. 独立复验。',
  proof: '# 验证证据\n\n此内容为界面验证夹具。\n\n## 边界测试\n覆盖满减门槛和会员折扣边界。\n\n## 复验结果\n第三轮的示例结果为 18 passed / 0 failed。',
})) await write(`.ai/tasks/${task}/${name}.md`, body);
const runIds = ['loop-round-1', 'loop-round-2', 'loop-round-3'];
const sessions = [{id: 'loop-author', role: 'author', windows: [{from: 0, to: null, registered: 0}]}, ...runIds.map((_, i) => ({id: `loop-verifier-${i + 1}`, role: 'verifier', parent: 'loop-author', windows: [{from: 0, to: null, registered: 0}]}))];
await write(`.ai/rsi/tasks/${task}/task.json`, {schema_version: 1, task_id: task, task_dir: `.ai/tasks/${task}`, workspace: root, status: 'VERIFYING', title: '修复订单优惠计算', sessions, runs: runIds, checkpoints: [], issues: []});
const call = (seq, id, name, minute, args = {}) => ({seq, time: Date.parse(when(minute)), type: 'tool/call', data: {callId: id, name, arguments: JSON.stringify(args)}});
const result = (seq, id, minute) => ({seq, time: Date.parse(when(minute)), type: 'tool/result', data: {message: {toolCallId: id, isError: false, content: [{type: 'text', text: 'Fixture tool result'}]}}});
const snapshot = (id, role, events) => ({session_id: id, role, source_verified: true, truncated: false, issues: [], events});
let finalVerdict;
for (const [i, id] of runIds.entries()) {
  const n = i + 1, at = [12, 28, 45][i];
  const reasons = i === 0 ? ['满减与会员折扣叠加顺序不一致', '金额边界没有覆盖', '零金额订单的结果不一致'] : i === 1 ? ['会员优惠边界不一致'] : [];
  const verdict = {status: i === 2 ? 'approve' : 'reject', summary: ['发现 3 项问题，需要修复优惠叠加顺序和金额边界。', '优惠叠加顺序已修复，仍有 1 项会员折扣边界问题。', '三项验收标准均通过，优惠叠加和边界行为已复核。'][i],
    criteria_results: ['优惠叠加顺序一致', '金额边界计算正确', '已有测试保持有效'].map((criterion, j) => ({criterion, result: j < reasons.length ? 'not_met' : 'met', evidence: `第 ${n} 轮：${j < reasons.length ? reasons[j] : '对应测试通过'}。`})),
    findings: reasons.map(reason => ({severity: 'important', reason, evidence: `第 ${n} 轮边界测试：同时使用满减和会员折扣时，结果与验收标准不一致。`})),
    unverified: [], verification_complete: true};
  finalVerdict = verdict;
  const events = [
    ['started', {parent_session_id: 'loop-author', inputs: {task_id: task, criteria: ['优惠叠加顺序一致', '金额边界计算正确', '已有测试保持有效'], intent_of_change: ['建立优惠计算与边界测试。', '统一优惠叠加顺序，保留冻结的失败测试。', '补齐会员折扣边界处理，原有测试全部通过。'][i], test_evidence: `第 ${n} 轮测试输出\n${i === 2 ? '18 passed / 0 failed' : i === 1 ? '17 passed / 1 failed' : '15 passed / 3 failed'}\n此内容为界面验证夹具。`}}],
    ['attempt_started', {attempt: 1}], ['attempt_session', {attempt: 1, session_id: `loop-verifier-${n}`}],
    ['attempt_finished', {attempt: 1, session_id: `loop-verifier-${n}`, stop_reason: 'end_turn'}],
    ['finished', {outcome: 'completed', result: verdict}],
  ];
  for (const [seq, [kind, data]] of events.entries()) await write(`.ai/rsi/runs/${id}/${String(seq).padStart(6, '0')}.json`, {schema_version: 1, run_id: id, seq, at: when(at + seq), kind, data});
  const trace = ['read', 'bash', 'structured_output'].flatMap((name, j) => [call(j * 2, `${id}-${j}`, name, at + j), result(j * 2 + 1, `${id}-${j}`, at + j + 1)]);
  await write(`.ai/rsi/tasks/${task}/sessions/loop-verifier-${n}.json`, snapshot(`loop-verifier-${n}`, 'verifier', trace));
}
const fixes = [
  call(0, 'fix-1', 'sdlc_fix_start', 21, {task_id: task, reason: '冻结第一轮失败测试，开始修复优惠叠加。'}), result(1, 'fix-1', 21),
  call(2, 'end-1', 'sdlc_fix_end', 27, {task_id: task, reason: '完成叠加顺序修复。'}), result(3, 'end-1', 27),
  call(4, 'fix-2', 'sdlc_fix_start', 37, {task_id: task, reason: '保留边界测试，继续修复会员折扣。'}), result(5, 'fix-2', 37),
  call(6, 'end-2', 'sdlc_fix_end', 44, {task_id: task, reason: '边界测试已通过，提交独立复验。'}), result(7, 'end-2', 44),
];
await write(`.ai/rsi/tasks/${task}/sessions/loop-author.json`, snapshot('loop-author', 'author', fixes));
await write(`.ai/tasks/${task}/verification.json`, {task, at: when(49), verdict: finalVerdict});
await write(`.ai/tasks/${task}/rsi.json`, {task_id: task, evidence_complete: true, run_count: 3, session_count: 4, review_status: 'collecting', issues: [], updated_at: when(49)});
for (const [id, title, status] of [['SEARCH-DEMO', '优化搜索召回质量', 'IMPLEMENTING'], ['GROWTH-DEMO', '新增用户成长体系', 'DONE']]) {
  await write(`.ai/tasks/${id}/state.yaml`, state(id, title, status, [[0, '', 'INTENT', '界面验证夹具'], [1, 'INTENT', status, '展示不同任务状态']]));
  await write(`.ai/tasks/${id}/intent.md`, '# 界面验证夹具\n\n用于验证任务筛选和切换。');
}
// A review can return all the way to specification; the later route can contain another verification.
const flowTask = 'FLOW-DEMO';
await write(`.ai/tasks/${flowTask}/state.yaml`, state(flowTask, '订单优惠：从审核退回到重新提交', 'REVIEWING', [
  [0, '', 'INTENT', '明确优惠叠加的边界'], [3, 'INTENT', 'SPEC', '补齐满减与会员折扣的验收标准'],
  [6, 'SPEC', 'PLANNED', '确认改动与测试范围'], [9, 'PLANNED', 'IMPLEMENTING', '开始实现'],
  [12, 'IMPLEMENTING', 'VERIFYING', '提交第一轮验收检查'], [21, 'VERIFYING', 'IMPLEMENTING', '验收发现优惠叠加顺序和金额边界有误'],
  [28, 'IMPLEMENTING', 'VERIFYING', '统一优惠叠加顺序，保留原失败测试'], [37, 'VERIFYING', 'PLANNED', '验收发现会员折扣边界未覆盖，需要补充测试方案'],
  [40, 'PLANNED', 'IMPLEMENTING', '补上零金额与折扣边界的实现和测试步骤'], [45, 'IMPLEMENTING', 'VERIFYING', '边界问题已修复，提交第三轮验收检查'],
  [52, 'VERIFYING', 'REVIEWING', '三项验收标准通过，提交审核'],
  [56, 'REVIEWING', 'SPEC', '审核发现多币种的舍入规则没有写进规格，当前实现无法确认是否满足业务要求'],
  [60, 'SPEC', 'PLANNED', '补齐人民币、日元的金额精度和舍入验收规则'],
  [64, 'PLANNED', 'IMPLEMENTING', '补充按币种处理精度的方案及边界回归测试'],
  [70, 'IMPLEMENTING', 'VERIFYING', '按币种处理金额精度，新增多币种回归用例，提交复验'],
  [78, 'VERIFYING', 'REVIEWING', '多币种与原优惠测试均通过，再次提交审核'],
], '  intent: "intent.md"\n  spec: "spec.md"\n  plan: "plan.md"\n  verification: "verification.json"\n  proof: "proof.md"', 78));
for (const [file, body] of Object.entries({
  intent: '# 订单优惠与多币种金额\n\n界面验证夹具，不是业务执行结果。\n\n## 问题\n优惠叠加与币种舍入规则需要明确。',
  spec: '# 验收标准\n\n- 满减与会员折扣按统一顺序叠加。\n- 人民币保留两位小数，日元舍入到整数（界面示例规则）。\n- 覆盖金额边界，不削弱原有测试。',
  plan: '# 修订后的计划\n\n## 金额精度\n按币种处理精度与舍入。\n\n## 回归范围\n保留优惠叠加用例，新增人民币和日元边界。',
  proof: '# 验证证据\n\n此内容为界面验证夹具。\n\n## 多币种回归\n第四轮示例结果：24 passed / 0 failed。\n\n## 再次提交\n已提交审核，尚无审核通过记录。',
})) await write(`.ai/tasks/${flowTask}/${file}.md`, body);
const flowRuns = ['flow-round-1', 'flow-round-2', 'flow-round-3', 'flow-round-4'];
const flowSessions = [{id: 'flow-author', role: 'author', windows: [{from: 0, to: null, registered: 0}]}, ...flowRuns.map((_, i) => ({id: `flow-verifier-${i + 1}`, role: 'verifier', parent: 'flow-author', windows: [{from: 0, to: null, registered: 0}]}))];
await write(`.ai/rsi/tasks/${flowTask}/task.json`, {schema_version: 1, task_id: flowTask, task_dir: `.ai/tasks/${flowTask}`, workspace: root, status: 'REVIEWING', title: '订单优惠：从审核退回到重新提交', sessions: flowSessions, runs: flowRuns, checkpoints: [], issues: []});
for (const [i, run] of runIds.entries()) {
  for (const file of await fs.readdir(path.join(root, `.ai/rsi/runs/${run}`))) {
    const doc = JSON.parse(await fs.readFile(path.join(root, `.ai/rsi/runs/${run}/${file}`), 'utf8'));
    doc.run_id = flowRuns[i];
    if (doc.data.inputs) doc.data.inputs.task_id = flowTask;
    if (doc.data.parent_session_id) doc.data.parent_session_id = 'flow-author';
    if (doc.data.session_id) doc.data.session_id = `flow-verifier-${i + 1}`;
    await write(`.ai/rsi/runs/${flowRuns[i]}/${file}`, doc);
  }
  await write(`.ai/rsi/tasks/${flowTask}/sessions/flow-verifier-${i + 1}.json`, snapshot(`flow-verifier-${i + 1}`, 'verifier', [call(0, 'read', 'read', [12, 28, 45][i]), result(1, 'read', [13, 29, 46][i])]));
}
const flowVerdict = {status: 'approve', summary: '多币种精度与原优惠行为已复核，满足修订后的验收规则。', criteria_results: [{criterion: '不同币种按规格舍入', result: 'met', evidence: '人民币和日元边界用例通过（界面示例）。'}], findings: [], unverified: [], verification_complete: true};
for (const [seq, [kind, data]] of [
  ['started', {parent_session_id: 'flow-author', inputs: {task_id: flowTask, criteria: ['不同币种按规格舍入'], intent_of_change: '按币种处理金额精度，新增人民币和日元边界用例；保留原优惠回归测试。', test_evidence: '界面验证夹具：24 passed / 0 failed'}}],
  ['attempt_started', {attempt: 1}], ['attempt_session', {attempt: 1, session_id: 'flow-verifier-4'}],
  ['attempt_finished', {attempt: 1, session_id: 'flow-verifier-4', stop_reason: 'end_turn'}], ['finished', {outcome: 'completed', result: flowVerdict}],
].entries()) await write(`.ai/rsi/runs/flow-round-4/${String(seq).padStart(6, '0')}.json`, {schema_version: 1, run_id: 'flow-round-4', seq, at: when(70 + seq), kind, data});
await write(`.ai/rsi/tasks/${flowTask}/sessions/flow-verifier-4.json`, snapshot('flow-verifier-4', 'verifier', [call(0, 'test', 'bash', 71), result(1, 'test', 72)]));
await write(`.ai/rsi/tasks/${flowTask}/sessions/flow-author.json`, snapshot('flow-author', 'author', [
  call(0, 'currency-start', 'sdlc_fix_start', 64, {task_id: flowTask, reason: '按修订的多币种规格开始修复，保留已有测试'}), result(1, 'currency-start', 64),
  call(2, 'currency-end', 'sdlc_fix_end', 69, {task_id: flowTask, reason: '已按币种处理精度，新增多币种回归用例，原优惠测试保持通过'}), result(3, 'currency-end', 69),
]));
await write(`.ai/tasks/${flowTask}/verification.json`, {task: flowTask, at: when(74), verdict: flowVerdict});
await fs.mkdir(path.join(repo, '.verify-home/storages'), {recursive: true});
await fs.writeFile(path.join(repo, '.verify-home/storages/workspace.json'), JSON.stringify({unit: {name: 'workspace', version: 2}, global: {initialized: true, workspaceIds: ['loop-ui-fixture']}, tables: {workspaces: {'loop-ui-fixture': {path: root, title: '界面验证 · 示例数据', sessionIds: [], createdAt: when(0), updatedAt: when(49)}}}}, null, 2));
console.log(root);
