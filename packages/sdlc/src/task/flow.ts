/** Small durable facts shared by task, verifier and dashboard. Never infer fixes from prose. */
import {randomUUID} from 'node:crypto';
import type {TaskState, TaskStatus} from './state.js';
import type {Verdict, Severity} from '../verify/verdict.js';
import {criterionEntries} from '../verify/verdict.js';

export type IssueStatus = 'open' | 'working' | 'submitted' | 'resolved' | 'deferred';
export interface IssueAction {
  id: string; at: string; actor: string; kind: 'reported' | 'started' | 'submitted' | 'deferred' | 'resolved' | 'unresolved';
  from: string; to: string; reason: string; evidence: string; run_id?: string;
}
export interface FlowIssue {
  id: string; source: 'verification' | 'review'; source_run?: string; criterion_id?: string;
  severity: Severity; blocking: boolean; description: string; evidence: string;
  status: IssueStatus; actions: IssueAction[];
}
export interface FlowRun {
  id: string; started_at: string; finished_at?: string;
  outcome: 'incomplete' | 'approve' | 'reject' | 'needs_human' | 'error' | 'cancelled';
  summary?: string; file?: string;
  legacy?: boolean;
}
export interface TaskWorkflow {
  version: 1; runs: FlowRun[]; issues: FlowIssue[]; active_run?: string; latest_run?: string;
}
export const emptyWorkflow = (): TaskWorkflow => ({version: 1, runs: [], issues: []});
const string = (x: unknown): x is string => typeof x === 'string';
const object = (x: unknown): Record<string, unknown> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};

export function parseWorkflow(raw: unknown): TaskWorkflow {
  const w = object(raw);
  if (w.version !== 1 || !Array.isArray(w.runs) || !Array.isArray(w.issues)) throw new Error('workflow 格式不完整，不能忽略已有问题');
  const ids = new Set<string>(), runs = new Set<string>();
  for (const value of w.runs) {
    const r = object(value);
    if (!string(r.id) || !/^[a-zA-Z0-9_-]{1,96}$/.test(r.id) || runs.has(r.id) || !string(r.started_at)
      || !['incomplete','approve','reject','needs_human','error','cancelled'].includes(String(r.outcome))) throw new Error('验证轮次记录损坏');
    runs.add(r.id);
  }
  for (const value of w.issues) {
    const i = object(value);
    if (!string(i.id) || ids.has(i.id) || !string(i.description) || !string(i.evidence) || typeof i.blocking !== 'boolean'
      || !['verification','review'].includes(String(i.source)) || !['blocking','important','minor'].includes(String(i.severity))
      || !['open','working','submitted','resolved','deferred'].includes(String(i.status)) || !Array.isArray(i.actions)) throw new Error('问题处理记录损坏');
    if (i.blocking && i.status === 'deferred') throw new Error('阻断问题不能延期后当作完成');
    for (const value of i.actions) {
      const a = object(value);
      if (!['id','at','actor','from','to','reason','evidence'].every(k => string(a[k]))
        || !['reported','started','submitted','deferred','resolved','unresolved'].includes(String(a.kind))) throw new Error('问题处理动作损坏');
    }
    ids.add(i.id);
  }
  for (const key of ['active_run','latest_run']) if (w[key] !== undefined && (!string(w[key]) || !runs.has(String(w[key])))) throw new Error('验证引用没有对应轮次');
  // Only public workflow fields are returned to the dashboard. Never spread unknown stored data.
  const pick = (value: unknown, keys: string[]) => Object.fromEntries(keys.filter(k=>object(value)[k]!==undefined).map(k=>[k,object(value)[k]]));
  return {
    ...pick(w,['version','active_run','latest_run']),
    runs:w.runs.map(r=>pick(r,['id','started_at','finished_at','outcome','summary','file','legacy'])),
    issues:w.issues.map(i=>({...pick(i,['id','source','source_run','criterion_id','severity','blocking','description','evidence','status']),
      actions:(object(i).actions as unknown[]).map(a=>pick(a,['id','at','actor','kind','from','to','reason','evidence','run_id']))})),
  } as unknown as TaskWorkflow;
}

export function requireIdle(state: TaskState): void {
  if (state.workflow?.active_run) throw new Error(`验证 ${state.workflow.active_run} 尚未结束；中断后用 sdlc_task_issue action=cancel_verification 记录取消，再重试`);
}
export function checkSubmission(state: TaskState): void {
  requireIdle(state);
  const outstanding = state.workflow?.issues.filter(i => i.status === 'open' || i.status === 'working') ?? [];
  if (outstanding.length) throw new Error('先处理上一轮问题并提交证据（普通建议可说明原因延期）：' + outstanding.map(i => i.id).join(', '));
}
export function pendingIssues(state: TaskState): FlowIssue[] {
  return state.workflow?.issues.filter(i => i.status === 'submitted') ?? [];
}
export interface IssueInput {
  action: 'report' | 'start' | 'submit' | 'defer' | 'cancel_verification';
  issue_id?: string; reason: string; evidence?: string; to?: string; severity?: string;
}
/** Stage history and issue actions are returned together for ONE guarded state write. */
export function actOnIssue(state: TaskState, input: IssueInput, actor: string, actionId: string, at: string): TaskState {
  const next = structuredClone(state), w = next.workflow ??= emptyWorkflow();
  if (w.issues.some(i => i.actions.some(a => a.id === actionId))) return state;
  if (!input.reason.trim() || input.reason.length > 2000 || (input.evidence?.length ?? 0) > 4000) throw new Error('处理原因必填（最多 2000 字），证据最多 4000 字');
  if (input.action === 'cancel_verification') {
    const run = w.runs.find(r => r.id === w.active_run);
    if (!run) throw new Error('没有待取消的验证');
    run.outcome = 'cancelled'; run.finished_at = at; run.summary = `${actor}：${input.reason}`;
    delete w.active_run; next.updated = at; return next;
  }
  requireIdle(state);
  let issue = w.issues.find(i => i.id === input.issue_id);
  if (input.action === 'report') {
    if (!['blocking','important','minor'].includes(input.severity ?? '')) throw new Error('报告问题必须给出 severity');
    issue = {id: `issue-${randomUUID()}`, source: 'review', severity: input.severity as Severity,
      blocking: input.severity === 'blocking', description: input.reason, evidence: input.evidence ?? '', status: 'open', actions: []};
    w.issues.push(issue);
  }
  if (!issue) throw new Error('问题编号不存在；先用 report 登记审核发现的问题');
  const from = next.status;
  let kind: IssueAction['kind'];
  if (input.action === 'report') {
    kind = 'reported';
    if (next.status === 'DONE') {
      next.status = 'REVIEWING';
      next.history.push({at,from,to:next.status,reason:`[${issue.id}] 完成后发现新问题：${input.reason}`});
    }
  }
  else if (input.action === 'start') {
    if (issue.status === 'resolved') throw new Error('已关闭问题不可重写历史；新发现用 report 登记');
    if (!['SPEC','PLANNED','IMPLEMENTING'].includes(input.to ?? '') && input.to !== state.status) throw new Error('退回目标只能是 SPEC/PLANNED/IMPLEMENTING；仅补证据时可填写当前阶段');
    if (input.to === 'DONE') throw new Error('完成状态不能执行修复；先退回对应阶段');
    const order = ['INTENT','SPEC','PLANNED','IMPLEMENTING','VERIFYING','REVIEWING','DONE'];
    if (order.indexOf(input.to!) > order.indexOf(state.status)) throw new Error('start 不能跳过前进阶段；先完成正常阶段准入');
    next.status = input.to as TaskStatus; issue.status = 'working'; kind = 'started';
    if (from !== next.status) next.history.push({at, from, to: next.status, reason: `[${issue.id}] ${input.reason}`});
  } else if (input.action === 'submit') {
    if (issue.status !== 'working' || !input.evidence?.trim()) throw new Error('先 start 记录处理阶段，再 submit 填写修改与测试证据');
    issue.status = 'submitted'; kind = 'submitted';
  } else {
    if (issue.blocking || issue.status === 'resolved') throw new Error('阻断问题不得延期；已关闭的问题不能改成延期');
    issue.status = 'deferred'; kind = 'deferred';
  }
  issue.actions.push({id: actionId, at, actor, kind, from, to: next.status, reason: input.reason, evidence: input.evidence ?? ''});
  next.updated = at;
  return next;
}

export function beginRun(state: TaskState, id: string, at: string): TaskState {
  checkSubmission(state);
  if (state.status !== 'VERIFYING') throw new Error('先把任务推进到 VERIFYING；验证不能绕过实际阶段');
  const next = structuredClone(state), w = next.workflow ??= emptyWorkflow();
  w.runs.push({id, started_at: at, outcome: 'incomplete'}); w.active_run = id; w.latest_run = id; next.updated = at;
  return next;
}
export function finishRun(state: TaskState, id: string, verdict: Verdict, criteria: string[], actor: string, at: string, file: string): TaskState {
  if (state.workflow?.active_run !== id) throw new Error('验证已取消或任务已切换，不能用迟到的结果覆盖当前任务');
  const next = structuredClone(state), w = next.workflow!, run = w.runs.find(r => r.id === id)!;
  delete w.active_run; run.finished_at = at; run.outcome = verdict.status; run.summary = verdict.summary.slice(0, 2000); run.file = file;
  for (const result of verdict.issue_results ?? []) {
    const issue = w.issues.find(i => i.id === result.issue_id && i.status === 'submitted');
    if (!issue || verdict.criteria_errors?.length || verdict.issue_errors?.length || verdict.snapshot_error) continue;
    issue.status = result.result === 'resolved' ? 'resolved' : 'open';
    issue.actions.push({id: `${id}:${issue.id}`, at, actor, kind: result.result === 'resolved' ? 'resolved' : 'unresolved',
      from: next.status, to: next.status, reason: result.result === 'resolved' ? '独立复验确认' : '独立复验未确认修复', evidence: result.evidence, run_id: id});
  }
  const add = (key: string, description: string, evidence: string, severity: Severity, blocking: boolean, criterion_id?: string) => {
    const existing = criterion_id && w.issues.find(i=>i.criterion_id===criterion_id && i.status!=='resolved');
    if (existing) {
      existing.status = 'open';
      existing.actions.push({id:`${id}:${key}:reported`,at,actor,kind:'unresolved',from:next.status,to:next.status,
        reason:'同一验收标准仍未通过',evidence:evidence.slice(0,4000),run_id:id});
      return;
    }
    w.issues.push({id: `${id}:${key}`, source: 'verification', source_run: id, ...(criterion_id ? {criterion_id} : {}),
      severity, blocking, description: description.slice(0, 2000), evidence: evidence.slice(0, 4000), status: 'open',
      actions: [{id: `${id}:${key}:reported`, at, actor, kind: 'reported', from: next.status, to: next.status, reason: description.slice(0, 2000), evidence: evidence.slice(0, 4000), run_id: id}]});
  };
  verdict.findings.forEach((f, i) => add(`F${i+1}`, f.reason, f.evidence, f.severity, f.severity === 'blocking'));
  const entries = criterionEntries(criteria);
  for (const [i, result] of (verdict.criteria_results ?? []).entries()) if (result.result !== 'met') {
    const c = entries.find(c => c.id === result.criterion_id);
    add(`C${i+1}`, c?.text ?? result.criterion ?? '验收标准未满足', result.evidence, 'blocking', true, c?.id);
  }
  if (verdict.status !== 'approve' && !w.issues.some(i => i.status === 'open' && i.blocking)) {
    add('decision', verdict.summary, (verdict.unverified ?? verdict.criteria_errors ?? []).join('\n'), 'blocking', true);
  }
  next.artifacts.verification = file; next.updated = at;
  return next;
}
