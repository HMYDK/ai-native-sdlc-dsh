import {extractSections, extractSubsections, REQUIRED_SECTIONS, sectionBody} from '../artifact/artifact.js';
import {parseSpecAcceptance, specHash, verificationAcceptance} from '../shared/acceptance.js';
import {parseSpecReviewRef, sameJSON} from '../shared/spec-review-record.js';
import type {TaskVerification} from '../task/approval.js';
import type {reviewWorkspace} from '../task/spec-review.js';
import type {TaskState} from '../task/state.js';
import {object} from './analysis.js';
import type {observeReviews, ReportGap} from './reviews.js';
import {message, readRunRecords, safeSegment, type RecordReader} from './store.js';

const SHA256 = /^[a-f0-9]{64}$/;
const EXECUTION_LIMIT = 256 * 1024;
export const SESSION_BYTES = 32 * 1024 * 1024;
type Reviews = Awaited<ReturnType<typeof observeReviews>>;
type Workspace = ReturnType<typeof reviewWorkspace>;
export type DeliveryEvidenceReader = RecordReader & {root: string};
export type OracleStatus = 'proven' | 'failed' | 'unverified';
interface Oracle {oracle_ref: string; command: string}
interface Outcome {outcome_ref: string; description: string; oracles: Oracle[]; criterion_ids: string[]}

function deliveryContract(spec: string, gap: ReportGap, path: string): Outcome[] {
  // Skip documentation examples and comments before applying the existing section parser.
  const visible = spec.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  const lines: string[] = [];
  let fence = '';
  for (const line of visible.split('\n')) {
    const marker = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
    if (!fence && marker) fence = marker[1];
    else if (fence && marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = '';
    else if (!fence && !marker) lines.push(line);
  }
  const markdown = lines.join('\n');
  const definition = REQUIRED_SECTIONS.spec.find(section => section.name === 'Delivery Contract')!;
  const headings = extractSections(markdown).filter(heading => definition.aliases.includes(heading.toLowerCase()));
  if (headings.length !== 1) {
    gap('delivery_contract', path, '需要唯一的 Delivery Contract 才能定位 Outcome 与 Oracle');
    return [];
  }
  const subsections = extractSubsections(sectionBody(markdown, headings[0]));
  const body = (name: string) => {
    const aliases = definition.subsections!.find(section => section.name === name)!.aliases;
    const matches = subsections.filter(section => aliases.includes(section.heading.toLowerCase()));
    if (matches.length !== 1) gap('delivery_contract', path, '需要唯一的 ' + name + ' 小节');
    return matches.length === 1 ? matches[0].body : '';
  };
  const outcomeBody = body('Outcome'), oracleBody = body('Oracle'), mapping = body('AC mapping');
  const rows = outcomeBody.split('\n').map(line => /^ {0,3}[-*]\s+(\S.*)$/.exec(line)?.[1])
    .filter((row): row is string => row !== undefined);
  const outcomes = (rows.length ? rows : outcomeBody ? [outcomeBody] : []).map((row, index): Outcome => {
    const explicit = /^(OUT-[A-Z0-9-]{1,48}):\s+(\S.*)$/.exec(row);
    return {outcome_ref: explicit?.[1] ?? 'Outcome/' + (index + 1), description: (explicit?.[2] ?? row).slice(0, 500),
      oracles: [], criterion_ids: []};
  });
  const oracleLines = oracleBody.split('\n');
  const oracles = oracleLines.map(line => /^ {0,3}- (ORACLE-[A-Z0-9-]{1,48}) \[(OUT-[A-Z0-9-]{1,48})\]: \x60([^\x60\r\n]{1,2048})\x60\s*$/.exec(line));
  let invalidReferences = false;
  if (oracleLines.some((line, index) => /^ {0,3}- ORACLE-/.test(line) && !oracles[index])) {
    invalidReferences = true;
    gap('oracle_reference', path, '含无法解析的 Oracle 声明');
  }
  for (const row of oracles) {
    if (!row) continue;
    const [, oracle_ref, outcomeRef, command] = row;
    const matches = outcomes.filter(outcome => outcome.outcome_ref === outcomeRef);
    if (matches.length !== 1 || oracles.filter(other => other?.[1] === oracle_ref).length !== 1) {
      gap('oracle_reference', path, 'Oracle ID 重复或 Outcome 引用不唯一：' + oracle_ref);
      invalidReferences = true;
      continue;
    }
    matches[0].oracles.push({oracle_ref, command});
  }
  const mappingRows = mapping.split('\n').map(line => /^ {0,3}- (OUT-[A-Z0-9-]{1,48}):\s+(AC-[A-Z0-9-]+(?:\s*,\s*AC-[A-Z0-9-]+)*)\s*$/.exec(line));
  const criteria = new Set<string>();
  if (mappingRows.some(Boolean)) {
    try {for (const {id} of parseSpecAcceptance(spec)) criteria.add(id);}
    catch {gap('outcome_ac_mapping', path, 'Spec 缺少可核对的验收清单');}
  }
  for (const outcome of outcomes) {
    const maps = mappingRows.filter(row => row?.[1] === outcome.outcome_ref);
    if (maps.length > 1) gap('outcome_ac_mapping', path, 'Outcome 的 AC 映射不唯一：' + outcome.outcome_ref);
    if (maps.length !== 1) continue;
    const mapped = [...new Set(maps[0]![2].split(',').map(id => id.trim()))];
    if (mapped.every(id => criteria.has(id))) outcome.criterion_ids = mapped;
    else gap('outcome_ac_mapping', path, 'Outcome 的 AC 映射含未登记编号：' + outcome.outcome_ref);
  }
  return invalidReferences ? outcomes.map(outcome => ({...outcome, oracles: []})) : outcomes;
}

async function executionEvidence(store: DeliveryEvidenceReader, doc: TaskVerification, runId: string) {
  const id = safeSegment(doc.verdict.verifier_session ?? '');
  const run = await readRunRecords(store, runId);
  const started = run.records.find(r => r.kind === 'started');
  const finished = run.records.find(r => r.kind === 'finished');
  const attempt = run.records.find(r => r.kind === 'attempt_session' && r.data.session_id === id);
  const result = object(finished?.data?.result);
  const parent = started?.data.parent_session_id;
  if (!run.summary.complete || object(started?.data.inputs).task_id !== doc.task || !parent || parent === id
      || result.verification_run_id !== runId || result.verifier_session !== id
      || !sameJSON(result.oracle_refs, doc.raw_verdict.oracle_refs)
      || !attempt || !run.records.some(r => r.kind === 'attempt_finished' && r.data.session_id === id
        && r.data.attempt === attempt.data.attempt && r.data.stopReason === 'completed')) {
    throw new Error('最终验证的独立会话归属或记录不完整');
  }
  const sessionFile = 'runs/' + runId + '/sessions/' + id + '.json';
  const oracleFile = 'runs/' + runId + '/oracles.json';
  const session = object(await store.read(sessionFile, SESSION_BYTES));
  const raw = object(await store.read(oracleFile, EXECUTION_LIMIT));
  if (session.session_id !== id || session.source_verified !== true || session.truncated !== false
      || !Array.isArray(session.events) || !session.events.length || session.observed_events !== session.events.length
      || !session.events.every((e, i) => object(e).seq === i && !object(e).omitted)) {
    throw new Error('独立会话未对账、已截断或事件不连续');
  }
  if (raw.schema_version !== 1 || raw.run_id !== runId || raw.truncated !== false || !Array.isArray(raw.executions)) {
    throw new Error('执行退出记录无法核对或已截断');
  }
  const events = session.events.map(object);
  return {
    oracleFile: store.root + '/' + oracleFile, sessionFile: store.root + '/' + sessionFile, sessionId: id,
    calls: events.filter(event => event.type === 'tool/call'),
    results: events.filter(event => event.type === 'tool/result'),
    executions: raw.executions.map(object).filter(item => item.session_id === id),
  };
}

type Evidence = Awaited<ReturnType<typeof executionEvidence>>;
function oracleExecution(oracle: Oracle, evidence: Evidence) {
  const calls = evidence.calls.filter(event => {
    const call = object(event.data);
    if (call.name !== 'bash' && call.name !== 'pwsh') return false;
    try {return object(JSON.parse(String(call.arguments))).command === oracle.command;}
    catch {return false;}
  });
  const executions = calls.flatMap(event => {
    const call = object(event.data);
    const terminal = evidence.results.filter(result => object(object(result.data).message).toolCallId === call.callId);
    const rows = evidence.executions.filter(row => row.call_id === call.callId && row.tool === call.name);
    if (typeof call.callId !== 'string' || calls.filter(e => object(e.data).callId === call.callId).length !== 1
        || terminal.length !== 1 || Number(terminal[0].seq) <= Number(event.seq)
        || object(object(terminal[0].data).message).isError === true || rows.length !== 1
        || rows[0].command_sha256 !== specHash(oracle.command) || !Number.isSafeInteger(rows[0].exit_code)) return [];
    return [{call_id: call.callId, tool: call.name, exit_code: rows[0].exit_code as number,
      call_seq: event.seq, result_seq: terminal[0].seq}];
  });
  const status: OracleStatus = executions.some(result => result.exit_code !== 0) ? 'failed'
    : executions.length && executions.length === calls.length ? 'proven' : 'unverified';
  return {status, executions, complete: calls.length > 0 && executions.length === calls.length};
}

export async function observeDelivery(workspace: Workspace, state: TaskState, reviews: Reviews, store: DeliveryEvidenceReader, gap: ReportGap) {
  const run = state.workflow?.runs.find(r => r.id === state.workflow?.latest_run);
  const statePath = workspace.prefix + '/state.yaml';
  let record: TaskVerification | undefined, reviewIndex = -1;
  let recordSnapshot: {path: string; sha256: string} | undefined;
  let evidence: Evidence | undefined;
  const registration = state.acceptance;
  if (run?.file && !run.legacy) {
    const reportedPath = workspace.prefix + '/' + run.file;
    try {
      if (run.file !== 'verifications/' + run.id + '.json') throw new Error('最终验证文件与 run_id 不一致');
      const snapshot = await workspace.task(run.file, 4 * 1024 * 1024);
      const doc = JSON.parse(snapshot.content) as TaskVerification;
      if (doc.task !== state.task || doc.verdict?.verification_run_id !== run.id || doc.verdict.status !== run.outcome) {
        throw new Error('最终验证的任务、轮次或裁决与状态不符');
      }
      const acceptance = verificationAcceptance(doc).registration;
      if (doc.binding?.version !== 1 || !SHA256.test(doc.binding.fingerprint) || !SHA256.test(doc.binding.code_fingerprint)
          || doc.binding.artifacts?.spec?.sha256 !== acceptance.spec_sha256
          || doc.binding.artifacts.spec.path !== workspace.prefix + '/' + acceptance.spec_path) throw new Error('最终验证的代码或 Spec 绑定无效');
      record = doc;
      recordSnapshot = {path: snapshot.path, sha256: snapshot.sha256};
      if (!doc.spec_review) throw new Error('历史验证记录缺少当时的 SPEC 审查引用');
      const ref = parseSpecReviewRef(doc.spec_review);
      reviewIndex = reviews.chain.findIndex(e => e.record.review_id === ref.id && e.snapshot.sha256 === ref.sha256
        && e.record.inputs.spec.sha256 === acceptance.spec_sha256 && e.record.inputs.spec.path === doc.binding.artifacts.spec.path
        && e.record.inputs.intent.sha256 === doc.binding.artifacts.intent?.sha256);
      if (reviewIndex < 0) throw new Error('最终验证的审查引用与可信链或制品版本不一致');
      if (state.spec_review?.id !== ref.id || reviews.currentInputs !== 'match'
          || !sameJSON(registration, acceptance) || doc.verdict.snapshot_error) {
        gap('delivery_version', reportedPath, '验证绑定与当前登记或已审查输入不一致，或验证过程中版本发生变化');
      } else if (doc.raw_verdict.oracle_refs?.length) {
        evidence = await executionEvidence(store, doc, run.id);
      }
    } catch (error) {gap('verification_evidence', reportedPath, message(error));}
  } else if (run || state.artifacts.verification) {
    gap('verification_evidence', statePath, '最新验证尚无可核对的运行级版本记录');
  }

  let spec = (reviews.chain[reviewIndex] ?? reviews.chain.at(-1))?.record.inputs.spec;
  if (!spec && state.artifacts.spec) {
    try {spec = await workspace.task(state.artifacts.spec);}
    catch (error) {gap('delivery_spec', statePath, message(error));}
  }
  const refs = record?.raw_verdict?.oracle_refs;
  const criterionResults = Array.isArray(record?.verdict.criteria_results) ? record.verdict.criteria_results : [];
  const outcomes = spec ? deliveryContract(spec.content, gap, spec.path).map(outcome => {
    const oracleResults = outcome.oracles.map(oracle => {
      const result = evidence && Array.isArray(refs) && refs.includes(oracle.oracle_ref) ? oracleExecution(oracle, evidence) : undefined;
      if (!result?.complete) gap('oracle_execution', spec!.path, '缺少可核对的完整独立执行结果：' + oracle.oracle_ref);
      return {
        ...oracle, status: result?.status ?? 'unverified', expected_exit_code: 0, run_id: run?.id ?? null,
        executions: result?.executions ?? [],
        ...(result?.executions.length && evidence ? {session_id: evidence.sessionId,
          working_directory: '.', evidence_path: evidence.oracleFile, session_path: evidence.sessionFile} : {}),
      };
    });
    if (!oracleResults.length) gap('oracle_reference', spec!.path, 'Outcome 缺少可核对的 Oracle 声明：' + outcome.outcome_ref);
    const status: OracleStatus = oracleResults.some(o => o.status === 'failed') ? 'failed'
      : oracleResults.length && oracleResults.every(o => o.status === 'proven') ? 'proven' : 'unverified';
    return {outcome_ref: outcome.outcome_ref, description: outcome.description, criterion_ids: outcome.criterion_ids,
      spec_path: spec!.path, spec_sha256: spec!.sha256, status, oracles: oracleResults};
  }) : [];
  const verification = run ? {
    run_id: run.id, outcome: run.outcome, started_at: run.started_at, finished_at: run.finished_at ?? null,
    record_path: recordSnapshot?.path ?? null, record_sha256: recordSnapshot?.sha256 ?? null,
    verdict: record?.verdict.status ?? null, verification_complete: record?.verdict.verification_complete ?? null,
    verifier_session: record?.verdict.verifier_session ?? null,
    spec_review: reviewIndex >= 0 ? record?.spec_review : null,
    acceptance: record?.acceptance ? {id: record.acceptance.id, spec_path: record.acceptance.spec_path,
      spec_sha256: record.acceptance.spec_sha256} : null,
    code_fingerprint: record?.binding.code_fingerprint ?? null, binding_fingerprint: record?.binding.fingerprint ?? null,
    criteria_results: (record?.acceptance?.criteria ?? []).map(({id}) => {
      const results = criterionResults.filter(r => r?.criterion_id === id && ['met', 'not_met', 'cannot_tell'].includes(r.result));
      const result = results.length === 1 ? results[0] : undefined;
      return {criterion_id: id, result: result?.result ?? 'unknown',
        evidence: typeof result?.evidence === 'string' ? result.evidence.slice(0, 1500) : null};
    }),
  } : null;
  return {verification, outcomes, reviewIndex, criteria: record?.acceptance?.criteria ?? []};
}
