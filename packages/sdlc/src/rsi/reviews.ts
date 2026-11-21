import {parseSpecAcceptance, specHash} from '../shared/acceptance.js';
import {
  assertReviewPredecessor, parseReviewAttempt, REVIEW_HISTORY_BYTES, REVIEW_HISTORY_FILES,
  REVIEW_ID, REVIEW_RECORD_BYTES, reviewFilename, reviewInputIdentity, sameJSON,
  type CompletedReview, type ReviewRecord, type Snapshot,
} from '../shared/spec-review-record.js';
import {taskFile} from '../task/io.js';
import {readRegisteredReviewInputs, reviewWorkspace, type ReviewFileContext} from '../task/spec-review.js';
import type {TaskState} from '../task/state.js';
import type {SpecFinding, SpecFollowUp} from '../verify/spec-review.js';
import {object} from './analysis.js';
import {message, type Execution} from './store.js';

export type ReportGap = (kind: string, path: string, detail: string) => void;
type Entry = {record: ReviewRecord; snapshot: Pick<Snapshot, 'path' | 'sha256'>};
type CompletedEntry = Entry & {record: CompletedReview};
type ReviewId = {review_id: string; record_path: string; record_sha256: string};

const entryRef = ({record, snapshot}: Entry): ReviewId => ({
  review_id: record.review_id, record_path: snapshot.path, record_sha256: snapshot.sha256,
});
export const elapsed = (start: unknown, finish: unknown) => {
  if (typeof start !== 'string' || typeof finish !== 'string') return null;
  const ms = Date.parse(finish) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
};

function specAcceptance(spec: string) {
  try {
    const criteria = parseSpecAcceptance(spec);
    return {sha256: specHash(JSON.stringify(criteria)),
      criteria: criteria.map(({id, text}) => ({id, sha256: specHash(text)}))};
  } catch {return null;}
}

function revision(before: CompletedEntry, after: Entry) {
  const original = before.record.inputs.spec;
  const updated = after.record.inputs?.spec;
  if (!updated) return null;
  const a = original.content.split('\n'), b = updated.content.split('\n');
  let first = 0, lastA = a.length, lastB = b.length;
  while (first < Math.min(lastA, lastB) && a[first] === b[first]) first++;
  while (lastA > first && lastB > first && a[lastA - 1] === b[lastB - 1]) {lastA--; lastB--;}
  const oldAC = specAcceptance(original.content), newAC = specAcceptance(updated.content);
  return {
    before_spec_sha256: original.sha256, after_spec_sha256: updated.sha256,
    changed_line_span: original.sha256 === updated.sha256 ? null : {
      start_line: first + 1, before_lines: lastA - first, after_lines: lastB - first,
    },
    acceptance: oldAC && newAC ? {
      before_sha256: oldAC.sha256, after_sha256: newAC.sha256,
      added: newAC.criteria.filter(c => !oldAC.criteria.some(old => old.id === c.id)).map(c => c.id),
      removed: oldAC.criteria.filter(c => !newAC.criteria.some(next => next.id === c.id)).map(c => c.id),
      changed: newAC.criteria.filter(c => oldAC.criteria.some(old => old.id === c.id && old.sha256 !== c.sha256)).map(c => c.id),
    } : null,
  };
}

function reviewChain(completed: Map<string, CompletedEntry>, state: TaskState): CompletedEntry[] {
  if (!completed.size && !state.spec_review) return [];
  const selected = state.spec_review;
  const referenced = new Set([...completed.values()].map(e => e.record.inputs.previous_review));
  const legacyHeads = [...completed.keys()].filter(id => !referenced.has(id));
  if (!selected && (legacyHeads.length !== 1 || [...completed.values()].some(e => e.record.schema_version !== 1))) {
    throw new Error('完成审查缺少唯一的有效链尾');
  }
  let id: string | undefined = selected?.id ?? legacyHeads[0];
  const head = id ? completed.get(id) : undefined;
  if (selected && (head?.snapshot.sha256 !== selected.sha256 || head.record.schema_version !== 2)) {
    throw new Error('任务登记的审查缺失或指纹不符');
  }
  const chain: CompletedEntry[] = [], visited = new Set<string>();
  while (id !== undefined) {
    const entry = completed.get(id);
    if (!entry || visited.has(id)) throw new Error('审查链有缺失或循环');
    chain.push(entry);
    visited.add(id);
    id = entry.record.inputs.previous_review;
    assertReviewPredecessor(entry.record, id === undefined ? undefined : completed.get(id));
  }
  if (!selected && visited.size !== completed.size) throw new Error('未登记的历史审查链不连续');
  return chain.reverse();
}

function roundSummary(entry: Entry, trusted: boolean) {
  const {record} = entry, inputs = record.inputs;
  const started = record.events.find(event => event?.kind === 'started');
  const attempted = record.events.filter(event => event?.kind === 'attempt_session' && typeof event.data?.session_id === 'string');
  const reviewerSessions = [...new Set(attempted.map(event => event.data.session_id as string))];
  const requested = object(started?.data?.inputs).previous_review;
  return {
    ...entryRef(entry),
    task_id: record.task,
    outcome: record.outcome,
    trusted_chain: trusted,
    started_at: record.started_at,
    finished_at: record.finished_at ?? null,
    duration_ms: elapsed(record.started_at, record.finished_at),
    previous_review: inputs?.previous_review ?? null,
    previous_review_sha256: inputs?.previous_review_sha256 ?? null,
    requested_previous_review: typeof requested === 'string' && REVIEW_ID.test(requested) ? requested : null,
    author_session: typeof started?.data?.author_session === 'string' ? started.data.author_session : null,
    reviewer_session: typeof record.reviewer_session === 'string' ? record.reviewer_session : reviewerSessions.at(-1) ?? null,
    reviewer_sessions: reviewerSessions,
    diagnostic: typeof record.diagnostic === 'string' ? record.diagnostic.slice(0, 1500) : null,
    structured_result_received: record.raw_result !== undefined,
    ...(record.review ? {result: {
      summary: record.review.summary, finding_ids: record.review.findings.map(f => f.id),
      follow_up: record.review.follow_up.map(({finding_id, result}) => ({finding_id, result})),
      limitations: record.review.limitations,
    }} : {}),
    input_versions: inputs ? {
      state: {path: inputs.state.path, sha256: inputs.state.sha256},
      ...reviewInputIdentity(inputs),
      acceptance: specAcceptance(inputs.spec.content),
      sources: inputs.sources.map(({id, path, origin, kind, sha256}) => ({id, path, origin, kind, sha256})),
    } : null,
    responses: inputs?.responses ?? [],
  };
}

type FollowUpObservation = ReviewId & {
  outcome: ReviewRecord['outcome'];
  author_response: string;
  follow_up: SpecFollowUp | null;
  spec_revision: ReturnType<typeof revision>;
};

export type FindingObservation = Omit<SpecFinding, 'id'> & {
  finding_id: string;
  introduced: ReviewId & {source_path: string; source_sha256: string; spec_sha256: string; criterion_id: string | null};
  status: SpecFollowUp['result'] | 'unknown';
  follow_ups: FollowUpObservation[];
};

export async function observeReviews(ctx: ReviewFileContext, exec: Execution, dir: string, state: TaskState, gap: ReportGap) {
  const workspace = reviewWorkspace(ctx, exec, dir);
  const relative = workspace.prefix + '/spec-reviews';
  const entries: Entry[] = [], completed = new Map<string, CompletedEntry>();
  let scanIncomplete = false;
  try {
    const target = await taskFile(ctx, exec, dir, 'spec-reviews');
    const info = await ctx.fs.stat(target, exec.signal);
    if (info && info.type !== 'directory') throw new Error('审查记录路径不是目录');
    const files = info ? (await ctx.fs.listDir(target, exec.signal)).map(item => item.name).filter(name => name.endsWith('.json')).sort() : [];
    if (files.length > REVIEW_HISTORY_FILES) {
      scanIncomplete = true;
      gap('review_scan_limit', relative, '审查文件超过可读取上限，列表不完整');
    }
    let bytes = 0;
    for (const name of files.slice(0, REVIEW_HISTORY_FILES)) {
      const id = name.slice(0, -5), file = relative + '/' + name;
      try {
        if (!REVIEW_ID.test(id)) throw new Error('审查文件名不含合法 review_id');
        const snapshot = await workspace.task(reviewFilename(id), REVIEW_RECORD_BYTES);
        bytes += Buffer.byteLength(snapshot.content);
        if (bytes > REVIEW_HISTORY_BYTES) {
          scanIncomplete = true;
          gap('review_scan_limit', relative, '审查记录超过可读取字节上限，列表不完整');
          break;
        }
        const record = parseReviewAttempt(JSON.parse(snapshot.content), state.task, id, file);
        if (elapsed(record.started_at, record.finished_at ?? record.started_at) === null) throw new Error('审查时间无效');
        if (record.inputs && (record.inputs.state.path !== workspace.prefix + '/state.yaml'
            || !record.inputs.spec.path.startsWith(workspace.prefix + '/')
            || !record.inputs.intent.path.startsWith(workspace.prefix + '/'))) throw new Error('审查输入快照归属不符');
        const entry = {record, snapshot: {path: snapshot.path, sha256: snapshot.sha256}};
        entries.push(entry);
        if (record.outcome === 'completed') completed.set(id, entry as CompletedEntry);
      } catch (error) {
        scanIncomplete = true;
        gap('invalid_review_record', file, message(error));
      }
    }
  } catch (error) {
    scanIncomplete = true;
    gap('review_directory', relative, message(error));
  }
  let chain: CompletedEntry[] = [], broken = false;
  try {chain = reviewChain(completed, state);}
  catch (error) {broken = true; gap('review_chain', relative, message(error));}
  const selected = chain.at(-1), trusted = new Map(chain.map(e => [e.record.review_id, e]));
  for (const entry of completed.values()) {
    if (!trusted.has(entry.record.review_id)) gap('unlinked_review', entry.snapshot.path, '完成记录未进入可信审查链');
  }

  let currentInputs: 'match' | 'changed' | 'unknown' = 'unknown';
  if (selected) {
    try {
      const current = await readRegisteredReviewInputs(ctx, exec, dir, state);
      currentInputs = sameJSON(reviewInputIdentity(current), reviewInputIdentity(selected.record.inputs))
        && (!state.acceptance || state.acceptance.spec_sha256 === current.spec.sha256) ? 'match' : 'changed';
      if (currentInputs === 'changed') gap('review_input_drift', selected.snapshot.path, '当前 Source、Intent、Spec 或 AC 登记与链尾版本不同');
    } catch (error) {gap('review_inputs_unavailable', selected.snapshot.path, message(error));}
  }

  entries.sort((a, b) => a.record.started_at.localeCompare(b.record.started_at) || a.record.review_id.localeCompare(b.record.review_id));
  const findings = new Map<string, FindingObservation>();
  for (const entry of completed.values()) {
    const inputs = entry.record.inputs;
    const criteria = specAcceptance(inputs.spec.content)?.criteria ?? [];
    for (const {id, ...finding} of entry.record.review.findings) {
      const source = inputs.sources.find(s => s.id === finding.source_id)!;
      findings.set(id, {...finding, finding_id: id, introduced: {
        ...entryRef(entry), source_path: source.path, source_sha256: source.sha256, spec_sha256: inputs.spec.sha256,
        criterion_id: criteria.some(c => c.id === finding.spec_reference) ? finding.spec_reference : null,
      }, status: trusted.has(entry.record.review_id) ? 'open' : 'unknown', follow_ups: []});
    }
  }
  // Apply only anchored follow-ups in chain order. Attempts preserve the author's response without changing status.
  for (const entry of [...chain, ...entries.filter(e => e.record.outcome !== 'completed')]) {
    const record = entry.record, inputs = record.inputs;
    if (!inputs?.previous_review) continue;
    const previous = trusted.get(inputs.previous_review);
    if (!previous || !sameJSON(inputs.previous_findings, previous.record.active_findings)
        || (record.schema_version === 2 && inputs.previous_review_sha256 !== previous.snapshot.sha256)) {
      gap('attempt_predecessor', entry.snapshot.path, '尝试的前轮记录或待处理发现无法核对');
      continue;
    }
    const specRevision = revision(previous, entry);
    for (const response of inputs.responses) {
      const finding = findings.get(response.finding_id);
      if (!finding) continue;
      const followUp = record.review?.follow_up.find(f => f.finding_id === response.finding_id) ?? null;
      finding.follow_ups.push({...entryRef(entry), outcome: record.outcome, author_response: response.response,
        follow_up: followUp, spec_revision: specRevision});
      if (followUp) finding.status = followUp.result;
    }
  }
  const order = new Map(entries.map((entry, index) => [entry.record.review_id, index]));
  for (const finding of findings.values()) finding.follow_ups.sort((a, b) => order.get(a.review_id)! - order.get(b.review_id)!);
  const rounds = entries.map(e => roundSummary(e, trusted.has(e.record.review_id)));
  return {
    chain, findings: [...findings.values()], currentInputs,
    observations: {
      status: scanIncomplete || broken ? 'incomplete' : rounds.length ? 'observed' : 'not_observed',
      chain_status: broken ? 'broken' : selected ? state.spec_review ? 'anchored' : 'legacy' : 'unobserved',
      current_inputs: currentInputs, selected_review: state.spec_review ?? null,
      source_authenticity: 'caller_supplied',
      rounds,
      unresolved_finding_ids: selected?.record.active_findings.map(f => f.id) ?? (rounds.length || broken ? null : []),
    },
  };
}
