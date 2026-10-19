/** Callback-only experiment engine; runtime observation and storage belong to the plugin. */
export type ExperimentVerdict = 'approve' | 'reject' | 'needs_human';
export type ExperimentArm = 'baseline' | 'candidate';
export interface ExperimentCase {
  id: string;
  source_run_id: string;
  expected: ExperimentVerdict;
  evidence: string;
  holdout: boolean;
}
export interface ExperimentSpec {
  hypothesis: string;
  baseline_guidance: string;
  candidate_guidance: string;
  repetitions: number;
  cases: ExperimentCase[];
}
export interface ExperimentObservation {
  run_id?: string;
  complete: boolean;
  verdict?: ExperimentVerdict;
  duration_ms: number;
  attempts: number;
  comparable: boolean;
  issues: string[];
  actual_config?: unknown;
  verifier_fingerprint?: string;
}
export interface ExperimentRow {
  case_id: string;
  source_run_id: string;
  arm: ExperimentArm;
  repetition: number;
  expected: ExperimentVerdict;
  holdout: boolean;
  observation: ExperimentObservation;
}
export interface ExperimentMetrics {
  planned: number;
  observed: number;
  unrun: number;
  completed: number;
  incomplete: number;
  correct: number;
  correct_help: number;
  missed_defects: number;
  false_alarms: number;
  unsafe_approvals: number;
  unresolved: number;
  duration_ms: number;
  attempts: number;
  completion_rate: number;
}
export interface ExperimentArmMetrics extends ExperimentMetrics {
  holdout: ExperimentMetrics;
}
export interface ExperimentReport {
  schema_version: 1;
  spec: ExperimentSpec;
  status: 'running' | 'completed' | 'cancelled';
  rows: ExperimentRow[];
  metrics: Record<ExperimentArm, ExperimentArmMetrics>;
  recommendation: 'candidate_promising' | 'keep_baseline' | 'inconclusive';
  issues: string[];
}
export interface ExperimentDependencies {
  signal: AbortSignal;
  /** Known runtime limitations prohibit adoption advice, while retaining measured regressions. */
  limitations?: string[];
  execute(caseSpec: ExperimentCase, guidance: string, arm: ExperimentArm, repetition: number): Promise<ExperimentObservation>;
  save(report: ExperimentReport): Promise<void>;
}

export function parseExperiment(raw: unknown): ExperimentSpec {
  if (!isObject(raw)) throw new Error('Experiment protocol must be an object.');
  const hypothesis = boundedText(raw.hypothesis, 'hypothesis', 8000);
  const baseline_guidance = boundedText(raw.baseline_guidance, 'baseline_guidance', 16000, true);
  const candidate_guidance = boundedText(raw.candidate_guidance, 'candidate_guidance', 16000);
  if (baseline_guidance === candidate_guidance) throw new Error('The two guidance strings must differ.');
  const repetitions = raw.repetitions === undefined ? 1 : raw.repetitions;
  if (typeof repetitions !== 'number' || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) {
    throw new Error('repetitions must be an integer from 1 to 5.');
  }
  if (!Array.isArray(raw.cases) || raw.cases.length < 1 || raw.cases.length > 12) {
    throw new Error('cases must contain 1 to 12 reference cases.');
  }
  const seen = new Set<string>();
  const cases = Array.from(raw.cases, (rawCase, index): ExperimentCase => {
    if (!isObject(rawCase)) throw new Error(`cases[${index}] must be an object.`);
    const id = safeId(rawCase.id, `cases[${index}].id`);
    if (seen.has(id)) throw new Error(`Duplicate case id: ${id}`);
    seen.add(id);
    const source_run_id = safeId(rawCase.source_run_id, `cases[${index}].source_run_id`);
    if (!isVerdict(rawCase.expected)) throw new Error(`cases[${index}].expected is not a reference verdict.`);
    if (typeof rawCase.holdout !== 'boolean') throw new Error(`cases[${index}].holdout must be a boolean.`);
    return { id, source_run_id, expected: rawCase.expected,
      evidence: boundedText(rawCase.evidence, `cases[${index}].evidence`, 8000), holdout: rawCase.holdout };
  });
  return { hypothesis, baseline_guidance, candidate_guidance, repetitions, cases };
}

/** Save errors deliberately escape: no further billable work may run without its durable record. */
export async function runExperiment(input: ExperimentSpec, deps: ExperimentDependencies): Promise<ExperimentReport> {
  const spec = parseExperiment(input);
  const limitations = [...(deps.limitations ?? [])];
  const rows: ExperimentRow[] = [];
  let report = makeReport(spec, rows, 'running', limitations);
  await deps.save(structuredClone(report));

  execution: for (const [caseIndex, caseSpec] of spec.cases.entries()) {
    for (let repetition = 1; repetition <= spec.repetitions; repetition++) {
      const arms: ExperimentArm[] = (caseIndex + repetition - 1) % 2 === 0
        ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
      for (const arm of arms) {
        if (deps.signal.aborted) break execution;
        const started = Date.now();
        let observation: ExperimentObservation;
        try {
          // The runtime adapter constructs verifier arguments. Reference answers stay in this protocol.
          const raw = await deps.execute({ ...caseSpec }, spec[`${arm}_guidance`], arm, repetition);
          observation = normalizeObservation(raw);
        } catch (error) {
          observation = { complete: false, comparable: false, duration_ms: Math.max(0, Date.now() - started),
            attempts: 0, issues: [`Execution failed; attempt count unknown: ${errorText(error)}`] };
        }
        rows.push({ case_id: caseSpec.id, source_run_id: caseSpec.source_run_id, arm, repetition,
          expected: caseSpec.expected, holdout: caseSpec.holdout, observation });
        report = makeReport(spec, rows, 'running', limitations);
        await deps.save(structuredClone(report));
      }
    }
  }
  report = makeReport(spec, rows, deps.signal.aborted ? 'cancelled' : 'completed', limitations);
  await deps.save(structuredClone(report));
  return report;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, field: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`${field} must be ${allowEmpty ? 'a' : 'a nonempty'} string of at most ${maximum} characters.`);
  }
  return value;
}

function safeId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value)) {
    throw new Error(`${field} must be a safe identifier of 1 to 96 characters.`);
  }
  return value;
}

function isVerdict(value: unknown): value is ExperimentVerdict {
  return value === 'approve' || value === 'reject' || value === 'needs_human';
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4000);
}

/** Canonical JSON refuses values JSON.stringify would silently drop, coerce, or turn into null. */
function canonicalJSON(value: unknown): string {
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 32) throw new Error('Runtime configuration exceeds 32 nesting levels.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || item === null) throw new Error('Runtime configuration must contain JSON values.');
    if (seen.has(item)) throw new Error('Runtime configuration is cyclic.');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new Error('Runtime configuration must contain plain JSON objects.');
    }
    seen.add(item);
    let result: unknown;
    if (Array.isArray(item)) {
      result = Array.from(item, value => visit(value, depth + 1));
    } else {
      result = Object.fromEntries(Object.keys(item).sort().map(key => [key, visit((item as Record<string, unknown>)[key], depth + 1)]));
    }
    seen.delete(item);
    return result;
  };
  const json = JSON.stringify(visit(value, 0));
  if (json.length > 64000) throw new Error('Runtime configuration exceeds 64000 characters.');
  return json;
}

function normalizeObservation(raw: unknown): ExperimentObservation {
  const issues: string[] = [];
  const source = isObject(raw) ? raw : {};
  let comparable = source.comparable === true;
  const invalid = (message: string) => { comparable = false; issues.push(message); };
  if (!isObject(raw)) invalid('Executor returned a non-object observation.');
  if (typeof source.complete !== 'boolean') invalid('Observation.complete must be a boolean.');
  if (typeof source.comparable !== 'boolean') invalid('Observation.comparable must be a boolean.');
  const verdict = isVerdict(source.verdict) ? source.verdict : undefined;
  const complete = source.complete === true && verdict !== undefined;
  if (source.complete === true && verdict === undefined) invalid('Structured completion was claimed without a valid verdict.');
  if (source.verdict !== undefined && verdict === undefined) invalid('Observation contains an invalid verdict.');
  const numeric = (key: 'duration_ms' | 'attempts'): number => {
    const value = source[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER
      || (key === 'attempts' && !Number.isSafeInteger(value))) {
      invalid(`Observation.${key} must be a finite nonnegative ${key === 'attempts' ? 'integer' : 'number'}.`);
      return 0;
    }
    return value;
  };
  const duration_ms = numeric('duration_ms');
  const attempts = numeric('attempts');
  if (Array.isArray(source.issues) && source.issues.every(issue => typeof issue === 'string')) {
    issues.push(...source.issues.slice(0, 50).map(issue => (issue as string).slice(0, 4000)));
    if (source.issues.length > 50 || source.issues.some(issue => issue.length > 4000)) invalid('Observation issues exceeded storage limits.');
  } else {
    invalid('Observation.issues must be an array of strings.');
  }
  let actual_config: unknown;
  if (!isObject(source.actual_config) || Object.keys(source.actual_config).length === 0) {
    invalid('Actual runtime configuration was not observed as a nonempty object.');
  } else {
    try { actual_config = JSON.parse(canonicalJSON(source.actual_config)); }
    catch (error) { invalid(errorText(error)); }
  }
  const verifier_fingerprint = typeof source.verifier_fingerprint === 'string'
    && source.verifier_fingerprint.trim().length > 0 && source.verifier_fingerprint.length <= 4000
    ? source.verifier_fingerprint : undefined;
  if (!verifier_fingerprint) invalid('Verifier fingerprint was not observed.');
  let run_id: string | undefined;
  if (source.run_id !== undefined) {
    try { run_id = safeId(source.run_id, 'Observation.run_id'); }
    catch (error) { invalid(errorText(error)); }
  }
  return { complete, comparable, duration_ms, attempts, issues,
    ...(run_id === undefined ? {} : { run_id }), ...(verdict === undefined ? {} : { verdict }),
    ...(actual_config === undefined ? {} : { actual_config }),
    ...(verifier_fingerprint === undefined ? {} : { verifier_fingerprint }) };
}

function metricsFor(rows: ExperimentRow[], planned: number): ExperimentMetrics {
  const metrics: ExperimentMetrics = { planned, observed: rows.length, unrun: planned - rows.length,
    completed: 0, incomplete: 0, correct: 0, correct_help: 0, missed_defects: 0, false_alarms: 0,
    unsafe_approvals: 0, unresolved: planned - rows.length, duration_ms: 0, attempts: 0, completion_rate: 0 };
  for (const row of rows) {
    const observation = row.observation;
    metrics.duration_ms += observation.duration_ms;
    metrics.attempts += observation.attempts;
    if (!observation.complete) {
      metrics.incomplete++;
      metrics.unresolved++;
      continue;
    }
    metrics.completed++;
    if (observation.verdict === row.expected) metrics.correct++;
    if (row.expected === 'needs_human' && observation.verdict === 'needs_human') metrics.correct_help++;
    if (row.expected === 'reject' && observation.verdict === 'approve') metrics.missed_defects++;
    if (row.expected === 'approve' && observation.verdict !== 'approve') metrics.false_alarms++;
    if (row.expected === 'needs_human' && observation.verdict === 'approve') metrics.unsafe_approvals++;
    if (row.expected !== 'needs_human' && observation.verdict === 'needs_human') metrics.unresolved++;
  }
  metrics.completion_rate = planned === 0 ? 0 : metrics.completed / planned;
  return metrics;
}

function hasRegression(baseline: ExperimentMetrics, candidate: ExperimentMetrics): boolean {
  return candidate.correct < baseline.correct || candidate.completed < baseline.completed
    || candidate.missed_defects > baseline.missed_defects || candidate.false_alarms > baseline.false_alarms
    || candidate.unsafe_approvals > baseline.unsafe_approvals || candidate.unresolved > baseline.unresolved;
}

/**
 * Faster failures are not productive work. A timing-only recommendation needs faster
 * paired correct completions (same case and repetition), lower total elapsed time,
 * and no extra attempts either on those pairs or across the experiment. Attempts are
 * only a cost proxy; this does not claim to measure tokens or money.
 */
function hasPairedTimingBenefit(rows: ExperimentRow[], baseline: ExperimentMetrics, candidate: ExperimentMetrics): boolean {
  if (candidate.duration_ms >= baseline.duration_ms || candidate.attempts > baseline.attempts) return false;
  const correctBaselines = new Map(rows
    .filter(row => row.arm === 'baseline' && row.observation.complete && row.observation.verdict === row.expected)
    .map(row => [`${row.case_id}\0${row.repetition}`, row.observation]));
  let pairs = 0, baselineTime = 0, candidateTime = 0, baselineAttempts = 0, candidateAttempts = 0;
  for (const row of rows) {
    if (row.arm !== 'candidate' || !row.observation.complete || row.observation.verdict !== row.expected) continue;
    const pairedBaseline = correctBaselines.get(`${row.case_id}\0${row.repetition}`);
    if (!pairedBaseline) continue;
    pairs++;
    baselineTime += pairedBaseline.duration_ms;
    candidateTime += row.observation.duration_ms;
    baselineAttempts += pairedBaseline.attempts;
    candidateAttempts += row.observation.attempts;
  }
  return pairs > 0 && candidateTime < baselineTime && candidateAttempts <= baselineAttempts;
}

function makeReport(
  spec: ExperimentSpec, rows: ExperimentRow[], status: ExperimentReport['status'], limitations: readonly string[],
): ExperimentReport {
  const planned = spec.cases.length * spec.repetitions;
  const holdoutPlanned = spec.cases.filter(c => c.holdout).length * spec.repetitions;
  const armMetrics = (arm: ExperimentArm): ExperimentArmMetrics => {
    const armRows = rows.filter(row => row.arm === arm);
    return { ...metricsFor(armRows, planned), holdout: metricsFor(armRows.filter(row => row.holdout), holdoutPlanned) };
  };
  const baseline = armMetrics('baseline'), candidate = armMetrics('candidate');
  const issues = ['Exploratory small-sample comparison; this does not establish statistically proven or general improvement.',
    ...limitations.map(limitation => `Runtime limitation: ${limitation}`)];
  let comparable = true;
  const blocked = (message: string) => { comparable = false; issues.push(message); };
  if (status !== 'completed' || rows.length !== planned * 2) blocked('The experiment has missing or unfinished pairs; unrun observations remain in the denominator.');
  if (rows.some(row => !row.observation.comparable)) blocked('One or more observations cannot be compared.');
  for (const row of rows) {
    issues.push(...row.observation.issues.map(issue => `${row.case_id}/${row.arm}/${row.repetition}: ${issue}`));
  }
  if (rows.length > 0 && rows.every(row => row.observation.comparable)) {
    const configs = new Set(rows.map(row => canonicalJSON(row.observation.actual_config)));
    const fingerprints = new Set(rows.map(row => row.observation.verifier_fingerprint));
    if (configs.size !== 1) blocked('Actual runtime configuration changed across observations.');
    if (fingerprints.size !== 1) blocked('Verifier fingerprint changed across observations.');
  }
  let recommendation: ExperimentReport['recommendation'] = 'inconclusive';
  if (comparable && (hasRegression(baseline, candidate) || hasRegression(baseline.holdout, candidate.holdout))) {
    recommendation = 'keep_baseline';
    issues.push('The candidate regressed on measured quality or completion, overall or on holdouts.');
  } else {
    const categories = new Set(spec.cases.map(c => c.expected));
    if (categories.size !== 3) blocked('Defect, good-change, and insufficient-evidence reference cases are all required before recommending adoption.');
    if (holdoutPlanned === 0) blocked('At least one held-out observation per arm is required before recommending adoption.');
    const improvement = candidate.correct > baseline.correct || candidate.completed > baseline.completed
      || hasPairedTimingBenefit(rows, baseline, candidate);
    const usableImprovement = candidate.correct > 0 && candidate.completed > 0 && improvement;
    // Limitations suppress adoption advice, not raw metrics or the regression branch above.
    if (comparable && usableImprovement && limitations.length === 0) recommendation = 'candidate_promising';
    else if (comparable && !usableImprovement) issues.push('No usable measured improvement was established.');
  }
  return { schema_version: 1, spec, status, rows: [...rows], metrics: { baseline, candidate }, recommendation, issues };
}
