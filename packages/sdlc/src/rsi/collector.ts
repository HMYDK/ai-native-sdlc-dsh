import type {Context} from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-session';
import type {VerificationRecord} from '../verify/recording.js';
import {Store,cwdOf,message,safeSegment,type Execution} from './store.js';
import {object} from './analysis.js';
import {captureWorkspace,type CodeSnapshot} from './snapshot.js';
import {Trace,readSession} from './trace.js';
import {LOADED_SUITE} from './runtime.js';

interface Capture {
  store:Store; parent:string; queue:Promise<void>; errors:string[];
  sessions:Map<string,Trace>; exec:Execution;
  enqueued:Map<string,number>;
}
export interface CaptureInfo {sessions:ReturnType<Trace['summary']>[];errors:string[]}

/** Per-run queues own all writes; session notifications never leak rejected promises. */
export class Collector {
  private active=new Map<string,Capture>();
  private pending=new Map<string,Trace>();
  constructor(readonly ctx:Context,readonly root:string) {}

  async code(exec:Execution):Promise<CodeSnapshot> {
    const cwd=cwdOf(exec);
    const workspace=await this.ctx.fs.resolve('.',{cwd});
    const mapped=this.ctx.fs.processPathFromHostPath(cwd);
    if(mapped===undefined||(await this.ctx.fs.resolve(mapped,{cwd})).targetKey!==workspace.targetKey) {
      return {complete:false,fingerprint:null,head:null,diff:null,untracked:[],excluded:[],issues:['文件系统不映射到宿主，无法用本机 Git 保存代码起点']};
    }
    return captureWorkspace(cwd,async(p,max)=>{
      const target=await this.ctx.fs.resolve(p,{cwd});
      if(!this.ctx.fs.contains(workspace,target))throw new Error(`快照文件越出工作区: ${p}`);
      return this.ctx.fs.readBytes(target,undefined,max);
    },this.root);
  }

  async record(record:VerificationRecord,exec:Execution):Promise<void> {
    safeSegment(record.run_id);
    if(!Number.isSafeInteger(record.seq)||record.seq<0||record.seq>999999)throw new Error('RSI 事件序号不合法');
    let state=this.active.get(record.run_id);
    if(record.kind==='started') {
      if(state)throw new Error('同一运行重复开始');
      const writeExec={agent:exec.agent};
      state={store:new Store(this.ctx,writeExec,this.root),parent:String(record.data.parent_session_id??object(exec.agent).id??''),queue:Promise.resolve(),errors:[],sessions:new Map(),exec:writeExec,enqueued:new Map()};
      this.active.set(record.run_id,state);
    }
    if(!state)throw new Error(`没有运行开始记录: ${record.run_id}`);
    const current=state;
    await current.queue;
    const durable=new Store(this.ctx,{...current.exec,signal:AbortSignal.timeout(15000)},this.root);
    try {
      if(record.kind==='attempt_session') {
        const id=safeSegment(String(record.data.session_id));
        const trace=this.pending.get(id)??new Trace(id,current.parent);
        this.pending.delete(id);current.sessions.set(id,trace);
        // The child may emit before startActivation returns its ID. Recover that prefix.
        try {trace.reconcile((await readSession(this.ctx,id,cwdOf(current.exec),current.parent)).events);}catch {/* report unresolved gaps at finish */}
        this.enqueueNewTrace(current,record.run_id,id,trace);
        await current.queue;
      }
      const value=record.kind==='started'?{...record,data:{...record.data,loaded_suite:LOADED_SUITE}}:record;
      await durable.write(`runs/${record.run_id}/${String(record.seq).padStart(6,'0')}.json`,value);
      if(record.kind==='started')await durable.write(`runs/${record.run_id}/code.json`,await this.code(current.exec));
      if(record.kind==='finished') {
        for(const [id,trace] of current.sessions) {
          try {trace.reconcile((await readSession(this.ctx,id,cwdOf(current.exec),current.parent)).events);}
          catch(error) {trace.source_verified=false;trace.issue(message(error));}
          this.enqueueNewTrace(current,record.run_id,id,trace);
          await current.queue;
          await durable.write(`runs/${record.run_id}/sessions/${id}.json`,trace.snapshot());
        }
        await durable.write(`runs/${record.run_id}/capture.json`,{
          sessions:[...current.sessions.values()].map(trace=>trace.summary()),errors:current.errors,
        } satisfies CaptureInfo);
        if(current.errors.length)throw new Error(`部分运行证据写入失败: ${current.errors.join('; ')}`);
        const health=(await durable.run(record.run_id)).evidence;
        if(!health.complete)throw new Error(`RSI 执行证据不完整: ${health.issues.join('; ')}`);
      }
    }catch(error) {current.errors.push(message(error));throw error;}
    finally {
      if(record.kind==='finished') {
        this.active.delete(record.run_id);
        for(const [id,trace] of this.pending)if(![...this.active.values()].some(c=>c.parent===trace.parent))this.pending.delete(id);
      }
    }
  }

  observe(session:unknown,event:unknown):void {
    const s=object(session),header=object(s.header);
    const id=String(s.id??''),parent=String(header.parentSession??'');
    const entry=[...this.active.entries()].find(([,c])=>c.sessions.has(id));
    const owner=entry?.[1];
    if(!owner&&!([...this.active.values()].some(c=>c.parent===parent)&&header.origin==='subagent'))return;
    try {safeSegment(id);}catch {return;}
    let trace=owner?.sessions.get(id)??this.pending.get(id);
    if(!trace) {
      if(this.pending.size>=64) {for(const c of this.active.values())if(c.parent===parent)c.errors.push('子会话缓冲超过 64，部分 trace 未收集');return;}
      trace=new Trace(id,parent);this.pending.set(id,trace);
    }
    trace.observe(event);
    if(owner&&entry)this.enqueueNewTrace(owner,entry[0],id,trace);
  }

  private enqueueNewTrace(state:Capture,runId:string,id:string,trace:Trace):void {
    for(let i=state.enqueued.get(id)??0;i<trace.events.length;i++)this.enqueueTrace(state,runId,id,i,trace.events[i]);
    state.enqueued.set(id,trace.events.length);
  }

  private enqueueTrace(state:Capture,runId:string,sessionId:string,index:number,event:unknown):void {
    state.queue=state.queue.then(async()=>{
      const store=new Store(this.ctx,{...state.exec,signal:AbortSignal.timeout(15000)},this.root);
      await store.write(`runs/${runId}/sessions/${sessionId}/events/${String(index).padStart(6,'0')}.json`,event);
    }).catch(error=>{state.errors.push(message(error));});
  }
  async flush():Promise<void> {await Promise.all([...this.active.values()].map(c=>c.queue));}
}
