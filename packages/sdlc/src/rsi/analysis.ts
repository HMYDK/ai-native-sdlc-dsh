export interface RecordEvent { schema_version: number; run_id: string; seq: number; at: string; kind: string; data: Record<string, unknown> }
export interface RunSummary {
  run_id: string; outcome: string; attempts: number; session_ids: string[];
  started_at: string | null; duration_ms: number | null; verdict: string | null;
  complete: boolean; issues: string[];
  evidence_complete?: boolean; replay_ready?: boolean; evidence_issues?: string[];
}
export function summarizeRun(runId: string, records: RecordEvent[]): RunSummary {
  const sorted = [...records].sort((a,b)=>a.seq-b.seq);
  const issues: string[] = [];
  sorted.forEach((r,i)=>{
    if(r.schema_version!==1 || r.run_id!==runId || r.seq!==i || !Number.isFinite(Date.parse(r.at))) issues.push(`事件 ${i} 的版本、归属、序号或时间不完整`);
  });
  const start=sorted[0]?.kind==='started'?sorted[0]:undefined;
  const finish=sorted.at(-1)?.kind==='finished'?sorted.at(-1):undefined;
  if(!start) issues.push('缺少开始记录');
  if(!finish) issues.push('缺少结束记录，可能仍在运行或曾中断');
  if(sorted.filter(r=>r.kind==='finished').length>1) issues.push('出现多个结束记录');
  const result=object(finish?.data.result);
  const outcome=typeof finish?.data.outcome==='string'?finish.data.outcome:'unknown';
  const verdict=['approve','reject','needs_human'].includes(String(result.status))?String(result.status):null;
  const complete=issues.length===0 && outcome==='completed' && verdict!==null;
  const duration=start && finish?Date.parse(finish.at)-Date.parse(start.at):null;
  if(duration!==null && duration<0) issues.push('结束时间早于开始时间');
  return {run_id:runId,outcome,attempts:sorted.filter(r=>r.kind==='attempt_started').length,
    session_ids:[...new Set(sorted.filter(r=>r.kind==='attempt_session').map(r=>r.data.session_id).filter((v):v is string=>typeof v==='string'))],
    started_at:start?.at??null,duration_ms:duration!==null&&duration>=0?duration:null,
    verdict:complete?verdict:null,complete:complete&&issues.length===0,issues};
}
export function object(value: unknown):Record<string,unknown> {
  return value!==null && typeof value==='object' && !Array.isArray(value)?value as Record<string,unknown>:{};
}
export function analyzeRuns(runs: {summary:RunSummary; records:RecordEvent[]}[]) {
  const observations: {kind:string; run_ids:string[]; evidence:string[]; hypothesis:string}[]=[];
  const groups:Record<string,typeof runs>={};
  for(const run of runs) {
    if (run.summary.evidence_complete === false) {
      observations.push({kind:'incomplete_capture',run_ids:[run.summary.run_id],
        evidence:[`runs/${run.summary.run_id}/capture.json`,`runs/${run.summary.run_id}/code.json`],
        hypothesis:`裁决完成不代表证据完整。先恢复采集或补录可核对的原始日志；不得补造历史配置或代码起点。${(run.summary.evidence_issues ?? []).join('; ')}`});
    }
    const kind=run.summary.issues.length?'incomplete_evidence':run.summary.outcome;
    (groups[kind]??=[]).push(run);
    if(run.summary.attempts>1) (groups.retried??=[]).push(run);
  }
  const hypotheses:Record<string,string>={
    no_verdict:'先区分提供方错误、取消和结构化输出失败；只有 trace 支持生成失败时，才比较缩短裁决与重试的效果。',
    error:'先定位报错的工具或基础设施；确认复现方式，再选择代码修复或配置修复。',
    cancelled:'取消并不说明方案有缺陷；结合取消前的耗时与人工说明再判断。',
    retried:'重试增加了成本；比较首次完成率与最终完成率，检查是否用更多调用换来了同样的正确结果。',
    incomplete_evidence:'先补齐记录或确认运行已结束；不能用缺失记录推断成功或根因。',
  };
  for(const [kind,items] of Object.entries(groups)) {
    if(!hypotheses[kind]) continue;
    observations.push({kind,run_ids:items.map(r=>r.summary.run_id),evidence:items.map(r=>{
      const last=r.records.at(-1); return `runs/${r.summary.run_id}/${String(last?.seq??0).padStart(6,'0')}.json`;
    }),hypothesis:hypotheses[kind]});
  }
  const completed=runs.filter(r=>r.summary.complete).length;
  return {total:runs.length,completed,completion_rate:runs.length?completed/runs.length:null,
    evidence_complete:runs.filter(r=>r.summary.evidence_complete===true).length,
    replay_ready:runs.filter(r=>r.summary.replay_ready===true).length,
    attempts:runs.reduce((n,r)=>n+r.summary.attempts,0),
    observed_duration_ms:runs.reduce((n,r)=>n+(r.summary.duration_ms??0),0),
    duration_unknown:runs.filter(r=>r.summary.duration_ms===null).length,
    observations,note:'这是有证据引用的现象和待验证假设；没有外部参考答案，不能据此估算漏检或误伤。'};
}
