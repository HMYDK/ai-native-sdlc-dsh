/** Public process facts. Never copy messages, model configuration, command bodies or tool output. */
const obj = (x: unknown): Record<string, unknown> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};
const short = (x: unknown, max = 500): string | undefined => typeof x === 'string' ? x.slice(0,max) : undefined;
export function sessionView(snapshot: Record<string, unknown>) {
  const events: unknown[] = [];
  for (const raw of Array.isArray(snapshot.events) ? snapshot.events : []) {
    const e = obj(raw), d = obj(e.data);
    if (e.omitted) continue;
    if (e.type === 'tool/call') {
      let a: Record<string,unknown> = {};
      try {a = obj(typeof d.arguments === 'string' ? JSON.parse(d.arguments) : d.arguments);} catch { /* unknown */ }
      const args: Record<string,unknown> = {};
      if (d.name === 'sdlc_fix_start' || d.name === 'sdlc_fix_end') {
        args.task_id = short(a.task_id,96); args.reason = short(a.reason,1000);
      } else if (d.name === 'edit' || d.name === 'write') args.path = short(a.path ?? a.file_path ?? a.filePath);
      events.push({type:e.type,seq:e.seq,time:e.time,data:{callId:short(d.callId,160),name:short(d.name,80),arguments:args}});
    } else if (e.type === 'tool/result') {
      const m = obj(d.message);
      events.push({type:e.type,seq:e.seq,time:e.time,data:{message:{toolCallId:short(m.toolCallId,160),isError:m.isError === true}}});
    }
  }
  return {schema_version:1,session_id:snapshot.session_id,role:snapshot.role,windows:snapshot.windows,
    source_verified:snapshot.source_verified,truncated:snapshot.truncated,issues:snapshot.issues,events};
}
