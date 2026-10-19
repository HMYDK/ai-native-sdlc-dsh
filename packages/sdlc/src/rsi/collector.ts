import type {Context} from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-session';
import type {VerificationRecord} from '../verify/recording.js';
import {Store,cwdOf,message,safeSegment,type Execution} from './store.js';
import {object} from './analysis.js';
import {captureCode,hash,type CodeSnapshot} from './snapshot.js';

interface Trace {
  session_id:string; events:unknown[]; bytes:number; truncated:boolean;
  configs:unknown[]; tool_results:number; parent:string;
}
interface Capture {
  store:Store; parent:string; queue:Promise<void>; errors:string[];
  sessions:Map<string,Trace>; exec:Execution;
}
export interface CaptureInfo {sessions:{session_id:string;configs:unknown[];tool_results:number;truncated:boolean}[]; errors:string[]}

/** All writes are owned by a per-run queue; emit callbacks never leave rejected promises behind. */
export class Collector {
  private active=new Map<string,Capture>();
  private pending=new Map<string,Trace>();
  constructor(readonly ctx:Context,readonly root:string) {}

  async code(exec:Execution):Promise<CodeSnapshot> {
    const cwd=cwdOf(exec);
    const workspace=await this.ctx.fs.resolve('.',{cwd});
    // git runs on the host. Do not pretend it can snapshot a remote FS world.
    const mapped=this.ctx.fs.processPathFromHostPath(cwd);
    if(mapped===undefined||(await this.ctx.fs.resolve(mapped,{cwd})).targetKey!==workspace.targetKey) {
      return {complete:false,fingerprint:null,head:null,diff:null,untracked:[],excluded:[],issues:['文件系统不映射到宿主，无法用本机 Git 保存代码起点']};
    }
    return captureCode(cwd,async(p,max)=>{
      const target=await this.ctx.fs.resolve(p,{cwd});
      if(!this.ctx.fs.contains(workspace,target)) throw new Error(`快照文件越出仓库: ${p}`);
      return this.ctx.fs.readBytes(target,undefined,max);
    },this.root);
  }

  async record(record:VerificationRecord,exec:Execution):Promise<void> {
    safeSegment(record.run_id);
    if(!Number.isSafeInteger(record.seq)||record.seq<0||record.seq>999999) throw new Error('RSI 事件序号不合法');
    let state=this.active.get(record.run_id);
    if(record.kind==='started') {
      if(state) throw new Error('同一运行重复开始');
      // The caller may already be cancelled when its final fact is emitted. Persistence gets its own bounded lifetime.
      const writeExec={agent:exec.agent};
      state={store:new Store(this.ctx,writeExec,this.root),parent:String(record.data.parent_session_id??object(exec.agent).id??''),queue:Promise.resolve(),errors:[],sessions:new Map(),exec:writeExec};
      this.active.set(record.run_id,state);
    }
    if(!state) throw new Error(`没有运行开始记录: ${record.run_id}`);
    const current=state;
    await current.queue;
    const durable=new Store(this.ctx,{...current.exec,signal:AbortSignal.timeout(15000)},this.root);
    try {
      if(record.kind==='attempt_session') {
        const id=safeSegment(String(record.data.session_id));
        const trace=this.pending.get(id)??{session_id:id,parent:current.parent,events:[],bytes:0,truncated:false,configs:[],tool_results:0};
        this.pending.delete(id);current.sessions.set(id,trace);
        trace.events.forEach((event,index)=>this.enqueueTrace(current,record.run_id,id,index,event));
        await current.queue;
      }
      await durable.write(`runs/${record.run_id}/${String(record.seq).padStart(6,'0')}.json`,record);
      if(record.kind==='started') {
        await durable.write(`runs/${record.run_id}/code.json`,await this.code(current.exec));
      }
      if(record.kind==='finished') {
        for(const [id,trace] of current.sessions) {
          await durable.write(`runs/${record.run_id}/sessions/${id}.json`,{session_id:id,events:trace.events,truncated:trace.truncated});
        }
        await durable.write(`runs/${record.run_id}/capture.json`,{
          sessions:[...current.sessions.values()].map(({session_id,configs,tool_results,truncated})=>({session_id,configs,tool_results,truncated})),
          errors:current.errors,
        } satisfies CaptureInfo);
        if(current.errors.length) throw new Error(`部分运行证据写入失败: ${current.errors.join('; ')}`);
      }
    } catch(error) {current.errors.push(message(error));throw error;}
    finally {
      if(record.kind==='finished') {
        this.active.delete(record.run_id);
        for(const [id,trace] of this.pending) if(![...this.active.values()].some(c=>c.parent===trace.parent)) this.pending.delete(id);
      }
    }
  }

  observe(session:unknown,event:unknown):void {
    const s=object(session),header=object(s.header),e=object(event);
    const id=String(s.id??'');const parent=String(header.parentSession??'');
    const entry=[...this.active.entries()].find(([,c])=>c.sessions.has(id));
    const owner=entry?.[1];
    if(!owner&&!([...this.active.values()].some(c=>c.parent===parent)&&header.origin==='subagent')) return;
    try {safeSegment(id);} catch {return;}
    let trace=owner?.sessions.get(id)??this.pending.get(id);
    if(!trace) {
      // Prevent unrelated concurrent children from growing an unbounded buffer.
      if(this.pending.size>=64) {for(const c of this.active.values()) if(c.parent===parent)c.errors.push('子会话缓冲超过 64，部分 trace 未收集');return;}
      trace={session_id:id,parent,events:[],bytes:0,truncated:false,configs:[],tool_results:0};this.pending.set(id,trace);
    }
    if(e.type==='request/header') {
      const h=object(object(e.data).header);
      if(h.config) {
        const config={config:h.config,adapterDefaults:h.adapterDefaults??null};
        if(!trace.configs.some(c=>JSON.stringify(c)===JSON.stringify(config))) trace.configs.push(JSON.parse(JSON.stringify(config)));
      }
    }
    if(e.type==='tool/result') trace.tool_results++;
    if(!['request/header','request/context','system/message','tool/result','turn/end','step/end'].includes(String(e.type))) return;
    const json=JSON.stringify(e);const bytes=Buffer.byteLength(json);
    const previous=trace.events.length;
    if(trace.bytes+bytes>2*1024*1024 || bytes>128*1024) {
      trace.truncated=true;
      if(trace.events.length<2000) trace.events.push({type:e.type,seq:e.seq,omitted:true,sha256:hash(json),bytes});
    } else if(trace.events.length<2000) {trace.events.push(JSON.parse(json));trace.bytes+=bytes;}
    else trace.truncated=true;
    if(owner&&entry&&trace.events.length>previous) this.enqueueTrace(owner,entry[0],id,previous,trace.events[previous]);
  }

  private enqueueTrace(state:Capture,runId:string,sessionId:string,index:number,event:unknown):void {
    state.queue=state.queue.then(async()=>{
      const store=new Store(this.ctx,{...state.exec,signal:AbortSignal.timeout(15000)},this.root);
      await store.write(`runs/${runId}/sessions/${sessionId}/events/${String(index).padStart(6,'0')}.json`,event);
    }).catch(error=>{state.errors.push(message(error));});
  }

  async flush():Promise<void> {await Promise.all([...this.active.values()].map(c=>c.queue));}
}
