import type {Context} from '@deepseek-ai/cordis';
import type {TaskRecord} from '../shared/task-recording.js';
import type {VerificationRecord} from '../verify/recording.js';
import {parseTaskState,normalizeTaskId} from '../task/state.js';
import {JSON_SCHEMA,load as parseYaml} from 'js-yaml';
import {hash} from './snapshot.js';
import {randomUUID} from 'node:crypto';
import {Store,cwdOf,safeRelative,safeSegment,message,type Execution} from './store.js';
import {object} from './analysis.js';
import {Trace,readSession} from './trace.js';
import {LOADED_SUITE} from './runtime.js';
import type {Collector} from './collector.js';

interface Window {from:number|null;to:number|null;registered:number}
interface TaskSession {id:string;role:'author'|'verifier'|'worker';parent?:string;windows:Window[]}
export interface TaskManifest {
  schema_version:1;task_id:string;task_dir:string;workspace:string;status:string;title:string;
  created_at:string;updated_at:string;loaded_suite:typeof LOADED_SUITE;
  sessions:TaskSession[];runs:string[];checkpoints:string[];issues:string[];
  review_status:'pending'|'collecting';
}
interface ActiveTask {manifest:TaskManifest;exec:Execution;store:Store;queue:Promise<void>}

function sessionId(exec:Execution):string {
  const agent=object(exec.agent),session=object(agent.session);
  return safeSegment(String(session.id??agent.id??''));
}
function startOfTurn(events:unknown[],before:number):number {
  for(let i=Math.min(before,events.length)-1;i>=0;i--) {
    const e=object(events[i]);if(e.type==='turn/start')return i;
  }
  for(let i=Math.min(before,events.length)-1;i>=0;i--)if(object(events[i]).type==='user/message')return i;
  return before;
}

/** Task ownership is explicit. Never associate a run with "the most recent task". */
export class TaskCollector {
  private tasks=new Map<string,ActiveTask>();
  private runTasks=new Map<string,ActiveTask>();
  constructor(readonly ctx:Context,readonly root:string,readonly collector:Collector) {}
  private key(exec:Execution,id:string):string {return `${cwdOf(exec)}\0${normalizeTaskId(id)}`;}
  private async load(exec:Execution,id:string,dir=`.ai/tasks/${normalizeTaskId(id)}`):Promise<ActiveTask> {
    id=normalizeTaskId(id);safeRelative(dir);
    const key=this.key(exec,id),known=this.tasks.get(key);if(known)return known;
    const writeExec={agent:exec.agent},store=new Store(this.ctx,writeExec,this.root);
    const raw=await store.optional(`tasks/${id}/task.json`);
    let manifest:TaskManifest;
    if(raw) {
      manifest=raw as TaskManifest;
      if(manifest.schema_version!==1||manifest.task_id!==id||manifest.workspace!==cwdOf(exec)||!Array.isArray(manifest.sessions)||!Array.isArray(manifest.runs)||!Array.isArray(manifest.checkpoints))throw new Error('RSI 任务索引损坏或归属不符');
      safeRelative(manifest.task_dir);
      for(const s of manifest.sessions) {
        safeSegment(s.id);if(s.parent)safeSegment(s.parent);
        if(!Array.isArray(s.windows)||s.windows.some(w=>![w.from,w.to].every(n=>n===null||Number.isSafeInteger(n)&&Number(n)>=0)||!Number.isSafeInteger(w.registered)||w.registered<0))throw new Error('RSI 会话范围损坏');
      }
      manifest.runs.forEach(safeSegment);manifest.checkpoints.forEach(safeSegment);
    }else {
      const target=await this.ctx.fs.resolve(`${dir}/state.yaml`,{cwd:cwdOf(exec)});
      const state=parseTaskState(id,parseYaml(await this.ctx.fs.readText(target),{schema:JSON_SCHEMA}));
      if(state.task!==id)throw new Error('任务 state.yaml 与登记 ID 不一致');
      manifest={schema_version:1,task_id:id,task_dir:dir,workspace:cwdOf(exec),status:state.status,title:state.title,
        created_at:new Date().toISOString(),updated_at:new Date().toISOString(),loaded_suite:LOADED_SUITE,
        sessions:[],runs:[],checkpoints:[],issues:[],review_status:state.status==='DONE'?'pending':'collecting'};
    }
    const task={manifest,exec:writeExec,store,queue:Promise.resolve()};this.tasks.set(key,task);return task;
  }
  private enqueue(task:ActiveTask,operation:()=>Promise<void>):Promise<void> {
    const next=task.queue.then(operation);
    task.queue=next.catch(error=>{const issue=message(error);if(!task.manifest.issues.includes(issue))task.manifest.issues.push(issue);});
    return next;
  }
  private async save(task:ActiveTask):Promise<void> {
    task.manifest.updated_at=new Date().toISOString();
    await task.store.write(`tasks/${task.manifest.task_id}/task.json`,task.manifest,true);
  }
  private async bindAuthor(task:ActiveTask,exec:Execution):Promise<void> {
    const id=sessionId(exec),seq=Number(object(object(exec.agent).session).seq??0);
    let switched=false;
    for(const other of this.tasks.values()) {
      if(other===task)continue;
      const prior=other.manifest.sessions.find(s=>s.id===id&&s.role==='author');
      const open=prior?.windows.findLast(w=>w.to===null);
      if(open) {open.to=seq;switched=true;void this.enqueue(other,()=>this.save(other)).catch(()=>{});}
    }
    let entry=task.manifest.sessions.find(s=>s.id===id&&s.role==='author');
    if(!entry) {entry={id,role:'author',windows:[]};task.manifest.sessions.push(entry);}
    if(!entry.windows.some(w=>w.to===null)) {
      let from:number|null=null;
      try {const source=await readSession(this.ctx,id,cwdOf(exec));from=startOfTurn(source.events,seq||source.events.length);}catch {/* retain the unresolved prefix */}
      const last=entry.windows.at(-1)?.to??0;
      entry.windows.push({from:from===null?null:Math.max(from,last,switched?seq:0),to:null,registered:seq});
    }
  }
  async record(record:TaskRecord,exec:Execution):Promise<void> {
    const task=await this.load(exec,record.state.task,record.task_dir);
    await this.enqueue(task,async()=>{
      await this.bindAuthor(task,exec);
      task.manifest.status=record.state.status;task.manifest.title=record.state.title;
      task.manifest.review_status=record.state.status==='DONE'?'pending':'collecting';
      const id=randomUUID(),artifacts:Record<string,unknown>={};
      for(const [name,relative] of Object.entries(record.state.artifacts)) {
        try {
          safeRelative(relative);const target=await this.ctx.fs.resolve(`${record.task_dir}/${relative}`,{cwd:cwdOf(exec)});
          const base=await this.ctx.fs.resolve(record.task_dir,{cwd:cwdOf(exec)});
          if(!this.ctx.fs.contains(base,target))throw new Error('制品越出任务目录');
          const content=await this.ctx.fs.readText(target);
          if(Buffer.byteLength(content)>512*1024)throw new Error('制品超过 512 KiB，正文未保存');
          artifacts[name]={path:relative,content};
        }catch(error) {artifacts[name]={path:relative,error:message(error)};}
      }
      await task.store.write(`tasks/${task.manifest.task_id}/checkpoints/${id}.json`,{
        at:new Date().toISOString(),kind:record.kind,state:record.state,artifacts,loaded_suite:LOADED_SUITE,code:await this.collector.code(exec),
      });
      task.manifest.checkpoints.push(id);await this.save(task);await this.capture(task);
    });
  }
  async verification(record:VerificationRecord,exec:Execution):Promise<void> {
    if(record.kind==='started') {
      const id=object(record.data.inputs).task_id;if(typeof id!=='string')return;
      const task=await this.load(exec,id);
      this.runTasks.set(record.run_id,task);
      await this.enqueue(task,async()=>{
        await this.bindAuthor(task,exec);
        if(!task.manifest.runs.includes(record.run_id))task.manifest.runs.push(record.run_id);
        await this.save(task);
      });
    }
    const task=this.runTasks.get(record.run_id);if(!task)return;
    if(record.kind==='attempt_session')await this.enqueue(task,async()=>{
      const id=safeSegment(String(record.data.session_id));
      const existing=task.manifest.sessions.find(s=>s.id===id);
      if(existing)existing.role='verifier';
      else task.manifest.sessions.push({id,role:'verifier',parent:sessionId(exec),windows:[{from:0,to:null,registered:0}]});
      await this.save(task);
    });
    if(record.kind==='finished') {
      try {await this.enqueue(task,async()=>{await this.capture(task);await this.save(task);});}
      finally {this.runTasks.delete(record.run_id);}
    }
  }
  observe(session:unknown,event:unknown):void {
    const s=object(session),e=object(event),id=String(s.id??''),seq=Number(e.seq);
    if(!Number.isSafeInteger(seq)||seq<0)return;
    const parent=String(object(s.header).parentSession??'');
    for(const task of this.tasks.values()) {
      let entry=task.manifest.sessions.find(item=>item.id===id);
      if(!entry&&parent&&object(s.header).origin==='subagent') {
        const parentEntry=task.manifest.sessions.find(item=>item.id===parent&&item.windows.some(w=>w.to===null));
        if(parentEntry) {
          try {safeSegment(id);}catch {continue;}
          entry={id,role:'worker',parent,windows:[{from:0,to:null,registered:0}]};task.manifest.sessions.push(entry);
        }
      }
      if(!entry||!entry.windows.some(w=>seq>=(w.from??w.registered)&&(w.to===null||seq<w.to)))continue;
      if(e.type==='turn/end'&&(task.manifest.status==='DONE'||entry.role!=='author')) {
        const open=entry.windows.findLast(w=>w.to===null);if(open)open.to=seq+1;
      }
      // Notifications cannot await disk. Own the queue and make failures observable on flush/query.
      void this.enqueue(task,async()=>{
        const relative=`tasks/${task.manifest.task_id}/sessions/${safeSegment(id)}/events/${String(seq).padStart(8,'0')}.json`;
        if(seq<8192&&await task.store.optional(relative)===undefined) {
          const text=JSON.stringify(event),bytes=Buffer.byteLength(text);
          await task.store.write(relative,bytes<=512*1024?event:{seq,type:e.type,omitted:true,bytes,sha256:hash(text)});
        }
        if(e.type==='turn/end') {await this.save(task);await this.capture(task);}
      }).catch(()=>{});
    }
  }
  private async capture(task:ActiveTask):Promise<void> {
    const snapshots:unknown[]=[],issues=[...task.manifest.issues];
    for(const session of task.manifest.sessions) {
      const trace=new Trace(session.id,session.parent??'');
      try {
        const source=await readSession(this.ctx,session.id,task.manifest.workspace,session.parent);
        for(const window of session.windows) {
          if(window.from===null)window.from=startOfTurn(source.events,window.registered);
          const end=window.to??source.events.length;
          const selected=source.events.filter(e=>Number(object(e).seq)>=window.from!&&Number(object(e).seq)<end);
          if(selected.length!==end-window.from||!selected.every((e,i)=>object(e).seq===window.from!+i))trace.issue('登记范围内的会话事件缺失');
          // Reuse the last request header as context, explicitly outside the task's event range.
          const context=source.events.slice(0,window.from).findLast(e=>object(e).type==='request/header');
          if(context)trace.observe(context);
          selected.forEach(e=>trace.observe(e));
        }
        trace.source_verified=trace.issues.length===0;
      }catch(error) {trace.issue(message(error));}
      if(!trace.configs.length)trace.issue('未观测到实际模型请求配置');
      if(trace.truncated)trace.issue('会话内容被截断');
      if(!trace.summary().observed_events)trace.issue('会话执行事件为空');
      issues.push(...trace.issues.map(issue=>`${session.id}: ${issue}`));
      const snapshot={...trace.snapshot(),role:session.role,windows:session.windows};snapshots.push(snapshot);
      await task.store.write(`tasks/${task.manifest.task_id}/sessions/${session.id}.json`,snapshot,true);
    }
    const runs=[];
    for(const id of task.manifest.runs) {
      try {const run=await task.store.run(id);runs.push(run.summary);issues.push(...(run.summary.evidence_issues??[]).map(issue=>`${id}: ${issue}`));}
      catch(error) {issues.push(`${id}: ${message(error)}`);}
    }
    if(!task.manifest.sessions.some(s=>s.role==='author'))issues.push('缺少作者会话');
    if(!task.manifest.checkpoints.length)issues.push('没有任务起点快照；不能用后补快照冒充历史起点');
    else {
      for(const checkpoint of task.manifest.checkpoints) {
        const value=object(await task.store.read(`tasks/${task.manifest.task_id}/checkpoints/${checkpoint}.json`));
        if(object(value.code).complete!==true)issues.push(`代码快照不完整: ${checkpoint}`);
        for(const [name,artifact] of Object.entries(object(value.artifacts)))if(object(artifact).error)issues.push(`制品快照不完整: ${checkpoint}/${name}`);
      }
      const first=object(await task.store.read(`tasks/${task.manifest.task_id}/checkpoints/${task.manifest.checkpoints[0]}.json`));
      if(first.kind!=='created')issues.push('采集开始晚于任务创建，起点证据不完整');
      if(object(first.code).complete!==true)issues.push('任务起点代码快照不完整');
    }
    const health={task_id:task.manifest.task_id,task_complete:task.manifest.status==='DONE',
      evidence_complete:issues.length===0,comparison_ready:issues.length===0&&runs.length>0&&runs.every(r=>r.replay_ready),
      issues:[...new Set(issues)],run_count:runs.length,session_count:snapshots.length,
      review_status:task.manifest.review_status,updated_at:new Date().toISOString()};
    await task.store.write(`tasks/${task.manifest.task_id}/evidence.json`,{...health,runs,sessions:snapshots.map(s=>{const {events,...summary}=s as ReturnType<Trace['snapshot']>;return summary;})},true);
    // Small, non-sensitive summary for the board; raw code and tool output stay in .ai/rsi.
    await new Store(this.ctx,task.exec,task.manifest.task_dir).write('rsi.json',health,true);
    await this.save(task);
  }
  async inspect(exec:Execution,id:string) {
    const task=await this.load(exec,id);
    await this.enqueue(task,()=>this.capture(task));
    return {task:task.manifest,evidence:await task.store.read(`tasks/${task.manifest.task_id}/evidence.json`)};
  }
  async list(exec:Execution) {
    await this.flush();const store=new Store(this.ctx,exec,this.root),tasks=[];
    for(const id of await store.list('tasks')) {
      try {tasks.push({task_id:id,task:await store.read(`tasks/${safeSegment(id)}/task.json`),evidence:await store.optional(`tasks/${id}/evidence.json`)});}
      catch(error) {tasks.push({task_id:id,error:message(error)});}
    }
    return tasks;
  }
  async flush():Promise<void> {await Promise.all([...this.tasks.values()].map(task=>task.queue));}
}
