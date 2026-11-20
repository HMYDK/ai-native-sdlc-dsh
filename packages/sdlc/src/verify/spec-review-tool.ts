/** SPEC feedback has its own records; it never updates workflow, acceptance or delivery verdicts. */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { FsVersion } from '@deepseek-ai/dsh-fs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readTask, taskFile } from '../task/io.js';
import { normalizeTaskId } from '../task/state.js';
import { requireSessionCwd, resolveOptions, writePolicy } from '../shared/helpers.js';
import { assertVerifierPreset, dispatchVerifier, withVerifierPreset, type VerifierRequest } from './runtime.js';
import { VERIFIER_PRESET_ID } from './preset.js';
import { errorMessages, isCancellation, VERIFIER_FINGERPRINT, type VerificationRecord, type VerificationRecording } from './recording.js';
import type { SdlcVerifyConfig } from './index.js';
import {
  activeFindings, buildSpecReviewPrompt, object, parseResponses, parseSpecReview,
  SOURCE_KINDS, SPEC_REVIEW_SCHEMA, text, textHash,
  type AuthorResponse, type ReviewSource, type SpecFinding, type SpecReview,
} from './spec-review.js';

interface Snapshot { path: string; content: string; sha256: string }
interface SourceInput { path: string; origin: string; kind: ReviewSource['kind'] }
interface ReviewInputs {
  state: Snapshot; intent: Snapshot; spec: Snapshot; sources: ReviewSource[];
  previous_review?: string; previous_findings: SpecFinding[]; responses: AuthorResponse[];
}
interface ReviewRecord {
  schema_version: 1; task: string; review_id: string; review_file: string;
  started_at: string; finished_at?: string;
  review_complete: boolean; outcome: 'running' | 'completed' | 'incomplete' | 'cancelled';
  reviewer_fingerprint: string; requested_model: string | null;
  inputs?: ReviewInputs; raw_result?: unknown; review?: SpecReview; active_findings?: SpecFinding[];
  reviewer_session?: string; diagnostic?: string;
  events: { at: string; kind: VerificationRecord['kind']; data: Record<string, unknown> }[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sourceInputs(raw: unknown): SourceInput[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) throw new Error('sources 需要 1–8 个原文文件；不能只提供 Actor 对需求的转述');
  const inputs = raw.map(value => {
    const s = object(value, 'source');
    if (Object.keys(s).some(k => !['path', 'origin', 'kind'].includes(k))) throw new Error('source 含未知字段');
    if (!SOURCE_KINDS.includes(s.kind as ReviewSource['kind'])) throw new Error('source.kind 必须是 original / clarification / author_inference');
    return { path: text(s.path, 'source.path', 2000), origin: text(s.origin, 'source.origin', 2000), kind: s.kind as ReviewSource['kind'] };
  });
  if (!inputs.some(s => s.kind === 'original')) throw new Error('至少需要一份 original 原始需求，作者推断不能代替它');
  if (new Set(inputs.map(s => s.path)).size !== inputs.length) throw new Error('sources 不能重复引用同一文件');
  return inputs;
}

export function registerSpecReviewTool(ctx: Context, cfg: SdlcVerifyConfig): void {
  ctx.tools.register(defineTool({
    name: 'sdlc_spec_review',
    description: 'Review a SPEC draft against original requirements before implementation, in an independent context. '
      + 'Returns evidence-backed omissions, scope drift, weak acceptance methods and clarification questions, never an approval. '
      + 'Does not change task state, acceptance registration, issues or verification.json. One model dispatch, no automatic retry. '
      + 'For follow-up, pass previous_review and respond to every active finding; the reviewer can confirm fixes or withdraw mistaken findings.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Existing task in SPEC with registered intent/spec drafts; no plan or implementation required.' },
      sources: { type: 'json', description: 'Array of {path, origin, kind}: workspace-relative UTF-8 original files, traceable URL/message reference, and original|clarification|author_inference. Metadata is caller-declared, not authenticated. Defaults to prior review sources on follow-up, otherwise the registered source artifact. Supply complete relevant original context, not an Actor-selected summary.' },
      previous_review: { type: 'string', description: 'review_id of a completed review of THIS task. Explicit ancestry avoids selecting an unrelated/concurrent latest result.' },
      responses: { type: 'json', description: 'Follow-up: [{finding_id, response}] for EVERY previous active finding, stating the Spec revision, factual counterevidence or unresolved question. These are author claims for independent review.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      const root = requireSessionCwd(exec, 'sdlc_spec_review');
      const id = normalizeTaskId(args.task_id), dir = `${root}/.ai/tasks/${id}`;
      const state = await readTask(ctx, exec, dir, id);
      if (state.status !== 'SPEC') throw new Error('sdlc_spec_review 在 SPEC 阶段审查草稿；需求变更请先按现有流程回到 SPEC');
      const runId = randomUUID(), relative = `spec-reviews/${runId}.json`;
      const target = await taskFile(ctx, exec, dir, relative), policy = await writePolicy(ctx, exec);
      const doc: ReviewRecord = {
        schema_version: 1, task: id, review_id: runId, review_file: `.ai/tasks/${id}/${relative}`,
        started_at: new Date().toISOString(), review_complete: false, outcome: 'running',
        reviewer_fingerprint: VERIFIER_FINGERPRINT, requested_model: cfg.verifierModel || null, events: [],
      };
      let version: FsVersion | undefined;
      const save = async () => {
        // Keep evidence of cancellation. A write failure remains a tool error, never a completed review.
        const signal = exec.signal?.aborted ? undefined : exec.signal;
        const result = await ctx.fs.writeText(target, JSON.stringify(doc, null, 2) + '\n',
          version === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version }, signal, policy);
        version = result.version;
      };
      await save();
      const recording: VerificationRecording = {
        id: runId, complete: false, cancelled: false,
        async record(kind, data) {
          // Prepared already holds the exact prompt; avoid duplicating it and free-form model output
          // in every event. The structured result is saved separately, never inferred from that text.
          const eventData = { ...data };
          if (kind === 'attempt_started' && typeof eventData.prompt === 'string') {
            eventData.prompt_sha256 = textHash(eventData.prompt);
            delete eventData.prompt;
          }
          if (kind === 'attempt_finished') { delete eventData.result; delete eventData.structured; }
          doc.events.push({ at: new Date().toISOString(), kind, data: structuredClone(eventData) });
          await save();
        },
      };
      // Bounded full-text snapshots are passed directly to the reviewer; URLs alone do not count as read sources.
      let totalBytes = 0;
      const read = async (file: string, count = true, limit = 256 * 1024): Promise<Snapshot> => {
        if (path.isAbsolute(file) || file.split(/[\\/]/).some(s => !s || s === '..') || file.includes('\\')) throw new Error('输入文件必须是工作区内的相对路径');
        const workspace = await ctx.fs.resolve(root, resolveOptions(exec));
        const resolved = await ctx.fs.resolve(`${root}/${file}`, resolveOptions(exec));
        if (!ctx.fs.contains(workspace, resolved)) throw new Error('审查输入越出工作区');
        const info = await ctx.fs.stat(resolved, exec.signal);
        if (!info || info.type !== 'file' || (info.size ?? 0) > limit) throw new Error(`审查输入不存在或超过 ${limit} 字节：${file}`);
        const content = await ctx.fs.readText(resolved, exec.signal);
        if (count) totalBytes += Buffer.byteLength(content);
        if ((count && totalBytes > 256 * 1024) || Buffer.byteLength(content) > limit) throw new Error('审查输入超过大小上限，请明确拆分需求范围');
        if ((await ctx.fs.stat(resolved, exec.signal))?.version !== info.version) throw new Error(`读取期间输入变化：${file}`);
        return { path: file, content, sha256: textHash(content) };
      };
      const registered = async (kind: 'intent' | 'spec') => {
        const file = state.artifacts[kind];
        if (!file) throw new Error(`未登记 ${kind} 草稿`);
        await taskFile(ctx, exec, dir, file);
        return read(`.ai/tasks/${id}/${file}`);
      };
      try {
        await recording.record('started', { task: id, inputs: args, author_session: (exec.agent as { id?: string } | undefined)?.id ?? null });
        const stateSnapshot = await read(`.ai/tasks/${id}/state.yaml`);
        // The first state read determined the registered inputs. Detect a concurrent change before using them.
        const current = await readTask(ctx, exec, dir, id);
        if (JSON.stringify(current) !== JSON.stringify(state)) throw new Error('准备审查期间任务登记发生变化');
        const intent = await registered('intent'), spec = await registered('spec');
        let previous: ReviewRecord | undefined, previousSnapshot: Snapshot | undefined;
        if (args.previous_review !== undefined) {
          if (!UUID.test(args.previous_review)) throw new Error('previous_review 必须是本任务的 review_id');
          previousSnapshot = await read(`.ai/tasks/${id}/spec-reviews/${args.previous_review}.json`, false, 2 * 1024 * 1024);
          previous = JSON.parse(previousSnapshot.content) as ReviewRecord;
          if (previous.schema_version !== 1 || previous.task !== id || previous.review_id !== args.previous_review
              || !previous.review_complete || previous.outcome !== 'completed' || !previous.inputs || !previous.review
              || !Array.isArray(previous.active_findings)) throw new Error('前轮不是本任务已完成的 SPEC 审查');
          // Recompute the derived list so a stale/accidentally edited cache cannot silently drop prior findings.
          const parsed = parseSpecReview(previous.raw_result, previous.inputs.sources, previous.inputs.previous_findings, previous.review_id);
          if (JSON.stringify(activeFindings(parsed, previous.inputs.previous_findings)) !== JSON.stringify(previous.active_findings)) throw new Error('前轮发现记录不一致');
        }
        const prior = previous?.active_findings ?? [];
        const responses = parseResponses(args.responses, prior);
        let declared: unknown = args.sources;
        if (declared === undefined && previous) declared = previous.inputs!.sources.map(({ path, origin, kind }) => ({ path, origin, kind }));
        if (declared === undefined && state.artifacts.source) {
          await taskFile(ctx, exec, dir, state.artifacts.source);
          declared = [{ path: `.ai/tasks/${id}/${state.artifacts.source}`, origin: '任务登记的 source 文件；出处与确认信息见原文，来源未经插件认证', kind: 'original' }];
        }
        const sources: ReviewSource[] = [];
        for (const [i, source] of sourceInputs(declared).entries()) {
          const snapshot = await read(source.path);
          if (!snapshot.content.trim()) throw new Error(`来源文件为空：${source.path}`);
          sources.push({ ...snapshot, ...source, id: `S${i + 1}` });
        }
        doc.inputs = { state: stateSnapshot, intent, spec, sources, previous_findings: prior, responses,
          ...(previous ? { previous_review: previous.review_id } : {}) };
        const prompt = buildSpecReviewPrompt({ task: id, intent: intent.content, spec: spec.content, sources,
          previous: prior, previousSpec: previous?.inputs?.spec.content, previousSources: previous?.inputs?.sources, responses });
        // Include the historical material too in the input budget, before any paid dispatch.
        if (Buffer.byteLength(prompt) > 512 * 1024) throw new Error('审查提示词超过 512 KiB，请拆分任务；未派发模型');
        await recording.record('prepared', { prompt, outputSchema: SPEC_REVIEW_SCHEMA });
        if (!exec.agent) throw new Error('sdlc_spec_review requires a calling agent');
        await withVerifierPreset(ctx, async () => {
          await assertVerifierPreset(ctx);
          const request: VerifierRequest = {
            parent: exec.agent!, prompt: [{ type: 'text', text: prompt }],
            agentPreset: VERIFIER_PRESET_ID, outputSchema: SPEC_REVIEW_SCHEMA,
            ...(cfg.verifierModel || cfg.verifierMaxTokens > 0 ? { agentOptions: {
              ...(cfg.verifierModel ? { model: cfg.verifierModel } : {}),
              ...(cfg.verifierMaxTokens > 0 ? { maxTokens: cfg.verifierMaxTokens } : {}),
            } } : {}),
          };
          const { run, result } = await dispatchVerifier(ctx, cfg.verifierProvider, request, exec.signal, recording, 1, 'sdlc-spec-review');
          doc.reviewer_session = run ? String(run.childId) : undefined;
          doc.raw_result = result.structured;
          if (result.stopReason === 'aborted' || exec.signal.aborted) { recording.cancelled = true; throw new Error('SPEC 审查已取消'); }
          if (result.structured === undefined) throw new Error(`未取得结构化审查结果；不从自由文本猜测。stop_reason=${result.stopReason}`);
          const review = parseSpecReview(result.structured, sources, prior, runId);
          // Source and draft edits invalidate this observation, not the user's ability to advance the task.
          for (const snapshot of [stateSnapshot, intent, spec, ...sources, ...(previousSnapshot ? [previousSnapshot] : [])]) {
            if ((await read(snapshot.path, false, snapshot === previousSnapshot ? 2 * 1024 * 1024 : 256 * 1024)).sha256 !== snapshot.sha256) throw new Error(`审查期间输入发生变化：${snapshot.path}；本轮未完成，请基于当前版本重新审查`);
          }
          const active = activeFindings(review, prior);
          doc.review = review;
          doc.active_findings = active;
          doc.review_complete = true;
          doc.outcome = 'completed';
          recording.complete = true;
        });
      } catch (error) {
        doc.review_complete = false;
        doc.outcome = recording.cancelled || isCancellation(error, exec.signal) ? 'cancelled' : 'incomplete';
        doc.diagnostic = errorMessages(error).join('; ');
      } finally {
        doc.finished_at = new Date().toISOString();
        await recording.record('finished', { outcome: doc.outcome, review_complete: doc.review_complete, diagnostic: doc.diagnostic ?? null });
      }
      return JSON.parse(JSON.stringify({
        task: id, review_id: runId, review_file: doc.review_file, review_complete: doc.review_complete, outcome: doc.outcome,
        ...(doc.review ? { review: doc.review, active_findings: doc.active_findings } : {}),
        ...(doc.diagnostic ? { diagnostic: doc.diagnostic } : {}),
        ...(doc.reviewer_session ? { reviewer_session: doc.reviewer_session } : {}),
        note: 'SPEC 反馈不是交付裁决或推进许可；原始需求真实性与语义充分性不由哈希/结构校验证明。',
      }));
    },
  }));
}
