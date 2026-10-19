import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRun, analyzeRuns, type RecordEvent } from './analysis.js';
const event = (seq:number, kind:string, data:Record<string,unknown>={}):RecordEvent => ({schema_version:1,run_id:'run-1',seq,at:new Date(1000+seq*1000).toISOString(),kind,data});
test('没有裁决的失败不能被当成正常 needs_human', () => {
  const records=[event(0,'started'),event(1,'attempt_started',{attempt:1}),event(2,'finished',{outcome:'no_verdict',result:{status:'needs_human'}})];
  const out=summarizeRun('run-1',records);
  assert.equal(out.outcome,'no_verdict'); assert.equal(out.complete,false); assert.equal(out.verdict,null); assert.equal(out.attempts,1);
});
test('真正的 needs_human 裁决计入完成，重试仍单独可见',()=>{
  const records=[event(0,'started'),event(1,'attempt_started',{attempt:1}),event(2,'attempt_session',{attempt:1,session_id:'s1'}),event(3,'attempt_started',{attempt:2}),event(4,'attempt_session',{attempt:2,session_id:'s2'}),event(5,'finished',{outcome:'completed',result:{status:'needs_human'}})];
  const out=summarizeRun('run-1',records);
  assert.equal(out.complete,true); assert.equal(out.verdict,'needs_human'); assert.equal(out.attempts,2); assert.equal(out.duration_ms,5000); assert.deepEqual(out.session_ids,['s1','s2']);
});
test('进程崩溃留下的开始记录保持未知，不猜失败原因',()=>{
  const out=summarizeRun('run-1',[event(0,'started'),event(1,'attempt_started',{attempt:1})]);
  assert.equal(out.outcome,'unknown'); assert.equal(out.duration_ms,null); assert.match(out.issues.join(' '),/结束/);
});
test('序号缺口或错归属不能算完整证据',()=>{
  const out=summarizeRun('run-1',[event(0,'started'),{...event(3,'finished',{outcome:'completed',result:{status:'approve'}}),run_id:'other'}]);
  assert.equal(out.complete,false); assert.ok(out.issues.length>0);
});
test('复盘给出失败的具体记录引用；不把所有失败猜成 JSON 错误',()=>{
  const records=[event(0,'started'),event(1,'attempt_started',{attempt:1}),event(2,'finished',{outcome:'no_verdict'})];
  const out=analyzeRuns([{summary:summarizeRun('run-1',records),records}]);
  assert.equal(out.observations[0]?.kind,'no_verdict'); assert.deepEqual(out.observations[0]?.run_ids,['run-1']);
  assert.match(out.observations[0]?.evidence[0]??'',/run-1\/000002.json/);
  assert.doesNotMatch(out.observations[0]?.hypothesis??'',/一定.*JSON/);
});
