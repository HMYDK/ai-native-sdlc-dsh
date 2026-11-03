/** Read-only, bounded projections of a selected task's durable execution evidence. */
import type {Context} from '@deepseek-ai/cordis';
import type {FsTarget} from '@deepseek-ai/dsh-fs';
import {JSON_SCHEMA, load as parseYaml} from 'js-yaml';
import {STATUSES} from '../task/state.js';
import {parseWorkflow, type TaskWorkflow, type FlowIssue} from '../task/flow.js';
import {sessionView} from '../shared/session-view.js';
import {enforceCriteriaPolicy, criterionEntries, type Verdict, type CriteriaInput} from '../verify/verdict.js';
import {additionalCriteria, parseAcceptanceRegistration, verificationAcceptance} from '../shared/acceptance.js';

type FileSystem = Pick<Context['fs'], 'resolve' | 'contains' | 'stat' | 'readBytes' | 'listDir'>;
type ObjectValue = Record<string, unknown>;
type Outcome = 'approve' | 'reject' | 'needs_human' | 'error' | 'cancelled' | 'no_verdict' | 'incomplete';
export interface ExecutionRound {
  id: string; number: number; source: 'rsi' | 'current_verdict' | 'task_record';
  startedAt: string | null; finishedAt: string | null; outcome: Outcome; attemptCount: number;
  summary: string; criteria: {criterion: string; status: string; evidence: string}[];
  findings: {id: string; severity: string; description: string; evidence: string}[];
  unverified: string[];
  testEvidence: string | null; changesSummary: string | null;
  toolEvents: {id: string; name: string; at: string | null; status: 'completed' | 'error' | 'unknown'; summary: string}[];
}
export interface ExecutionRepair {
  id: string; at: string | null; kind: 'fix_start' | 'fix_end' | 'backtrack'; summary: string; source: string;
}
export interface TaskExecution {
  taskId: string; repoRoot: string; status: 'recorded' | 'partial' | 'unavailable';
  issues: string[]; rounds: ExecutionRound[]; repairs: ExecutionRepair[];
  findings: FlowIssue[]; findingTotal: number; findingOffset: number; findingNext: number | null;
  activities: {id:string;at:string|null;summary:string}[];
}
interface ReadOptions {repoRoot: string; taskId: string; tasksDir?: string; rsiDir?: string; signal?: AbortSignal; findingOffset?: number}
interface RecordEvent {seq: number; kind: string; at: string | null; data: ObjectValue}
interface SessionEntry {id: string; role: string; parent?: string; windows: {from: number | null; to: number | null}[]}
const STAGES: readonly string[] = STATUSES;
const MAX_ROUNDS = 50, MAX_SESSIONS = 64, MAX_RECORDS = 64, MAX_EVENTS = 8192;
const MAX_FILE = 2 * 1024 * 1024, MAX_TRACE = 32 * 1024 * 1024, MAX_TOTAL = 64 * 1024 * 1024;
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown, length = 600): string => typeof value === 'string' ? value.slice(0, length) : '';
const timestamp = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const eventTime = (event: ObjectValue): string | null => typeof event.time === 'number' && Number.isFinite(event.time) && Math.abs(event.time) <= 8.64e15 ? new Date(event.time).toISOString() : timestamp(event.at);
const segment = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value) && !value.includes('..');
function relative(value: string): string {
  if (!value || value.startsWith('/') || /[\\:\x00-\x1f]/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('目录必须是工作区内相对路径');
  return value;
}
const verdictStatus = (value: unknown): value is 'approve' | 'reject' | 'needs_human' => ['approve', 'reject', 'needs_human'].includes(String(value));

/** Uses DSH's identity/containment and byte-limited reads; never invokes the RSI collector. */
export async function readExecution(fs: FileSystem, options: ReadOptions): Promise<TaskExecution> {
  const {repoRoot, taskId, signal} = options;
  const output: TaskExecution = {taskId, repoRoot, status: 'unavailable', issues: [], rounds: [], repairs: [], findings: [], findingTotal: 0, findingOffset: 0, findingNext: null, activities: []};
  const issue = (message: string) => { if (output.issues.length < 30 && !output.issues.includes(message)) output.issues.push(message); };
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(taskId)) { issue('任务标识不合法'); return output; }
  let remaining = MAX_TOTAL;
  const workspace = await fs.resolve('.', {cwd: repoRoot, signal});
  const tasksDir = relative(options.tasksDir ?? '.ai/tasks'), rsiDir = relative(options.rsiDir ?? '.ai/rsi');
  const taskDir = `${tasksDir}/${taskId}`;
  const taskRoot = await fs.resolve(taskDir, {cwd: repoRoot, signal});
  const rsiRoot = await fs.resolve(rsiDir, {cwd: repoRoot, signal});
  const target = async (base: FsTarget, prefix: string, name: string) => {
    relative(name);
    const value = await fs.resolve(`${prefix}/${name}`, {cwd: workspace.displayPath || repoRoot, signal});
    if (!fs.contains(workspace, base) || !fs.contains(base, value)) throw new Error('路径越出记录目录');
    return value;
  };
  const read = async (base: FsTarget, prefix: string, name: string, max = MAX_FILE): Promise<string | undefined> => {
    const value = await target(base, prefix, name), info = await fs.stat(value, signal);
    if (!info) return undefined;
    if (info.type !== 'file') throw new Error('记录不是普通文件');
    const cap = Math.min(max, remaining);
    if (cap <= 0 || (info.size !== undefined && info.size > cap)) throw new Error('记录超过读取上限');
    const bytes = await fs.readBytes(value, signal, cap);
    remaining -= bytes.byteLength;
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  };
  const json = async (name: string, max = MAX_FILE): Promise<unknown> => {
    const raw = await read(rsiRoot, rsiDir, name, max);
    return raw === undefined ? undefined : JSON.parse(raw);
  };
  // Never include parser errors: they may quote the raw input that this projection omits.
  const failed = (name: string, error: unknown) => issue(`${name}: ${error instanceof Error && /上限|越出|普通文件/.test(error.message) ? error.message : '记录缺失、损坏或无法读取'}`);
  const array = (value: unknown, max: number, label: string): unknown[] => {
    if (!Array.isArray(value)) { issue(`${label}格式不完整`); return []; }
    if (value.length > max) issue(`${label}超过展示上限 ${max}，仅保留部分记录`);
    return value.slice(0, max);
  };
  const criteriaFor = (inputs: ObjectValue): CriteriaInput => inputs.schema_version === 3 ? verificationAcceptance(inputs).entries
    : inputs.acceptance ? [...parseAcceptanceRegistration(inputs.acceptance).criteria,...additionalCriteria(inputs.additional_criteria as string[] | undefined)]
    : Array.isArray(inputs.criteria) && inputs.criteria.every(c=>typeof c==='string') ? inputs.criteria as string[] : [];
  const normalizeVerdict = (id: string, verdict: ObjectValue, inputs: ObjectValue) => ({
    summary: text(verdict.summary, 800),
    criteria: array(verdict.criteria_results ?? [], 24, `${id} 验收标准`).map((raw, i) => {
      const row = object(raw);
      const entries = criterionEntries(criteriaFor(inputs));
      const entry = typeof row.criterion_id === 'string' ? entries.find(c=>c.id===row.criterion_id) : entries[i];
      return {criterion: text(row.criterion || entry?.text || row.criterion_id || `第 ${i + 1} 条标准`),
        status: ['met', 'not_met', 'cannot_tell'].includes(String(row.result)) ? String(row.result) : 'unknown', evidence: text(row.evidence)};
    }),
    findings: array(verdict.findings ?? [], 24, `${id} 发现`).map((raw, i) => {
      const row = object(raw);
      return {id: `${id}:finding:${i + 1}`, severity: ['blocking', 'important', 'minor'].includes(String(row.severity)) ? String(row.severity) : 'unknown', description: text(row.reason), evidence: text(row.evidence)};
    }),
    testEvidence: text(inputs.test_evidence, 1000) || null,
    unverified: array(verdict.unverified ?? [], 24, `${id} 未复核事项`).filter((v): v is string => typeof v === 'string').map(v => text(v)),
    // A caller's short change intent is available; raw diffs/code are never returned.
    changesSummary: text(inputs.intent_of_change, 800) || null,
  });
  let workflow: TaskWorkflow | undefined;
  try {
    const raw = await read(taskRoot, taskDir, 'state.yaml', 2 * 1024 * 1024);
    if (raw === undefined) throw new Error('任务状态缺失');
    const state = object(parseYaml(raw, {schema: JSON_SCHEMA}));
    if (state.task !== taskId) throw new Error('任务状态归属不符');
    if (state.workflow) workflow = parseWorkflow(state.workflow);
    if (workflow) {
      const offset = Math.min(Math.max(0,Math.floor((workflow.issues.length-1)/20)*20),Math.max(0, Number.isSafeInteger(options.findingOffset) ? options.findingOffset! : 0));
      output.findingTotal = workflow.issues.length; output.findingOffset = offset;
      output.findings = workflow.issues.slice(offset,offset+20).map(i => ({...i,actions:i.actions.slice(-100)}));
      output.findingNext = offset+20 < workflow.issues.length ? offset+20 : null;
      if (output.findings.some(i=>i.actions.length===100)) issue('单个问题仅展示最近 100 个处理动作');
    }
    for (const [i, entry] of array(state.history ?? [], 256, '任务历史').entries()) {
      const h = object(entry), from = STAGES.indexOf(String(h.from)), to = STAGES.indexOf(String(h.to));
      if (from >= 0 && to >= 0 && to < from) output.repairs.push({id: `history:${i}`, at: timestamp(h.at), kind: 'backtrack', summary: `${String(h.from)} → ${String(h.to)}${text(h.reason) ? `：${text(h.reason)}` : ''}`, source: `${taskDir}/state.yaml#history[${i}]`});
    }
  } catch (error) { failed(`${taskDir}/state.yaml`, error); return output; }

  let manifest: ObjectValue | undefined;
  try {
    const value = await json(`tasks/${taskId}/task.json`, 256 * 1024);
    if (value !== undefined) {
      const doc = object(value);
      if (doc.schema_version !== 1 || doc.task_id !== taskId || typeof doc.workspace !== 'string' || typeof doc.task_dir !== 'string') throw new Error('索引归属不符');
      relative(doc.task_dir);
      const owner = await fs.resolve(doc.workspace, {cwd: repoRoot, signal}), ownerTask = await fs.resolve(doc.task_dir, {cwd: repoRoot, signal});
      if (owner.targetKey !== workspace.targetKey || ownerTask.targetKey !== taskRoot.targetKey) throw new Error('索引归属不符');
      manifest = doc;
      for (const entry of array(doc.issues ?? [], 16, '索引问题')) if (typeof entry === 'string') issue(text(entry));
    }
  } catch (error) { failed(`tasks/${taskId}/task.json（含归属检查）`, error); }

  const sessions = new Map<string, SessionEntry>();
  const traces = new Map<string, ObjectValue[]>();
  if (manifest) for (const raw of array(manifest.sessions, MAX_SESSIONS, '登记会话')) {
    const row = object(raw);
    if (!segment(row.id) || !['author', 'verifier', 'worker'].includes(String(row.role)) || !Array.isArray(row.windows) || (row.parent !== undefined && !segment(row.parent))) { issue('登记会话的标识、角色或范围不合法'); continue; }
    const windows: SessionEntry['windows'] = [];
    for (const rawWindow of row.windows.slice(0, 128)) {
      const w = object(rawWindow);
      if (![w.from, w.to].every(n => n === null || Number.isSafeInteger(n) && Number(n) >= 0) || (w.from !== null && w.to !== null && Number(w.to) < Number(w.from))) { issue(`${row.id}: 会话范围不合法`); continue; }
      windows.push({from: w.from as number | null, to: w.to as number | null});
    }
    if (sessions.has(row.id)) { issue(`${row.id}: 会话登记重复`); continue; }
    sessions.set(row.id, {id: row.id, role: String(row.role), parent: row.parent as string | undefined, windows});
  }
  const trace = async (entry: SessionEntry): Promise<ObjectValue[]> => {
    if (traces.has(entry.id)) return traces.get(entry.id)!;
    const location = `tasks/${taskId}/sessions/${entry.id}.json`;
    const events: ObjectValue[] = [];
    try {
      const compact = await json(location.replace(/\.json$/, '.view.json'));
      const snapshot = compact === undefined ? object(sessionView(object(await json(location, MAX_TRACE)))) : object(compact);
      if (compact !== undefined && snapshot.schema_version !== 1) throw new Error('精简过程记录格式不符');
      if (snapshot.session_id !== entry.id || snapshot.role !== entry.role || !Array.isArray(snapshot.events)) throw new Error('会话归属或形状不符');
      if (snapshot.source_verified !== true || snapshot.truncated === true) issue(`${entry.id}: 会话证据未确认完整`);
      for (const value of array(snapshot.issues ?? [], 8, `${entry.id} 问题`)) if (typeof value === 'string') issue(`${entry.id}: ${text(value)}`);
      for (const raw of array(snapshot.events, MAX_EVENTS, `${entry.id} 事件`)) {
        const event = object(raw);
        if (!Number.isSafeInteger(event.seq) || Number(event.seq) < 0) { issue(`${entry.id}: 事件序号不完整`); continue; }
        if (!entry.windows.some(w => w.from !== null && Number(event.seq) >= w.from && (w.to === null || Number(event.seq) < w.to))) continue;
        if (event.omitted) { issue(`${entry.id}: 事件正文被截断`); continue; }
        // Hidden reasoning, messages, request configuration and arbitrary tool payloads stay private.
        if (event.type === 'tool/call' || event.type === 'tool/result') events.push(event);
      }
    } catch (error) { failed(location, error); }
    events.sort((a, b) => Number(a.seq) - Number(b.seq)); traces.set(entry.id, events); return events;
  };
  const toolCalls = (events: ObjectValue[]) => events.filter(e => e.type === 'tool/call').map(event => {
    const data = object(event.data), id = text(data.callId, 160);
    const results = id ? events.filter(e => e.type === 'tool/result' && object(object(e.data).message).toolCallId === id && Number(e.seq) > Number(event.seq)) : [];
    const result = results.length === 1 ? results[0] : undefined, message = object(object(result?.data).message);
    const status = result ? message.isError === true ? 'error' as const : 'completed' as const : 'unknown' as const;
    return {event, data, id, result, status};
  });

  const registeredRuns = manifest && Array.isArray(manifest.runs) ? [...new Set(manifest.runs)] : [];
  if (!manifest) {
    try {
      const folder = await target(rsiRoot,rsiDir,'runs');
      const names = (await fs.listDir(folder,signal)).map(e=>e.name).filter(segment).sort();
      if (names.length > 200) issue('旧轮次目录超过 200 个，本次仅核对部分');
      for (const id of names.slice(0,200)) {
        try {
        const start = object(await json(`runs/${id}/000000.json`));
        if (start.run_id !== id || start.kind !== 'started' || object(object(start.data).inputs).task_id !== taskId) continue;
        const prepared = object(await json(`runs/${id}/000001.json`));
        const artifacts = Object.values(object(object(prepared.data).artifacts));
        if (prepared.run_id !== id || prepared.kind !== 'prepared' || !artifacts.length) continue;
        let owned = true;
        for (const artifact of artifacts) {
          if (typeof artifact !== 'string' || !fs.contains(taskRoot,await fs.resolve(artifact,{cwd:repoRoot,signal}))) {owned=false;break;}
        }
        if (owned) registeredRuns.push(id);
        } catch { issue(`旧轮次 ${id} 无法核对，未归入当前任务`); }
      }
      if (registeredRuns.length) issue('旧验证轮次按任务编号和制品归属恢复；未登记的阶段退回无法还原');
    } catch { /* Legacy directories can be absent. The current-verdict fallback remains explicit. */ }
  }
  if (manifest && !Array.isArray(manifest.runs)) issue('验证轮次格式不完整');
  if (registeredRuns.length > MAX_ROUNDS) issue(`验证轮次超过展示上限 ${MAX_ROUNDS}，仅展示最近登记的轮次`);
  if (workflow) for (const run of workflow.runs.slice(-MAX_ROUNDS)) {
    try {
      let doc: ObjectValue = {};
      if (run.file) {
        const raw = await read(taskRoot,taskDir,run.file);
        doc = object(raw === undefined ? undefined : JSON.parse(raw));
        if (doc.task !== taskId || (!run.legacy && object(doc.verdict).verification_run_id !== run.id)) throw new Error('裁决归属不符');
        if (run.legacy) issue('已保留旧裁决问题；旧记录没有代码版本绑定，需重新验证');
      }
      const verdict = object(doc.verdict);
      output.rounds.push({id:run.id,number:0,source:'task_record',startedAt:timestamp(run.started_at),finishedAt:timestamp(run.finished_at),
        outcome:run.outcome,attemptCount:Number(verdict.verifier_attempts)|| (run.finished_at ? 1 : 0),
        ...normalizeVerdict(run.id,verdict,doc),toolEvents:[],summary:text(run.summary)||'运行未完成，不能确认是否仍在执行'});
    } catch(error) {failed(run.file ?? run.id,error);}
  }
  // Start with recent runs so the shared byte budget cannot hide the latest result behind old traces.
  for (const value of registeredRuns.slice(-MAX_ROUNDS).reverse()) {
    if (!segment(value)) { issue('验证运行标识不合法'); continue; }
    const id = value, records: RecordEvent[] = [];
    const taskRound = output.rounds.find(r=>r.id===id);
    try {
      const folder = await target(rsiRoot, rsiDir, `runs/${id}`);
      const names = (await fs.listDir(folder, signal)).map(entry => entry.name).filter(name => /^\d{6}\.json$/.test(name)).sort();
      if (names.length > MAX_RECORDS) issue(`${id}: 运行事件超过 ${MAX_RECORDS} 条，仅读取首尾记录`);
      const selectedNames = names.length > MAX_RECORDS ? [...names.slice(0, MAX_RECORDS / 2), ...names.slice(-MAX_RECORDS / 2)] : names;
      for (const name of selectedNames) {
        try {
          const record = object(await json(`runs/${id}/${name}`));
          if (record.schema_version !== 1 || record.run_id !== id || record.seq !== Number(name.slice(0, 6)) || typeof record.kind !== 'string' || !record.data || Array.isArray(record.data) || typeof record.data !== 'object') throw new Error('事件归属或形状不符');
          const at = timestamp(record.at); if (!at) issue(`${id}/${name}: 时间无效`);
          records.push({seq: Number(record.seq), kind: record.kind, at, data: object(record.data)});
        } catch (error) { failed(`runs/${id}/${name}`, error); }
      }
    } catch (error) { failed(`runs/${id}`, error); }
    const starts = records.filter(r => r.kind === 'started'), start = starts[0];
    if (starts.length !== 1 || !start || object(start.data.inputs).task_id !== taskId) { issue(`${id}: 缺少可核对的任务开始记录或任务归属不符`); continue; }
    records.forEach((record, i) => { if (record.seq !== i) issue(`${id}: 运行事件有缺口`); });
    const finishes = records.filter(r => r.kind === 'finished'), finish = finishes.length === 1 ? finishes[0] : undefined;
    if (finishes.length > 1) issue(`${id}: 结束记录重复，结果未确认`);
    if (!finish) issue(`${id}: 缺少结束记录，是否已结束无法确认`);
    const prepared = records.find(r=>r.kind==='prepared');
    const inputs = {...object(start.data.inputs),...(prepared ? {criteria:prepared.data.criteria,acceptance:prepared.data.acceptance} : {})}, verdict = object(finish?.data.result);
    if (verdict.status === 'approve' && Array.isArray(inputs.criteria) && Array.isArray(verdict.findings)) {
      const checked = enforceCriteriaPolicy(verdict as unknown as Verdict,criteriaFor(inputs),undefined);
      if (checked.status !== 'approve') issue(`${id}: 历史原结论为通过，但验收结果校验不完整；保留原记录，不能据此确认有效通过`);
    }
    let outcome: Outcome = 'incomplete';
    if (finish) {
      if (['cancelled', 'error', 'no_verdict'].includes(String(finish.data.outcome))) outcome = String(finish.data.outcome) as Outcome;
      else if (finish.data.outcome === 'completed' && verdictStatus(verdict.status)) outcome = verdict.status;
      else issue(`${id}: 结束记录没有明确结果`);
      if (start.at && finish.at && finish.at < start.at) issue(`${id}: 结束时间早于开始时间`);
    }
    const attempts = new Set(records.filter(r => r.kind === 'attempt_started').map(r => r.data.attempt).filter(n => Number.isSafeInteger(n) && Number(n) > 0));
    const round: ExecutionRound = {id, number: 0, source: 'rsi', startedAt: start.at, finishedAt: finish?.at ?? null, outcome, attemptCount: attempts.size,
      ...normalizeVerdict(id, verdict, inputs), toolEvents: []};
    if (!round.summary) round.summary = outcome === 'incomplete' ? '结束记录缺失，结果未确认' : outcome === 'cancelled' ? '验证已取消' : outcome === 'error' ? '验证执行出错' : '本次没有结构化裁决';
    const children = [...new Set(records.filter(r => r.kind === 'attempt_session').map(r => r.data.session_id))];
    for (const child of children) {
      const entry = typeof child === 'string' ? sessions.get(child) : undefined;
      if (!entry || entry.role !== 'verifier' || (typeof start.data.parent_session_id === 'string' && entry.parent !== start.data.parent_session_id)) { issue(`${id}: 验证者会话未登记或父级归属不符`); continue; }
      const calls = toolCalls(await trace(entry));
      for (const call of calls) {
        if (round.toolEvents.length >= 12) { issue(`${id}: 工具事件仅展示前 12 条`); break; }
        const name = text(call.data.name, 80); if (!name) continue;
        round.toolEvents.push({id: `${entry.id}:${call.id || call.event.seq}`, name, at: eventTime(call.event), status: call.status,
          summary: call.status === 'completed' ? '工具调用已完成' : call.status === 'error' ? '工具调用报错' : '缺少可配对的工具结果'});
      }
    }
    if (taskRound) {
      taskRound.toolEvents = round.toolEvents;
      taskRound.attemptCount = round.attemptCount;
    } else output.rounds.push(round);
  }
  // Fix calls must carry this task ID and have a paired successful result. A reject proves neither.
  for (const entry of sessions.values()) if (entry.role === 'author' || entry.role === 'worker') {
    for (const call of toolCalls(await trace(entry))) {
      if (['edit','write'].includes(String(call.data.name)) && call.status === 'completed' && output.activities.length < 100) {
        const args = object(call.data.arguments), file = text(args.path,500);
        if (file) output.activities.push({id:`${entry.id}:${call.id}`,at:eventTime(call.result!),summary:`作者修改文件：${file}（未据此认定问题已解决）`});
      }
      if (!['sdlc_fix_start', 'sdlc_fix_end'].includes(String(call.data.name)) || call.status !== 'completed') continue;
      let args: ObjectValue;
      try { args = object(typeof call.data.arguments === 'string' ? JSON.parse(call.data.arguments) : call.data.arguments); } catch { continue; }
      if (args.task_id !== taskId) continue;
      if (output.repairs.length >= 128) { issue('修复记录仅展示前 128 条'); break; }
      const kind = call.data.name === 'sdlc_fix_start' ? 'fix_start' : 'fix_end';
      output.repairs.push({id: `${entry.id}:${call.id}`, at: eventTime(call.result!), kind,
        summary: text(args.reason) || (kind === 'fix_start' ? '进入修复并冻结测试' : '结束修复并解除测试冻结'), source: `${rsiDir}/tasks/${taskId}/sessions/${entry.id}.json#${call.event.seq}`});
    }
  }
  if (output.activities.length === 100) issue('历史作者操作仅展示前 100 条；未展示的操作不代表没有发生');
  if (!output.rounds.length) {
    // Legacy files are a current verdict, not a reconstructed first historical round.
    try {
      const raw = await read(taskRoot, taskDir, 'verification.json', 512 * 1024);
      if (raw !== undefined) {
        const doc = object(JSON.parse(raw)), verdict = object(doc.verdict);
        if (doc.task !== taskId || !verdictStatus(verdict.status)) throw new Error('当前裁决归属或形状不符');
        const id = 'current-verdict';
        output.rounds.push({id, number: 1, source: 'current_verdict', startedAt: null, finishedAt: timestamp(doc.at), outcome: verdict.verification_complete === false ? 'no_verdict' : verdict.status,
          attemptCount: Number.isSafeInteger(verdict.verifier_attempts) && Number(verdict.verifier_attempts) > 0 ? Math.min(Number(verdict.verifier_attempts), 64) : 0,
          ...normalizeVerdict(id, verdict, doc), toolEvents: []});
      }
    } catch (error) { failed(`${taskDir}/verification.json`, error); }
    issue('没有可核对的验证历史；当前裁决不能还原此前轮次');
  }
  output.rounds.sort((a, b) => (a.startedAt ?? a.finishedAt ?? '').localeCompare(b.startedAt ?? b.finishedAt ?? '') || a.id.localeCompare(b.id));
  output.rounds.forEach((round, i) => { round.number = Math.max(0, registeredRuns.length - MAX_ROUNDS) + i + 1; });
  output.repairs.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '') || a.id.localeCompare(b.id));
  output.status = output.rounds.length || output.repairs.length || output.findings.length || output.activities.length ? output.issues.length ? 'partial' : 'recorded' : 'unavailable';
  return output;
}
