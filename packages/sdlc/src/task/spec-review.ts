/** The state-selected review and the registered inputs are checked at every protected entry. */
import path from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import {requireSessionCwd, resolveOptions} from '../shared/helpers.js';
import {
  parseCompletedReview, REVIEW_ID, REVIEW_INPUT_BYTES, REVIEW_RECORD_BYTES, reviewFilename, sameJSON,
  sourceDescriptor, sourceInputs, workspacePath, type CompletedReview, type Snapshot, type SpecReviewRef,
} from '../shared/spec-review-record.js';
import {textHash, type ReviewSource} from '../verify/spec-review.js';
import {taskFile, type TaskExec} from './io.js';
import type {TaskState} from './state.js';

export const DEFAULT_SOURCE_ORIGIN = '任务登记的 source 文件。出处与确认信息见原文，来源未经插件认证';
type LoadedReview = {record: CompletedReview; snapshot: Snapshot};
type ReadTaskFile = (relative: string, limit?: number) => Promise<Snapshot>;

export function reviewWorkspace(ctx: Context, exec: TaskExec, dir: string) {
  const root = requireSessionCwd(exec, 'SPEC 审查');
  const prefix = workspacePath(path.relative(root, dir).split(path.sep).join('/'));
  const read = async (file: string, limit = REVIEW_INPUT_BYTES): Promise<Snapshot> => {
    workspacePath(file);
    const workspace = await ctx.fs.resolve(root, resolveOptions(exec));
    const target = await ctx.fs.resolve(`${root}/${file}`, resolveOptions(exec));
    if (!ctx.fs.contains(workspace, target)) throw new Error(`审查输入越出工作区：${file}`);
    const before = await ctx.fs.stat(target, exec.signal);
    if (!before || before.type !== 'file' || (before.size ?? 0) > limit) {
      throw new Error(`审查文件不存在、不是文件或超过 ${limit} 字节：${file}`);
    }
    const content = await ctx.fs.readText(target, exec.signal);
    const after = await ctx.fs.stat(target, exec.signal);
    if (!after || after.type !== 'file' || after.version !== before.version) throw new Error(`读取期间审查文件变化：${file}`);
    if (Buffer.byteLength(content) > limit) throw new Error(`审查文件超过 ${limit} 字节：${file}`);
    return {path: file, content, sha256: textHash(content)};
  };
  const task: ReadTaskFile = async (file, limit) => {
    await taskFile(ctx, exec, dir, file);
    return read(`${prefix}/${file}`, limit);
  };
  return {read, task, prefix};
}

/** A manifest augments the registered original. A tool argument cannot replace this list. */
export async function readRegisteredReviewInputs(ctx: Context, exec: TaskExec, dir: string, state: TaskState) {
  const workspace = reviewWorkspace(ctx, exec, dir);
  const {source, intent, spec, spec_sources: manifest} = state.artifacts;
  if (!source) throw new Error('任务未登记原始 source 文件。请在进入 SPEC 时登记 source，再执行独立审查');
  if (!intent || !spec) throw new Error('任务未登记 Intent 或 Spec，无法核对审查输入');
  const original = `${workspace.prefix}/${source}`;
  await taskFile(ctx, exec, dir, source);
  const sourceManifest = manifest ? await workspace.task(manifest) : undefined;
  const declared = sourceInputs(sourceManifest
    ? JSON.parse(sourceManifest.content)
    : [{path: original, kind: 'original', origin: DEFAULT_SOURCE_ORIGIN}]);
  if (!declared.some(entry => entry.path === original && entry.kind === 'original')) {
    throw new Error('spec_sources 必须完整列出已登记 source，且该文件的 kind 必须为 original');
  }
  const sources: ReviewSource[] = [];
  for (const [i, input] of declared.entries()) {
    const snapshot = await workspace.read(input.path);
    if (!snapshot.content.trim()) throw new Error(`来源文件为空：${input.path}`);
    sources.push({...snapshot, ...input, id: `S${i + 1}`});
  }
  const intentSnapshot = await workspace.task(intent);
  const specSnapshot = await workspace.task(spec);
  const bytes = [intentSnapshot, specSnapshot, ...sources, ...(sourceManifest ? [sourceManifest] : [])]
    .reduce((sum, snapshot) => sum + Buffer.byteLength(snapshot.content), 0);
  if (bytes > REVIEW_INPUT_BYTES) throw new Error('审查输入超过 256 KiB，请拆分任务或资料');
  return {intent: intentSnapshot, spec: specSnapshot, sources, ...(sourceManifest ? {source_manifest: sourceManifest} : {})};
}

function parseReviewFile(snapshot: Snapshot, task: string, id: string): LoadedReview {
  try {
    return {record: parseCompletedReview(JSON.parse(snapshot.content), task, id, snapshot.path), snapshot};
  } catch (error) {
    throw new Error(`请核对并恢复 SPEC 审查记录 ${snapshot.path}：${error instanceof Error ? error.message : String(error)}`);
  }
}

function verifyFollowUp(current: CompletedReview, previous: LoadedReview | undefined): void {
  if (current.inputs.previous_review !== previous?.record.review_id
      || !sameJSON(current.inputs.previous_findings, previous?.record.active_findings ?? [])
      || (current.schema_version === 2 && current.inputs.previous_review_sha256 !== previous?.snapshot.sha256)) {
    throw new Error('复审链与前轮记录或未解决发现不一致');
  }
}

async function loadAnchoredReview(read: ReadTaskFile, state: TaskState, ref: SpecReviewRef): Promise<LoadedReview> {
  const file = await read(reviewFilename(ref.id), REVIEW_RECORD_BYTES);
  if (file.sha256 !== ref.sha256) throw new Error('当前 SPEC 审查记录指纹与任务引用不符，请恢复记录');
  const loaded = parseReviewFile(file, state.task, ref.id);
  if (loaded.record.schema_version !== 2) throw new Error('旧版审查尚未补审，需回到 SPEC');
  const previous = loaded.record.inputs.previous_review;
  verifyFollowUp(loaded.record, previous
    ? parseReviewFile(await read(reviewFilename(previous), REVIEW_RECORD_BYTES), state.task, previous)
    : undefined);
  return loaded;
}

/** Only migration reads advisory history. It must form one unambiguous chain. */
async function readLegacyHead(ctx: Context, exec: TaskExec, dir: string, task: string): Promise<LoadedReview | undefined> {
  const folder = await taskFile(ctx, exec, dir, 'spec-reviews');
  const info = await ctx.fs.stat(folder, exec.signal);
  if (!info) return undefined;
  if (info.type !== 'directory') throw new Error('spec-reviews 不是目录，请恢复历史审查记录');
  const files = (await ctx.fs.listDir(folder, exec.signal)).map(entry => entry.name)
    .filter(name => name.endsWith('.json') && REVIEW_ID.test(name.slice(0, -5)));
  if (files.length > 128) throw new Error('历史审查过多，需人工核对并迁移审查链');
  const {task: read} = reviewWorkspace(ctx, exec, dir);
  const entries = new Map<string, LoadedReview>();
  let bytes = 0;
  for (const name of files) {
    const id = name.slice(0, -5);
    const snapshot = await read(reviewFilename(id), REVIEW_RECORD_BYTES);
    bytes += Buffer.byteLength(snapshot.content);
    if (bytes > 16 * 1024 * 1024) throw new Error('历史审查超过 16 MiB，需人工核对并迁移审查链');
    const raw = JSON.parse(snapshot.content);
    if (raw?.task !== task || raw?.review_id !== id) throw new Error('历史审查与任务身份不一致，请恢复原记录');
    if (raw.review_complete === false && ['running', 'incomplete', 'cancelled'].includes(raw.outcome)) continue;
    const loaded = parseReviewFile(snapshot, task, id);
    if (loaded.record.schema_version !== 1) throw new Error('有完成记录未对应当前任务引用，请先人工核查并恢复审查链');
    entries.set(id, loaded);
  }
  if (entries.size === 0) return undefined;
  const predecessors = new Set<string>();
  for (const entry of entries.values()) {
    const previous = entry.record.inputs.previous_review;
    verifyFollowUp(entry.record, previous ? entries.get(previous) : undefined);
    if (previous) predecessors.add(previous);
  }
  const heads = [...entries].filter(([id]) => !predecessors.has(id));
  if (heads.length !== 1) throw new Error('历史 SPEC 审查链有分叉或循环，请人工核对全部发现后迁移');
  const visited = new Set<string>();
  let next: string | undefined = heads[0][0];
  while (next && !visited.has(next)) {
    visited.add(next);
    next = entries.get(next)?.record.inputs.previous_review;
  }
  if (visited.size !== entries.size || next) throw new Error('历史 SPEC 审查链不连续，请人工恢复原记录');
  return heads[0][1];
}

export async function previousSpecReview(ctx: Context, exec: TaskExec, dir: string, state: TaskState) {
  return state.spec_review
    ? loadAnchoredReview(reviewWorkspace(ctx, exec, dir).task, state, state.spec_review)
    : readLegacyHead(ctx, exec, dir, state.task);
}

export async function requireCurrentSpecReview(ctx: Context, exec: TaskExec, dir: string, state: TaskState): Promise<SpecReviewRef> {
  if (!state.spec_review) {
    throw new Error('缺少任务登记的有效 SPEC 审查。请进入或退回 SPEC，登记原始来源并调用 sdlc_spec_review');
  }
  const ref = state.spec_review;
  const {record} = await loadAnchoredReview(reviewWorkspace(ctx, exec, dir).task, state, ref);
  const current = await readRegisteredReviewInputs(ctx, exec, dir, state);
  if (state.acceptance && state.acceptance.spec_sha256 !== current.spec.sha256) {
    throw new Error('AC 登记与当前 Spec 的版本不同。请退回 SPEC 完成审查，再重新登记验收清单');
  }
  const snapshotIdentity = ({path, sha256}: Snapshot) => ({path, sha256});
  const identity = (inputs: typeof current) => ({
    intent: snapshotIdentity(inputs.intent),
    spec: snapshotIdentity(inputs.spec),
    manifest: inputs.source_manifest && snapshotIdentity(inputs.source_manifest),
    sources: inputs.sources.map(source => ({...sourceDescriptor(source), sha256: source.sha256})),
  });
  if (!sameJSON(identity(current), identity(record.inputs))) {
    throw new Error('Source、来源清单、Intent 或 Spec/AC 已变更。请退回 SPEC，按当前登记的资料重新审查');
  }
  if (record.active_findings.length) {
    throw new Error('SPEC 审查仍有未解决发现。请在 SPEC 逐项回应并复审：' + record.active_findings.map(f => f.id).join(', '));
  }
  return ref;
}
