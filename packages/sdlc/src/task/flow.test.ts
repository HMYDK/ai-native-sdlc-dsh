import {test} from 'node:test';
import assert from 'node:assert/strict';
import {actOnIssue, beginRun, finishRun, checkSubmission, parseWorkflow} from './flow.js';
import {parseTaskState, serializeTaskState, type TaskState} from './state.js';
import {enforceIssuePolicy, criterionEntries, type Verdict} from '../verify/verdict.js';
import {load, JSON_SCHEMA} from 'js-yaml';
const at = '2026-10-31T00:00:00Z';
const task = (): TaskState => ({task:'TEST-1',title:'fixture',status:'REVIEWING',created:at,updated:at,artifacts:{},history:[]});
const report = (state = task(), severity: 'blocking'|'minor' = 'blocking') => actOnIssue(state,{action:'report',reason:'非目标场景被改变',severity},'reviewer','report-1',at);
const act = (state: TaskState, action: 'start'|'submit'|'defer', id: string, to?: string) => actOnIssue(state,{action,issue_id:state.workflow!.issues[0]!.id,reason:'处理实际问题',evidence:'tests/regression: PASS',to},'author',id,at);
const approved = (): Verdict => ({status:'approve',summary:'probe passed',findings:[]});

test('审核发现 → 退回实现 → 提交修复 → 独立复验；作者不能自行关闭', () => {
  let state = report(); const id = state.workflow!.issues[0]!.id;
  state = act(state,'start','start-1','IMPLEMENTING');
  assert.equal(state.history[0]!.to,'IMPLEMENTING'); assert.match(state.history[0]!.reason,new RegExp(id));
  assert.equal(state.workflow!.issues[0]!.status,'working'); assert.throws(()=>checkSubmission(state),/先处理/);
  state = act(state,'submit','submit-1'); assert.equal(state.workflow!.issues[0]!.status,'submitted');
  state.status = 'VERIFYING'; state = beginRun(state,'run-2',at);
  state = finishRun(state,'run-2',{...approved(),issue_results:[{issue_id:id,result:'resolved',evidence:'independent probe'}]},[],'verifier',at,'verifications/run-2.json');
  assert.equal(state.workflow!.issues[0]!.status,'resolved');
  assert.equal(state.workflow!.issues[0]!.actions.at(-1)!.actor,'verifier');
  assert.equal(state.workflow!.issues[0]!.actions.at(-1)!.run_id,'run-2');
});
test('需求/规划/实现退回都与问题同写；补证据不捏造阶段迁移', () => {
  for (const to of ['SPEC','PLANNED','IMPLEMENTING']) assert.equal(act(report(),'start','start-1',to).history[0]!.to,to);
  const same = act(report(),'start','start-1','REVIEWING'); assert.equal(same.history.length,0);
  assert.equal(same.workflow!.issues[0]!.actions.at(-1)!.to,'REVIEWING');
});
test('普通建议可说明原因延期，阻断问题不可以', () => {
  assert.equal(act(report(task(),'minor'),'defer','defer-1').workflow!.issues[0]!.status,'deferred');
  assert.throws(()=>act(report(),'defer','defer-1'),/阻断/);
});
test('相同调用重试不重复创建问题或退回；未提交处理不能直接重跑 verify', () => {
  const state = report(); assert.equal(report(state),state);
  const started = act(state,'start','start-1','IMPLEMENTING'); assert.equal(act(started,'start','start-1','IMPLEMENTING'),started);
  started.status='VERIFYING'; assert.throws(()=>beginRun(started,'run-2',at),/先处理/);
});
test('缺少、重复、未知问题结果和无法确认，均不能沿用 approve', () => {
  const pending=[{id:'old-1'}];
  for (const rows of [[],[{issue_id:'other',result:'resolved' as const,evidence:'probe'}],[{issue_id:'old-1',result:'cannot_tell' as const,evidence:'no environment'}],Array(2).fill({issue_id:'old-1',result:'resolved',evidence:'probe'})]) {
    assert.equal(enforceIssuePolicy({...approved(),issue_results:rows},pending).status,'needs_human');
  }
});
test('验证中断可明确取消，迟到结果不能覆盖；并发运行被拒', () => {
  const state=task();state.status='VERIFYING';const running=beginRun(state,'run-1',at);
  assert.throws(()=>beginRun(running,'run-2',at),/尚未结束/);
  const cancelled=actOnIssue(running,{action:'cancel_verification',reason:'进程重启，明确放弃旧运行'},'author','cancel',at);
  assert.equal(cancelled.workflow!.runs[0]!.outcome,'cancelled');
  assert.throws(()=>finishRun(cancelled,'run-1',approved(),[],'verifier',at,'verifications/run-1.json'),/迟到/);
});
test('问题处理往返保存且损坏记录不能被静默忽略', () => {
  const state=act(report(),'start','start-1','PLANNED');
  assert.deepEqual(parseTaskState(state.task,load(serializeTaskState(state),{schema:JSON_SCHEMA})),state);
  assert.throws(()=>parseWorkflow({...state.workflow,issues:[{id:'broken'}]}),/损坏/);
  const raw=structuredClone(state.workflow) as any;
  raw.private_trace='secret';raw.issues[0].raw_output='secret';raw.issues[0].actions[0].raw_args='secret';
  assert.ok(!JSON.stringify(parseWorkflow(raw)).includes('secret'));
});
test('完成后发现新问题会明确重开审核，不能留在 DONE',()=>{
  const state=task();state.status='DONE';const next=report(state);
  assert.equal(next.status,'REVIEWING');assert.equal(next.history.at(-1)!.from,'DONE');
});
test('同一验收标准多次未通过保留问题编号，矛盾的已解决声明不能关闭它',()=>{
  const criteria=['非目标场景保持原行为'], criterion_id=criterionEntries(criteria)[0]!.id;
  const verdict:Verdict={status:'reject',summary:'probe failed',findings:[],criteria_results:[{criterion_id,result:'not_met',evidence:'probe still fails'}]};
  let state=task();state.status='VERIFYING';state=finishRun(beginRun(state,'r1',at),'r1',verdict,criteria,'verifier',at,'verifications/r1.json');
  const id=state.workflow!.issues[0]!.id;
  state=act(state,'start','fix','IMPLEMENTING');state=act(state,'submit','submit');state.status='VERIFYING';
  const checked=enforceIssuePolicy({...verdict,issue_results:[{issue_id:id,result:'resolved',evidence:'conflicting answer'}]},state.workflow!.issues);
  assert.ok(checked.issue_errors?.length);
  state=finishRun(beginRun(state,'r2',at),'r2',checked,criteria,'verifier',at,'verifications/r2.json');
  assert.equal(state.workflow!.issues.length,1);assert.equal(state.workflow!.issues[0]!.id,id);
  assert.equal(state.workflow!.issues[0]!.status,'open');
});
