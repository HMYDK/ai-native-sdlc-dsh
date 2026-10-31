import type {Context} from '@deepseek-ai/cordis';
import {mutateTask, taskFile, actorOf, type TaskExec} from './io.js';
import {beginRun, finishRun, pendingIssues, type FlowIssue} from './flow.js';
import {captureBinding, type VerificationBinding} from './binding.js';
import {writePolicy} from '../shared/helpers.js';
import {recordTask} from '../shared/task-recording.js';
import type {Verdict} from '../verify/verdict.js';
import {enforceIssuePolicy} from '../verify/verdict.js';
import {enforceCriteriaPolicy} from '../verify/verdict.js';
import {createHash} from 'node:crypto';
import type {TaskState} from './state.js';
import type {TaskVerification} from './approval.js';
export interface TaskVerificationContext {
  id: string; dir: string; run: string; binding: VerificationBinding; pending: FlowIssue[];
}
export async function startTaskVerification(ctx: Context, exec: TaskExec, task: {id:string;dir:string}, run: string, roots?: string[], criteria?: string[]): Promise<TaskVerificationContext> {
  // Adoption is a separate durable write: a refused retry must still show the old findings.
  await mutateTask(ctx,exec,task.dir,task.id,async state => {
    if (state.workflow?.latest_run || !state.artifacts.verification) return {state,value:undefined};
    const body = await ctx.fs.readText(await taskFile(ctx,exec,task.dir,state.artifacts.verification),exec.signal);
    let old: TaskVerification;
    try { old = JSON.parse(body); } catch { throw new Error('旧验证文件损坏，请先恢复原记录，不能当作没有发现过问题'); }
    if (!old.verdict || !Array.isArray(old.verdict.findings) || !['approve','reject','needs_human'].includes(old.verdict.status)) throw new Error('旧裁决格式不完整，请先恢复原记录');
    const id = 'legacy-' + createHash('sha256').update(body).digest('hex').slice(0,20);
    const criteria = Array.isArray(old.criteria) ? old.criteria : [];
    const verdict = enforceCriteriaPolicy(old.verdict,criteria,old.verdict.verifier_session);
    const staged = structuredClone(state);
    staged.workflow ??= {version:1,runs:[],issues:[]};
    staged.workflow.active_run = id; staged.workflow.latest_run = id;
    staged.workflow.runs.push({id,started_at:typeof old.at==='string'?old.at:'',outcome:'incomplete',legacy:true});
    const file = `verifications/${id}.json`, target = await taskFile(ctx,exec,task.dir,file);
    if (await ctx.fs.stat(target,exec.signal)) {
      if (await ctx.fs.readText(target,exec.signal) !== body) throw new Error('旧裁决归档内容不一致');
    } else await ctx.fs.writeText(target,body,{kind:'createIfAbsent'},exec.signal,await writePolicy(ctx,exec));
    const next = finishRun(staged,id,verdict,criteria,verdict.verifier_session??'legacy-verifier',typeof old.at==='string'?old.at:'',file);
    // Import findings without inventing a historical return or changing the task's update time.
    next.updated = state.updated;
    return {state:next,value:undefined};
  });
  return mutateTask(ctx,exec,task.dir,task.id,async state => {
    const next = beginRun(state,run,new Date().toISOString());
    const artifacts = Object.fromEntries(Object.entries(state.artifacts).map(([k,v])=>[k,`${task.dir}/${v}`]));
    const binding = await captureBinding(ctx,exec,artifacts,roots);
    await checkRecordedReturn(ctx,exec,task.dir,state,binding,criteria);
    return {state:next,value:{...task,run,binding,pending:pendingIssues(state)}};
  });
}
async function checkRecordedReturn(ctx: Context, exec: TaskExec, dir: string, state: TaskState, current: VerificationBinding, criteria?: string[]): Promise<void> {
  // An interrupted retry must not erase the last completed version boundary.
  const previous = [...(state.workflow?.runs ?? [])].reverse().find(r=>r.file && !r.legacy);
  if (!previous?.file) return;
  const old = JSON.parse(await ctx.fs.readText(await taskFile(ctx,exec,dir,previous.file),exec.signal)) as TaskVerification;
  const normalize = (values:string[])=>JSON.stringify(values.map(c=>c.trim()).sort());
  const criteriaChanged = criteria !== undefined && normalize(criteria) !== normalize(old.criteria);
  if (old.binding?.fingerprint === current.fingerprint && !criteriaChanged) return;
  const stages = ['INTENT','SPEC','PLANNED','IMPLEMENTING','VERIFYING','REVIEWING','DONE'];
  let required = 3;
  if (criteriaChanged || ['intent','spec'].some(k=>old.binding?.artifacts[k]?.sha256 !== current.artifacts[k]?.sha256)) required = 1;
  else if (old.binding?.artifacts.plan?.sha256 !== current.artifacts.plan?.sha256) required = 2;
  const recorded = state.history.some(h=>h.at >= (previous.finished_at ?? previous.started_at)
    && stages.indexOf(h.to) <= required && stages.indexOf(h.to) < stages.indexOf(h.from));
  if (!recorded) throw new Error(`上轮验证后代码、需求/计划或验收标准已经改变，但没有相应退回记录。请用 sdlc_task_issue 登记原因并 start 退回 ${stages[required]}，提交修复证据后再验证；不能在验证阶段直接改完当作已处理。`);
}
export async function completeTaskVerification(ctx: Context, exec: TaskExec, task: TaskVerificationContext, raw: Verdict, result: Verdict,
  inputs: {criteria:string[];intent_of_change:string;test_evidence?:string}): Promise<Verdict> {
  let verdict = enforceIssuePolicy(result,task.pending);
  try {
    const paths = Object.fromEntries(Object.entries(task.binding.artifacts).map(([k,v])=>[k,v.path]));
    const after = await captureBinding(ctx,exec,paths,task.binding.roots);
    if (after.fingerprint !== task.binding.fingerprint) throw new Error('独立验证期间代码或验收制品发生变化');
  } catch (error) {
    verdict = {...verdict,status:verdict.status === 'reject' ? 'reject' : 'needs_human',snapshot_error:error instanceof Error ? error.message : '版本核对失败'};
    verdict.summary += '\n' + verdict.snapshot_error + '；本轮不能确认当前版本通过。';
  }
  verdict = {...verdict,verification_run_id:task.run};
  const at = new Date().toISOString(), file = `verifications/${task.run}.json`;
  const doc = {schema_version:2,task:task.id,at,...inputs,verdict,raw_verdict:raw,binding:task.binding};
  const body = JSON.stringify(doc,null,2)+'\n', policy = await writePolicy(ctx,exec);
  const state = await mutateTask(ctx,exec,task.dir,task.id,async state => {
    // Check ownership before ANY verdict write; a cancelled result cannot overwrite the latest cache.
    const next = finishRun(state,task.run,verdict,inputs.criteria,verdict.verifier_session ?? 'independent-verifier',at,file);
    await ctx.fs.writeText(await taskFile(ctx,exec,task.dir,file),body,{kind:'createIfAbsent'},exec.signal,policy);
    await ctx.fs.writeText(await taskFile(ctx,exec,task.dir,'verification.json'),body,undefined,exec.signal,policy);
    return {state:next,value:next};
  });
  const root = task.dir.slice(0,task.dir.lastIndexOf('/'));
  const cwd = (exec.agent as {session?:{header?:{cwd?:string}}})?.session?.header?.cwd;
  const relative = cwd && root.startsWith(cwd+'/') ? task.dir.slice(cwd.length+1) : `.ai/tasks/${task.id}`;
  const errors = await recordTask(ctx,{kind:'advanced',task_dir:relative,state},exec);
  return {...verdict,...(errors.length ? {recording_errors:errors} : {})};
}
export async function abandonTaskVerification(ctx: Context, exec: TaskExec, task: TaskVerificationContext, reason: string): Promise<void> {
  // Even an aborted invocation must release its durable active marker.
  const cleanup = {...exec,signal:undefined};
  await mutateTask(ctx,cleanup,task.dir,task.id,state => {
    if (state.workflow?.active_run !== task.run) return {state,value:undefined};
    const next = structuredClone(state), w = next.workflow!, run = w.runs.find(r=>r.id===task.run)!;
    delete w.active_run; run.outcome = exec.signal?.aborted ? 'cancelled' : 'error'; run.finished_at = new Date().toISOString();
    run.summary = `${actorOf(exec)}：${reason.slice(0,1000)}`; next.updated = run.finished_at;
    return {state:next,value:undefined};
  });
}
