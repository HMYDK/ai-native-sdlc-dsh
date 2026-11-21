/** On-disk review protocol shared by the producer and the task gate. */
import {
  activeFindings, object, parseResponses, parseSpecReview, SOURCE_KINDS, text, textHash,
  type AuthorResponse, type ReviewSource, type SpecFinding, type SpecReview,
} from '../verify/spec-review.js';
import type {VerificationRecord} from '../verify/recording.js';

export const REVIEW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
export const REVIEW_INPUT_BYTES = 256 * 1024;
export const REVIEW_RECORD_BYTES = 2 * 1024 * 1024;
export const REVIEW_HISTORY_BYTES = 16 * 1024 * 1024;
export const REVIEW_HISTORY_FILES = 128;

export interface SpecReviewRef {version: 1; id: string; sha256: string}
export interface Snapshot {path: string; content: string; sha256: string}
export type SourceInput = Pick<ReviewSource, 'path' | 'origin' | 'kind'>;
export interface ReviewInputs {
  state: Snapshot;
  intent: Snapshot;
  spec: Snapshot;
  sources: ReviewSource[];
  source_manifest?: Snapshot;
  previous_review?: string;
  previous_review_sha256?: string;
  previous_findings: SpecFinding[];
  responses: AuthorResponse[];
}
export interface ReviewRecord {
  schema_version: 1 | 2;
  task: string;
  review_id: string;
  review_file: string;
  started_at: string;
  finished_at?: string;
  review_complete: boolean;
  outcome: 'running' | 'completed' | 'incomplete' | 'cancelled';
  reviewer_fingerprint: string;
  requested_model: string | null;
  inputs?: ReviewInputs;
  raw_result?: unknown;
  review?: SpecReview;
  active_findings?: SpecFinding[];
  reviewer_session?: string;
  diagnostic?: string;
  events: {at: string; kind: VerificationRecord['kind']; data: Record<string, unknown>}[];
}

export type CompletedReview = ReviewRecord & {
  inputs: ReviewInputs;
  review: SpecReview;
  active_findings: SpecFinding[];
};
export const sameJSON = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
export const reviewFilename = (id: string): string => `spec-reviews/${id}.json`;

export function parseSpecReviewRef(raw: unknown): SpecReviewRef {
  const ref = object(raw, 'spec_review');
  if (ref.version !== 1 || typeof ref.id !== 'string' || !REVIEW_ID.test(ref.id)
      || typeof ref.sha256 !== 'string' || !SHA256.test(ref.sha256)) {
    throw new Error('任务的 SPEC 审查引用损坏，请恢复实际审查记录和引用');
  }
  return {version: 1, id: ref.id, sha256: ref.sha256};
}

export function workspacePath(raw: unknown): string {
  const file = text(raw, '工作区路径', 2000);
  if (file.includes('\\') || /^[A-Za-z]:/.test(file) || file.split('/').some(part => !part || part === '..' || part === '.')) {
    throw new Error('输入文件必须是规范的工作区内相对路径');
  }
  return file;
}

export function sourceInputs(raw: unknown): SourceInput[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) {
    throw new Error('sources 需要 1–8 个原文文件，包含至少一份 original');
  }
  const inputs = raw.map(value => {
    const source = object(value, 'source');
    if (Object.keys(source).some(key => !['path', 'origin', 'kind'].includes(key))) throw new Error('source 含未知字段');
    const kind = source.kind as SourceInput['kind'];
    if (!SOURCE_KINDS.includes(kind)) throw new Error('source.kind 必须是 original / clarification / author_inference');
    return {path: workspacePath(source.path), origin: text(source.origin, 'source.origin', 2000), kind};
  });
  if (!inputs.some(source => source.kind === 'original')) throw new Error('至少需要一份 original 原始需求，作者推断不能代替它');
  if (new Set(inputs.map(source => source.path)).size !== inputs.length) throw new Error('sources 不能重复引用同一个路径');
  return inputs;
}

export function sourceDescriptor({path, origin, kind}: SourceInput): SourceInput {
  return {path, origin, kind};
}

export function reviewInputIdentity(inputs: Pick<ReviewInputs, 'intent' | 'spec' | 'source_manifest' | 'sources'>) {
  const identity = ({path, sha256}: Snapshot) => ({path, sha256});
  return {
    intent: identity(inputs.intent),
    spec: identity(inputs.spec),
    manifest: inputs.source_manifest && identity(inputs.source_manifest),
    sources: inputs.sources.map(source => ({...sourceDescriptor(source), sha256: source.sha256})),
  };
}

export function assertReviewPredecessor(current: CompletedReview, previous?: {record: CompletedReview; snapshot: Pick<Snapshot, 'sha256'>}): void {
  if (current.inputs.previous_review !== previous?.record.review_id
      || !sameJSON(current.inputs.previous_findings, previous?.record.active_findings ?? [])
      || (current.schema_version === 2 && current.inputs.previous_review_sha256 !== previous?.snapshot.sha256)) {
    throw new Error('复审链与前轮记录或未解决发现不一致');
  }
}

function checkSnapshot(raw: unknown): void {
  const snap = object(raw, '输入快照');
  workspacePath(snap.path);
  if (typeof snap.content !== 'string' || snap.sha256 !== textHash(snap.content)) throw new Error('输入快照指纹与内容不符');
}

export function parseCompletedReview(raw: unknown, task: string, id: string, file: string): CompletedReview {
  const doc = object(raw, 'SPEC 审查记录') as unknown as ReviewRecord;
  const terminal = Array.isArray(doc.events) ? doc.events.at(-1) : undefined;
  if (!REVIEW_ID.test(id) || ![1, 2].includes(doc.schema_version) || doc.task !== task || doc.review_id !== id
      || doc.review_file !== file || doc.outcome !== 'completed' || doc.review_complete !== true || !doc.finished_at
      || !doc.inputs || !Array.isArray(doc.active_findings) || typeof doc.reviewer_session !== 'string'
      || !doc.reviewer_session || !Array.isArray(doc.events)
      || !doc.events.some(event => event?.kind === 'attempt_session' && event.data?.session_id === doc.reviewer_session)
      || terminal?.kind !== 'finished' || terminal.data?.outcome !== 'completed' || terminal.data?.review_complete !== true
      || (doc.schema_version === 2 && !doc.events.some(event => event?.kind === 'attempt_finished'
        && event.data?.session_id === doc.reviewer_session && event.data?.stopReason === 'completed'))) {
    throw new Error('记录不是本任务完整的独立 SPEC 审查');
  }
  const inputs = checkReviewInputs(doc);
  const review = parseSpecReview(doc.raw_result, inputs.sources, inputs.previous_findings, id);
  if (!sameJSON(doc.review, review) || !sameJSON(doc.active_findings, activeFindings(review, inputs.previous_findings))) {
    throw new Error('已保存的结果与重新解析的发现或收口状态不一致');
  }
  return doc as CompletedReview;
}

/** Failed attempts may predate input preparation. Their available snapshots use the same protocol. */
export function parseReviewAttempt(raw: unknown, task: string, id: string, file: string): ReviewRecord {
  const doc = object(raw, 'SPEC 审查记录') as unknown as ReviewRecord;
  if (doc.outcome === 'completed') return parseCompletedReview(raw, task, id, file);
  if (!REVIEW_ID.test(id) || ![1, 2].includes(doc.schema_version) || doc.task !== task || doc.review_id !== id
      || doc.review_file !== file || doc.review_complete !== false || !Array.isArray(doc.events)
      || doc.review !== undefined || doc.active_findings !== undefined
      || !['running', 'incomplete', 'cancelled'].includes(doc.outcome)) {
    throw new Error('审查尝试的身份、版本或结果不一致');
  }
  const terminal = doc.events.at(-1);
  if (doc.outcome !== 'running' && (terminal?.kind !== 'finished' || terminal.data?.outcome !== doc.outcome
      || terminal.data?.review_complete !== false || !doc.finished_at)) throw new Error('审查尝试缺少对应的结束记录');
  if (doc.inputs !== undefined) checkReviewInputs(doc);
  return doc;
}

function checkReviewInputs(doc: ReviewRecord): ReviewInputs {
  const inputs = doc.inputs!;
  for (const snapshot of [inputs.state, inputs.intent, inputs.spec, ...(inputs.source_manifest ? [inputs.source_manifest] : [])]) {
    checkSnapshot(snapshot);
  }
  if (!Array.isArray(inputs.sources)) throw new Error('原文快照缺失');
  sourceInputs(inputs.sources.map(sourceDescriptor));
  inputs.sources.forEach((source, i) => {
    checkSnapshot(source);
    if (source.id !== `S${i + 1}`) throw new Error('原文快照编号不一致');
  });
  if (!Array.isArray(inputs.previous_findings) || inputs.previous_findings.length > 128
      || inputs.previous_findings.some(finding => typeof finding?.id !== 'string')) throw new Error('前轮发现不完整');
  if (inputs.previous_review === undefined) {
    if (inputs.previous_findings.length || inputs.previous_review_sha256 !== undefined) throw new Error('前轮引用缺失');
  } else if (typeof inputs.previous_review !== 'string' || !REVIEW_ID.test(inputs.previous_review) || inputs.previous_review === doc.review_id
      || (doc.schema_version === 2 && !SHA256.test(inputs.previous_review_sha256 ?? ''))) {
    throw new Error('前轮引用不合法');
  }
  parseResponses(inputs.responses, inputs.previous_findings);
  return inputs;
}
