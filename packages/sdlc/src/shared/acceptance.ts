/** One contract for Spec authoring, stage gates, verification and read-only reporting. */
import {createHash} from 'node:crypto';

export interface AcceptanceCriterion { id: string; text: string }
export interface AcceptanceRegistration {
  version: 1;
  id: string;
  spec_path: string;
  spec_sha256: string;
  criteria: AcceptanceCriterion[];
  registered_at: string;
  registered_by: string;
}
export const specHash = (text: string): string => createHash('sha256').update(text).digest('hex');
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const idPattern = /^AC-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
export const criterionText = (c: AcceptanceCriterion): string => `${c.id}: ${c.text}`;

/** A deliberately small Markdown grammar. Ambiguous/non-list content is an error, never omitted. */
export function parseSpecAcceptance(spec: string): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = [];
  let active = false, sections = 0, fence = '', comment = false;
  for (const [index, line] of spec.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!active && (comment || trimmed.startsWith('<!--'))) {
      comment = !trimmed.includes('-->');
      continue;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker || fence) {
      if (active) throw new Error(`验收章节第 ${index + 1} 行不能包含代码块；请使用 - AC-001: 要求`);
      if (!fence) fence = marker!;
      else if (marker?.[0] === fence[0] && marker.length >= fence.length && new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = '';
      continue;
    }
    const heading = /^ {0,3}(#{1,2})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      active = heading[1] === '##' && /^(acceptance criteria|验收标准)$/i.test(heading[2]);
      if (active && ++sections > 1) throw new Error('Spec 只能有一个 Acceptance Criteria / 验收标准章节');
      continue;
    }
    if (!active || !trimmed) continue;
    const row = /^ {0,3}- (AC-[A-Z0-9]+(?:-[A-Z0-9]+)*):\s*(\S.*)$/.exec(line);
    if (!row || /<[^<>\n]+>/.test(row[2])) throw new Error(`验收章节第 ${index + 1} 行格式不合法；每项单独一行：- AC-001: 明确的验收要求`);
    if (criteria.some(c => c.id === row[1])) throw new Error(`验收编号重复：${row[1]}`);
    criteria.push({id:row[1],text:row[2].trim()});
  }
  if (!sections) throw new Error('Spec 缺少 ## Acceptance Criteria（或 ## 验收标准）章节');
  if (!criteria.length) throw new Error('验收清单不能为空');
  return criteria;
}

export function registerAcceptance(spec_path: string, spec: string, id: string, registered_at: string, registered_by: string): AcceptanceRegistration {
  return parseAcceptanceRegistration({version:1,id,spec_path,spec_sha256:specHash(spec),criteria:parseSpecAcceptance(spec),registered_at,registered_by});
}
export function parseAcceptanceRegistration(raw: unknown): AcceptanceRegistration {
  const r = object(raw);
  if (r.version !== 1 || !['id','spec_path','spec_sha256','registered_at','registered_by'].every(k => typeof r[k] === 'string' && (r[k] as string).trim())
    || !/^[a-f0-9]{64}$/.test(String(r.spec_sha256)) || !Number.isFinite(Date.parse(String(r.registered_at)))
    || !Array.isArray(r.criteria) || !r.criteria.length) throw new Error('验收清单登记记录损坏或版本不支持');
  const spec_path = r.spec_path as string;
  if (spec_path.startsWith('/') || spec_path.includes('\\') || spec_path.split('/').some(p => !p || p === '..' || p === '.')) throw new Error('验收清单的 Spec 路径不合法');
  const seen = new Set<string>();
  const criteria = r.criteria.map(value => {
    const c = object(value);
    if (typeof c.id !== 'string' || !idPattern.test(c.id) || seen.has(c.id) || typeof c.text !== 'string' || !c.text.trim() || c.text !== c.text.trim() || /[\r\n]/.test(c.text)) throw new Error('验收清单登记记录包含空项、重复或非法编号');
    seen.add(c.id);
    return {id:c.id,text:c.text};
  });
  return {version:1,id:r.id as string,spec_path,spec_sha256:r.spec_sha256 as string,criteria,registered_at:r.registered_at as string,registered_by:r.registered_by as string};
}
export function requireAcceptance(raw: unknown, specPath: string | undefined, spec: string | undefined): AcceptanceRegistration {
  if (raw === undefined) throw new Error('未登记任务验收清单；请先回到 SPEC，补齐验收章节，再推进到 PLANNED 或后续阶段登记');
  const registration = parseAcceptanceRegistration(raw);
  if (spec === undefined || specPath !== registration.spec_path || specHash(spec) !== registration.spec_sha256) throw new Error('Spec 与已登记版本不同；包括说明文字在内的修改都需要回到 SPEC、记录原因并重新登记验收清单');
  if (JSON.stringify(parseSpecAcceptance(spec)) !== JSON.stringify(registration.criteria)) throw new Error('登记的验收清单与 Spec 内容不一致');
  return registration;
}

/** Legacy task callers may repeat the full list, but may not choose the task's scope. */
export function checkSubmittedCriteria(entries: AcceptanceCriterion[], submitted?: string[]): void {
  if (submitted === undefined) return;
  const seen = new Set<string>(), errors: string[] = [];
  for (const text of submitted) {
    const matches = entries.filter(c => text.trim() === c.text || text.trim() === criterionText(c));
    if (matches.length !== 1) {errors.push(`未知或被改写的验收标准：${text}`);continue;}
    const id = matches[0].id;
    if (seen.has(id)) errors.push(`重复提交：${id}`);
    seen.add(id);
  }
  const missing = entries.filter(c => !seen.has(c.id));
  if (missing.length) errors.unshift('缺少任务验收标准：' + missing.map(c => c.id).join(', '));
  if (errors.length) throw new Error(errors.join('；') + '。任务验证请省略 criteria，或提交 Spec 中的完整清单');
}
export function additionalCriteria(values: string[] = []): AcceptanceCriterion[] {
  if (!Array.isArray(values) || values.some(v => typeof v !== 'string' || !v.trim())) throw new Error('additional_criteria 必须是非空字符串组成的数组');
  const entries = values.map(text => ({id:'EXTRA-' + specHash(text.trim()).slice(0,16),text:text.trim()}));
  if (new Set(entries.map(c => c.id)).size !== entries.length) throw new Error('additional_criteria 包含重复检查');
  return entries;
}

export interface AcceptanceCoverage { expected: number; answered: number; met: number; missing: string[]; errors: string[] }
export function acceptanceCoverage(entries: AcceptanceCriterion[], raw: unknown): AcceptanceCoverage {
  const results = Array.isArray(raw) ? raw.map(object) : [], seen = new Map<string, number>(), errors: string[] = [];
  const valid = new Map<string, string>();
  if (!Array.isArray(raw)) errors.push('缺少逐项验收结果');
  for (const result of results) {
    const c = entries.find(c => c.id === result.criterion_id);
    if (!c) {errors.push(`未知验收编号：${String(result.criterion_id)}`);continue;}
    seen.set(c.id,(seen.get(c.id) ?? 0) + 1);
    if ((seen.get(c.id) ?? 0) > 1) {errors.push(`验收编号重复报告：${c.id}`);valid.delete(c.id);continue;}
    if (!['met','not_met','cannot_tell'].includes(String(result.result)) || typeof result.evidence !== 'string' || !result.evidence.trim()) {
      errors.push(`验收项 ${c.id} 的结论或证据不合法`);continue;
    }
    valid.set(c.id,String(result.result));
  }
  const missing = entries.filter(c => !seen.has(c.id)).map(c => c.id);
  if (missing.length) errors.push('缺少验收结果：' + missing.join(', '));
  return {expected:entries.length,answered:valid.size,met:[...valid.values()].filter(v=>v==='met').length,missing,errors};
}

/** v3 uses the explicit Spec IDs. v1/v2 readers must retain their original hash IDs. */
export function verificationAcceptance(raw: unknown, expected?: AcceptanceRegistration): {registration:AcceptanceRegistration; entries:AcceptanceCriterion[]} {
  const doc = object(raw);
  if (doc.schema_version !== 3) throw new Error('历史裁决未核对完整验收范围，需要按已登记清单重新验证');
  const registration = parseAcceptanceRegistration(doc.acceptance);
  if (expected && JSON.stringify(registration) !== JSON.stringify(expected)) throw new Error('裁决使用的验收清单版本已失效');
  const entries = [...registration.criteria,...additionalCriteria(doc.additional_criteria as string[] | undefined)];
  if (JSON.stringify(doc.criteria) !== JSON.stringify(entries.map(criterionText))) throw new Error('裁决保存的验收范围与登记清单不一致');
  return {registration,entries};
}

export interface AcceptanceSummary extends AcceptanceCoverage {
  status: 'unregistered'|'invalid'|'changed'|'unverified'|'legacy'|'incomplete'|'verified';
}
/** Read-only callers use exactly the same parser, baseline and coverage checks as the gates. */
export function summarizeAcceptance(raw: unknown, specPath: string | undefined, spec: string | undefined, document?: unknown): AcceptanceSummary {
  let entries: AcceptanceCriterion[] = [];
  try {if (spec !== undefined) entries = parseSpecAcceptance(spec);} catch { /* diagnostics below */ }
  const empty = (): AcceptanceCoverage => ({expected:entries.length,answered:0,met:0,missing:entries.map(c=>c.id),errors:[]});
  if (raw === undefined) return {...empty(),status:'unregistered',errors:['未登记验收清单；历史裁决未核对完整验收范围']};
  let registration: AcceptanceRegistration;
  try {registration = parseAcceptanceRegistration(raw);entries = registration.criteria;}
  catch (e) {return {...empty(),status:'invalid',errors:[(e as Error).message]};}
  try {requireAcceptance(registration,specPath,spec);}
  catch (e) {return {...empty(),status:'changed',errors:[(e as Error).message]};}
  if (document === undefined) return {...empty(),status:'unverified'};
  const doc = object(document), verdict = object(doc.verdict);
  if (doc.schema_version !== 3) return {...empty(),status:'legacy',errors:['历史裁决未核对完整验收范围']};
  // Even invalid documents show actual missing ACs rather than declaring 1/1 complete.
  const coverage = acceptanceCoverage(entries,verdict.criteria_results);
  try {
    const checked = verificationAcceptance(doc,registration);
    const all = acceptanceCoverage(checked.entries,verdict.criteria_results);
    // Additional checks do not count as mandatory Spec requirements on the board.
    coverage.errors = all.errors;
    return {...coverage,status:verdict.status === 'approve' && all.met === all.expected && !all.errors.length ? 'verified' : 'incomplete'};
  } catch (e) {return {...coverage,status:'incomplete',errors:[...coverage.errors,(e as Error).message]};}
}
