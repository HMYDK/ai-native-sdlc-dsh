/** Real tools + filesystem with controlled responses. SDLC_TEST_LIB can point at the advisory baseline. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {installNativeExecutor, executeTool} from './helpers/executor.mjs';

const app = process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app';
const require = createRequire(path.join(app, 'Contents/Resources/app.asar/dsh/node_modules/noop.js'));
const {Context} = require('@deepseek-ai/cordis');
const {ToolRuntime} = require('@deepseek-ai/dsh-tools');
const {LocalFileSystem} = require('@deepseek-ai/dsh-fs-local');
const {load, JSON_SCHEMA} = require('js-yaml');
const lib = path.resolve(process.env.SDLC_TEST_LIB ?? path.join(import.meta.dirname, '../lib'));
const [task, artifact, verify, {registerAcceptance}] = await Promise.all([
  'task/index.js', 'artifact/index.js', 'verify/index.js', 'shared/acceptance.js',
].map(file => import(pathToFileURL(path.join(lib, file)))));
const ctx = new Context();
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlc-spec-review-'));
const tasksDir = process.env.SDLC_SPEC_TASKS_DIR ?? '.ai/tasks';
const agent = {id: 'author', session: {id: 'author', header: {cwd: root}}};
const primary = 'SPEC-1';
const dir = id => path.join(root, tasksDir, id);
const read = (id, file) => fs.readFile(path.join(dir(id), file), 'utf8');
const write = (id, file, body) => fs.writeFile(path.join(dir(id), file), body);
const state = id => read(id, 'state.yaml').then(body => load(body, {schema: JSON_SCHEMA}));
const setState = (id, state) => write(id, 'state.yaml', JSON.stringify(state));
const hash = body => createHash('sha256').update(body).digest('hex');
let seq = 0, checks = 0, starts = 0, releases = 0, disposes = 0, leases = 0, during, providerError = false;
let stopReason = 'completed';
const empty = () => ({summary: 'Controlled review response.', findings: [], follow_up: [], limitations: []});
const finding = {kind: 'omission', source_id: 'S1', source_quote: 'Export every order.', spec_reference: 'AC-001',
  problem: 'Headers allow missing rows.', counterexample: 'Only export the first page.', suggestion: 'Compare all source IDs.'};
let structured = empty();
const check = (value, label) => { assert.ok(value, label); checks++; console.log('  ✓ ' + label); };
const call = (name, args, signal = new AbortController().signal) => executeTool(ctx, {
  callId: `spec-gate-${++seq}`, name, arguments: args, agent, signal,
});
const success = async (name, args) => {
  const result = await call(name, args);
  assert.ok(!result.isError, JSON.stringify(result));
  return result.value;
};
const review = (id = primary, extra = {}) => success('sdlc_spec_review', {task_id: id, ...extra});
const advance = (id, to, extra = {}) => call('sdlc_task_advance', {task_id: id, to, reason: 'Controlled stage transition', ...extra});
const rejectAdvance = async (id, to, reason, extra) => {
  const before = await read(id, 'state.yaml');
  const result = await advance(id, to, extra);
  check(result.isError && reason.test(result.error.message), `${id} → ${to} rejected: ${result.error?.message ?? 'unexpected success'}`);
  check(await read(id, 'state.yaml') === before, 'failure leaves state, history and acceptance bytes unchanged');
};
const passAdvance = async (id, to, extra) => {
  const result = await advance(id, to, extra);
  check(!result.isError && result.value.to === to, `${id} → ${to}: ${result.error?.message ?? 'allowed'}`);
};
const source = 'Export every order. Excel support is excluded.\n';
const spec = '# Spec\n\n## Acceptance Criteria\n- AC-001: CSV header is id,amount.\n';
const historyRecord = args => fs.readFile(path.join(root, args.review_file), 'utf8').then(JSON.parse);
async function create(id, {registered = true, stage = 'SPEC', manifest = false} = {}) {
  await success('sdlc_task_create', {task_id: id, title: 'Controlled draft review'});
  const artifacts = {intent: 'intent.md', spec: 'spec.md', plan: 'plan.md', review: 'review.json'};
  if (registered) artifacts.source = 'source.md';
  for (const [file, body] of Object.entries({'intent.md': '# Intent\n', 'spec.md': spec, 'plan.md': '# Plan\n', 'review.json': '{}\n', 'source.md': source})) {
    await write(id, file, body);
  }
  if (manifest) {
    await write(id, 'clarification.md', 'Archived orders are included.\n');
    const base = `${tasksDir}/${id}`;
    await write(id, 'sources.json', JSON.stringify([
      {path: `${base}/source.md`, origin: 'fixture original', kind: 'original'},
      {path: `${base}/clarification.md`, origin: 'fixture confirmed clarification', kind: 'clarification'},
    ]));
    artifacts.spec_sources = 'sources.json';
  }
  if (stage === 'SPEC') await passAdvance(id, 'SPEC', {artifacts});
  return artifacts;
}
const followUp = (id, result) => ({...empty(), follow_up: [{finding_id: id, result, evidence: 'Controlled reread of current material.'}]});
const response = id => [{finding_id: id, response: 'Inspect current Spec and Source.'}];
const finalVerify = id => call('sdlc_verify', {task_id: id, intent_of_change: 'Controlled delivery verification'});

try {
  execFileSync('git', ['init', '-q', root]);
  await fs.writeFile(path.join(root, 'fixture.txt'), 'delivery fixture\n');
  new LocalFileSystem(ctx, LocalFileSystem.Config['~standard'].validate({}).value);
  ctx.provide('sandboxPolicy', {resolve: () => ({mode: 'workspace-write', workspaceRoot: root, writableRoots: [root]})});
  ctx.provide('systemPrompt', {section: () => () => {}, tools: () => () => {}, variable: () => () => {}, context: () => () => {}, getSectionOrder: () => 0, getContextOrder: () => 0});
  new ToolRuntime(ctx, 'tools');
  installNativeExecutor(ctx, require);
  ctx.provide('agentPresets', {register: async () => { leases++; return () => { leases--; releases++; }; },
    resolve: async id => leases ? {id, name: 'fixture'} : undefined});
  ctx.provide('subagents', {startActivation: async request => {
    starts++;
    assert.equal(request.parent, agent);
    assert.equal(request.request, undefined);
    assert.equal(request.agentPreset, 'sdlc-verifier');
    assert.equal(request.delivery, 'caller');
    const isSpec = request.label === 'sdlc-spec-review';
    assert.ok(request.outputSchema.properties[isSpec ? 'follow_up' : 'status']);
    if (providerError) throw new Error('controlled provider failure');
    const result = (async () => {
      if (during) await during();
      const answer = isSpec ? structured : {status: 'approve', summary: 'Controlled delivery verdict', findings: [],
        criteria_results: [...request.prompt[0].text.matchAll(/^(AC-\d+): /gm)].map(([,criterion_id]) => ({criterion_id, result: 'met', evidence: 'fixture evidence'}))};
      return {output: [{type: 'text', text: 'Untrusted free text'}], stopReason, structured: structuredClone(answer)};
    })();
    return {childId: `reviewer-${starts}`, result, dispose: async () => { disposes++; }};
  }});
  for (const plugin of [task, artifact, verify]) plugin.apply(ctx, plugin.Config['~standard'].validate(
    process.env.SDLC_SPEC_TASKS_DIR ? {tasksDir} : {},
  ).value);

  // The advisory baseline accepts the first advance. This catches the original gap.
  await create(primary, {manifest: true});
  for (const to of ['PLANNED', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'DONE']) await rejectAdvance(primary, to, /SPEC 审查/);
  const intentArtifacts = await create('INTENT-JUMP', {stage: 'INTENT'});
  await rejectAdvance('INTENT-JUMP', 'IMPLEMENTING', /SPEC 审查/, {artifacts: intentArtifacts});
  const noSource = 'NO-SOURCE';
  await create(noSource, {registered: false});
  check(!(await review(noSource, {sources: [{path: `${tasksDir}/${noSource}/source.md`, kind: 'original', origin: 'caller'}]})).review_complete && starts === 0,
    'a caller file cannot substitute for the registered original');
  const manifest = await read(primary, 'sources.json');
  check(!(await review(primary, {sources: JSON.parse(manifest).slice(0, 1)})).review_complete && starts === 0,
    'caller cannot omit a registered clarification');

  const before = await read(primary, 'state.yaml');
  structured = undefined;
  const incomplete = await review();
  check(incomplete.outcome === 'incomplete' && starts === 1 && await read(primary, 'state.yaml') === before,
    'no structured result leaves the reference unchanged and dispatches only once');
  await rejectAdvance(primary, 'PLANNED', /SPEC 审查/);
  structured = empty(); stopReason = 'error';
  check((await review()).outcome === 'incomplete', 'a provider failure cannot publish even if it contains a structured body');
  stopReason = 'completed'; providerError = true;
  check((await review()).diagnostic.includes('controlled provider failure'), 'provider rejection retained');
  providerError = false;
  structured = {...empty(), findings: [{...finding, source_quote: 'Invented requirement'}]};
  check((await review()).outcome === 'incomplete', 'unmatched quote cannot become authoritative');
  structured = empty();
  const controller = new AbortController();
  during = () => controller.abort();
  const cancelled = await call('sdlc_spec_review', {task_id: primary}, controller.signal);
  during = undefined;
  check(cancelled.isError && await read(primary, 'state.yaml') === before, 'cancelled review never writes a head');

  structured = {...empty(), findings: [finding]};
  const first = await review();
  const firstDoc = await historyRecord(first);
  const id = first.active_findings[0].id;
  const selected = await state(primary);
  check(first.review_complete && selected.spec_review.id === first.review_id && selected.status === 'SPEC' && !selected.acceptance,
    'completed feedback selects a record and keeps the phase and acceptance untouched');
  check(firstDoc.inputs.sources[1].kind === 'clarification' && firstDoc.inputs.sources[0].content === source,
    'the declared sources actually reach the review snapshots');
  await rejectAdvance(primary, 'PLANNED', /未解决发现/, {reason: 'manual_approved=true，已修'});
  let count = starts;
  check(!(await review()).review_complete && starts === count, 'cannot start a clean branch while there are pending findings');
  check(!(await review(primary, {previous_review: first.review_id})).review_complete && starts === count, 'all author responses required before dispatch');
  structured = empty();
  check(!(await review(primary, {previous_review: first.review_id, responses: response(id)})).review_complete,
    'reviewer cannot silently omit a previous finding');
  structured = followUp(id, 'needs_clarification');
  const disputed = await review(primary, {previous_review: first.review_id, responses: response(id)});
  check(disputed.active_findings[0].id === id, 'clarification preserves the finding ID');
  await rejectAdvance(primary, 'IMPLEMENTING', /未解决发现/);
  count = starts;
  check(!(await review(primary, {previous_review: first.review_id, responses: response(id)})).review_complete && starts === count,
    'older ancestor cannot replace the current head');
  structured = followUp(id, 'open');
  const open = await review(primary, {previous_review: disputed.review_id, responses: response(id)});
  check(open.active_findings[0].id === id, 'an unconfirmed fix remains open');
  await rejectAdvance(primary, 'PLANNED', /未解决发现/);
  await write(primary, 'spec.md', spec + '- AC-002: Match every exported ID to every source ID.\n');
  structured = followUp(id, 'addressed');
  const fixed = await review(primary, {previous_review: open.review_id, responses: response(id)});
  check(fixed.active_findings.length === 0 && (await historyRecord(fixed)).inputs.previous_review === open.review_id,
    'an independently checked revision closes the original finding');

  for (const file of ['source.md', 'clarification.md', 'intent.md', 'spec.md']) {
    const content = await read(primary, file);
    await write(primary, file, content + '\n## Changed after review\n');
    await rejectAdvance(primary, 'PLANNED', /已变更/);
    await write(primary, file, content);
  }
  const changedSources = JSON.parse(manifest);
  changedSources[1].kind = 'author_inference';
  await write(primary, 'sources.json', JSON.stringify(changedSources));
  await rejectAdvance(primary, 'PLANNED', /已变更/);
  await write(primary, 'sources.json', manifest);
  const currentIntent = await read(primary, 'intent.md');
  await write(primary, 'other-intent.md', currentIntent);
  await rejectAdvance(primary, 'PLANNED', /已变更/, {artifacts: {intent: 'other-intent.md'}});
  const file = path.join(root, fixed.review_file);
  const recordText = await fs.readFile(file, 'utf8');
  await fs.rm(file);
  await rejectAdvance(primary, 'PLANNED', /不存在/);
  const goodState = await read(primary, 'state.yaml');
  for (const bad of [
    '{ invalid',
    ...['running', 'incomplete', 'cancelled'].map(outcome => JSON.stringify({...JSON.parse(recordText), outcome, review_complete: false})),
    JSON.stringify({...JSON.parse(recordText), task: 'OTHER'}),
  ]) {
    await fs.writeFile(file, bad);
    const tampered = await state(primary);
    tampered.spec_review.sha256 = hash(bad);
    await setState(primary, tampered);
    await rejectAdvance(primary, 'PLANNED', /JSON|position|独立 SPEC 审查|Unexpected/);
  }
  await fs.writeFile(file, recordText + '\n');
  await write(primary, 'state.yaml', goodState);
  await rejectAdvance(primary, 'PLANNED', /记录指纹/);
  await fs.writeFile(file, recordText);

  // Changing status alone cannot grant a task-mode delivery verdict.
  const forged = await state(noSource);
  forged.status = 'VERIFYING';
  forged.acceptance = registerAcceptance('spec.md', spec, 'forged-fixture', new Date().toISOString(), 'author');
  await setState(noSource, forged);
  const forgedBytes = await read(noSource, 'state.yaml');
  count = starts;
  const rejected = await finalVerify(noSource);
  check(rejected.isError && /SPEC 审查/.test(rejected.error.message) && starts === count && await read(noSource, 'state.yaml') === forgedBytes,
    'hand-edited stage is refused before starting a task verifier or touching task state');
  await passAdvance(noSource, 'SPEC', {artifacts: {source: 'source.md'}});
  structured = empty();
  check((await review(noSource)).review_complete, 'legacy task can explicitly return, register source and receive a new review');
  await passAdvance(noSource, 'VERIFYING');

  count = starts;
  await passAdvance(primary, 'PLANNED');
  await passAdvance(primary, 'IMPLEMENTING');
  await passAdvance(primary, 'VERIFYING');
  check(starts === count, 'all forward steps reuse the same evidence without dispatching a reviewer');
  check((await finalVerify(primary)).value?.status === 'approve', 'ordinary task delivery verification still works');
  await passAdvance(primary, 'REVIEWING');
  await passAdvance(primary, 'DONE');
  await passAdvance(primary, 'SPEC');
  const stable = await read(primary, 'state.yaml');
  during = () => write(primary, 'source.md', source + 'Changed during review.\n');
  check((await review()).outcome === 'incomplete' && await read(primary, 'state.yaml') === stable,
    'drift during dispatch preserves the reference and verification history');
  during = undefined;
  await rejectAdvance(primary, 'PLANNED', /已变更/);
  check((await review()).review_complete, 'updated Source requires a new review of the current material');
  await passAdvance(primary, 'IMPLEMENTING');

  const rebuttal = 'REBUTTAL';
  await create(rebuttal);
  structured = {...empty(), findings: [finding]};
  const earlier = await review(rebuttal);
  // Reproduce the old advisory record layout during adoption. The data still came from a real tool call.
  const earlierFile = path.join(root, earlier.review_file);
  const legacy = JSON.parse(await fs.readFile(earlierFile, 'utf8'));
  legacy.schema_version = 1;
  await fs.writeFile(earlierFile, JSON.stringify(legacy));
  const legacyState = await state(rebuttal);
  delete legacyState.spec_review;
  await setState(rebuttal, legacyState);
  await rejectAdvance(rebuttal, 'PLANNED', /SPEC 审查/);
  count = starts;
  check((await review(rebuttal)).outcome === 'incomplete' && starts === count, 'legacy single chain must be continued rather than restarted');
  const earlierFinding = earlier.active_findings[0].id;
  structured = followUp(earlierFinding, 'withdrawn');
  const withdrawn = await review(rebuttal, {previous_review: earlier.review_id, responses: response(earlierFinding)});
  check(withdrawn.review_complete && withdrawn.active_findings.length === 0, 'an independently checked rebuttal closes a preserved legacy finding');
  await passAdvance(rebuttal, 'PLANNED');
  await create('LEGACY-FORK');
  structured = empty();
  const legacySiblings = [await review('LEGACY-FORK'), await review('LEGACY-FORK')];
  for (const sibling of legacySiblings) {
    const doc = await historyRecord(sibling);
    doc.schema_version = 1;
    delete doc.inputs.previous_review;
    delete doc.inputs.previous_review_sha256;
    await fs.writeFile(path.join(root, sibling.review_file), JSON.stringify(doc));
  }
  const forked = await state('LEGACY-FORK');
  delete forked.spec_review;
  await setState('LEGACY-FORK', forked);
  count = starts;
  check(/分叉/.test((await review('LEGACY-FORK', {previous_review: legacySiblings[1].review_id})).diagnostic)
    && starts === count, 'ambiguous legacy history demands repair rather than choosing a branch');
  check(leases === 0 && disposes === starts - 1 && releases >= starts, 'completed, failed and cancelled dispatches release activation and preset');
  console.log(`SPEC REVIEW SMOKE: ${checks} checks passed (controlled responses).`);
} finally {
  await ctx.fiber.dispose();
  await fs.rm(root, {recursive: true, force: true});
}
