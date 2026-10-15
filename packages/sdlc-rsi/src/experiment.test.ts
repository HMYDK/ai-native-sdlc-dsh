import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExperiment, runExperiment,
  type ExperimentSpec, type ExperimentObservation, type ExperimentReport,
  type ExperimentDependencies,
} from './experiment.js';

const config = { model: 'test-provider', temperature: 0, max_steps: 12 };
function spec(over: Partial<ExperimentSpec> = {}): ExperimentSpec {
  return {
    hypothesis: 'Shorter evidence should preserve decisions and reduce time.',
    baseline_guidance: '', candidate_guidance: 'Use short evidence.', repetitions: 1,
    cases: [
      { id: 'bad', source_run_id: 'run-bad', expected: 'reject', evidence: 'BUG-1 reproduction', holdout: false },
      { id: 'good', source_run_id: 'run-good', expected: 'approve', evidence: 'BUG-1 corrected revision', holdout: true },
      { id: 'unknown', source_run_id: 'run-unknown', expected: 'needs_human', evidence: 'Missing acceptance criteria', holdout: false },
    ], ...over,
  };
}
function observation(over: Partial<ExperimentObservation> = {}): ExperimentObservation {
  return { complete: true, verdict: 'approve', duration_ms: 20, attempts: 1,
    comparable: true, issues: [], actual_config: config, verifier_fingerprint: 'verifier-v1', ...over };
}
async function run(
  execute: ExperimentDependencies['execute'] = async (c) => observation({ verdict: c.expected }),
  input = spec(),
) {
  const saves: ExperimentReport[] = [];
  const report = await runExperiment(input, { signal: new AbortController().signal, execute,
    save: async (value) => { saves.push(structuredClone(value)); } });
  return { report, saves };
}

test('parse defaults repetitions and rejects unbounded or ambiguous protocols', () => {
  const { repetitions: _, ...raw } = spec();
  assert.equal(parseExperiment(raw).repetitions, 1);
  const invalid: unknown[] = [null, [], {}, { ...raw, hypothesis: ' ' },
    { ...raw, hypothesis: 'x'.repeat(8001) }, { ...raw, candidate_guidance: '' },
    { ...raw, baseline_guidance: 'x'.repeat(16001) },
    ...[0, 6, 1.5, '2', NaN].map(repetitions => ({ ...raw, repetitions })),
    { ...raw, cases: [] }, { ...raw, cases: new Array(1) }, { ...raw, cases: Array(13).fill(raw.cases[0]) },
    { ...raw, cases: [raw.cases[0], raw.cases[0]] },
    ...['../bad', '.', '..', ' space', 'a'.repeat(97)].map(id => ({ ...raw, cases: [{ ...raw.cases[0], id }] })),
    { ...raw, cases: [{ ...raw.cases[0], source_run_id: '../run' }] },
    { ...raw, cases: [{ ...raw.cases[0], expected: 'maybe' }] },
    { ...raw, cases: [{ ...raw.cases[0], evidence: ' ' }] },
    { ...raw, cases: [{ ...raw.cases[0], evidence: 'x'.repeat(8001) }] },
    { ...raw, cases: [{ ...raw.cases[0], holdout: 'true' }] },
  ];
  for (const value of invalid) assert.throws(() => parseExperiment(value));
});

test('protocol is saved before execution and each observation is saved before the next call', async () => {
  const events: string[] = [];
  const saved: ExperimentReport[] = [];
  await runExperiment(spec(), {
    signal: new AbortController().signal,
    execute: async c => { events.push(`execute:${c.id}`); return observation({ verdict: c.expected }); },
    save: async report => { events.push(`save:${report.status}:${report.rows.length}`); saved.push(report); },
  });
  assert.deepEqual(events.slice(0, 4), ['save:running:0', 'execute:bad', 'save:running:1', 'execute:bad']);
  assert.equal(events.at(-1), 'save:completed:6');
  assert.equal(saved[0].rows.length, 0, 'saved protocol must not later mutate into the final report');
  assert.equal(saved[0].metrics.baseline.planned, 3);
});

test('arm order alternates by case and repetition and retains the assigned guidance', async () => {
  const order: string[] = [];
  await run(async (c, guidance, arm, repetition) => {
    order.push(`${c.id}:${repetition}:${arm}`);
    assert.equal(guidance, arm === 'baseline' ? '' : 'Use short evidence.');
    return observation({ verdict: c.expected });
  }, spec({ repetitions: 2 }));
  assert.deepEqual(order, [
    'bad:1:baseline', 'bad:1:candidate', 'bad:2:candidate', 'bad:2:baseline',
    'good:1:candidate', 'good:1:baseline', 'good:2:baseline', 'good:2:candidate',
    'unknown:1:baseline', 'unknown:1:candidate', 'unknown:2:candidate', 'unknown:2:baseline',
  ]);
});

test('matching quality plus lower measured time is promising only with comparable complete coverage', async () => {
  const { report } = await run(async (c, _, arm) => observation({
    verdict: c.expected, duration_ms: arm === 'baseline' ? 30 : 10,
    attempts: arm === 'baseline' ? 2 : 1,
    actual_config: arm === 'baseline' ? config : { max_steps: 12, temperature: 0, model: 'test-provider' },
  }));
  assert.equal(report.recommendation, 'candidate_promising');
  assert.equal(report.metrics.baseline.duration_ms, 90);
  assert.equal(report.metrics.candidate.attempts, 3);
  assert.equal(report.metrics.candidate.correct, 3);
  assert.equal(report.metrics.candidate.correct_help, 1);
  assert.equal(report.metrics.candidate.completion_rate, 1);
  assert.equal(report.metrics.candidate.holdout.planned, 1);
  assert.match(report.issues.join('\n'), /exploratory/i);
});

test('completed needs_human is separate from missing structured verdict and unresolved defect', async () => {
  const { report } = await run(async (c, _, arm) => {
    if (arm === 'baseline') return observation({ verdict: c.expected });
    if (c.id === 'good') return observation({ verdict: undefined, complete: true });
    return observation({ verdict: 'needs_human' });
  });
  assert.equal(report.metrics.candidate.completed, 2);
  assert.equal(report.metrics.candidate.correct_help, 1);
  assert.equal(report.metrics.candidate.unresolved, 2);
  assert.equal(report.metrics.candidate.false_alarms, 0);
  assert.equal(report.rows.find(r => r.arm === 'candidate' && r.case_id === 'good')!.observation.complete, false);
  assert.notEqual(report.recommendation, 'candidate_promising');
});

test('faster failures in both arms are never an improvement', async () => {
  const { report } = await run(async (_, __, arm) => observation({
    complete: false, verdict: undefined, duration_ms: arm === 'baseline' ? 40 : 1,
  }));
  assert.equal(report.metrics.candidate.completed, 0);
  assert.equal(report.metrics.candidate.unresolved, 3);
  assert.equal(report.recommendation, 'inconclusive');
});

test('more false alarms veto a faster candidate even if its total correct count improves', async () => {
  const { report } = await run(async (c, _, arm) => observation({
    verdict: arm === 'baseline' ? 'approve'
      : (c.id === 'good' ? 'needs_human' : c.expected),
    duration_ms: arm === 'baseline' ? 100 : 1,
  }));
  assert.equal(report.metrics.candidate.correct, 2);
  assert.equal(report.metrics.baseline.correct, 1);
  assert.equal(report.metrics.baseline.missed_defects, 1);
  assert.equal(report.metrics.baseline.unsafe_approvals, 1);
  assert.equal(report.metrics.candidate.false_alarms, 1);
  assert.equal(report.recommendation, 'keep_baseline');
});

test('holdout regressions veto aggregate improvements', async () => {
  const input = spec({ cases: [
    ...spec().cases.map(c => ({ ...c, holdout: c.id === 'bad' })),
    { id: 'another-bad', source_run_id: 'run-another', expected: 'reject', evidence: 'Second defect', holdout: false },
  ] });
  const { report } = await run(async (c, _, arm) => observation({
    verdict: arm === 'baseline'
      ? (c.id === 'bad' || c.id === 'good' ? c.expected : 'approve')
      : (c.id === 'bad' ? 'approve' : c.expected),
  }), input);
  assert.ok(report.metrics.candidate.correct > report.metrics.baseline.correct);
  assert.equal(report.metrics.candidate.holdout.missed_defects, 1);
  assert.equal(report.recommendation, 'keep_baseline');
});

test('cancelled experiments retain every planned observation in the denominator', async () => {
  const controller = new AbortController();
  const saves: ExperimentReport[] = [];
  let calls = 0;
  const report = await runExperiment(spec(), {
    signal: controller.signal,
    execute: async c => { calls++; controller.abort(); return observation({ verdict: c.expected }); },
    save: async value => { saves.push(value); },
  });
  assert.equal(calls, 1);
  assert.equal(report.status, 'cancelled');
  assert.equal(report.rows.length, 1);
  assert.equal(report.metrics.baseline.completion_rate, 1 / 3);
  assert.equal(report.metrics.baseline.unrun, 2);
  assert.equal(report.metrics.candidate.unrun, 3);
  assert.equal(report.metrics.candidate.unresolved, 3);
  assert.equal(report.recommendation, 'inconclusive');
  assert.equal(saves.at(-1)!.status, 'cancelled');
});

test('already cancelled protocols are saved without any execution', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0; const saves: ExperimentReport[] = [];
  const report = await runExperiment(spec(), { signal: controller.signal,
    execute: async () => { calls++; return observation(); }, save: async r => { saves.push(r); } });
  assert.equal(calls, 0);
  assert.equal(report.status, 'cancelled');
  assert.equal(report.metrics.baseline.unrun, 3);
  assert.equal(saves.length, 2);
});

test('execute errors become incomplete observations instead of dropping rows', async () => {
  const { report, saves } = await run(async c => { if (c.id === 'bad') throw new Error('provider unavailable'); return observation({ verdict: c.expected }); });
  assert.equal(report.rows.length, 6);
  assert.equal(report.metrics.baseline.completed, 2);
  assert.equal(report.metrics.baseline.incomplete, 1);
  assert.equal(report.metrics.baseline.unresolved, 1);
  assert.match(report.rows[0].observation.issues.join(), /provider unavailable/);
  assert.equal(report.recommendation, 'inconclusive');
  assert.equal(saves.length, 8);
});

test('a failed save prevents any later paid call, including failure saving the protocol', async () => {
  for (const failAt of [1, 2]) {
    let calls = 0, saves = 0;
    await assert.rejects(runExperiment(spec(), { signal: new AbortController().signal,
      execute: async () => { calls++; return observation(); },
      save: async () => { if (++saves === failAt) throw new Error('disk full'); },
    }), /disk full/);
    assert.equal(calls, failAt - 1);
  }
});

test('config drift, absent runtime metadata and verifier drift prevent comparison', async () => {
  const variants: Partial<ExperimentObservation>[] = [
    { actual_config: { ...config, temperature: 0.5 } }, { actual_config: undefined },
    { actual_config: null }, { actual_config: {} }, { actual_config: 'unknown' }, { actual_config: [] },
    { verifier_fingerprint: 'verifier-v2' },
    { verifier_fingerprint: undefined }, { comparable: false, issues: ['snapshot changed'] },
  ];
  for (const variation of variants) {
    const { report } = await run(async (c, _, arm) => observation({ verdict: c.expected,
      duration_ms: arm === 'baseline' ? 100 : 1, ...(arm === 'candidate' ? variation : {}) }));
    assert.equal(report.recommendation, 'inconclusive');
  }
});

test('missing holdouts or any reference category prevents an adoption recommendation', async () => {
  const cases = spec().cases;
  for (const inputCases of [cases.map(c => ({ ...c, holdout: false })),
    cases.filter(c => c.expected !== 'approve'), cases.filter(c => c.expected !== 'reject'),
    cases.filter(c => c.expected !== 'needs_human')]) {
    const { report } = await run(async (c, _, arm) => observation({ verdict: c.expected,
      duration_ms: arm === 'baseline' ? 100 : 1 }), spec({ cases: inputCases }));
    assert.equal(report.recommendation, 'inconclusive');
  }
});

test('unknown and corrupt observations never introduce NaN or create a successful result', async () => {
  const variants: unknown[] = [null, 'broken', {},
    observation({ duration_ms: NaN, attempts: Infinity }),
    observation({ duration_ms: -1, attempts: -1 }),
    { ...observation(), complete: 'true', comparable: 'yes', verdict: 'ok' },
    { ...observation(), issues: 'oops' },
    { ...observation(), actual_config: { temperature: NaN } },
  ];
  for (const broken of variants) {
    const { report } = await run(async (_, __, arm) => arm === 'candidate' ? broken as ExperimentObservation : observation());
    assert.ok(Number.isFinite(report.metrics.candidate.duration_ms));
    assert.ok(Number.isFinite(report.metrics.candidate.attempts));
    assert.equal(report.recommendation, 'inconclusive');
    assert.doesNotThrow(() => JSON.stringify(report));
  }
});

test('no measurable gain stays inconclusive and repeated rows remain independent', async () => {
  const { report } = await run(undefined, spec({ repetitions: 3 }));
  assert.equal(report.metrics.baseline.planned, 9);
  assert.equal(report.metrics.baseline.observed, 9);
  assert.equal(report.metrics.baseline.correct, 9);
  assert.equal(report.recommendation, 'inconclusive');
});

test('configuration drift inside one arm also invalidates the whole experiment', async () => {
  const { report } = await run(async (c, _, arm) => observation({ verdict: c.expected,
    duration_ms: arm === 'baseline' ? 100 : 1,
    actual_config: c.id === 'unknown' ? { ...config, max_steps: 20 } : config,
  }));
  assert.equal(report.recommendation, 'inconclusive');
  assert.match(report.issues.join('\n'), /configuration changed/);
});

test('matching empty or unknown runtime metadata is still not evidence of comparability', async () => {
  for (const actual_config of [{}, [], 'unknown']) {
    const { report } = await run(async (c, _, arm) => observation({ verdict: c.expected,
      duration_ms: arm === 'baseline' ? 100 : 1, actual_config }));
    assert.equal(report.recommendation, 'inconclusive');
  }
});

test('callbacks cannot mutate the frozen protocol or previously saved results', async () => {
  const input = spec();
  const report = await runExperiment(input, { signal: new AbortController().signal,
    execute: async c => { const expected = c.expected; c.expected = 'approve'; input.cases[0].expected = 'approve'; return observation({ verdict: expected }); },
    save: async r => { r.spec.cases[0].expected = 'approve'; r.rows.length = 0; },
  });
  assert.equal(report.spec.cases[0].expected, 'reject');
  assert.equal(report.rows[0].expected, 'reject');
  assert.equal(report.metrics.baseline.correct, 3);
});

test('a real completion improvement can be promising without pretending failed baseline calls completed', async () => {
  const { report } = await run(async (c, _, arm) => observation({ verdict: c.expected,
    complete: !(arm === 'baseline' && c.id === 'bad'), duration_ms: arm === 'baseline' ? 1 : 100,
  }));
  assert.equal(report.metrics.baseline.completed, 2);
  assert.equal(report.metrics.candidate.completed, 3);
  assert.equal(report.recommendation, 'candidate_promising');
});

test('faster failures cannot borrow a successful unchanged holdout to claim timing improvement', async () => {
  const { report } = await run(async (c, _, arm) => observation({
    complete: c.id === 'good', verdict: c.id === 'good' ? 'approve' : undefined,
    duration_ms: c.id === 'good' ? 10 : arm === 'baseline' ? 100 : 1,
  }));
  assert.equal(report.metrics.baseline.duration_ms, 210);
  assert.equal(report.metrics.candidate.duration_ms, 12);
  assert.equal(report.metrics.baseline.correct, 1);
  assert.equal(report.metrics.candidate.correct, 1);
  assert.equal(report.recommendation, 'inconclusive');
});

test('faster correct paired runs may support timing gains even when other observations fail equally', async () => {
  const { report } = await run(async (c, _, arm) => observation({
    complete: c.id === 'good', verdict: c.id === 'good' ? 'approve' : undefined,
    duration_ms: c.id === 'good' ? (arm === 'baseline' ? 10 : 5) : 100,
  }));
  assert.equal(report.metrics.candidate.completed, 1);
  assert.equal(report.recommendation, 'candidate_promising');
});

test('timing-only benefit must not increase attempts on successful pairs or in total', async () => {
  const recommendations = [];
  for (const increaseSuccessful of [false, true]) {
    const { report } = await run(async (c, _, arm) => observation({
      complete: c.id === 'good', verdict: c.id === 'good' ? 'approve' : undefined,
      duration_ms: arm === 'baseline' ? 100 : 1,
      attempts: arm === 'baseline' ? (c.id === 'good' ? 1 : 2)
        : increaseSuccessful ? (c.id === 'good' ? 2 : 1) : (c.id === 'good' ? 1 : 3),
    }));
    recommendations.push(report.recommendation);
  }
  assert.deepEqual(recommendations, ['inconclusive', 'inconclusive']);
});

test('timing-only benefit pairs the same case and repetition, not unrelated correct calls', async () => {
  const { report } = await run(async (c, _, arm, repetition) => observation({
    complete: c.id === 'good' && repetition === (arm === 'baseline' ? 1 : 2),
    verdict: c.id === 'good' ? 'approve' : undefined,
    duration_ms: arm === 'baseline' ? 100 : 1,
  }), spec({ repetitions: 2 }));
  assert.equal(report.metrics.baseline.correct, 1);
  assert.equal(report.metrics.candidate.correct, 1);
  assert.equal(report.recommendation, 'inconclusive');
});

test('faster correct pairs cannot mask an overall elapsed-time increase', async () => {
  const { report } = await run(async (c, _, arm) => observation({
    complete: c.id === 'good', verdict: c.id === 'good' ? 'approve' : undefined,
    duration_ms: c.id === 'good' ? (arm === 'baseline' ? 10 : 5) : (arm === 'baseline' ? 1 : 100),
  }));
  assert.ok(report.metrics.candidate.duration_ms > report.metrics.baseline.duration_ms);
  assert.equal(report.recommendation, 'inconclusive');
});

test('runtime limitations remain visible in every report and prevent positive adoption advice', async () => {
  const limitation = '参考答案与验证者共享文件系统，未实现盲评隔离；本次仅作探索，不能据此推荐采用。';
  const limitations = [limitation];
  const saved: ExperimentReport[] = [];
  const report = await runExperiment(spec(), { signal: new AbortController().signal, limitations,
    execute: async (c, _, arm) => {
      limitations.length = 0;
      return observation({ verdict: c.expected, duration_ms: arm === 'baseline' ? 100 : 1 });
    },
    save: async r => { saved.push(r); },
  });
  assert.equal(report.metrics.baseline.duration_ms, 300);
  assert.equal(report.metrics.candidate.duration_ms, 3);
  assert.equal(report.metrics.candidate.correct, 3);
  assert.equal(saved.length, 8);
  assert.equal(report.recommendation, 'inconclusive');
  for (const current of [...saved, report]) {
    assert.equal(current.recommendation, 'inconclusive');
    assert.ok(current.issues.some(issue => issue.includes(limitation)), 'runtime limitation must remain visible');
  }
});

test('runtime limitations do not hide measured quality regressions', async () => {
  const report = await runExperiment(spec(), { signal: new AbortController().signal,
    limitations: ['Reference answers share the verifier filesystem.'],
    execute: async (c, _, arm) => observation({ verdict: arm === 'candidate' && c.id === 'good' ? 'reject' : c.expected }),
    save: async () => {},
  });
  assert.equal(report.metrics.candidate.false_alarms, 1);
  assert.equal(report.recommendation, 'keep_baseline');
  assert.ok(report.issues.some(issue => issue.includes('Reference answers share')));
});
