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
import { humanAge, scanTasks, summarize, summarizeVerdict, type ScanInput } from './scan.js';

/** 造一个合法的 state.yaml 文本。 */
function stateYaml(over: {
  task: string;
  status: string;
  artifacts?: Record<string, string>;
  title?: string;
  updated?: string;
}): string {
  const arts = over.artifacts ?? {};
  return [
    `task: ${over.task}`,
    `title: ${JSON.stringify(over.title ?? '标题')}`,
    `status: ${over.status}`,
    'created: "2026-10-07T10:00:00.000Z"',
    `updated: "${over.updated ?? '2026-10-07T10:00:00.000Z'}"`,
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
  assert.equal(
    summarize({
      tasks: [],
      counts: {
        total: 0,
        ok: 0,
        incomplete: 0,
        error: 0,
        byStatus: {},
        verdicts: { approve: 0, reject: 0, needs_human: 0, none: 0 },
        staleness: { closed: 0, waiting: 0, stale: 0, active: 0, unknown: 0 },
      },
    }),
    '没有任务。',
  );

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

// ─────────────────────────────────────────────── 停滞判定（时间维度）

test('停滞判定：三种"没动"必须分开——closed / waiting / stale', () => {
  const NOW = Date.parse('2026-10-10T00:00:00.000Z'); // 基准时刻
  const THREE_DAYS_AGO = '2026-10-07T00:00:00.000Z';

  const mk = (task: string, status: string, opts: { updated?: string; verdict?: string } = {}) => {
    const files: Record<string, string> = {
      'state.yaml': stateYaml({
        task,
        status,
        updated: opts.updated ?? THREE_DAYS_AGO,
        artifacts: { intent: 'i.md', spec: 's.md', plan: 'p.md' },
      }),
      'i.md': 'x',
      's.md': 'x',
      'p.md': 'x',
    };
    if (opts.verdict !== undefined) {
      files['verification.json'] = verdictJson({ status: opts.verdict, criteria: 1, results: ['met'] });
    }
    return files;
  };

  const r = scanTasks({
    dirs: ['DONE-OLD', 'NEEDS-HUMAN', 'STUCK', 'FRESH'].map((task) => ({
      task,
      files: Object.keys(
        mk(
          task,
          task === 'DONE-OLD' ? 'DONE' : task === 'STUCK' ? 'IMPLEMENTING' : 'VERIFYING',
          task === 'NEEDS-HUMAN'
            ? { verdict: 'needs_human' }
            : task === 'FRESH'
              ? { updated: '2026-10-09T23:00:00.000Z' }
              : {},
        ),
      ),
    })),
    readFile: (task, rel) =>
      mk(
        task,
        task === 'DONE-OLD' ? 'DONE' : task === 'STUCK' ? 'IMPLEMENTING' : 'VERIFYING',
        task === 'NEEDS-HUMAN'
          ? { verdict: 'needs_human' }
          : task === 'FRESH'
            ? { updated: '2026-10-09T23:00:00.000Z' }
            : {},
      )[rel],
    now: NOW,
    staleAfterHours: 24,
  });

  const byTask = Object.fromEntries(r.tasks.map((t) => [t.task, t.staleness?.class]));
  assert.equal(byTask['DONE-OLD'], 'closed', 'DONE 是终态，不存在"停滞"');
  assert.equal(
    byTask['NEEDS-HUMAN'],
    'waiting',
    'needs_human 是验证者明确说"交给人"——在等人，不是停滞',
  );
  assert.equal(byTask['STUCK'], 'stale', 'IMPLEMENTING 三天没动 = 真停滞');
  assert.equal(byTask['FRESH'], 'active', '刚动过的不算停滞');
});

test('停滞判定：阈值可配，且边界是"超过"而不是"达到"', () => {
  const NOW = Date.parse('2026-10-08T12:00:00.000Z');
  const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();
  const mk = (hoursAgo: number) => ({
    'state.yaml': stateYaml({
      task: 'T1',
      status: 'IMPLEMENTING',
      updated: at(hoursAgo),
      artifacts: { intent: 'i.md', spec: 's.md', plan: 'p.md' },
    }),
    'i.md': 'x',
    's.md': 'x',
    'p.md': 'x',
  });
  const run = (hoursAgo: number, threshold: number) =>
    scanTasks({
      dirs: [{ task: 'T1', files: Object.keys(mk(hoursAgo)) }],
      readFile: (_t: string, rel: string) => (mk(hoursAgo) as Record<string, string>)[rel],
      now: NOW,
      staleAfterHours: threshold,
    }).tasks[0]?.staleness?.class;

  assert.equal(run(23, 24), 'active', '23 小时 < 24 小时阈值');
  assert.equal(run(24, 24), 'active', '恰好等于阈值不算超过（边界是"超过"）');
  assert.equal(run(25, 24), 'stale', '25 小时 > 24 小时阈值');
  assert.equal(run(23, 12), 'stale', '阈值改成 12 小时后 23 小时算停滞');
});

test('回归：坏任务的停滞类别是 unknown，不能误报成 stale', () => {
  // 坏任务没有可信的 updated，判成"停滞"会误导人去追一个假的时间问题。
  const r = scanTasks(inputOf({ BROKEN: { 'state.yaml': '[' } }), );
  assert.equal(r.tasks[0]?.staleness?.class, 'unknown');
});

test('排序：停滞的排在"在等人"的前面', () => {
  // 看板要让人一眼看到"需要我动手"的。needs_human 在等人是流程正常，
  // 真正停滞的才是要处理的。
  const NOW = Date.parse('2026-10-10T00:00:00.000Z');
  const old = '2026-10-01T00:00:00.000Z';
  const mkFiles = (task: string, status: string, verdict?: string) => {
    const f: Record<string, string> = {
      'state.yaml': stateYaml({
        task,
        status,
        updated: old,
        artifacts: { intent: 'i.md', spec: 's.md', plan: 'p.md' },
      }),
      'i.md': 'x',
      's.md': 'x',
      'p.md': 'x',
    };
    if (verdict !== undefined) {
      f['verification.json'] = verdictJson({ status: verdict, criteria: 1, results: ['met'] });
    }
    return f;
  };
  const files = {
    'A-WAITING': mkFiles('A-WAITING', 'VERIFYING', 'needs_human'),
    'B-STUCK': mkFiles('B-STUCK', 'IMPLEMENTING'),
  };
  const r = scanTasks({
    dirs: Object.entries(files).map(([task, f]) => ({ task, files: Object.keys(f) })),
    readFile: (t, rel) => files[t as keyof typeof files]?.[rel],
    now: NOW,
    staleAfterHours: 24,
  });
  assert.equal(r.tasks[0]?.task, 'B-STUCK', '停滞的要排在人前面');
  assert.equal(r.tasks[1]?.task, 'A-WAITING');
});

test('summarize 把停滞的数量放在最显眼处', () => {
  const NOW = Date.parse('2026-10-10T00:00:00.000Z');
  const files = {
    'B-STUCK': {
      'state.yaml': stateYaml({
        task: 'B-STUCK',
        status: 'IMPLEMENTING',
        updated: '2026-10-01T00:00:00.000Z',
        artifacts: { intent: 'i.md', spec: 's.md', plan: 'p.md' },
      }),
      'i.md': 'x',
      's.md': 'x',
      'p.md': 'x',
    },
  };
  const r = scanTasks({
    dirs: [{ task: 'B-STUCK', files: Object.keys(files['B-STUCK']) }],
    readFile: (_t: string, rel: string) => (files['B-STUCK'] as Record<string, string>)[rel],
    now: NOW,
    staleAfterHours: 24,
  });
  const line = summarize(r);
  assert.match(line, /1 个停滞/, `停滞数应出现在概览里：${line}`);
});

test('humanAge 给人读的时长', () => {
  assert.equal(humanAge(30_000), '1 分钟', '不足一分钟也显示 1 分钟，不显示 0');
  assert.equal(humanAge(45 * 60_000), '45 分钟');
  assert.equal(humanAge(5 * 3600_000), '5 小时');
  assert.equal(humanAge(3 * 24 * 3600_000), '3 天');
});

// ─────────────────── REVIEWING 的四种形态（以前完全没覆盖，藏了一个真缺陷）

test('回归：REVIEWING + approve 不算"在等人"——推进是机械动作', () => {
  // 缺陷原貌：`verdictStatus === 'needs_human' || status === 'REVIEWING'`
  // 把**所有** REVIEWING 都算成 waiting，于是在真实仓库里实测到
  // 「2 个任务，1 个在等人」——而那个任务的裁决是 approve、
  // `sdlc_task_advance → DONE` 一行就能推。
  // 那是**假的求助信号**：看板喊"来人"，其实没有人需要出手。
  //
  // 判据应当按"下一步该谁动"分，而不是按状态名分。
  const NOW = Date.parse('2026-10-10T00:00:00.000Z');
  const OLD = '2026-10-07T00:00:00.000Z'; // 三天前，超过 24 小时阈值
  const mk = (task: string, verdict?: string) => {
    const files: Record<string, string> = {
      'state.yaml': stateYaml({
        task,
        status: 'REVIEWING',
        updated: OLD,
        artifacts: { intent: 'i.md', spec: 's.md', plan: 'p.md' },
      }),
      'i.md': 'x',
      's.md': 'x',
      'p.md': 'x',
    };
    if (verdict !== undefined) {
      files['verification.json'] = verdictJson({
        status: verdict,
        criteria: 1,
        results: ['met'],
      });
    }
    return files;
  };
  const tasks = [
    { task: 'APPR', verdict: 'approve' },
    { task: 'REJ', verdict: 'reject' },
    { task: 'HUMAN', verdict: 'needs_human' },
    { task: 'NONE', verdict: undefined },
  ];
  const r = scanTasks({
    dirs: tasks.map((t) => ({ task: t.task, files: Object.keys(mk(t.task, t.verdict)) })),
    readFile: (task, rel) => mk(task, tasks.find((t) => t.task === task)?.verdict)[rel],
    now: NOW,
    staleAfterHours: 24,
  });
  const byTask = Object.fromEntries(r.tasks.map((t) => [t.task, t.staleness?.class]));

  assert.equal(
    byTask['APPR'],
    'stale',
    'approve 之后没人推进 —— 这才是"停滞"，不是"在等人"（没有人被请求出手）',
  );
  for (const t of ['REJ', 'HUMAN', 'NONE']) {
    assert.equal(byTask[t], 'waiting', `${t} 是真的在等人`);
  }
  // 汇总也必须对得上，否则 summary 里那句"1 个在等人"仍然是错的
  assert.equal(r.counts.staleness.waiting, 3, '只有三种形态算 waiting');
  assert.equal(r.counts.staleness.stale, 1, 'approve 那条算 stale');
});

test('回归：REVIEWING + approve 且**刚动过** → active（不是 waiting，也不是 stale）', () => {
  // 这条防的是"矫枉过正"：修完上面那个缺陷后，很容易顺手把
  // REVIEWING+approve 一律算成 stale。刚 approve 完还没推进不是停滞。
  const NOW = Date.parse('2026-10-10T00:00:00.000Z');
  const files: Record<string, string> = {
    'state.yaml': stateYaml({
      task: 'FRESH-APPR',
      status: 'REVIEWING',
      updated: '2026-10-09T23:00:00.000Z', // 一小时前
      artifacts: { intent: 'i.md', spec: 's.md', plan: 'p.md' },
    }),
    'i.md': 'x',
    's.md': 'x',
    'p.md': 'x',
    'verification.json': verdictJson({ status: 'approve', criteria: 1, results: ['met'] }),
  };
  const r = scanTasks({
    dirs: [{ task: 'FRESH-APPR', files: Object.keys(files) }],
    readFile: (_t, rel) => files[rel],
    now: NOW,
    staleAfterHours: 24,
  });
  assert.equal(r.tasks[0]?.staleness?.class, 'active');
});
