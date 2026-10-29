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
const state = (id, title, status, history, artifacts = '  intent: "intent.md"') => [
  `task: ${id}`, `title: "${title}"`, `status: ${status}`, `created: "${when(0)}"`, `updated: "${when(id === task ? 58 : 1)}"`,
  'artifacts:', artifacts, 'history:', ...history.flatMap(([at, from, to, reason]) => [`  - at: "${when(at)}"`, `    from: "${from}"`, `    to: "${to}"`, `    reason: "${reason}"`]), '',
].join('\n');
await write(`.ai/tasks/${task}/state.yaml`, state(task, '修复订单优惠计算', 'VERIFYING', [
  [0, '', 'INTENT', '明确优惠叠加的边界'], [3, 'INTENT', 'SPEC', '补齐满减与会员折扣的验收标准'],
  [6, 'SPEC', 'PLANNED', '确认最小改动与测试范围'], [9, 'PLANNED', 'IMPLEMENTING', '开始实现'],
  [12, 'IMPLEMENTING', 'VERIFYING', '提交第一轮验证'], [21, 'VERIFYING', 'IMPLEMENTING', '修复第一轮发现的优惠叠加问题'],
  [28, 'IMPLEMENTING', 'VERIFYING', '保留原测试，提交第二轮验证'], [37, 'VERIFYING', 'IMPLEMENTING', '修复会员折扣边界'],
  [45, 'IMPLEMENTING', 'VERIFYING', '提交第三轮验证'],
], '  intent: "intent.md"\n  spec: "spec.md"\n  plan: "plan.md"\n  verification: "verification.json"'));
for (const [name, body] of Object.entries({
  intent: '# 订单优惠计算\n\n这是界面验证夹具，不是业务执行结果。\n\n## 问题\n满减与会员折扣叠加时，计算结果需要保持一致。',
  spec: '# 验收标准\n\n- 满减门槛按统一顺序计算。\n- 会员折扣边界有测试。\n- 不削弱已有测试。',
  plan: '# 修复计划\n\n1. 先复现边界。\n2. 冻结失败测试。\n3. 修复优惠叠加顺序。\n4. 独立复验。',
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
await fs.mkdir(path.join(repo, '.verify-home/storages'), {recursive: true});
await fs.writeFile(path.join(repo, '.verify-home/storages/workspace.json'), JSON.stringify({unit: {name: 'workspace', version: 2}, global: {initialized: true, workspaceIds: ['loop-ui-fixture']}, tables: {workspaces: {'loop-ui-fixture': {path: root, title: '界面验证 · 示例数据', sessionIds: [], createdAt: when(0), updatedAt: when(49)}}}}, null, 2));
console.log(root);
