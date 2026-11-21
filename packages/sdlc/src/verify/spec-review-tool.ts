/** Publish independent SPEC feedback and advance the task-owned review reference. */
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { FsVersion } from '@deepseek-ai/dsh-fs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { actorOf, mutateTask, readTask, taskFile } from '../task/io.js';
import { requireIdle } from '../task/flow.js';
import { previousSpecReview, readRegisteredReviewInputs, reviewWorkspace } from '../task/spec-review.js';
import { REVIEW_INPUT_BYTES, REVIEW_RECORD_BYTES, reviewFilename, sameJSON, sourceDescriptor, sourceInputs, type ReviewRecord } from '../shared/spec-review-record.js';
import { normalizeTaskId } from '../task/state.js';
import { requireSessionCwd, writePolicy } from '../shared/helpers.js';
import { assertVerifierPreset, dispatchVerifier, withVerifierPreset, type VerifierRequest } from './runtime.js';
import { VERIFIER_PRESET_ID } from './preset.js';
import { errorMessages, isCancellation, VERIFIER_FINGERPRINT, type VerificationRecord, type VerificationRecording } from './recording.js';
import type { SdlcVerifyConfig } from './index.js';
import {
  activeFindings, buildSpecReviewPrompt, parseResponses, parseSpecReview, SPEC_REVIEW_SCHEMA, textHash,
} from './spec-review.js';

export function registerSpecReviewTool(ctx: Context, cfg: SdlcVerifyConfig): void {
  ctx.tools.register(defineTool({
    name: 'sdlc_spec_review',
    description: 'Review a SPEC draft against original requirements before implementation, in an independent context. '
      + 'Returns evidence-backed omissions, scope drift, weak acceptance methods and clarification questions, never an approval. '
      + 'A completed run updates the task review reference. Progress requires a current review with no active findings. One model dispatch, no automatic retry. '
      + 'For follow-up, pass previous_review and respond to every active finding; the reviewer can confirm fixes or withdraw mistaken findings.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Existing task in SPEC with registered source, intent and spec; no plan or implementation required.' },
      sources: { type: 'json', description: 'Optional exact copy of the registered source list. Omit to use task.artifacts.source and the optional spec_sources manifest. Each entry is {path, origin, kind}; path is workspace-relative. Metadata is caller-declared.' },
      previous_review: { type: 'string', description: 'When the current review has unresolved findings, specify its review_id and respond to each one. Only the task-selected latest review is eligible. Existing single-chain advisory reviews must be followed up during migration.' },
      responses: { type: 'json', description: 'Follow-up: [{finding_id, response}] for EVERY previous active finding, stating the Spec revision, factual counterevidence or unresolved question. These are author claims for independent review.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      const root = requireSessionCwd(exec, 'sdlc_spec_review');
      const id = normalizeTaskId(args.task_id), dir = `${root}/${cfg.tasksDir.replace(/\/+$/, '')}/${id}`;
      const state = await readTask(ctx, exec, dir, id);
      if (state.status !== 'SPEC') throw new Error('sdlc_spec_review 在 SPEC 阶段审查草稿；需求变更请先按现有流程回到 SPEC');
      requireIdle(state);
      const runId = randomUUID(), relative = reviewFilename(runId);
      const workspace = reviewWorkspace(ctx, exec, dir);
      const target = await taskFile(ctx, exec, dir, relative), policy = await writePolicy(ctx, exec);
      const doc: ReviewRecord = {
        schema_version: 2, task: id, review_id: runId, review_file: `${workspace.prefix}/${relative}`,
        started_at: new Date().toISOString(), review_complete: false, outcome: 'running',
        reviewer_fingerprint: VERIFIER_FINGERPRINT, requested_model: cfg.verifierModel || null, events: [],
      };
      let version: FsVersion | undefined;
      let savedHash: string | undefined;
      const save = async () => {
        // Keep evidence of cancellation. A write failure remains a tool error, never a completed review.
        const signal = exec.signal?.aborted ? undefined : exec.signal;
        const body = JSON.stringify(doc, null, 2) + '\n';
        const result = await ctx.fs.writeText(target, body,
          version === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version }, signal, policy);
        version = result.version;
        savedHash = textHash(body);
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
      const finish = async () => {
        doc.finished_at = new Date().toISOString();
        await recording.record('finished', {outcome: doc.outcome, review_complete: doc.review_complete, diagnostic: doc.diagnostic ?? null});
      };
      try {
        await recording.record('started', { task: id, inputs: args, author_session: actorOf(exec) });
        const stateSnapshot = await workspace.task('state.yaml');
        if (!sameJSON(await readTask(ctx, exec, dir, id), state)) throw new Error('准备审查期间任务登记发生变化');
        const registered = await readRegisteredReviewInputs(ctx, exec, dir, state);
        if (args.sources !== undefined && !sameJSON(sourceInputs(args.sources), registered.sources.map(sourceDescriptor))) {
          throw new Error('sources 与任务登记的来源清单不一致。请使用完整登记清单，或省略 sources');
        }
        const previous = await previousSpecReview(ctx, exec, dir, state);
        const prior = previous?.record.active_findings ?? [];
        const previousId = previous?.record.review_id;
        if ((args.previous_review !== undefined || prior.length > 0 || previous?.record.schema_version === 1)
            && args.previous_review !== previousId) {
          throw new Error(previousId
            ? `必须复审当前审查 ${previousId}，传入 previous_review 并逐项回应其未解决发现`
            : '当前任务没有可复审的前轮记录');
        }
        const responses = parseResponses(args.responses, prior);
        const {intent, spec, sources, source_manifest} = registered;
        const currentInputs = [stateSnapshot, intent, spec, ...sources, ...(source_manifest ? [source_manifest] : [])];
        if (currentInputs.reduce((sum, snapshot) => sum + Buffer.byteLength(snapshot.content), 0) > REVIEW_INPUT_BYTES) {
          throw new Error('审查输入超过 256 KiB，请拆分任务或资料');
        }
        doc.inputs = {state: stateSnapshot, ...registered, previous_findings: prior, responses,
          ...(previous ? {previous_review: previousId, previous_review_sha256: previous.snapshot.sha256} : {})};
        const prompt = buildSpecReviewPrompt({task: id, intent: intent.content, spec: spec.content, sources,
          previous: prior, previousSpec: previous?.record.inputs.spec.content, previousSources: previous?.record.inputs.sources, responses});
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
          if (result.stopReason !== 'completed') throw new Error(`SPEC 审查未正常结束：${result.stopReason}`);
          if (result.structured === undefined) throw new Error(`未取得结构化审查结果；不从自由文本猜测。stop_reason=${result.stopReason}`);
          const review = parseSpecReview(result.structured, sources, prior, runId);
          await mutateTask(ctx, exec, dir, id, async current => {
            if (!sameJSON(current, state)) throw new Error('任务或审查链已变更，请重新读取当前任务后复审');
            for (const snapshot of currentInputs) {
              if ((await workspace.read(snapshot.path)).sha256 !== snapshot.sha256) throw new Error(`审查期间输入发生变化：${snapshot.path}，请重新审查`);
            }
            if (previous && (await workspace.read(previous.snapshot.path, REVIEW_RECORD_BYTES)).sha256 !== previous.snapshot.sha256) {
              throw new Error('审查期间前轮记录发生变化，请恢复记录后复审');
            }
            doc.review = review;
            doc.active_findings = activeFindings(review, prior);
            doc.review_complete = true;
            doc.outcome = 'completed';
            await finish();
            return {state: {...current, updated: doc.finished_at!, spec_review: {version: 1, id: runId, sha256: savedHash!}}, value: undefined};
          });
          recording.complete = true;
        });
      } catch (error) {
        doc.review_complete = false;
        doc.outcome = recording.cancelled || isCancellation(error, exec.signal) ? 'cancelled' : 'incomplete';
        doc.diagnostic = errorMessages(error).join('; ');
        delete doc.review;
        delete doc.active_findings;
        // A record published before a failed state CAS cannot become the selected review.
        if (doc.events.at(-1)?.kind === 'finished') doc.events.pop();
        await finish();
      }
      return JSON.parse(JSON.stringify({
        task: id, review_id: runId, review_file: doc.review_file, review_complete: doc.review_complete, outcome: doc.outcome,
        ...(doc.review ? { review: doc.review, active_findings: doc.active_findings } : {}),
        ...(doc.diagnostic ? { diagnostic: doc.diagnostic } : {}),
        ...(doc.reviewer_session ? { reviewer_session: doc.reviewer_session } : {}),
        note: '任务推进会重新核对登记的输入及未解决发现。哈希与结构校验不证明来源真实或需求穷尽。',
      }));
    },
  }));
}
