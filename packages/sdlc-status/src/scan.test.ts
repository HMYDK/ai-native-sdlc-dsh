/**
 * 跨任务扫描的单测。
 *
 * 这个插件的价值全在**聚合**上，所以测试也集中在那里。三个重点：
 *   1. **坏任务不能拖垮全局**——一个 state.yaml 被手改坏，看板仍要报出其它任务
 *      （出问题的时候最需要能看到东西）
 *   2. `verification.json` 的解析必须容错——它是另一个插件写的，格式演进时要降级而非崩
 *   3. 状态分类要与 sdlc-task 的**同一份**门槛定义一致（不是各写一份）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanTasks, summarize, summarizeVerdict, type ScanInput } from './scan.js';

/** 造一个合法的 state.yaml 文本。 */
function stateYaml(over: {
  task: string;
  status: string;
  artifacts?: Record<string, string>;
  title?: string;
}): string {
  const arts = over.artifacts ?? {};
  return [
    `task: ${over.task}`,
    `title: ${JSON.stringify(over.title ?? '标题')}`,
    `status: ${over.status}`,
    'created: "2026-10-07T10:00:00.000Z"',
    'updated: "2026-10-07T10:00:00.000Z"',
    'artifacts:',
    ...Object.entries(arts).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`),
    'history: []',
    '',
  ].join('\n');
}

function verdictJson(over: {
  status: string;
  criteria?: number;
  results?: Array<'met' | 'not_met' | 'cannot_tell'>;
}): string {
  return JSON.stringify({
    task: 'T',
    at: '2026-10-07T12:00:00.000Z',
    criteria: Array.from({ length: over.criteria ?? 0 }, (_, i) => `c${i}`),
    verdict: {
      status: over.status,
      summary: 's',
      findings: [],
      ...(over.results !== undefined
        ? {
            criteria_results: over.results.map((r, i) => ({
              criterion: `c${i}`,
              result: r,
              evidence: 'e',
            })),
          }
        : {}),
    },
  });
}

/** 便捷构造：任务 → 文件内容。 */
function inputOf(files: Record<string, Record<string, string>>): ScanInput {
  const dirs = Object.entries(files).map(([task, f]) => ({ task, files: Object.keys(f) }));
  return {
    dirs,
    readFile: (task, rel) => files[task]?.[rel],
  };
}

test('齐备的任务判为 ok，并带出状态与标题', () => {
  const r = scanTasks(
    inputOf({
      'PROJ-1': {
        'state.yaml': stateYaml({
          task: 'PROJ-1',
          status: 'SPEC',
          title: '带标题',
          artifacts: { intent: 'intent.md', spec: 'spec.md' },
        }),
        'intent.md': 'x',
        'spec.md': 'x',
      },
    }),
  );
  assert.equal(r.tasks.length, 1);
  const t = r.tasks[0]!;
  assert.equal(t.health, 'ok');
  assert.equal(t.status, 'SPEC');
  assert.equal(t.title, '带标题');
  assert.deepEqual(t.missingForStatus, []);
  assert.deepEqual(t.missingOnDisk, []);
  assert.equal(r.counts.ok, 1);
});

test('状态要求但未登记的制品 → incomplete，并点名缺哪个', () => {
  const r = scanTasks(
    inputOf({
      'PROJ-1': {
        'state.yaml': stateYaml({
          task: 'PROJ-1',
          status: 'PLANNED',
          artifacts: { intent: 'intent.md' },
        }),
        'intent.md': 'x',
      },
    }),
  );
  const t = r.tasks[0]!;
  assert.equal(t.health, 'incomplete');
  assert.equal(t.missingForStatus.length, 2, 'PLANNED 需要 intent/spec/plan，只登记了 intent');
  assert.ok(t.missingForStatus.some((m) => m.includes('spec')));
  assert.ok(t.missingForStatus.some((m) => m.includes('spec.md')), '要点名文件名，而不是只给键');
});

test('登记了但磁盘上没有 → incomplete，且与"未登记"分开报', () => {
  const r = scanTasks(
    inputOf({
      'PROJ-1': {
        'state.yaml': stateYaml({
          task: 'PROJ-1',
          status: 'SPEC',
          artifacts: { intent: 'intent.md', spec: 'spec.md' },
        }),
        'intent.md': 'x',
        // spec.md 文件缺失
      },
    }),
  );
  const t = r.tasks[0]!;
  assert.equal(t.health, 'incomplete');
  assert.deepEqual(t.missingForStatus, [], '制品都登记了');
  assert.deepEqual(t.missingOnDisk, ['spec.md'], '要说清是文件不见了');
});

test('nextRequired 回答"下一步还缺什么"', () => {
  const r = scanTasks(
    inputOf({
      'PROJ-1': {
        'state.yaml': stateYaml({
          task: 'PROJ-1',
          status: 'INTENT',
          artifacts: { intent: 'intent.md' },
        }),
        'intent.md': 'x',
      },
    }),
  );
  assert.deepEqual(r.tasks[0]!.nextRequired, ['spec(spec.md)']);
});

test('回归：坏掉的任务不能拖垮全局（出问题时要能看见别的）', () => {
  const r = scanTasks(
    inputOf({
      'BROKEN': { 'state.yaml': '这不是 YAML: [ 未闭合\n' },
      'GOOD': {
        'state.yaml': stateYaml({ task: 'GOOD', status: 'SPEC', artifacts: { intent: 'i.md', spec: 's.md' } }),
        'i.md': 'x',
        's.md': 'x',
      },
    }),
  );
  assert.equal(r.counts.total, 2);
  assert.equal(r.counts.error, 1);
  assert.equal(r.counts.ok, 1, '好任务必须仍然被报出来');
  const broken = r.tasks.find((t) => t.task === 'BROKEN')!;
  assert.equal(broken.health, 'error');
  assert.match(broken.error ?? '', /无法解析/);
  assert.equal(broken.status, undefined);
});

test('state.yaml 形状合法但语义不合法 → error，错误信息可操作', () => {
  const r = scanTasks(
    inputOf({
      'PROJ-1': { 'state.yaml': stateYaml({ task: 'PROJ-1', status: 'NOPE' }) },
    }),
  );
  const t = r.tasks[0]!;
  assert.equal(t.health, 'error');
  assert.match(t.error ?? '', /允许值/, '要说清合法值，否则人只能去翻代码');
});

test('目录里没有 state.yaml → error（而不是静默忽略）', () => {
  const r = scanTasks(inputOf({ 'NOT-A-TASK': { 'readme.txt': 'x' } }));
  assert.equal(r.tasks.length, 1);
  assert.equal(r.tasks[0]!.health, 'error');
  assert.match(r.tasks[0]!.error ?? '', /没有 state\.yaml/);
});

test('空目录被跳过（不算任务，也不算错误）', () => {
  const r = scanTasks({ dirs: [{ task: 'EMPTY', files: [] }], readFile: () => undefined });
  assert.equal(r.counts.total, 0);
});

test('裁决摘要：正常解析并统计逐条结果', () => {
  const v = summarizeVerdict(
    verdictJson({ status: 'approve', criteria: 3, results: ['met', 'met', 'cannot_tell'] }),
  );
  assert.ok(v);
  assert.equal(v.status, 'approve');
  assert.equal(v.criteria, 3);
  assert.equal(v.met, 2);
  assert.equal(v.cannotTell, 1);
  assert.equal(v.notMet, 0);
});

test('回归：verification.json 坏掉时降级为"无裁决"，不抛错', () => {
  // 这个文件是**另一个插件**写的。格式演进或写入中断时，
  // 看板不能因此整体报错——那会让人在最需要信息的时候失去信息。
  for (const bad of ['{ 不是 JSON', '', 'null', '[]', '{"verdict":null}', '{"verdict":{}}', '"字符串"']) {
    assert.equal(summarizeVerdict(bad), undefined, `应容错: ${JSON.stringify(bad)}`);
  }
  const r = scanTasks(
    inputOf({
      'PROJ-1': {
        'state.yaml': stateYaml({ task: 'PROJ-1', status: 'SPEC', artifacts: { intent: 'i.md', spec: 's.md' } }),
        'i.md': 'x',
        's.md': 'x',
        'verification.json': '{ 坏掉的 JSON',
      },
    }),
  );
  assert.equal(r.tasks[0]!.health, 'ok', '坏裁决不该影响任务本身的健康度');
  assert.equal(r.tasks[0]!.verdict, undefined);
  assert.equal(r.counts.verdicts.none, 1);
});

test('裁决统计：approve / reject / needs_human / 未验证 分开计', () => {
  const mk = (task: string, vj?: string) => ({
    'state.yaml': stateYaml({ task, status: 'VERIFYING', artifacts: { intent: 'i.md', spec: 's.md', plan: 'p.md' } }),
    'i.md': 'x',
    's.md': 'x',
    'p.md': 'x',
    ...(vj !== undefined ? { 'verification.json': vj } : {}),
  });
  const r = scanTasks(
    inputOf({
      A: mk('A', verdictJson({ status: 'approve', criteria: 1, results: ['met'] })),
      B: mk('B', verdictJson({ status: 'reject', criteria: 1, results: ['not_met'] })),
      C: mk('C', verdictJson({ status: 'needs_human', criteria: 1, results: ['cannot_tell'] })),
      D: mk('D'),
    }),
  );
  assert.deepEqual(r.counts.verdicts, { approve: 1, reject: 1, needs_human: 1, none: 1 });
});

test('展示顺序按流程推进，坏任务排最前', () => {
  const mk = (task: string, status: string) => ({
    'state.yaml': stateYaml({ task, status, artifacts: { intent: 'i.md', spec: 's.md', plan: 'p.md' } }),
    'i.md': 'x',
    's.md': 'x',
    'p.md': 'x',
  });
  const r = scanTasks(
    inputOf({
      'Z-DONE': mk('Z-DONE', 'DONE'),
      'A-INTENT': mk('A-INTENT', 'INTENT'),
      'M-SPEC': mk('M-SPEC', 'SPEC'),
      BROKEN: { 'state.yaml': '[' },
    }),
  );
  const order = r.tasks.map((t) => t.task);
  // 坏掉的排最前——它需要人处理，不该埋在中间
  assert.equal(order[0], 'BROKEN', '坏任务要显眼，不是按状态排在后面');
  // 正常的按流程推进
  assert.ok(order.indexOf('A-INTENT') < order.indexOf('M-SPEC'));
  assert.ok(order.indexOf('M-SPEC') < order.indexOf('Z-DONE'));
});

test('VERIFYING 只要求 intent/spec/plan（与 sdlc-task 一致）', () => {
  // 本包复制了一份门槛表（跨包 import 走不通，见 scan.ts 顶部说明），
  // 漂移由 contract.test.ts 对照 sdlc-task 源码检测。
  // 这条用例锁住**本包的实际判定行为**：VERIFYING 不含 verification 制品
  //（那是 REVIEWING 的门槛）。
  const r = scanTasks(
    inputOf({
      'PROJ-1': {
        // VERIFYING 在 sdlc-task 里的门槛是 intent/spec/plan（不含 verification）
        'state.yaml': stateYaml({
          task: 'PROJ-1',
          status: 'VERIFYING',
          artifacts: { intent: 'i.md', spec: 's.md', plan: 'p.md' },
        }),
        'i.md': 'x',
        's.md': 'x',
        'p.md': 'x',
      },
    }),
  );
  assert.equal(r.tasks[0]!.health, 'ok', 'VERIFYING 只要求 intent/spec/plan');
});

test('summarize 的一句话概览', () => {
  assert.equal(summarize({ tasks: [], counts: { total: 0, ok: 0, incomplete: 0, error: 0, byStatus: {}, verdicts: { approve: 0, reject: 0, needs_human: 0, none: 0 } } }), '没有任务。');

  const r = scanTasks(
    inputOf({
      A: { 'state.yaml': '[' },
      B: {
        'state.yaml': stateYaml({ task: 'B', status: 'SPEC', artifacts: { intent: 'i.md', spec: 's.md' } }),
        'i.md': 'x',
        's.md': 'x',
        'verification.json': verdictJson({ status: 'needs_human', criteria: 2, results: ['cannot_tell', 'cannot_tell'] }),
      },
    }),
  );
  const line = summarize(r);
  assert.match(line, /2 个任务/);
  assert.match(line, /1 个读不出来/, '坏任务必须在概览里显眼');
  assert.match(line, /needs_human 1/);
});
