/** Run a controlled task, official Bash tool and real export assertions without a model. */
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {executeTool, installNativeExecutor} from './helpers/executor.mjs';

const require = createRequire(path.join(process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app',
  'Contents/Resources/app.asar/dsh/node_modules/noop.js'));
const {Context} = require('@deepseek-ai/cordis');
const {LocalFileSystem} = require('@deepseek-ai/dsh-fs-local');
const {createScope, scopeTarget} = require('@deepseek-ai/dsh-scope');
const {ToolRuntime} = require('@deepseek-ai/dsh-tools');
const {SkillRegistry} = require('@deepseek-ai/dsh-skill');
const bash = require('@deepseek-ai/dsh-tool-bash');
const plugins = await Promise.all(['task', 'artifact', 'verify', 'rsi'].map(name => import('../lib/' + name + '/index.js')));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlc-rsi-obs-'));
const tasksDir = process.env.SDLC_SPEC_TASKS_DIR ?? '.ai/tasks';
const ctx = new Context();
const authorKey = {}, verifierKey = {};
const authorPreset = createScope(ctx, authorKey), verifierPreset = createScope(ctx, verifierKey);
const sources = new Map();
const command = 'node assert-export.mjs';
const source = 'Export every order in CSV. Sorting is unspecified.\n';
const spec = requirement => [
  '## Delivery Contract', '### Source', 'source.md', '### Outcome', '- OUT-001: Export every order in CSV.',
  '### Boundary', 'CSV file contents.', '### Oracle', '- ORACLE-001 [OUT-001]: `' + command + '`',
  '### AC mapping', '- OUT-001: AC-001', '## Acceptance Criteria', '- AC-001: ' + requirement, '',
].join('\n');
const initial = spec('CSV header is id,amount.');
const revised = spec('CSV contains exactly all source order IDs.');
const appCode = slice => 'export function exportCsv(rows) { return "id,amount\\n" + '
  + 'rows' + slice + '.map(({id, amount}) => id + "," + amount).join("\\n") + "\\n"; }\n';
const dir = task => path.join(root, tasksDir, task);
const read = (task, file) => fs.readFile(path.join(dir(task), file), 'utf8');
const write = (task, file, contents) => fs.writeFile(path.join(dir(task), file), contents);
const empty = () => ({summary: 'Controlled review', findings: [], follow_up: [], limitations: []});
const omission = {kind: 'omission', source_id: 'S1', source_quote: 'Export every order in CSV.',
  spec_reference: 'AC-001', problem: 'Headers do not prove all orders exported.',
  counterexample: 'The first page is the only page emitted.', suggestion: 'Compare all source order IDs.'};
const sorting = {kind: 'ambiguity', source_id: 'S1', source_quote: 'Sorting is unspecified.',
  spec_reference: 'Outcome', problem: 'Check whether sorting affects the expected output.',
  counterexample: 'Orders arrive in their original order.', suggestion: 'Confirm source scope.'};
let reviewAnswer = empty(), stopReason = 'completed', executeOracle = true, sequence = 0, checks = 0;
let waitForReview;

function agent(id, preset, parentSession) {
  const session = {id, seq: 0, header: {cwd: root, ...(parentSession ? {origin: 'subagent', parentSession} : {})}};
  const caller = {id: 'agent-' + id, session};
  const scope = createScope(ctx, caller, {parent: preset});
  caller.ctx = scope.ctx;
  sources.set(id, {header: session.header, events: []});
  return {caller, scope};
}
const author = agent('author', authorKey).caller;
const emit = (caller, type, data) => {
  const session = caller.session;
  const {events} = sources.get(session.id);
  const event = {seq: events.length, type, time: Date.now(), data};
  events.push(event);
  session.seq = events.length;
  ctx.emit(scopeTarget(session, caller), 'session/event', session, event);
};
const checked = (value, label) => {assert.ok(value, label);checks++;};
async function call(name, args, caller = author) {
  const id = 'call-' + (++sequence);
  emit(caller, 'tool/call', {name, callId: id, arguments: JSON.stringify(args)});
  const result = await executeTool(ctx, {callId: id, name, arguments: args, agent: caller, signal: new AbortController().signal});
  emit(caller, 'tool/result', {message: {toolCallId: id, isError: result.isError, content: result.content}, meta: result.meta});
  assert.ok(!result.isError, name + ': ' + result.error?.message);
  return result.value;
}
const advance = (task, to, artifacts) => call('sdlc_task_advance', {task_id: task, to, reason: 'Controlled task transition', artifacts});
const analyze = task => call('sdlc_rsi_analyze', {task_id: task});
const review = (task, args = {}) => call('sdlc_spec_review', {task_id: task, ...args});
const verify = task => call('sdlc_verify', {task_id: task, intent_of_change: 'Export all source order IDs.'});
const reported = result => result.delivery_evidence.outcomes[0];
async function create(task) {
  await call('sdlc_task_create', {task_id: task, title: 'Export every order'});
  await write(task, 'intent.md', '# Intent\nExport all orders to CSV.\n');
  await write(task, 'source.md', source);
  await write(task, 'spec.md', initial);
  await write(task, 'plan.md', '# Plan\nRun the CSV consumer assertion.\n');
  await write(task, 'review.json', '{"status":"approve","summary":"Controlled review pass"}\n');
  await advance(task, 'SPEC', {intent: 'intent.md', source: 'source.md', spec: 'spec.md', plan: 'plan.md', review: 'review.json'});
}
const goToVerification = async task => {
  for (const stage of ['PLANNED', 'IMPLEMENTING', 'VERIFYING']) await advance(task, stage);
};
const goToDone = async task => {
  await advance(task, 'REVIEWING');
  await advance(task, 'DONE');
};

try {
  await fs.writeFile(path.join(root, '.gitignore'), '.ai/\n');
  await fs.writeFile(path.join(root, 'orders.mjs'), appCode('.slice(0,1)'));
  await fs.writeFile(path.join(root, 'assert-export.mjs'), [
    'import assert from "node:assert/strict";', 'import {exportCsv} from "./orders.mjs";',
    'const rows = [{id:1,amount:8},{id:2,amount:20},{id:3,amount:3}];',
    'const exported = exportCsv(rows).trim().split("\\n").slice(1).map(row => Number(row.split(",")[0]));',
    'assert.deepEqual(exported, rows.map(row => row.id));',
  ].join('\n'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {stdio: 'pipe'});
  git('init', '-q');
  git('add', '.gitignore', 'orders.mjs', 'assert-export.mjs');
  git('-c', 'user.name=RSI fixture', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Baseline omits orders');
  const baseline = spawnSync('node', ['assert-export.mjs'], {cwd: root, encoding: 'utf8'});
  checked(baseline.status === 1 && /AssertionError/.test(baseline.stderr), 'baseline fails the real delivery assertion');
  new LocalFileSystem(ctx, LocalFileSystem.Config['~standard'].validate({}).value);
  ctx.provide('sandboxPolicy', {resolve: () => ({mode: 'workspace-write', workspaceRoot: root, writableRoots: [root]})});
  ctx.provide('systemPrompt', {section: () => () => {}, tools: () => () => {}, getSectionOrder: () => 0});
  ctx.provide('workingDirectory', {ensure: async actor => actor.session.header.cwd});
  ctx.provide('shellEnv', {collect: () => ({})});
  ctx.provide('shell', {
    resolve: request => request,
    execute: async request => ({result: async () => {
      assert.equal(request.command, command);
      const child = spawnSync('/bin/bash', ['-c', request.command], {cwd: request.workdir, encoding: 'utf8', timeout: 5000});
      if (child.error) throw child.error;
      return {exitCode: child.status, signal: child.signal, timedOut: false, aborted: false, timeoutMs: 5000,
        stdout: {text: child.stdout, truncated: false}, stderr: {text: child.stderr, truncated: false}};
    }}),
  });
  new ToolRuntime(ctx, 'tools');
  installNativeExecutor(ctx, require);
  new SkillRegistry(ctx);
  bash.apply(verifierPreset.ctx, {enableRunInBackground: false});
  bash.apply(authorPreset.ctx, {enableRunInBackground: false});
  ctx.provide('sessionQuery', {observeSession: async id => {
    const session = sources.get(id);
    if (!session) throw new Error('No controlled session ' + id);
    return {...session, [Symbol.dispose]: () => {}};
  }});
  ctx.provide('agentPresets', {register: async () => () => {}, resolve: async id => ({id, name: 'controlled verifier'})});
  let childNumber = 0;
  ctx.provide('subagents', {startActivation: async request => {
    assert.equal(request.agentPreset, 'sdlc-verifier');
    const isSpec = request.label === 'sdlc-spec-review';
    const childId = 'child-' + (++childNumber);
    const {caller, scope} = agent(childId, verifierKey, request.parent.session.id);
    const result = (async () => {
      if (childNumber === 1) {
        sources.get(childId).inheritedEventCount = 1;
        emit(caller, 'assistant/message', {usage: {inputTokens: 10, outputTokens: 2, totalTokens: 12}});
      }
      emit(caller, 'request/header', {header: {config: {model: 'controlled-response'}}});
      if (!isSpec && executeOracle) await call('bash', {command, description: 'Run the CSV assertion'}, caller);
      if (!isSpec && !executeOracle) await call('bash', {command, description: 'Author-only assertion'});
      if (isSpec && waitForReview) await waitForReview;
      emit(caller, 'assistant/message', {usage: {inputTokens: 20, outputTokens: 5, totalTokens: 25}});
      emit(caller, 'turn/end', {});
      const structured = isSpec ? structuredClone(reviewAnswer) : {
        status: 'approve', summary: 'Controlled verdict independent of the Oracle result', findings: [],
        criteria_results: [{criterion_id: 'AC-001', result: 'met', evidence: 'Controlled criterion verdict'}],
        oracle_refs: ['ORACLE-001'],
      };
      return {output: [], stopReason: isSpec ? stopReason : 'completed', structured};
    })();
    return {childId, result, dispose: () => scope.dispose()};
  }});
  for (const plugin of plugins) plugin.apply(authorPreset.ctx, plugin.Config['~standard'].validate(
    plugin.name === 'sdlc-rsi' ? {} : {tasksDir},
  ).value);
  emit(author, 'turn/start', {});
  emit(author, 'request/header', {header: {config: {model: 'controlled-author'}}});
  emit(author, 'assistant/message', {usage: {inputTokens: 10, outputTokens: 2, totalTokens: 12}});

  const success = 'OBS-EXPORT';
  await create(success);
  reviewAnswer = {...empty(), findings: [omission, sorting]};
  const first = await review(success);
  const [f1, f2] = first.review.findings.map(f => f.id);
  const responses = [{finding_id: f1, response: 'Replace header check with complete ID assertions.'},
    {finding_id: f2, response: 'The source expressly leaves sorting unspecified.'}];
  reviewAnswer = {...empty(), follow_up: [{finding_id: f1, result: 'open', evidence: 'The Spec still checks only headers.'},
    {finding_id: f2, result: 'needs_clarification', evidence: 'Inspect the original scope statement.'}]};
  const second = await review(success, {previous_review: first.review_id, responses});
  const ongoing = await analyze(success);
  checked(ongoing.spec_review_observations.unresolved_finding_ids.length === 2, 'open and needs_clarification remain unresolved');
  checked(ongoing.finding_lifecycle.some(f => f.finding_id === f2 && f.status === 'needs_clarification'), 'follow-up result is not collapsed to open');

  let release;
  waitForReview = new Promise(resolve => {release = resolve;});
  stopReason = 'aborted';
  const pending = review(success, {previous_review: second.review_id, responses});
  try {
    const reviewDir = path.join(dir(success), 'spec-reviews');
    for (let attempt = 0; attempt < 100 && (await fs.readdir(reviewDir)).length < 3; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    checked((await analyze(success)).spec_review_observations.rounds.some(round => round.outcome === 'running'), 'running review is visible');
  } finally {release();await pending;waitForReview = undefined;stopReason = 'completed';}

  await write(success, 'spec.md', revised);
  reviewAnswer = {...empty(), follow_up: [{finding_id: f1, result: 'addressed', evidence: 'AC-001 now compares all order IDs.'},
    {finding_id: f2, result: 'withdrawn', evidence: 'Original explicitly leaves sorting unspecified.'}]};
  const closed = await review(success, {previous_review: second.review_id, responses});
  reviewAnswer = {...empty(), findings: [{...omission, source_quote: 'Text absent from registered source.'}]};
  const incomplete = await review(success);
  checked(incomplete.outcome === 'incomplete', 'unverifiable source quotation leaves an incomplete record');
  reviewAnswer = empty();
  await review(success);
  await goToVerification(success);
  await fs.writeFile(path.join(root, 'orders.mjs'), appCode(''));
  await verify(success);
  await goToDone(success);
  const before = await read(success, 'state.yaml');
  const green = await analyze(success), repeat = await analyze(success);
  const finding = green.finding_lifecycle.find(f => f.finding_id === f1);
  const oracle = reported(green).oracles[0];
  checked(await read(success, 'state.yaml') === before, 'analysis preserves task state bytes');
  assert.deepEqual(green.spec_review_observations, repeat.spec_review_observations);
  assert.deepEqual(green.finding_lifecycle, repeat.finding_lifecycle);
  assert.deepEqual(green.observed_cost, repeat.observed_cost);
  checks += 3;
  checked(green.spec_review_observations.rounds.length === 6, 'all complete, incomplete and cancelled rounds are retained');
  checked(green.spec_review_observations.rounds.find(round => round.review_id === incomplete.review_id).diagnostic.includes('原文无法核对'), 'reference failure stays visible');
  checked(green.spec_review_observations.rounds.some(round => round.outcome === 'cancelled'), 'cancelled attempt stays visible');
  checked(green.spec_review_observations.unresolved_finding_ids.length === 0, 'the selected completed chain closed both findings');
  checked(green.finding_lifecycle.find(f => f.finding_id === f2).status === 'withdrawn', 'withdrawn is preserved as a refutation');
  checked(finding.status === 'addressed' && finding.follow_ups.some(step => step.review_id === closed.review_id
    && step.spec_revision.acceptance.changed.includes('AC-001')), 'addressed review carries the changed AC');
  checked(finding.delivery.status === 'linked' && finding.delivery.criterion_result.result === 'met', 'explicit finding and revised AC link to the final verdict');
  checked(finding.delivery.outcomes[0].status === 'proven', 'explicit AC mapping links the finding to the proven Outcome');
  checked(green.delivery_evidence.checkpoints.length > 0 && green.delivery_evidence.verification.code_fingerprint, 'exact verification and stage snapshots are present');
  checked(green.delivery_evidence.evidence_complete === true, 'all referenced evidence is complete for the fixture');
  checked(oracle.status === 'proven' && oracle.executions[0].exit_code === 0, 'official Bash completion supplies real exit zero');
  for (const evidencePath of [finding.introduced.record_path, finding.delivery.verification_path, oracle.session_path, oracle.evidence_path]) {
    checked((await fs.stat(path.join(root, evidencePath))).isFile(), 'evidence is readable: ' + evidencePath);
  }
  checked(green.observed_cost.sessions.some(session => session.role === 'spec_reviewer' && session.total_tokens_observed === 25), 'reported child usage is counted');
  checked(green.observed_cost.total_tokens === 187, 'each scoped usage record contributes once, excluding inherited history');

  const work = 'OBS-NO-ORACLE';
  await create(work);
  await write(work, 'spec.md', revised);
  await review(work);
  await goToVerification(work);
  executeOracle = false;
  await verify(work);
  await goToDone(work);
  const noOracle = await analyze(work);
  checked(noOracle.delivery_evidence.task_state.status === 'DONE' && noOracle.delivery_evidence.verification.verdict === 'approve'
    && reported(noOracle).status === 'unverified' && !noOracle.delivery_evidence.evidence_complete,
  'author-only execution, DONE, and all AC met remain unverified');

  const checkpointPath = path.join(root, green.delivery_evidence.checkpoints[0].path);
  const checkpointBytes = await fs.readFile(checkpointPath);
  await fs.rm(checkpointPath);
  const missingCheckpoint = await analyze(success);
  checked(!missingCheckpoint.delivery_evidence.evidence_complete && missingCheckpoint.evidence_gaps.some(g => g.kind === 'checkpoint'),
    'missing task and code checkpoint is surfaced');
  await fs.writeFile(checkpointPath, checkpointBytes);
  const historicalPath = path.join(root, green.delivery_evidence.verification.record_path);
  const historicalBytes = await fs.readFile(historicalPath);
  const historicalRecord = JSON.parse(historicalBytes);
  delete historicalRecord.spec_review;
  await fs.writeFile(historicalPath, JSON.stringify(historicalRecord));
  const historical = await analyze(success);
  checked(historical.delivery_evidence.verification.verdict === 'approve' && reported(historical).status === 'unverified'
    && historical.finding_lifecycle.find(f => f.finding_id === f1).delivery.status === 'unlinked',
  'historical v3 verdict remains readable without an invented review association');
  await fs.writeFile(historicalPath, historicalBytes);
  const ancestorPath = path.join(root, first.review_file);
  const ancestorBytes = await fs.readFile(ancestorPath);
  await fs.rm(ancestorPath);
  const missingAncestor = await analyze(success);
  checked(missingAncestor.spec_review_observations.chain_status === 'broken'
    && missingAncestor.evidence_gaps.some(g => g.kind === 'review_chain')
    && !missingAncestor.delivery_evidence.evidence_complete, 'missing predecessor breaks the full chain even when the head is intact');
  await fs.writeFile(ancestorPath, ancestorBytes);

  const red = 'OBS-FAILED';
  await create(red);
  await write(red, 'spec.md', revised);
  await review(red);
  await goToVerification(red);
  await fs.writeFile(path.join(root, 'orders.mjs'), appCode('.slice(0,1)'));
  executeOracle = true;
  await verify(red);
  const failed = await analyze(red);
  checked(failed.delivery_evidence.verification.verdict === 'approve' && reported(failed).status === 'failed'
    && reported(failed).oracles[0].executions[0].exit_code === 1, 'actual Oracle failure survives an approve verdict');

  const failedOracle = reported(failed).oracles[0];
  const proofPath = path.join(root, failedOracle.session_path);
  const proof = JSON.parse(await fs.readFile(proofPath, 'utf8'));
  await fs.writeFile(proofPath, JSON.stringify({...proof, truncated: true}));
  const truncated = await analyze(red);
  checked(reported(truncated).status === 'unverified' && truncated.evidence_gaps.some(g => g.kind === 'verification_evidence'), 'truncated logs cannot prove execution');
  await fs.writeFile(proofPath, JSON.stringify(proof));
  await write(red, 'source.md', source + 'Version drift.\n');
  checked((await analyze(red)).evidence_gaps.some(g => g.kind === 'review_input_drift'), 'changed Source is an evidence gap');

  const wrong = randomUUID();
  const copied = JSON.parse(await fs.readFile(path.join(root, closed.review_file), 'utf8'));
  await write(red, 'spec-reviews/' + wrong + '.json', JSON.stringify({...copied, review_id: wrong}));
  await write(red, 'spec-reviews/' + randomUUID() + '.json', '{bad');
  const redReview = failed.spec_review_observations.selected_review.id;
  await write(red, 'spec-reviews/' + redReview + '.json', '{bad head');
  const broken = await analyze(red);
  checked(broken.spec_review_observations.chain_status === 'broken'
    && broken.evidence_gaps.filter(g => g.kind === 'invalid_review_record').length === 3, 'cross-task, corrupt and broken head records surfaced');
  const old = 'OBS-LEGACY';
  await call('sdlc_task_create', {task_id: old, title: 'Task without SPEC review history'});
  checked((await analyze(old)).spec_review_observations.status === 'not_observed', 'tasks without records do not gain invented reviews');
  checked(!('spec_review_observations' in await call('sdlc_rsi_analyze', {})), 'standalone run analysis is compatible');

  if (process.env.RSI_OBS_REPORT) {
    await fs.writeFile(process.env.RSI_OBS_REPORT, JSON.stringify({
      fixture: 'Controlled responses and real order-export assertion', checks, baseline_exit_code: baseline.status,
      addressed_finding: finding,
      withdrawn_status: green.finding_lifecycle.find(f => f.finding_id === f2).status,
      rounds: green.spec_review_observations.rounds.map(({review_id, record_path, outcome, previous_review, input_versions, reviewer_session}) =>
        ({review_id, record_path, outcome, previous_review, spec_sha256: input_versions?.spec.sha256 ?? null, reviewer_session})),
      delivery_evidence: green.delivery_evidence,
      no_oracle: {status: reported(noOracle).status, verification: noOracle.delivery_evidence.verification.verdict},
      failed_oracle: failedOracle,
      observed_cost: green.observed_cost,
      evidence_gaps: green.evidence_gaps.map(({kind, path}) => ({kind, path})),
      negative_evidence_gap_kinds: [...new Set(broken.evidence_gaps.map(gap => gap.kind))],
    }, null, 2) + '\n');
  }
  console.log('RSI OBSERVABILITY: ' + checks + ' checks passed with real ToolRuntime and CSV assertions.');
} finally {
  await authorPreset.dispose();
  await verifierPreset.dispose();
  await ctx.fiber.dispose();
  await fs.rm(root, {recursive: true, force: true});
}
