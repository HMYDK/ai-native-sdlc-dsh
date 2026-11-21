import type {Context} from '@deepseek-ai/cordis';
import {JSON_SCHEMA, load} from 'js-yaml';
import {resolve} from 'node:path';
import {parseSpecAcceptance, specHash} from '../shared/acceptance.js';
import {reviewWorkspace} from '../task/spec-review.js';
import {parseTaskState} from '../task/state.js';
import {object} from './analysis.js';
import {observeDelivery, SESSION_BYTES} from './delivery.js';
import {elapsed, observeReviews, type FindingObservation, type ReportGap} from './reviews.js';
import {cwdOf, message, safeSegment, type Execution, type Store} from './store.js';
import type {TaskManifest} from './tasks.js';

type Reviews = Awaited<ReturnType<typeof observeReviews>>;
type Delivery = Awaited<ReturnType<typeof observeDelivery>>;

async function matchingCheckpoints(task: TaskManifest, delivery: Delivery, store: Store, gap: ReportGap) {
  const run = delivery.verification;
  if (!run?.acceptance) return [];
  const checkpoints = [];
  const folder = 'tasks/' + task.task_id + '/checkpoints/';
  for (const checkpoint of task.checkpoints) {
    const file = folder + safeSegment(checkpoint) + '.json';
    try {
      const value = object(await store.read(file, SESSION_BYTES));
      const state = object(value.state), code = object(value.code);
      if (state.task !== task.task_id) throw new Error('任务快照归属不符');
      if (object(state.workflow).latest_run !== run.run_id) continue;
      const spec = object(object(value.artifacts).spec);
      if (object(state.acceptance).id !== run.acceptance.id || typeof spec.content !== 'string'
          || specHash(spec.content) !== run.acceptance.spec_sha256) throw new Error('阶段的 Spec 快照与验证版本不符');
      if (code.complete !== true || typeof code.fingerprint !== 'string') throw new Error('阶段代码快照不完整');
      checkpoints.push({path: store.root + '/' + file, stage: state.status, at: value.at,
        code_snapshot_fingerprint: code.fingerprint, git_head: typeof code.head === 'string' ? code.head : null});
    } catch (error) {gap('checkpoint', store.root + '/' + file, message(error));}
  }
  if (!checkpoints.length) gap('verification_checkpoint', store.root + '/' + folder, '最终验证缺少同轮次且版本匹配的阶段快照');
  return checkpoints;
}

function findingDelivery(finding: FindingObservation, reviews: Reviews, delivery: Delivery, gap: ReportGap) {
  const run = delivery.verification;
  const last = finding.follow_ups.findLast(step => step.follow_up !== null);
  const criterionId = finding.introduced.criterion_id;
  if (finding.status !== 'addressed' || !last) return {status: 'unlinked'};
  const reviewed = reviews.chain.findIndex(entry => entry.record.review_id === last.review_id);
  if (criterionId && run?.spec_review && reviewed >= 0 && reviewed <= delivery.reviewIndex
      && last.spec_revision?.acceptance?.changed.includes(criterionId)) {
    const revised = parseSpecAcceptance(reviews.chain[reviewed].record.inputs.spec.content).find(c => c.id === criterionId);
    const verified = delivery.criteria.find(c => c.id === criterionId);
    if (revised && verified && revised.text === verified.text) {
      const outcomes = delivery.outcomes.filter(outcome => outcome.criterion_ids.includes(criterionId))
        .map(outcome => ({outcome_ref: outcome.outcome_ref, oracle_refs: outcome.oracles.map(oracle => oracle.oracle_ref), status: outcome.status}));
      if (!outcomes.length) gap('finding_outcome_link', last.record_path, '验收条款缺少明确的 Outcome 映射：' + criterionId);
      return {status: 'linked', criterion_id: criterionId, linkage: 'explicit_criterion_id_and_version',
        verification_run_id: run.run_id, verification_path: run.record_path, outcome_link: outcomes.length ? 'linked' : 'unlinked',
        criterion_result: run.criteria_results.find(result => result.criterion_id === criterionId) ?? null,
        outcomes};
    }
  }
  gap('finding_delivery_link', last.record_path, '无法确定同版验收条款与最终验证的关联：' + finding.finding_id);
  return {status: 'unlinked'};
}

/** Each task-scoped assistant settlement contributes at most one reported usage record. */
async function taskUsage(task: TaskManifest, reviews: Reviews, store: Store, gap: ReportGap) {
  const sessions = new Map(task.sessions.map(s => [s.id, s.role as string]));
  for (const round of reviews.observations.rounds) {
    for (const id of round.reviewer_sessions) sessions.set(id, 'spec_reviewer');
  }
  const summaries = [];
  for (const [id, role] of sessions) {
    let calls = 0, reported = 0, unknown = 0, input = 0, output = 0, total = 0, exact = 0;
    let complete = false;
    const file = 'tasks/' + task.task_id + '/sessions/' + id + '.json';
    try {
      safeSegment(id);
      const snapshot = object(await store.read(file, SESSION_BYTES));
      if (snapshot.session_id !== id || !Array.isArray(snapshot.events)) throw new Error('会话快照归属或事件不符');
      const inherited = snapshot.inherited_event_count;
      complete = snapshot.source_verified === true && snapshot.truncated === false && snapshot.events.length > 0
        && typeof inherited === 'number' && Number.isSafeInteger(inherited) && inherited >= 0;
      if (!complete) gap('session_incomplete', store.root + '/' + file, '会话缺失、截断或尚未与原始日志对账');
      const seen = new Set<number>();
      let invalidSequence = false;
      for (const raw of snapshot.events) {
        const event = object(raw);
        if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue;
        const seq = event.seq;
        if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || seen.has(seq)) {
          invalidSequence = true;
          continue;
        }
        if (typeof inherited === 'number' && seq < inherited) continue;
        seen.add(seq);
        calls++;
        const data = object(event.data);
        // A failed assistant attempt may retain its final usage chunk in the durable stream.
        const usage = object(data.usage ?? (Array.isArray(data.stream) ? data.stream.map(r => object(object(r).chunk))
          .findLast(chunk => chunk.type === 'usage')?.usage : undefined));
        const valid = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
        if (valid(usage.inputTokens) && valid(usage.outputTokens)) {
          reported++;
          input += usage.inputTokens;
          output += usage.outputTokens;
        } else unknown++;
        if (valid(usage.totalTokens)) {exact++;total += usage.totalTokens;}
      }
      if (invalidSequence) {
        complete = false;
        gap('session_event_identity', store.root + '/' + file, '模型调用的会话事件序号损坏或重复');
      }
    } catch (error) {gap('session_unavailable', store.root + '/' + file, message(error));}
    summaries.push({session_id: id, role, calls_observed: calls, calls_without_usage: unknown,
      input_tokens_observed: reported ? input : null, output_tokens_observed: reported ? output : null,
      total_tokens_observed: exact ? total : null, total_tokens: complete && calls > 0 && exact === calls ? total : null});
  }
  const known = summaries.filter(s => s.total_tokens_observed !== null);
  return {
    sessions: summaries,
    observed_total_tokens: known.length ? known.reduce((sum, s) => sum + s.total_tokens_observed!, 0) : null,
    total_tokens: summaries.length && summaries.every(s => s.total_tokens !== null)
      ? summaries.reduce((sum, s) => sum + s.total_tokens!, 0) : null,
    monetary_cost: null,
  };
}

export async function observeTask(ctx: Context, exec: Execution, task: TaskManifest, taskEvidence: unknown, store: Store) {
  const dir = resolve(cwdOf(exec), task.task_dir);
  const workspace = reviewWorkspace(ctx, exec, dir);
  const gaps: {kind: string; path: string; detail: string}[] = [];
  const gap: ReportGap = (kind, path, detail) => {gaps.push({kind, path, detail: detail.slice(0, 1500)});};
  const stateSnapshot = await workspace.task('state.yaml');
  const raw = load(stateSnapshot.content, {schema: JSON_SCHEMA});
  if (object(raw).task !== undefined && object(raw).task !== task.task_id) throw new Error('任务 state.yaml 与登记 ID 不一致');
  const state = parseTaskState(task.task_id, raw);
  const issues = object(taskEvidence).issues;
  if (Array.isArray(issues)) for (const issue of issues) {
    if (typeof issue === 'string') gap('task_capture', store.root + '/tasks/' + task.task_id + '/evidence.json', issue);
  }
  const reviews = await observeReviews(ctx, exec, dir, state, gap);
  const delivery = await observeDelivery(workspace, state, reviews, store, gap);
  const checkpoints = await matchingCheckpoints(task, delivery, store, gap);
  const rounds = reviews.observations.rounds;
  const verifications = state.workflow?.runs ?? [];
  const finding_lifecycle = reviews.findings.map(finding => ({...finding, delivery: findingDelivery(finding, reviews, delivery, gap)}));
  const usage = await taskUsage(task, reviews, store, gap);
  const complete = gaps.length === 0 && state.status === 'DONE' && !!delivery.verification?.record_path
    && reviews.observations.chain_status === 'anchored' && reviews.observations.current_inputs === 'match'
    && rounds.every(round => round.outcome !== 'running') && reviews.observations.unresolved_finding_ids?.length === 0
    && delivery.outcomes.length > 0 && delivery.outcomes.every(outcome => outcome.status !== 'unverified');
  return {
    spec_review_observations: reviews.observations,
    finding_lifecycle,
    delivery_evidence: {task_state: {path: stateSnapshot.path, sha256: stateSnapshot.sha256, status: state.status},
      verification: delivery.verification, outcomes: delivery.outcomes, checkpoints, evidence_complete: complete},
    observed_cost: {
      spec_review_rounds: reviews.observations.status === 'not_observed' ? null : rounds.length,
      spec_follow_up_rounds: reviews.observations.status === 'not_observed' ? null
        : rounds.filter(round => round.previous_review !== null || round.requested_previous_review !== null).length,
      verification_rounds: state.workflow ? verifications.length : null,
      spec_reviews: rounds.map(({review_id, duration_ms, reviewer_sessions}) => ({review_id, duration_ms, reviewer_sessions})),
      verifications: verifications.map(run => ({run_id: run.id, duration_ms: elapsed(run.started_at, run.finished_at)})),
      task_recorded_elapsed_ms: elapsed(state.created, state.updated),
      ...usage,
    },
    evidence_gaps: gaps,
    attribution: 'observational',
  };
}
