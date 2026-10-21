import {object, type RecordEvent} from './analysis.js';

export interface EvidenceHealth {
  complete: boolean;
  replay_ready: boolean;
  issues: string[];
}

/** A verdict is an outcome, not proof that its investigation was recorded. */
export function assessEvidence(records: RecordEvent[], rawCapture: unknown, rawCode: unknown): EvidenceHealth {
  const issues: string[] = [];
  const capture = object(rawCapture), code = object(rawCode);
  const expected = [...new Set(records.filter(r => r.kind === 'attempt_session')
    .map(r => r.data.session_id).filter((id): id is string => typeof id === 'string'))];
  const sessions = Array.isArray(capture.sessions) ? capture.sessions.map(object) : [];
  if (!rawCapture) issues.push('缺少 capture.json，不能确认会话证据是否保存');
  for (const id of expected) {
    const matches = sessions.filter(s => s.session_id === id);
    if (matches.length !== 1) { issues.push(`会话 ${id} 的采集记录缺失或重复`); continue; }
    const session = matches[0];
    if (!Array.isArray(session.configs) || session.configs.length === 0) issues.push(`会话 ${id} 未观测到实际模型请求配置`);
    if (typeof session.observed_events !== 'number' || session.observed_events === 0) issues.push(`会话 ${id} 缺少可核对的执行事件`);
    if (session.source_verified !== true) issues.push(`会话 ${id} 未与 DSH 原始日志对账`);
    if (session.truncated === true) issues.push(`会话 ${id} 的执行记录被截断`);
    if (Array.isArray(session.issues)) issues.push(...session.issues.filter((v): v is string => typeof v === 'string').map(v => `会话 ${id}: ${v}`));
  }
  if (Array.isArray(capture.errors)) issues.push(...capture.errors.filter((v): v is string => typeof v === 'string'));
  if (code.complete !== true || typeof code.fingerprint !== 'string') issues.push('代码起点不完整，不能据此重放对照');
  if (Array.isArray(code.issues)) issues.push(...code.issues.filter((v): v is string => typeof v === 'string'));
  const unique = [...new Set(issues)];
  return {complete: unique.length === 0, replay_ready: unique.length === 0 && expected.length > 0, issues: unique};
}
