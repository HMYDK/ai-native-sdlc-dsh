import test from 'node:test';
import assert from 'node:assert/strict';
import {assessEvidence} from './evidence.js';
import {summarizeRun,analyzeRuns,type RecordEvent} from './analysis.js';
const records:RecordEvent[]=['started','attempt_started','attempt_session','finished'].map((kind,seq)=>({
  schema_version:1,run_id:'demo',seq,at:new Date(seq*1000).toISOString(),kind,
  data:kind==='attempt_session'?{session_id:'child'}:kind==='finished'?{outcome:'completed',result:{status:'approve'}}:{},
}));
const good={sessions:[{session_id:'child',configs:[{config:{model:'test'}}],observed_events:3,tool_results:0,source_verified:true,truncated:false,issues:[]}],errors:[]};
test('DEMO-22149 同形：裁决完成但采集为空，分析必须报告证据断链',()=>{
  const health=assessEvidence(records,{sessions:[{session_id:'child',configs:[],tool_results:0,truncated:false}],errors:[]},{complete:false,issues:['not a git repository']});
  assert.equal(health.complete,false);assert.equal(health.replay_ready,false);
  const summary={...summarizeRun('demo',records),evidence_complete:health.complete,evidence_issues:health.issues};
  const report=analyzeRuns([{summary,records}]);
  assert.equal(report.completion_rate,1);assert.equal(report.evidence_complete,0);
  assert.equal(report.observations[0]?.kind,'incomplete_capture');
  assert.match(health.issues.join(' '),/实际模型请求配置/);
});
test('零工具调用不等于漏采：完整日志且有实际配置仍可分析',()=>{
  assert.equal(assessEvidence(records,good,{complete:true,fingerprint:'code'}).complete,true);
});
test('截断、来源未核对、重复会话、损坏快照均不允许比较',()=>{
  for(const sessions of [[],[...good.sessions,...good.sessions],[{...good.sessions[0],truncated:true}],[{...good.sessions[0],source_verified:false}]]) {
    assert.equal(assessEvidence(records,{...good,sessions},{complete:true,fingerprint:'code'}).replay_ready,false);
  }
  assert.equal(assessEvidence(records,good,undefined).complete,false);
});
