/**
 * 状态机与 state.yaml 形状的单测。
 *
 * 这部分是纯函数（无 DSH 依赖），所以能脱离 harness 验证。
 * 覆盖重点：
 *   1. **序列化往返** —— state.yaml 是事实来源，读写不一致等于事实被篡改
 *   2. **迁移准入** —— 门槛漏了，状态机就只是装饰
 *   3. **回退放行** —— 发现了更好的方案却不敢改计划，才是真正的失败模式
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSON_SCHEMA, load as parseYaml } from 'js-yaml';
import {
  applyAdvance,
  checkAdvance,
  checkConsistency,
  direction,
  isStatus,
  normalizeArtifactPath,
  normalizeTaskId,
  parseTaskState,
  REQUIRED_ARTIFACTS,
  serializeTaskState,
  STATUSES,
  taskDirFor,
  type TaskState,
} from './state.js';

const baseState = (over: Partial<TaskState> = {}): TaskState => ({
  task: 'PROJ-1',
  title: '客户自助查询理赔状态',
  status: 'INTENT',
  created: '2026-10-07T10:00:00.000Z',
  updated: '2026-10-07T10:00:00.000Z',
  artifacts: { intent: 'intent.md' },
  history: [{ at: '2026-10-07T10:00:00.000Z', from: '', to: 'INTENT', reason: '任务创建' }],
  ...over,
});

// ─────────────────────────────────────────────────────── task id 规范化

test('task id 规范化与校验', () => {
  assert.equal(normalizeTaskId('proj-1024'), 'PROJ-1024');
  assert.equal(normalizeTaskId('  abc1  '), 'ABC1');
  for (const bad of ['', '   ', 'a b', 'a/b', '-ABC', 'ABC-', 'a'.repeat(65), 42, null]) {
    assert.throws(() => normalizeTaskId(bad), /非法 task id|必须是字符串/, `应拒绝: ${String(bad)}`);
  }
});

test('任务目录路径', () => {
  assert.equal(taskDirFor('/repo', 'proj-1'), '/repo/.ai/tasks/PROJ-1');
  assert.equal(taskDirFor('/repo/', 'PROJ-1'), '/repo/.ai/tasks/PROJ-1');
});

// ───────────────────────────────────────────────── 序列化 / 解析往返

test('state.yaml 序列化 → 解析 往返一致（含特殊字符）', () => {
  const state = baseState({
    title: '含: 冒号 与 # 井号 的标题',
    artifacts: { intent: 'intent.md', spec: 'spec.md', plan: 'plan.md' },
    history: [
      { at: '2026-10-07T10:00:00.000Z', from: '', to: 'INTENT', reason: '任务创建' },
      { at: '2026-10-07T11:00:00.000Z', from: 'INTENT', to: 'SPEC', reason: '产品负责人接受意图' },
    ],
  });
  const text = serializeTaskState(state);
  const roundTripped = parseTaskState('PROJ-1', parseYaml(text, { schema: JSON_SCHEMA }));

  // 语义比较：artifacts 在序列化时会按键排序（为了 diff 稳定），
  // 所以不能拿对象键序去比——那是断言取巧，不是事实来源的要求。
  assert.equal(roundTripped.task, state.task);
  assert.equal(roundTripped.title, state.title, 'title 必须逐字一致');
  assert.equal(roundTripped.status, state.status);
  assert.equal(roundTripped.created, state.created, 'created 不能被改写');
  assert.equal(roundTripped.updated, state.updated, 'updated 不能被改写');
  assert.deepEqual(roundTripped.artifacts, state.artifacts, '制品映射内容一致');
  assert.deepEqual(roundTripped.history, state.history, 'history 逐条一致');
});

test('回归：created/updated 缺失时**报错**，不静默填当前时间', () => {
  // 静默补时间等于伪造事实。state.yaml 是事实来源，宁可报错。
  assert.throws(
    () => parseTaskState('PROJ-1', { title: 'x', status: 'INTENT' }),
    /缺少 created/,
  );
  assert.throws(
    () => parseTaskState('PROJ-1', { title: 'x', status: 'INTENT', created: '2026-01-01T00:00:00Z' }),
    /缺少 updated/,
  );
  assert.throws(
    () =>
      parseTaskState('PROJ-1', {
        title: 'x',
        status: 'INTENT',
        created: '   ',
        updated: '2026-01-01T00:00:00Z',
      }),
    /缺少 created/,
  );
});

test('回归：含 YAML 元字符的文本必须能往返（曾写出非法 YAML）', () => {
  // 这条用例的存在理由是一次真实 bug：早先只按首字符决定是否加引号，
  // 于是 `title: 含: 冒号 与 # 井号` 被原样写出 → YAML 语法错误。
  // 写入时看起来正常，**下一次读取才崩**——而 state.yaml 是事实来源。
  const nasty = [
    '含: 冒号 的标题',
    '含 # 井号 的标题',
    'a: b',
    'ends with colon:',
    '#leading hash',
    '带 "引号" 与 \'单引号\'',
    '[看起来像数组]',
    '{看起来像映射}',
    '|管道 >折叠',
    '*别名 &锚点',
    '- 看起来像列表项',
    '  前后有空格  ',
    '制表符\t在中间',
  ];
  for (const title of nasty) {
    const state = baseState({ title });
    const text = serializeTaskState(state);
    let back: TaskState;
    try {
      back = parseTaskState('PROJ-1', parseYaml(text, { schema: JSON_SCHEMA }));
    } catch (e) {
      assert.fail(`含元字符的标题写出的 YAML 无法解析（${JSON.stringify(title)}）：${(e as Error).message.split('\n')[0]}`);
    }
    assert.equal(back.title, title, `标题往返不一致（${JSON.stringify(title)}）`);
  }
});

test('回归：时间戳必须用 JSON_SCHEMA 解析（默认 schema 会转成 Date）', () => {
  // 这个坑会让**读取任何正常写出的 state.yaml 都失败**：
  // js-yaml 默认 schema 把 ISO 时间戳解析成 Date 对象，
  // 而校验要求字符串 → 报 "缺少 created"。
  const text = serializeTaskState(baseState());
  const withDefault = parseYaml(text) as Record<string, unknown>;
  assert.ok(
    withDefault['created'] instanceof Date,
    '前提：默认 schema 确实会把时间戳转成 Date（这条断言本身在锁住那个前提）',
  );
  const withJson = parseYaml(text, { schema: JSON_SCHEMA }) as Record<string, unknown>;
  assert.equal(typeof withJson['created'], 'string', 'JSON_SCHEMA 下时间戳保持字符串');
  assert.doesNotThrow(() => parseTaskState('PROJ-1', withJson));
  // 宽容路径：即使有人用默认 schema 解析，也不该崩
  assert.doesNotThrow(() => parseTaskState('PROJ-1', withDefault));
});

test('序列化拒绝表达不了的值（而不是静默写坏）', () => {
  assert.throws(
    () => serializeTaskState(baseState({ title: '两行\n标题' })),
    /不能包含换行/,
    '含换行的值在单行标量里表达不了，必须报错而不是写坏 YAML',
  );
});

test('空 artifacts / 空 history 能正确往返', () => {
  const state = baseState({ artifacts: {}, history: [] });
  const back = parseTaskState('PROJ-1', parseYaml(serializeTaskState(state)));
  assert.deepEqual(back.artifacts, {});
  assert.deepEqual(back.history, []);
});

// ────────────────────────────────────────────────────────── 制品路径

test('制品路径：必须是相对任务目录的路径', () => {
  assert.equal(normalizeArtifactPath('PROJ-1', 'spec.md'), 'spec.md');
  assert.equal(normalizeArtifactPath('PROJ-1', 'sub/dir/spec.md'), 'sub/dir/spec.md');
  // 从仓库根起的完整路径会被自动剥掉前缀
  assert.equal(
    normalizeArtifactPath('PROJ-1', '.ai/tasks/PROJ-1/spec.md'),
    'spec.md',
    '允许写完整路径，但要归一化为相对路径',
  );
  assert.equal(normalizeArtifactPath('PROJ-1', 'a\\b.md'), 'a/b.md', '反斜杠归一化');
});

test('制品路径：拒绝绝对路径与跳出任务目录', () => {
  for (const bad of ['/etc/passwd', '../outside.md', 'a/../../b.md', '']) {
    assert.throws(() => normalizeArtifactPath('PROJ-1', bad), /绝对路径|跳出任务目录|非空字符串/,
      `应拒绝: ${bad}`);
  }
});

// ──────────────────────────────────────────────────────── 解析的健壮性

test('parseTaskState 对坏输入给出可操作的错误', () => {
  assert.throws(() => parseTaskState('PROJ-1', null), /顶层必须是一个映射/);
  assert.throws(() => parseTaskState('PROJ-1', []), /顶层必须是一个映射/);
  const stamp = { created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' };
  assert.throws(() => parseTaskState('PROJ-1', { status: 'INTENT', ...stamp }), /缺少 title/);
  assert.throws(
    () => parseTaskState('PROJ-1', { title: 'x', status: 'NOPE', ...stamp }),
    /status 非法.*允许值/s,
    '错误信息要列出允许值，否则人只能去翻代码',
  );
  assert.throws(
    () => parseTaskState('PROJ-1', { title: 'x', status: 'INTENT', artifacts: [], ...stamp }),
    /artifacts 必须是映射.*不能是数组/s,
  );
});

// ──────────────────────────────────────────────────────── 状态机方向

test('direction 正确区分前进/回退/不变', () => {
  assert.equal(direction('INTENT', 'SPEC'), 'forward');
  assert.equal(direction('VERIFYING', 'PLANNED'), 'back');
  assert.equal(direction('SPEC', 'SPEC'), 'same');
  assert.equal(STATUSES.length, 7);
  for (const s of STATUSES) assert.equal(isStatus(s), true);
  assert.equal(isStatus('nope'), false);
});

// ─────────────────────────────────────────────────── 迁移准入门槛

test('前进：缺必要制品时拒绝，并说明缺哪个', () => {
  const state = baseState(); // 只有 intent
  const v = checkAdvance('INTENT', 'SPEC', state, () => true, '接受意图');
  assert.equal(v.ok, false);
  assert.equal(v.direction, 'forward');
  assert.ok(
    v.problems.some((p) => p.includes('spec') && p.includes('spec.md')),
    `问题描述要点名缺哪个制品及其文件名，实际：${v.problems.join(' | ')}`,
  );
});

test('前进：制品齐备且文件存在时放行', () => {
  const state = baseState({
    artifacts: { intent: 'intent.md', spec: 'spec.md' },
  });
  const v = checkAdvance('INTENT', 'SPEC', state, () => true, '接受意图');
  assert.equal(v.ok, true, `应放行，实际问题：${v.problems.join(' | ')}`);
});

test('前进：登记了但文件不在磁盘上 → 拒绝', () => {
  const state = baseState({ artifacts: { intent: 'intent.md', spec: 'spec.md' } });
  const v = checkAdvance('INTENT', 'SPEC', state, (rel) => rel !== 'spec.md', '接受意图');
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.includes('磁盘上不存在')), '要区分"没登记"与"文件没了"');
});

test('空 reason 被拒绝（迁移是审计记录）', () => {
  const state = baseState({ artifacts: { intent: 'intent.md', spec: 'spec.md' } });
  const v = checkAdvance('INTENT', 'SPEC', state, () => true, '   ');
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.includes('必须给出 reason')));
});

test('迁移到相同状态被拒绝', () => {
  const v = checkAdvance('SPEC', 'SPEC', baseState(), () => true, 'x');
  assert.equal(v.ok, false);
  assert.equal(v.direction, 'same');
});

test('回退：允许，但同样要求目标状态的制品齐备且给原因', () => {
  // 从 IMPLEMENTING 退回 PLANNED：目标状态需要 intent/spec/plan
  const complete = baseState({
    status: 'IMPLEMENTING',
    artifacts: { intent: 'intent.md', spec: 'spec.md', plan: 'plan.md' },
  });
  const ok = checkAdvance('IMPLEMENTING', 'PLANNED', complete, () => true, '发现计划漏了一个边界条件');
  assert.equal(ok.ok, true, `回退应放行：${ok.problems.join(' | ')}`);
  assert.equal(ok.direction, 'back');

  // 但缺 plan 时回退也不行——否则会退到一个自己都不成立的状态
  const missingPlan = baseState({ status: 'IMPLEMENTING', artifacts: { intent: 'intent.md' } });
  const bad = checkAdvance('IMPLEMENTING', 'PLANNED', missingPlan, () => true, '退回');
  assert.equal(bad.ok, false);
});

test('DONE 需要 verification 与 review 都在', () => {
  const partial = baseState({
    status: 'REVIEWING',
    artifacts: { intent: 'i.md', spec: 's.md', plan: 'p.md', verification: 'verification.json' },
  });
  const v = checkAdvance('REVIEWING', 'DONE', partial, () => true, '评审通过');
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.includes('review')));
});

// ──────────────────────────────────────────────────────── 状态自洽检查

test('checkConsistency 区分"状态超前"与"文件丢失"', () => {
  // 状态是 PLANNED（需要 intent/spec/plan），但只登记了 intent
  const state = baseState({ status: 'PLANNED', artifacts: { intent: 'intent.md' } });
  const r = checkConsistency(state, (rel) => rel !== 'intent.md');
  assert.deepEqual(r.missingForStatus, ['spec', 'plan'], '应报告状态超前的缺失');
  assert.deepEqual(r.missingOnDisk, ['intent.md'], '应报告磁盘上找不到的文件');
});

test('checkConsistency 在完全自洽时为空', () => {
  const state = baseState({
    status: 'SPEC',
    artifacts: { intent: 'intent.md', spec: 'spec.md' },
  });
  const r = checkConsistency(state, () => true);
  assert.deepEqual(r.missingForStatus, []);
  assert.deepEqual(r.missingOnDisk, []);
});

// ──────────────────────────────────────────────────────── applyAdvance

test('applyAdvance 追加 history 并更新 updated，不改 created', () => {
  const state = baseState({ artifacts: { intent: 'intent.md', spec: 'spec.md' } });
  const next = applyAdvance(state, 'SPEC', '接受意图', '2026-10-08T09:00:00.000Z');
  assert.equal(next.status, 'SPEC');
  assert.equal(next.created, state.created, 'created 不能被迁移改写');
  assert.equal(next.updated, '2026-10-08T09:00:00.000Z');
  assert.equal(next.history.length, state.history.length + 1);
  const last = next.history[next.history.length - 1];
  assert.deepEqual(last, {
    at: '2026-10-08T09:00:00.000Z',
    from: 'INTENT',
    to: 'SPEC',
    reason: '接受意图',
  });
  // 原对象不被修改（纯函数）
  assert.equal(state.history.length, 1, 'applyAdvance 不应就地修改入参');
});

// ─────────────────────────────────────────── 门槛表本身的完整性

test('门槛表覆盖全部状态，且随状态单调不减', () => {
  for (const s of STATUSES) {
    assert.ok(Array.isArray(REQUIRED_ARTIFACTS[s]), `${s} 缺少门槛定义`);
  }
  for (let i = 1; i < STATUSES.length; i += 1) {
    const prev = REQUIRED_ARTIFACTS[STATUSES[i - 1] as (typeof STATUSES)[number]];
    const cur = REQUIRED_ARTIFACTS[STATUSES[i] as (typeof STATUSES)[number]];
    for (const k of prev) {
      assert.ok(cur.includes(k), `${STATUSES[i]} 的门槛应包含 ${STATUSES[i - 1]} 的 ${k}（不能越走越松）`);
    }
  }
});

// ─────────────────────────── 空 artifacts 的序列化（测试场抓到的真实缺陷）

test('回归：空 artifacts 不写 {} 占位符（否则第一个制品的登记会写坏事实来源）', () => {
  // 缺陷原貌：序列化器对空 artifacts 写
  //     artifacts:
  //       {}
  // 而"登记制品"是在 artifacts: 之后、缩进块结束处插一行——它把 `{}` 当成
  // 一条已有条目，插在**它后面**，产生非法缩进：
  //     artifacts:
  //       {}
  //       intent: "intent.md"
  // 于是整个 state.yaml 解析失败。后果：artifacts 为空时，
  // **第一个制品的登记就会写坏 state.yaml**——而它是事实来源。
  const empty = baseState({ artifacts: {} });
  const text = serializeTaskState(empty);

  assert.ok(!/^\s*\{\}\s*$/m.test(text), `空 artifacts 不该出现 {} 占位符：\n${text}`);

  // 空映射仍要能往返
  const back = parseTaskState('PROJ-1', parseYaml(text, { schema: JSON_SCHEMA }));
  assert.deepEqual(back.artifacts, {});

  // 关键：模拟**真实调用方**的登记做法（sdlc-artifact / sdlc-verify 的
  // registerArtifact：在 artifacts 段末尾插一行）。
  // 它必须同时处理两种形态：`artifacts: {}`（同一行）与 `artifacts:` + 缩进块。
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^artifacts:\s*(\{\s*\})?\s*$/.test(l));
  assert.ok(start >= 0, `应有 artifacts 行：\n${text}`);

  if (/^artifacts:\s*\{\s*\}\s*$/.test(lines[start] ?? '')) {
    // 空映射写成同一行 → 直接把这一行换掉
    lines[start] = 'artifacts:\n  intent: "intent.md"';
  } else {
    let insertAt = start + 1;
    while (insertAt < lines.length && /^\s{2}\S/.test(lines[insertAt] ?? '')) insertAt += 1;
    lines.splice(insertAt, 0, '  intent: "intent.md"');
  }
  const afterRegister = lines.join('\n');

  const reparsed = parseTaskState(
    'PROJ-1',
    parseYaml(afterRegister, { schema: JSON_SCHEMA }),
  );
  assert.deepEqual(
    reparsed.artifacts,
    { intent: 'intent.md' },
    `登记一行后必须是合法 YAML 且解析出该制品。实际文本：\n${afterRegister}`,
  );
});

test('回归：非空 artifacts 可以继续追加登记（不破坏已有条目）', () => {
  const text = serializeTaskState(baseState({ artifacts: { intent: 'intent.md' } }));
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^artifacts:\s*$/.test(l));
  let insertAt = start + 1;
  while (insertAt < lines.length && /^\s{2}\S/.test(lines[insertAt] ?? '')) insertAt += 1;
  lines.splice(insertAt, 0, '  spec: "spec.md"');
  const back = parseTaskState('PROJ-1', parseYaml(lines.join('\n'), { schema: JSON_SCHEMA }));
  assert.deepEqual(back.artifacts, { intent: 'intent.md', spec: 'spec.md' });
});
