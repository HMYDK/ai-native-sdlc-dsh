#!/usr/bin/env node
/** One bounded model invocation through the installed tarball.
 * Usage (Electron node mode): run.mjs PROFILE WORKSPACE TASK_ID ARGS_JSON OUT_ROOT SLOT
 * OUT_ROOT is shared across this batch; slots 1–4 are consumed once, even on failure.
 * The caller prepares the fixture and isolated DSH_HOME, including credentials.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {randomUUID, createHash} from 'node:crypto';
import {cancelAfterResponse, cancelBeforeStep} from './budget.mjs';

const [profileArg, workspaceArg, taskId, argsFile, outputArg, slot] = process.argv.slice(2);
assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1', 'Use the App Electron executable with ELECTRON_RUN_AS_NODE=1');
assert.ok(profileArg && workspaceArg && taskId && argsFile && outputArg && /^[1-4]$/.test(slot), 'Expected PROFILE WORKSPACE TASK_ID ARGS_JSON OUT_ROOT SLOT(1–4)');
assert.ok(process.env.DSH_HOME, 'An isolated DSH_HOME is required');
const profileDir = path.resolve(profileArg), workspace = await fs.realpath(workspaceArg);
const output = path.resolve(outputArg), evalHome = await fs.realpath(process.env.DSH_HOME);
const within = (root, target) => { const rel = path.relative(root, target); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
assert.notEqual(evalHome, path.join(os.homedir(), '.dsh'));
assert.ok(within(path.join(evalHome, 'profiles'), await fs.realpath(profileDir)));
assert.ok(!within(workspace, output), 'Usage, run arguments and labels stay outside the review workspace');
const args = JSON.parse(await fs.readFile(argsFile, 'utf8'));
assert.equal(args.task_id, taskId);
await fs.mkdir(output, {recursive: true});
const slotFile = path.join(output, `call-${slot}.json`);
const outputTokens = Number(process.env.SPEC_EVAL_OUTPUT_TOKENS ?? '8192');
assert.ok([8192, 16384].includes(outputTokens), 'Supported output caps: 8192 or 16384');
const reasoningEffort = process.env.SPEC_EVAL_REASONING_EFFORT;
assert.ok(reasoningEffort === undefined || ['off', 'low', 'high', 'max'].includes(reasoningEffort), 'Unsupported DeepSeek reasoning effort');
const tool = process.env.SPEC_EVAL_TOOL ?? 'sdlc_spec_review';
assert.ok(['sdlc_spec_review', 'sdlc_verify'].includes(tool), 'Unsupported evaluation tool');
const delivery = tool === 'sdlc_verify';
const limits = {review_activations: 1, wall_ms: 480000, output_tokens_per_request: outputTokens,
  observed_tokens: delivery ? 200000 : 80000, steps: delivery ? 10 : 12, cancellation_grace_ms: 8000};
const report = {slot: Number(slot), task: taskId, tool, started_at: new Date().toISOString(), outcome: 'preparing',
  provider: 'deepseek-account', model: 'deepseek-v4-pro', requested_reasoning_effort: reasoningEffort ?? null, limits,
  parent_model_calls: 0, child_sessions: [], model_steps: 0, model_responses: 0, request_headers: 0, failed_attempts: 0,
  usages: [], tools: [], routes: [], resolved_configs: [], response_block_stats: [], attempt_failures: []};
await fs.writeFile(slotFile, JSON.stringify(report, null, 2), {flag: 'wx', mode: 0o600});
const save = () => fs.writeFile(slotFile, JSON.stringify(report, null, 2) + '\n');
const modules = path.join(process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app', 'Contents/Resources/app.asar/dsh/node_modules');
const require = createRequire(path.join(modules, 'noop.js'));
const {loadLayeredEnv, loadProfileDirectory} = require('@deepseek-ai/dsh-app-boot');
const {runProfile} = require('@deepseek-ai/dsh/profile-boot');
const installAnchor = path.join(modules, '@deepseek-ai/dsh/package.json');
const parentId = `spec-eval-${randomUUID()}`;
const controller = new AbortController();
const observedTokens = () => report.usages.reduce((sum, u) => sum + (u.totalTokens ?? ((u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0))), 0);
let ctx, handle, timer, cancellationWatchdog;
const started = Date.now();
controller.signal.addEventListener('abort', () => {
  report.cancellation = {reason: String(controller.signal.reason?.message ?? controller.signal.reason),
    at: new Date().toISOString(), observed_tokens: observedTokens(), step: report.model_steps};
  console.error('EVAL_CANCEL', JSON.stringify(report.cancellation));
  // A broken cancellation channel must not let paid work keep running. Record
  // the forced exit even if the host cannot finish its usual cleanup.
  cancellationWatchdog = setTimeout(() => {
    report.outcome = 'forced_stop';
    report.finished_at = new Date().toISOString();
    report.duration_ms = Date.now() - started;
    report.usage_complete_for_responses = false;
    try {
      writeFileSync(slotFile, JSON.stringify(report, null, 2) + '\n');
    } finally {
      process.exit(124);
    }
  }, limits.cancellation_grace_ms);
}, {once: true});
try {
  const profile = loadProfileDirectory('dsh', profileDir, installAnchor);
  assert.equal(profile.skippedBundles.length, 0);
  const patches = [];
  if (delivery) {
    const {load, dump} = require('js-yaml');
    const {entryListSchema} = require('@deepseek-ai/cordis-plugin-include');
    const bundle = path.join(profileDir, 'node_modules/@ai-native-sdlc-plugin/dsh-sdlc/cordis.patch.yml');
    const config = load(await fs.readFile(bundle, 'utf8'), {schema: entryListSchema})[0].insert.find(row => row.id === 'preset-sdlc').config;
    const verify = config.plugins.find(row => row.id === 'sdlc-verify');
    verify.config = {...verify.config, verifierRetryOnMalformed: false};
    const overlay = path.join(output, `delivery-${slot}.patch.yml`);
    await fs.writeFile(overlay, dump([{id: 'preset-sdlc', config}], {schema: entryListSchema, noRefs: true}), {flag: 'wx'});
    patches.push(overlay);
  }
  ({ctx} = await runProfile({environment: loadLayeredEnv('dsh'), profile: 'web', resolvedProfile: {profile, installAnchor}, patchFiles: patches, args: ['--no-open', '--host', '127.0.0.1', '--port', '0']}));
  if (delivery) {
    const {load} = require('js-yaml');
    const {entryListSchema} = require('@deepseek-ai/cordis-plugin-include');
    const rows = load((await ctx.agentPresets.readDocument('sdlc')).content, {schema: entryListSchema});
    assert.equal(rows.find(row => row.id === 'sdlc-verify').config.verifierRetryOnMalformed, false);
    report.delivery_profile = {composition_rows: rows.length, verifierRetryOnMalformed: false};
  }
  report.host_version = require('@deepseek-ai/dsh/package.json').version;
  ctx.on('session/event', (session, event) => {
    if (session.id === parentId) {
      if (event.type === 'request/header') report.parent_model_calls++;
      return;
    }
    if (!report.child_sessions.includes(session.id)) report.child_sessions.push(session.id);
    if (report.child_sessions.length > limits.review_activations) controller.abort(new Error('evaluation activation budget exceeded'));
    if (event.type === 'step/start') {
      report.model_steps++;
      console.log('MODEL_STEP', report.model_steps);
      if (cancelBeforeStep(observedTokens(), report.limits.observed_tokens, report.model_steps, report.limits.steps)) controller.abort(new Error('evaluation token/step budget exceeded before next model step'));
    } else if (event.type === 'request/header') {
      report.request_headers++;
      const config = event.data.header.config;
      report.resolved_configs.push(Object.fromEntries(['provider', 'model', 'reasoningEffort', 'maxTokens'].filter(k => config[k] !== undefined).map(k => [k, config[k]])));
    }
    else if (event.type === 'request/context') {
      report.routes.push({provider: event.data.provider, model: event.data.model});
    } else if (event.type === 'assistant/attempt') {
      report.failed_attempts++;
      for (const entry of event.data.stream ?? []) {
        const chunk = entry.chunk;
        if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') report.attempt_failures.push({failure: chunk.reason.failure});
        const block = chunk?.type === 'block-end' ? chunk.block : undefined;
        if (block?.type === 'tool-call' && typeof block.arguments === 'string') {
          try { JSON.parse(block.arguments); }
          catch (error) { report.attempt_failures.push({tool: block.name, characters: block.arguments.length,
            bytes: Buffer.byteLength(block.arguments), sha256: createHash('sha256').update(block.arguments).digest('hex'),
            parse_error: String(error.message)}); }
        }
      }
    }
    else if (event.type === 'assistant/message') {
      report.model_responses++;
      report.response_block_stats.push((event.data.message.content ?? []).map(block => ({type: block.type, text_characters: (block.text ?? '').length})));
      if (event.data.usage) report.usages.push(event.data.usage);
      const used = observedTokens();
      if (used > report.limits.observed_tokens) {
        if (cancelAfterResponse(used, report.limits.observed_tokens, event.data.message.content ?? [])) controller.abort(new Error('evaluation observed-token budget exceeded'));
        else report.over_budget_terminal_submission = true;
      }
    } else if (event.type === 'tool/call') {
      report.tools.push({session: session.id, name: event.data.name, arguments: event.data.arguments});
      console.log('REVIEWER_TOOL', event.data.name);
    }
  });
  handle = await ctx.agents.create({sessionId: parentId, meta: {cwd: workspace, agentPreset: 'sdlc'},
    agentOptions: {provider: report.provider, model: report.model, maxTokens: outputTokens,
      ...(reasoningEffort ? {reasoningEffort} : {})},
    setup: async agentCtx => {await ctx.agentPresets.mount(agentCtx, 'sdlc');}});
  assert.equal(ctx.agents.get(handle.agent.id), handle.agent);
  const stateFile = path.join(workspace, '.ai/tasks', taskId, 'state.yaml');
  const initial = await fs.readFile(stateFile, 'utf8');
  report.state_sha256 = createHash('sha256').update(initial).digest('hex');
  report.outcome = 'running';
  await save();
  timer = setTimeout(() => controller.abort(new Error('evaluation wall-clock budget exceeded')), report.limits.wall_ms);
  const result = await ctx.tools.execute({agent: handle.agent, signal: controller.signal,
    calls: [{id: `spec-eval-${slot}`, name: tool, arguments: JSON.stringify(args)}]});
  report.tool_result = result.results[0].result;
  report.outcome = report.tool_result.isError ? 'tool_error' : (report.tool_result.value?.[delivery ? 'status' : 'outcome'] ?? 'missing_result');
  const finalState = await fs.readFile(stateFile, 'utf8');
  report.state_unchanged = finalState === initial;
  report.no_delivery_verdict = !(await fs.readdir(path.dirname(stateFile))).includes('verification.json');
  report.preset_released = !(await ctx.agentPresets.list()).some(p => p.id === 'sdlc-verifier');
  assert.equal(report.parent_model_calls, 0);
  if (!delivery) {
    const gated = await fs.access(path.join(profileDir, 'node_modules/@ai-native-sdlc-plugin/dsh-sdlc/lib/task/spec-review.js')).then(() => true, () => false);
    if (gated && report.outcome === 'completed') {
      const {load, JSON_SCHEMA} = require('js-yaml');
      const before = load(initial, {schema: JSON_SCHEMA});
      const after = load(finalState, {schema: JSON_SCHEMA});
      const {spec_review: ref, updated: _at, ...stableAfter} = after;
      const {spec_review: _previous, updated: _before, ...stableBefore} = before;
      assert.deepEqual(stableAfter, stableBefore);
      const {review_id, review_file} = report.tool_result.value;
      assert.equal(ref.id, review_id);
      assert.equal(ref.sha256, createHash('sha256').update(await fs.readFile(path.join(workspace, review_file))).digest('hex'));
      report.only_review_reference_updated = true;
    } else {
      assert.equal(report.state_unchanged, true);
    }
    assert.equal(report.no_delivery_verdict, true);
  }
  assert.equal(report.preset_released, true);
  console.log('REVIEW_RESULT', JSON.stringify(report.tool_result));
} catch (error) {
  report.outcome = 'runner_error';
  report.error = String(error?.stack ?? error);
  console.error('EVAL_ERROR', String(error?.message ?? error));
} finally {
  clearTimeout(timer);
  try {
    if (handle) await handle.dispose();
  } finally {
    try {
      if (ctx) await ctx.fiber.dispose();
    } finally {
      clearTimeout(cancellationWatchdog);
      report.finished_at = new Date().toISOString();
      report.duration_ms = Date.now() - started;
      report.usage_complete_for_responses = report.failed_attempts === 0 && report.usages.length === report.model_responses;
      await save();
      console.log('EVAL_SAVED', JSON.stringify({slot: Number(slot), outcome: report.outcome, steps: report.model_steps, responses: report.model_responses, usages: report.usages, duration_ms: report.duration_ms}));
    }
  }
}
process.exit(report.outcome === (delivery ? 'approve' : 'completed') ? 0 : 1);
