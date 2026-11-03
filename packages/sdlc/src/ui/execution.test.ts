import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

// Dynamic import keeps the first red run an assertion about the missing reader.
const modulePath = './execution.js';
const implementation = await import(modulePath).catch(() => ({}));
const at = (n: number) => new Date(Date.UTC(2026, 9, 28, 1, n)).toISOString();

async function fixture(t: test.TestContext, taskId = 'TASK-1') {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'sdlc-execution-'));
  t.after(() => fs.rm(repoRoot, {recursive: true, force: true}));
  // macOS 的 tmpdir 是 /var/... 的符号链接；必须用真实路径算相对 reads，
  // 否则 read 断言会得到 ../../private/var/... 而恒真（Linux CI 才暴露）。
  const rootKey = realpathSync(repoRoot);
  const reads: string[] = [];
  const writes = async (relative: string, value: unknown) => {
    const file = path.join(repoRoot, relative);
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const canonical = (p: string): string => {
    try { return realpathSync(p); } catch { return p; }
  };
  const api = {
    async resolve(p: string, options: {cwd: string}) {
      const displayPath = canonical(path.resolve(options.cwd, p));
      return {targetKey: `file:${displayPath}`, displayPath};
    },
    contains(parent: {displayPath: string}, child: {displayPath: string}) {
      const rel = path.relative(parent.displayPath, child.displayPath);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    },
    async stat(target: {displayPath: string}) {
      try { const stat = await fs.stat(target.displayPath); return {type: stat.isFile() ? 'file' : 'directory', size: stat.size}; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
    },
    async readBytes(target: {displayPath: string}, _signal: unknown, maxBytes: number) {
      reads.push(path.relative(rootKey, target.displayPath));
      const stat = await fs.stat(target.displayPath);
      if (stat.size > maxBytes) throw new Error('FS_TOO_LARGE');
      return new Uint8Array(await fs.readFile(target.displayPath));
    },
    async listDir(target: {displayPath: string}) {
      reads.push(path.relative(rootKey, target.displayPath) + '/');
      return (await fs.readdir(target.displayPath, {withFileTypes: true})).map(entry => ({name: entry.name, type: entry.isDirectory() ? 'directory' : 'file'}));
    },
  };
  const state = async (history = '') => writes(`.ai/tasks/${taskId}/state.yaml`, `task: ${taskId}\nstatus: VERIFYING\ntitle: Fixture\nartifacts: {}\nhistory:\n${history}`);
  await state();
  const manifest = async (runs: unknown[] = [], sessions: unknown[] = [], extra = {}, rsiDir = '.ai/rsi') => writes(`${rsiDir}/tasks/${taskId}/task.json`, {
    schema_version: 1, task_id: taskId, task_dir: `.ai/tasks/${taskId}`, workspace: repoRoot,
    status: 'VERIFYING', title: 'Fixture', sessions, runs, checkpoints: [], issues: [], ...extra,
  });
  const run = async (id: string, startMinute: number, outcome = 'reject', attempts = 1, extraInputs = {}, rsiDir = '.ai/rsi') => {
    const entries: {kind: string; data: unknown}[] = [{kind: 'started', data: {inputs: {task_id: taskId, criteria: ['行为正确'], ...extraInputs}, parent_session_id: 'author'}}];
    for (let i = 1; i <= attempts; i++) entries.push({kind: 'attempt_started', data: {attempt: i}});
    if (outcome !== 'incomplete') entries.push({kind: 'finished', data: ['approve', 'reject', 'needs_human'].includes(outcome)
      ? {outcome: 'completed', result: {status: outcome, summary: `${id} 的裁决`, findings: [{severity: 'important', reason: '边界行为未满足', evidence: '失败测试'}], criteria_results: [{result: 'not_met', evidence: '测试失败'}]}}
      : {outcome}});
    for (const [seq, entry] of entries.entries()) await writes(`${rsiDir}/runs/${id}/${String(seq).padStart(6, '0')}.json`, {schema_version: 1, run_id: id, seq, at: at(startMinute + seq), ...entry});
  };
  const trace = async (id: string, role: string, events: unknown[], extra = {}) => writes(`.ai/rsi/tasks/${taskId}/sessions/${id}.json`, {
    session_id: id, role, source_verified: true, truncated: false, issues: [], events, ...extra,
  });
  const read = async (options = {}) => {
    assert.equal(typeof implementation.readExecution, 'function', 'execution reader is exported');
    return implementation.readExecution(api, {repoRoot, taskId, ...options});
  };
  return {repoRoot, taskId, reads, writes, state, manifest, run, trace, read};
}
const session = (id: string, role = 'author', extra = {}) => ({id, role, windows: [{from: 0, to: null, registered: 0}], ...extra});
const call = (seq: number, id: string, name: string, args: unknown = {}) => ({seq, time: Date.parse(at(seq)), type: 'tool/call', data: {callId: id, name, arguments: JSON.stringify(args)}});
const result = (seq: number, id: string, isError = false) => ({seq, time: Date.parse(at(seq)), type: 'tool/result', data: {message: {toolCallId: id, isError, content: [{type: 'text', text: 'PRIVATE_TOOL_OUTPUT'}]}}});

test('按验证调用排序；一次调用的重试不变成新一轮，拒绝也不等于修复', async t => {
  const f = await fixture(t); await f.manifest(['later', 'earlier']);
  await f.run('later', 20, 'approve'); await f.run('earlier', 1, 'reject', 2);
  const value = await f.read();
  assert.deepEqual(value.rounds.map((r: any) => [r.id, r.number, r.attemptCount, r.outcome]), [['earlier', 1, 2, 'reject'], ['later', 2, 1, 'approve']]);
  assert.equal(value.rounds[0].source, 'rsi'); assert.deepEqual(value.repairs, []);
  assert.deepEqual(value.rounds[0].criteria, [{criterion: '行为正确', status: 'not_met', evidence: '测试失败'}]);
});

test('取消、无裁决、错误和缺结束记录分别保留；缺结束不声称正在运行', async t => {
  const f = await fixture(t); const outcomes = ['cancelled', 'no_verdict', 'error', 'incomplete']; await f.manifest(outcomes);
  for (const [i, outcome] of outcomes.entries()) await f.run(outcome, i * 10, outcome);
  const value = await f.read(); assert.deepEqual(value.rounds.map((r: any) => r.outcome), outcomes);
  assert.equal(value.rounds.at(-1).finishedAt, null); assert.equal(value.status, 'partial');
  assert.doesNotMatch(JSON.stringify(value), /正在运行|active/);
});

test('大量轮次保留最近结果，并说明早期记录未展示', async t => {
  const f = await fixture(t), runs = Array.from({length: 52}, (_, i) => `run-${i}`);
  await f.manifest(runs);
  for (const [i, id] of runs.entries()) await f.run(id, i * 4, i === 51 ? 'approve' : 'reject');
  const value = await f.read();
  assert.equal(value.rounds.length, 50); assert.equal(value.rounds.at(-1).id, 'run-51');
  assert.equal(value.rounds.at(-1).number, 52); assert.equal(value.rounds.at(-1).outcome, 'approve');
  assert.ok(value.issues.some((s: string) => s.includes('最近登记')));
});

test('通过裁决仍保留验证者明确未复核的事项', async t => {
  const f = await fixture(t); await f.manifest(['round']); await f.run('round', 1, 'approve');
  await f.writes('.ai/rsi/runs/round/000002.json', {schema_version: 1, run_id: 'round', seq: 2, at: at(3), kind: 'finished', data: {outcome: 'completed', result: {status: 'approve', summary: '本地检查通过', unverified: ['未验证线上环境']}}});
  assert.deepEqual((await f.read()).rounds[0].unverified, ['未验证线上环境']);
});

test('只把同任务且成功返回的 fix 调用与实际状态回退作为修复记录', async t => {
  const f = await fixture(t); await f.manifest(['reject'], [session('author')]); await f.run('reject', 1);
  await f.state(`  - at: "${at(0)}"\n    from: IMPLEMENTING\n    to: VERIFYING\n    reason: 提交验证\n  - at: "${at(5)}"\n    from: VERIFYING\n    to: IMPLEMENTING\n    reason: 处理边界问题\n`);
  await f.trace('author', 'author', [call(0, 'start', 'sdlc_fix_start', {task_id: 'TASK-1', reason: '复现边界'}), result(1, 'start'), call(2, 'wrong', 'sdlc_fix_end', {task_id: 'OTHER'}), result(3, 'wrong'), call(4, 'failed', 'sdlc_fix_end', {task_id: 'TASK-1'}), result(5, 'failed', true), call(6, 'pending', 'sdlc_fix_end', {task_id: 'TASK-1'}), call(7, 'end', 'sdlc_fix_end', {task_id: 'TASK-1', reason: '原测试通过'}), result(8, 'end')]);
  const value = await f.read(); assert.deepEqual(value.repairs.map((r: any) => r.kind).sort(), ['backtrack', 'fix_end', 'fix_start']);
  assert.ok(value.repairs.every((r: any) => r.source)); assert.doesNotMatch(JSON.stringify(value), /PRIVATE_TOOL_OUTPUT/);
});

test('每轮只显示显式关联验证者的工具摘要，不泄漏参数、输出、配置或思考', async t => {
  const f = await fixture(t); await f.manifest(['round'], [session('child', 'verifier', {parent: 'author'}), session('unrelated', 'verifier')]);
  await f.run('round', 1); await f.writes('.ai/rsi/runs/round/000002.json', {schema_version: 1, run_id: 'round', seq: 2, at: at(3), kind: 'attempt_session', data: {attempt: 1, session_id: 'child'}});
  await f.writes('.ai/rsi/runs/round/000003.json', {schema_version: 1, run_id: 'round', seq: 3, at: at(4), kind: 'finished', data: {outcome: 'completed', result: {status: 'reject', summary: '需要修复', findings: []}}});
  await f.trace('child', 'verifier', [call(0, 'read', 'read', {file_path: 'SECRET_INPUT'}), result(1, 'read'), {seq: 2, type: 'assistant/reasoning', data: {text: 'HIDDEN_REASONING'}}]);
  await f.trace('unrelated', 'verifier', [call(0, 'other', 'UNRELATED_TOOL'), result(1, 'other')]);
  const value = await f.read(); assert.equal(value.rounds[0].toolEvents[0].name, 'read'); assert.equal(value.rounds[0].toolEvents[0].status, 'completed');
  assert.doesNotMatch(JSON.stringify(value), /SECRET_INPUT|PRIVATE_TOOL_OUTPUT|HIDDEN_REASONING|UNRELATED_TOOL/);
  assert.ok(!f.reads.some(p => p.endsWith('/unrelated.json')));
});

test('损坏和其他任务的记录不会吞掉正确轮次，也不会混入错归属裁决', async t => {
  const f = await fixture(t); await f.manifest(['good', 'broken', 'wrong', '../escape']); await f.run('good', 1); await f.run('wrong', 20, 'approve', 1, {task_id: 'OTHER'});
  await f.writes('.ai/rsi/runs/broken/000000.json', '{bad');
  const value = await f.read(); assert.equal(value.status, 'partial'); assert.deepEqual(value.rounds.map((r: any) => r.id), ['good']);
  assert.ok(value.issues.length >= 3);
});

test('中间记录损坏仍保留已核对的开始、结束与裁决，并明确证据缺口', async t => {
  const f = await fixture(t); await f.manifest(['round']); await f.run('round', 1, 'approve');
  await f.writes('.ai/rsi/runs/round/000001.json', '{bad'); const value = await f.read();
  assert.equal(value.rounds[0].outcome, 'approve'); assert.equal(value.status, 'partial'); assert.ok(value.issues.length);
});

test('索引的工作区或任务归属不符时拒绝所有历史内容', async t => {
  const f = await fixture(t); await f.run('wrong', 1); await f.manifest(['wrong'], [], {workspace: '/other'});
  let value = await f.read(); assert.deepEqual(value.rounds, []); assert.equal(value.status, 'unavailable');
  await f.manifest(['wrong'], [], {task_id: 'OTHER'}); value = await f.read(); assert.deepEqual(value.rounds, []);
});

test('旧任务只有当前裁决时不编造此前循环', async t => {
  const f = await fixture(t); await f.run('unknown-history', 1); await f.writes('.ai/tasks/TASK-1/verification.json', {task: 'TASK-1', at: at(1), criteria: ['行为正确'], verdict: {status: 'reject', summary: '当前结论', verifier_attempts: 2, findings: []}});
  const value = await f.read(); assert.equal(value.rounds.length, 1); assert.equal(value.rounds[0].source, 'current_verdict'); assert.equal(value.status, 'partial');
  // manifest 缺失时会扫描 .ai/rsi/runs 做旧轮次恢复，但必须同时核对任务号和制品归属；
  // 这里的 run 没有 prepared 制品，因此不得产出 rsi 轮次，也不得伪造退回。
  assert.deepEqual(value.repairs, []); assert.ok(!value.rounds.some((r: {source: string}) => r.source === 'rsi'));
  assert.match(value.issues.join(' '), /历史/);
});

test('旧裁决缺失或 task 不符时不产生轮次', async t => {
  const f = await fixture(t); assert.equal((await f.read()).status, 'unavailable');
  await f.writes('.ai/tasks/TASK-1/verification.json', {task: 'OTHER', verdict: {status: 'approve'}});
  assert.deepEqual((await f.read()).rounds, []);
});

test('符号链接不能把 RSI 或单条记录引向工作区外', async t => {
  const f = await fixture(t); const outside = await fixture(t, 'OUTSIDE');
  await outside.writes('secret/000000.json', {schema_version: 1, run_id: 'escaped', seq: 0, at: at(0), kind: 'started', data: {inputs: {task_id: 'TASK-1', intent_of_change: 'PRIVATE_OUTSIDE'}}});
  await f.manifest(['escaped']); await fs.mkdir(path.join(f.repoRoot, '.ai/rsi/runs'), {recursive: true});
  await fs.symlink(path.join(outside.repoRoot, 'secret'), path.join(f.repoRoot, '.ai/rsi/runs/escaped'));
  const value = await f.read(); assert.equal(value.status, 'unavailable'); assert.deepEqual(value.rounds, []); assert.doesNotMatch(JSON.stringify(value), /PRIVATE_OUTSIDE/);
});

test('读取有上限；超大事件不阻塞其余可核对记录', async t => {
  const f = await fixture(t); await f.manifest(['round']); await f.run('round', 1); await f.writes('.ai/rsi/runs/round/000001.json', 'x'.repeat(3 * 1024 * 1024));
  const value = await f.read(); assert.equal(value.rounds[0].outcome, 'reject'); assert.equal(value.status, 'partial');
  assert.ok(value.issues.length); assert.ok(!f.reads.includes('.ai/rsi/runs/round/000001.json'));
});

test('自定义 RSI 目录可读，返回受限且没有创建或改写任何文件', async t => {
  const f = await fixture(t); await f.manifest(['custom'], [], {}, '.records'); await f.run('custom', 1, 'reject', 1, {test_evidence: '测试通过', intent_of_change: '修复边界', diff: 'RAW_CODE_SECRET'}, '.records');
  const before = await fs.readdir(f.repoRoot, {recursive: true}); const value = await f.read({rsiDir: '.records'});
  assert.equal(value.rounds[0].testEvidence, '测试通过'); assert.equal(value.rounds[0].changesSummary, '修复边界');
  assert.doesNotMatch(JSON.stringify(value), /RAW_CODE_SECRET/); assert.deepEqual(await fs.readdir(f.repoRoot, {recursive: true}), before);
});

test('正常采集的 4–16 MiB 会话仍可恢复成功动作，消息正文不进入响应', async t => {
  const f = await fixture(t); await f.manifest(['round'],[session('author')]);await f.run('round',1);
  await f.trace('author','author',[
    {seq:0,type:'assistant/message',data:{content:'PRIVATE_REASONING'.repeat(400000)}},
    call(1,'edit-1','edit',{path:'src/product.ts',new_string:'PRIVATE_CODE'}),result(2,'edit-1'),
    call(3,'start','sdlc_fix_start',{task_id:'TASK-1',reason:'fix consumer'}),result(4,'start'),
  ]);
  const value=await f.read();
  assert.equal(value.repairs[0].kind,'fix_start'); assert.match(value.activities[0].summary,/src\/product.ts/);
  assert.doesNotMatch(JSON.stringify(value),/PRIVATE_CODE|PRIVATE_REASONING|读取上限/);
});
test('优先使用精简过程记录，不读取原始长会话和工具输出', async t => {
  const f=await fixture(t);await f.manifest(['round'],[session('author')]);await f.run('round',1);
  await f.trace('author','author',[],{secret:'PRIVATE_CONFIG'});
  await f.writes('.ai/rsi/tasks/TASK-1/sessions/author.view.json',{schema_version:1,session_id:'author',role:'author',source_verified:true,truncated:false,issues:[],events:[call(0,'start','sdlc_fix_start',{task_id:'TASK-1',reason:'compact'}),result(1,'start')]});
  const value=await f.read(); assert.equal(value.repairs[0].kind,'fix_start');
  assert.ok(!f.reads.includes('.ai/rsi/tasks/TASK-1/sessions/author.json')); assert.doesNotMatch(JSON.stringify(value),/PRIVATE_CONFIG/);
});
test('旧轮次恢复必须同时核对任务 ID 和制品实际归属，不能借用别的任务', async t => {
  const f=await fixture(t);await f.run('old',1);await f.run('wrong',6);
  await f.writes('.ai/tasks/TASK-1/spec.md','# acceptance');
  await f.writes('.ai/rsi/runs/old/000001.json',{schema_version:1,run_id:'old',seq:1,kind:'prepared',at:at(2),data:{artifacts:{spec:path.join(f.repoRoot,'.ai/tasks/TASK-1/spec.md')},prompt:'PRIVATE_PROMPT'}});
  await f.writes('.ai/rsi/runs/wrong/000001.json',{schema_version:1,run_id:'wrong',seq:1,kind:'prepared',at:at(7),data:{artifacts:{spec:path.join(f.repoRoot,'.ai/tasks/OTHER/spec.md')}}});
  const value=await f.read(); assert.deepEqual(value.rounds.map((r:any)=>r.id),['old']);assert.deepEqual(value.repairs,[]);
  assert.match(value.issues.join(' '),/旧验证轮次/);assert.doesNotMatch(JSON.stringify(value),/PRIVATE_PROMPT/);
});
test('任务内的问题和精简裁决不依赖 RSI 会话，按页返回明确关联的动作', async t => {
  const f=await fixture(t);
  const issues=Array.from({length:21},(_,i)=>({id:`issue-${i}`,source:'review',severity:'blocking',blocking:true,description:`问题 ${i}`,evidence:'probe',status:'submitted',actions:[{id:`action-${i}`,at:at(1),actor:'author',kind:'started',from:'REVIEWING',to:'IMPLEMENTING',reason:'修复最终行为',evidence:'tests/consumer'}]}));
  await f.writes('.ai/tasks/TASK-1/state.yaml',{task:'TASK-1',history:[],workflow:{version:1,issues,runs:[{id:'r1',started_at:at(1),finished_at:at(2),outcome:'approve',file:'verifications/r1.json',summary:'verified'}],latest_run:'r1'}});
  await f.writes('.ai/tasks/TASK-1/verifications/r1.json',{schema_version:2,task:'TASK-1',criteria:['actual behavior'],verdict:{verification_run_id:'r1',status:'approve',summary:'probe',findings:[],criteria_results:[]},raw_verdict:{hidden:'PRIVATE_RAW'}});
  const page1=await f.read(),page2=await f.read({findingOffset:20});
  assert.equal(page1.findings.length,20);assert.equal(page1.findingNext,20);assert.equal(page2.findings[0].id,'issue-20');assert.equal(page2.findingNext,null);
  assert.equal(page1.rounds[0].source,'task_record');assert.equal(page1.findings[0].actions[0].to,'IMPLEMENTING');assert.doesNotMatch(JSON.stringify(page1),/PRIVATE_RAW/);
});
test('损坏或不支持版本的 acceptance 只回退本轮标准文本，不吞掉整轮执行记录', async t => {
  const f = await fixture(t); await f.manifest(['bad-reject', 'bad-approve']);
  const write = async (id: string, finish: unknown) => {
    await f.writes(`.ai/rsi/runs/${id}/000000.json`, {schema_version: 1, run_id: id, seq: 0, at: at(1), kind: 'started', data: {inputs: {task_id: 'TASK-1', criteria: ['行为正确']}}});
    await f.writes(`.ai/rsi/runs/${id}/000001.json`, {schema_version: 1, run_id: id, seq: 1, at: at(2), kind: 'prepared', data: {criteria: ['行为正确'], acceptance: {version: 1}}});
    await f.writes(`.ai/rsi/runs/${id}/000002.json`, {schema_version: 1, run_id: id, seq: 2, at: at(3), kind: 'finished', data: finish});
  };
  await write('bad-reject', {outcome: 'completed', result: {status: 'reject', summary: '当前结论', findings: [], criteria_results: [{result: 'not_met', evidence: '失败测试'}]}});
  await write('bad-approve', {outcome: 'completed', result: {status: 'approve', summary: '通过', findings: [], criteria_results: [{result: 'met', evidence: '通过测试'}]}});
  const value = await f.read();
  assert.deepEqual(value.rounds.map((r: {id: string}) => r.id).sort(), ['bad-approve', 'bad-reject']);
  assert.ok(value.issues.some((i: string) => i.includes('验收标准来源受损')));
});
