import type {Context} from '@deepseek-ai/cordis';
import type {ToolRunContext} from '@deepseek-ai/dsh-tools';
import {randomUUID} from 'node:crypto';
import {Store,cwdOf,message} from './store.js';
import {object} from './analysis.js';
import {hash} from './snapshot.js';
import {Collector,type CaptureInfo} from './collector.js';
import type {ExperimentCase,ExperimentObservation} from './experiment.js';

/** Omit reference labels from the prompt. Shared-filesystem access is a separate limitation. */
export async function replayInput(store:Store,sourceId:string):Promise<Record<string,unknown>> {
  const run=await store.run(sourceId);
  const started=run.records.find(r=>r.kind==='started');
  const prepared=run.records.find(r=>r.kind==='prepared');
  if(!started||!prepared||run.summary.issues.length) throw new Error(`来源运行 ${sourceId} 缺少完整输入记录`);
  const original=object(started.data.inputs);
  const input:Record<string,unknown>={};
  for(const key of ['intent_of_change','diff','test_evidence','scope']) if(original[key]!==undefined)input[key]=original[key];
  input.criteria=prepared.data.criteria;input.artifacts=prepared.data.artifacts;
  return input;
}

export async function replayCase(ctx:Context,exec:ToolRunContext,store:Store,collector:Collector,c:ExperimentCase,guidance:string):Promise<ExperimentObservation> {
  const issues:string[]=[];
  const source=await store.run(c.source_run_id);
  const sourceStart=source.records.find(r=>r.kind==='started');
  const sourcePrepared=source.records.find(r=>r.kind==='prepared');
  const originalCode=object(await store.read(`runs/${c.source_run_id}/code.json`));
  const before=await collector.code(exec);
  if(!before.complete||!originalCode.complete||before.fingerprint!==originalCode.fingerprint) throw new Error(`当前代码与来源运行的快照不同或快照不完整；先在当前起点采集新的来源运行。${before.issues.join('; ')} ${Array.isArray(originalCode.issues)?originalCode.issues.join('; '):''}`);
  const checkArtifacts=async(signal?:AbortSignal)=>{
    for(const artifact of Object.values(object(sourcePrepared?.data.artifact_snapshots))) {
      const a=object(artifact);
      if(typeof a.path!=='string'||typeof a.sha256!=='string') throw new Error('来源运行缺少完整制品快照');
      const current=await ctx.fs.readText(await ctx.fs.resolve(a.path,{cwd:cwdOf(exec),signal}),signal);
      if(hash(current)!==a.sha256) throw new Error(`制品已变化: ${a.path}`);
    }
  };
  await checkArtifacts(exec.signal);
  const args={...await replayInput(store,c.source_run_id),experimental_guidance:guidance};
  const began=Date.now();
  const callId=randomUUID();
  let runId:string|undefined;
  // ToolRuntime errors have no value. Correlate the exact invocation before dispatch,
  // rather than guessing the latest run (which breaks under concurrent calls).
  const dispose=ctx.on('sdlc-verify/record',(record,recordExec)=>{
    if(record.kind==='started'&&recordExec.callId===callId)runId=record.run_id;
  });
  let result;
  try {
    result=await ctx.tools.execute({callId:callId as never,rootCallId:exec.rootCallId,parent:exec.token,
      name:'sdlc_verify',arguments:args,agent:exec.agent,signal:exec.signal});
  } finally {dispose();}
  for(const context of result.additionalContexts??[])exec.deferContext(context);
  if(!result.isError&&result.concludesTurn)exec.concludeTurn();
  const value=result.isError?{}:object(result.value);
  if(typeof value.verification_run_id==='string') {
    if(runId&&runId!==value.verification_run_id)issues.push('返回运行 ID 与调用事件不一致');
    else runId=value.verification_run_id;
  }
  const after=await collector.code(exec);
  if(!after.complete||before.fingerprint!==after.fingerprint) issues.push('验证过程中代码改变或结束快照不完整');
  try {await checkArtifacts(AbortSignal.timeout(15000));}
  catch(error) {issues.push(`验证结束制品复查失败: ${message(error)}`);}
  if(result.isError) issues.push(result.error.message);
  if(Array.isArray(value.recording_errors)&&value.recording_errors.length)issues.push('验证器报告记录写入失败');
  let actualConfig:unknown;let fingerprint:string|undefined;let attempts=0;
  if(runId) {
    try {
      const recorded=await store.run(runId);attempts=recorded.summary.attempts;
      issues.push(...recorded.summary.issues);
      const start=recorded.records.find(r=>r.kind==='started');
      fingerprint=typeof start?.data.verifier_fingerprint==='string'?start.data.verifier_fingerprint:undefined;
      if(fingerprint!==sourceStart?.data.verifier_fingerprint)issues.push('验证器已不同于来源运行');
      if(JSON.stringify(start?.data.config)!==JSON.stringify(sourceStart?.data.config))issues.push('验证器配置已不同于来源运行');
      const capture=await store.read(`runs/${runId}/capture.json`) as CaptureInfo;
      issues.push(...capture.errors);
      const configs=[...new Set(capture.sessions.flatMap(s=>s.configs).map(c=>JSON.stringify(c)))].sort().map(c=>JSON.parse(c));
      if(!configs.length)issues.push('未观测到实际模型请求配置');
      else if(configs.length>1)issues.push('同次运行的实际模型请求配置发生变化，无法进行固定配置对照');
      else actualConfig={requests:configs,verifier_config:start?.data.config};
    } catch(error) {issues.push(`记录不可读: ${message(error)}`);}
  } else issues.push('调用没有返回可关联的运行 ID');
  const verdict=['approve','reject','needs_human'].includes(String(value.status))?value.status as ExperimentObservation['verdict']:undefined;
  return {run_id:runId,complete:value.verification_complete===true,verdict,
    duration_ms:Date.now()-began,attempts,comparable:issues.length===0,issues,
    actual_config:actualConfig,verifier_fingerprint:fingerprint};
}
