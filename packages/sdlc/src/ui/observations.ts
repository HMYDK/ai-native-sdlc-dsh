/** Bounded display facts from RSI's existing version and provenance checks. */
import {join} from 'node:path';
import {observeDelivery, type DeliveryEvidenceReader, type OracleStatus} from '../rsi/delivery.js';
import {observeReviews} from '../rsi/reviews.js';
import {reviewWorkspace, type ReviewFileContext} from '../task/spec-review.js';
import {parseTaskState} from '../task/state.js';

export interface SpecReviewSummary {
  status: 'not_observed' | 'needs_inputs' | 'pending' | 'legacy' | 'open' | 'stale' | 'closed' | 'unavailable';
  unresolved: number | null;
  recordPath: string | null;
  incompleteHistory: boolean;
}
export interface DeliverySummary {
  status: OracleStatus;
  outcomes: {id: string; status: OracleStatus; oracles: {
    id: string; status: OracleStatus; exitCodes: number[]; evidencePath: string | null;
  }[]}[];
  truncated: boolean;
}

export async function readBoardObservations(
  ctx: ReviewFileContext,
  options: {repoRoot: string; taskId: string; taskDir: string; signal?: AbortSignal},
  rawState: unknown,
  reader: DeliveryEvidenceReader,
) {
  const {repoRoot, taskId, taskDir, signal} = options;
  const state = parseTaskState(taskId, rawState);
  const exec = {agent: {session: {header: {cwd: repoRoot}}}, signal};
  const dir = join(repoRoot, taskDir);
  const reviews = await observeReviews(ctx, exec, dir, state, () => {});
  const {chain_status, current_inputs, status: historyStatus, unresolved_finding_ids, selected_review, rounds} = reviews.observations;
  const unresolved = unresolved_finding_ids?.length ?? null;
  let status: SpecReviewSummary['status'] = 'not_observed';
  if (current_inputs === 'changed') status = 'stale';
  else if (chain_status === 'broken' || (chain_status === 'anchored' && current_inputs !== 'match')) status = 'unavailable';
  else if (chain_status === 'anchored') status = unresolved ? 'open' : 'closed';
  else if (historyStatus === 'incomplete') status = 'unavailable';
  else if (chain_status === 'legacy') status = 'legacy';
  else if (state.status === 'SPEC') status = state.artifacts.source && state.artifacts.intent && state.artifacts.spec ? 'pending' : 'needs_inputs';
  const specReview: SpecReviewSummary = {
    status,
    unresolved: chain_status === 'anchored' ? unresolved : null,
    recordPath: rounds.find(round => round.trusted_chain && round.review_id === selected_review?.id)?.record_path ?? null,
    incompleteHistory: historyStatus === 'incomplete',
  };
  const run = state.workflow?.latest_run;
  if (!run) return {specReview};

  const result = await observeDelivery(reviewWorkspace(ctx, exec, dir), state, reviews, reader, () => {});
  const outcomes: DeliverySummary['outcomes'] = result.outcomes.slice(0, 12).map(outcome => ({
    id: outcome.outcome_ref,
    status: outcome.status,
    oracles: outcome.oracles.slice(0, 8).map(oracle => ({
      id: oracle.oracle_ref,
      status: oracle.status,
      exitCodes: [...new Set(oracle.executions.map(execution => execution.exit_code))].slice(0, 8),
      evidencePath: oracle.evidence_path ?? null,
    })),
  }));
  const summary: DeliverySummary = {
    status: result.outcomes.some(outcome => outcome.status === 'failed') ? 'failed'
      : result.outcomes.length && result.outcomes.every(outcome => outcome.status === 'proven') ? 'proven' : 'unverified',
    outcomes,
    truncated: result.outcomes.length > outcomes.length || result.outcomes.some(outcome => outcome.oracles.length > 8),
  };
  return {specReview, delivery: {run, summary}};
}
