import type {Context} from '@deepseek-ai/cordis';
import {resolve} from 'node:path';
import {object} from './analysis.js';
import {hash} from './snapshot.js';

export interface SessionSource {
  header: Record<string,unknown>;
  events: readonly unknown[];
  inheritedEventCount?: number;
  [Symbol.dispose]():void;
}
interface SessionQuery {
  observeSession(id:string,options:{signal:AbortSignal;projectionMode:'none'}):Promise<SessionSource>;
}

/** Use the supported query service, not private compressed-log filenames or deprecated Session reads. */
export async function readSession(ctx:Context,id:string,cwd:string,parent?:string):Promise<{header:Record<string,unknown>;events:unknown[];inherited:number}> {
  const query=ctx.get('sessionQuery' as never) as SessionQuery|undefined;
  if(!query)throw new Error('sessionQuery 服务不可用，无法与 DSH 原始日志对账');
  const source=await query.observeSession(id,{signal:AbortSignal.timeout(15000),projectionMode:'none'});
  try {
    if(typeof source.header.cwd!=='string'||resolve(source.header.cwd)!==resolve(cwd))throw new Error('会话工作区与登记任务不一致');
    if(parent!==undefined&&source.header.parentSession!==parent)throw new Error('子会话父级与验证运行不一致');
    return {header:structuredClone(source.header),events:structuredClone([...source.events]),inherited:source.inheritedEventCount??0};
  }finally {source[Symbol.dispose]();}
}

export class Trace {
  readonly events:unknown[]=[];
  readonly configs:unknown[]=[];
  readonly issues:string[]=[];
  private readonly hashes=new Map<number,string>();
  private bytes=0;
  tool_results=0;
  truncated=false;
  source_verified=false;
  constructor(readonly session_id:string,readonly parent:string) {}

  observe(raw:unknown):void {
    const event=object(raw),seq=event.seq;
    if(!Number.isSafeInteger(seq)||Number(seq)<0||typeof event.type!=='string') {
      this.issue('事件缺少合法序号或类型');return;
    }
    const json=JSON.stringify(raw),digest=hash(json);
    if(this.hashes.has(Number(seq))) {
      if(this.hashes.get(Number(seq))!==digest)this.issue(`事件 ${seq} 的内容发生变化`);
      return;
    }
    this.hashes.set(Number(seq),digest);
    if(event.type==='request/header') {
      const h=object(object(event.data).header);
      if(h.config)this.configs.push(structuredClone({config:h.config,adapterDefaults:h.adapterDefaults??null}));
    }
    if(event.type==='tool/result')this.tool_results++;
    const bytes=Buffer.byteLength(json);
    if(this.bytes+bytes>16*1024*1024||bytes>512*1024||this.events.length>=8192) {
      this.truncated=true;
      if(this.events.length<8192)this.events.push({type:event.type,seq,omitted:true,sha256:digest,bytes});
    }else {this.events.push(JSON.parse(json));this.bytes+=bytes;}
  }
  reconcile(events:readonly unknown[]):void {
    for(const event of events)this.observe(event);
    const seqs=events.map(event=>object(event).seq);
    this.source_verified=seqs.every((seq,i)=>seq===i)&&this.issues.length===0;
    if(!this.source_verified)this.issue('原始日志的事件序号不连续或与实时事件不一致');
  }
  issue(value:string):void {if(!this.issues.includes(value))this.issues.push(value);}
  summary() {
    return {session_id:this.session_id,configs:this.configs,tool_results:this.tool_results,
      observed_events:this.hashes.size,truncated:this.truncated,source_verified:this.source_verified,issues:this.issues};
  }
  snapshot() {
    return {...this.summary(),events:[...this.events].sort((a,b)=>Number(object(a).seq)-Number(object(b).seq))};
  }
}
