#!/usr/bin/env node
/** Real rc.3 activation manager + installed runtime, controlled providers, no external model calls.
 * Run in App Electron node mode, with an isolated DSH_HOME and profile directory argument.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {setImmediate} from 'node:timers/promises';

assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1');
assert.ok(process.env.DSH_HOME && process.argv[2]);
const checkHome = await fs.realpath(process.env.DSH_HOME);
assert.notEqual(checkHome, path.join(os.homedir(), '.dsh'));
const profileDir = await fs.realpath(process.argv[2]);
const relative = path.relative(path.join(checkHome, 'profiles'), profileDir);
assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
const modules = path.join(process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app', 'Contents/Resources/app.asar/dsh/node_modules');
const require = createRequire(path.join(modules, 'noop.js'));
const {loadLayeredEnv, loadProfileDirectory} = require('@deepseek-ai/dsh-app-boot');
const {runProfile} = require('@deepseek-ai/dsh/profile-boot');
const installAnchor = path.join(modules, '@deepseek-ai/dsh/package.json');
const profile = loadProfileDirectory('dsh', profileDir, installAnchor);
assert.equal(profile.skippedBundles.length, 0);
const lib = path.join(profileDir, 'node_modules/@ai-native-sdlc-plugin/dsh-sdlc/lib');
const {dispatchVerifier} = await import(pathToFileURL(path.join(lib, 'verify/runtime.js')));
const {ctx} = await runProfile({environment: loadLayeredEnv('dsh'), profile: 'web', resolvedProfile: {profile, installAnchor}, patchFiles: [], args: ['--no-open', '--host', '127.0.0.1', '--port', '0']});

async function checkSpawnCancellation() {
  const {LlmAdapter} = require('@deepseek-ai/dsh-llm');
  const {load, JSON_SCHEMA} = require('js-yaml');
  const {registerAcceptance} = await import(pathToFileURL(path.join(lib, 'shared/acceptance.js')));
  const workspace = await fs.mkdtemp(path.join(checkHome, 'cancel-probe-'));
  const task = 'RUNTIME-CANCEL';
  const dir = path.join(workspace, '.ai/tasks', task);
  const at = new Date().toISOString();
  const spec = '# Spec\n\n## Acceptance Criteria\n- AC-001: Keep the cancelled run from completing delivery.\n';
  const stateFile = path.join(dir, 'state.yaml');
  const state = {
    task, title: 'Controlled cancellation probe', status: 'VERIFYING', created: at, updated: at, history: [],
    artifacts: {intent: 'intent.md', spec: 'spec.md', plan: 'plan.md'},
    acceptance: registerAcceptance('spec.md', spec, randomUUID(), at, 'runtime-probe'),
  };
  const controller = new AbortController();
  const parentId = `cancel-tool-${randomUUID()}`;
  const route = 'sdlc-cancel-fixture';
  const {promise: published, resolve: announcePublication} = Promise.withResolvers();
  let adapterCalls = 0, modelRequests = 0, aborts = 0, actor, releaseAdapter;
  const stopRecording = ctx.on('sdlc-verify/record', record => {
    if (record.kind === 'attempt_session') announcePublication();
  });
  const stopObserving = ctx.on('session/event', (session, event) => {
    if (session.id === parentId) return;
    if (event.type === 'request/header') modelRequests++;
    if (event.type === 'assistant/message' && event.data.usage?.totalTokens === 11) {
      aborts++;
      controller.abort(new Error('controlled observed-token threshold'));
    }
  });
  const timer = setTimeout(() => {
    announcePublication();
    controller.abort(new Error('cancellation probe timed out'));
  }, 10000);
  try {
    await fs.mkdir(dir, {recursive: true});
    execFileSync('git', ['init', '-q', workspace]);
    await Promise.all([
      fs.writeFile(stateFile, JSON.stringify(state)),
      fs.writeFile(path.join(dir, 'intent.md'), 'Check cancellation after the verifier starts.\n'),
      fs.writeFile(path.join(dir, 'spec.md'), spec),
      fs.writeFile(path.join(dir, 'plan.md'), 'Abort at the first assistant response requiring another step.\n'),
    ]);
    releaseAdapter = ctx.llm.registerAdapter([route], new class extends LlmAdapter {
      async *stream() {
        adapterCalls++;
        // The first request cannot respond until the tool records the published activation.
        await published;
        if (adapterCalls > 1) {
          yield {type: 'finish', reason: {kind: 'stop'}};
          return;
        }
        yield {type: 'block-start', index: 0, blockType: 'tool-call'};
        yield {type: 'block-end', index: 0, block: {type: 'tool-call', id: 'probe-read', name: 'read',
          arguments: JSON.stringify({file_path: `.ai/tasks/${task}/spec.md`})}};
        yield {type: 'usage', usage: {inputTokens: 10, outputTokens: 1, totalTokens: 11}};
        yield {type: 'finish', reason: {kind: 'tool-calls'}};
      }
    }());
    actor = await ctx.agents.create({sessionId: parentId, meta: {cwd: workspace, agentPreset: 'sdlc'},
      agentOptions: {provider: route, model: 'controlled-cancellation'},
      setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'sdlc'); }});
    const batch = await ctx.tools.execute({agent: actor.agent, signal: controller.signal, calls: [{
      id: 'verify-cancel', name: 'sdlc_verify', arguments: JSON.stringify({task_id: task, intent_of_change: 'Controlled cancellation probe.'}),
    }]});
    const result = batch.results[0].result;
    assert.equal(aborts, 1, 'the first response must trigger budget cancellation');
    assert.equal(modelRequests, 1, 'no new model request after the cancellation');
    assert.equal(adapterCalls, 1);
    assert.equal(result.isError, true);
    assert.match(result.error?.info?.code ?? '', /^(?:FS_)?ABORTED$/);
    const persisted = load(await fs.readFile(stateFile, 'utf8'), {schema: JSON_SCHEMA});
    assert.equal(persisted.status, 'VERIFYING');
    assert.equal(persisted.workflow?.active_run, undefined);
    assert.equal(persisted.workflow?.runs.at(-1).outcome, 'cancelled');
    assert.ok(!(await fs.readdir(dir)).includes('verification.json'));
    assert.ok(!(await ctx.agentPresets.list()).some(p => p.id === 'sdlc-verifier'));
    console.log('SPAWN_VERIFICATION_CANCELLATION pass; one scripted response, no second request, run cancelled, preset released');
  } finally {
    clearTimeout(timer);
    await stopObserving();
    await stopRecording();
    if (actor) await actor.dispose();
    releaseAdapter?.();
    await fs.rm(workspace, {recursive: true, force: true});
  }
}

let parent, release, pending, calls = 0, disposes = 0, settle;
const controller = new AbortController();
try {
  ctx.on('session/event', (_session, event) => { if (event.type === 'request/header') calls++; });
  parent = await ctx.agents.create({sessionId: `cancel-probe-${randomUUID()}`, meta: {cwd: checkHome}});
  release = ctx.subagents.registerProvider({name: 'sdlc-cancel-probe', inheritsParentContext: false,
    capabilities: {agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false},
    async start() {
      const result = new Promise(resolve => { settle = resolve; });
      return {id: randomUUID(), result, async dispose() { disposes++; settle({output: [], stopReason: 'aborted'}); }};
    },
  });
  let published;
  const ready = new Promise(resolve => { published = resolve; });
  pending = dispatchVerifier(ctx, 'sdlc-cancel-probe', {parent: parent.agent, prompt: [{type: 'text', text: 'Controlled cancellation probe; never call a model.'}]}, controller.signal,
    {id: 'cancel-probe', complete: false, cancelled: false, async record(kind) { if (kind === 'attempt_session') published(); }}, 1);
  const observed = pending.then(value => ({value}), error => ({error}));
  const started = await Promise.race([ready.then(() => true), observed.then(() => false)]);
  assert.ok(started, 'activation must publish before cancellation');
  controller.abort();
  // The old helper stays pending because rc.3 stops forwarding the startup signal.
  for (let i = 0; i < 20 && disposes === 0; i++) await setImmediate();
  assert.equal(disposes, 1, 'published activation must be disposed without waiting for its result');
  const outcome = await observed;
  if (outcome.error) throw outcome.error;
  assert.equal(outcome.value.result.stopReason, 'aborted');
  assert.equal(disposes, 1);
  assert.equal(calls, 0);
  console.log('PUBLISHED_ACTIVATION_CANCELLATION pass; real manager, controlled external provider, zero model requests');
  await checkSpawnCancellation();
} finally {
  // Resolve the controlled provider even on a failed baseline assertion.
  settle?.({output: [], stopReason: 'aborted'});
  if (pending) await pending.catch(() => {});
  await release?.();
  if (parent) await parent.dispose();
  await ctx.fiber.dispose();
}
