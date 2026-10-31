import type {Context} from '@deepseek-ai/cordis';
import type {TaskState} from './state.js';
import {taskFile, type TaskExec} from './io.js';
import {captureBinding, type VerificationBinding} from './binding.js';
import {enforceCriteriaPolicy, type Verdict} from '../verify/verdict.js';
import {requireIdle} from './flow.js';
export interface TaskVerification {
  schema_version: 2; task: string; at: string; criteria: string[];
  verdict: Verdict; raw_verdict: Verdict; binding: VerificationBinding;
  intent_of_change: string; test_evidence?: string;
}
export async function checkApproval(ctx: Context, exec: TaskExec, dir: string, state: TaskState, completing: boolean): Promise<void> {
  requireIdle(state);
  const w = state.workflow, run = w?.runs.find(r => r.id === w.latest_run);
  if (!run?.file || run.outcome !== 'approve') throw new Error('没有可用于推进的最新独立验证通过记录；失败、旧版无版本记录或中断的验证需要重新提交');
  const target = await taskFile(ctx, exec, dir, run.file);
  let doc: TaskVerification;
  try {doc = JSON.parse(await ctx.fs.readText(target, exec.signal)) as TaskVerification;}
  catch {throw new Error('验证裁决损坏或缺失，不能推进');}
  if (doc.schema_version !== 2 || doc.task !== state.task || doc.verdict?.verification_run_id !== run.id
    || !Array.isArray(doc.criteria) || !doc.criteria.every(c => typeof c === 'string') || !Array.isArray(doc.verdict?.findings)
    || !Array.isArray(doc.verdict?.criteria_results) || doc.binding?.version !== 1 || !Array.isArray(doc.binding.roots)) throw new Error('验证裁决归属、标准覆盖或版本记录不完整');
  const verdict = enforceCriteriaPolicy(doc.verdict, doc.criteria, doc.verdict.verifier_session, 'ids');
  if (verdict.status !== 'approve' || verdict.criteria_errors?.length || verdict.issue_errors?.length || verdict.snapshot_error) throw new Error('独立验证未通过或结果不完整，不能推进');
  const unresolved = w!.issues.filter(i => !['resolved','deferred'].includes(i.status) && (completing || i.blocking));
  if (unresolved.length) throw new Error('问题尚未处理或复验确认：' + unresolved.map(i => i.id).join(', '));
  const artifacts = Object.fromEntries(Object.entries(state.artifacts).map(([key,file]) => [key,`${dir}/${file}`]));
  const current = await captureBinding(ctx, exec, artifacts, doc.binding.roots);
  if (current.fingerprint !== doc.binding.fingerprint) throw new Error('代码或需求/计划已在验证后变化，旧 approve 已失效；请登记返工并重新验证');
}
