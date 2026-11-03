import type {Context} from '@deepseek-ai/cordis';
import {defineTool,type ToolRunContext} from '@deepseek-ai/dsh-tools';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {Store,safeRelative,safeSegment,cwdOf,message} from './store.js';
import {object} from './analysis.js';
import {hash} from './snapshot.js';
import {normalizeTaskId} from '../task/state.js';
import type {TaskCollector} from './tasks.js';

const text=(value:unknown,name:string,max=8000):string=>{
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`${name} 必须非空且不超过 ${max} 字符`);
  return value.trim();
};
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export interface Proposal {
  schema_version:1;id:string;at:string;source_task:string;source_workspace:string;
  source_evidence_complete:boolean;baseline_suite:unknown;baseline_suites?:unknown;
  title:string;problem:string;hypothesis:string;change:string;alternatives:string;acceptance:string;comparison:string;
  focus:'capture'|'workflow'|'verification'|'other';
  references:{path:string;sha256:string;observation:string;snapshot_path?:string}[];
  attribution:'caller_analysis';
}
export interface Packet {proposal:Proposal;sha256:string}
export function proposalInput(raw:unknown) {
  const value=object(raw),out={title:text(value.title,'title',160),problem:text(value.problem,'problem'),
    hypothesis:text(value.hypothesis,'hypothesis'),change:text(value.change,'change'),alternatives:text(value.alternatives,'alternatives'),
    acceptance:text(value.acceptance,'acceptance'),comparison:text(value.comparison,'comparison'),focus:text(value.focus,'focus') as Proposal['focus']};
  if(!['capture','workflow','verification','other'].includes(out.focus))throw new Error('focus 必须是 capture/workflow/verification/other');
  if(!Array.isArray(value.references)||value.references.length<1||value.references.length>12)throw new Error('需要 1..12 个已记录的证据引用');
  return {...out,references:value.references.map(raw=>{
    const ref=object(raw);return {path:safeRelative(text(ref.path,'path',512)),observation:text(ref.observation,'observation',1200)};
  })};
}
export function seal(proposal:Proposal):Packet {return {proposal,sha256:hash(canonical(proposal))};}
export function parsePacket(raw:unknown):Packet {
  if(Buffer.byteLength(JSON.stringify(raw))>96*1024)throw new Error('提案超过 96 KiB');
  const value=object(raw),p=object(value.proposal);proposalInput(p);
  if(p.schema_version!==1||p.attribution!=='caller_analysis'||typeof p.source_evidence_complete!=='boolean')throw new Error('提案格式不支持');
  normalizeTaskId(text(p.source_task,'source_task',96));safeSegment(text(p.id,'id',96));text(p.source_workspace,'source_workspace',2048);
  if(!Array.isArray(p.references)||p.references.some(r=>!/^[a-f0-9]{64}$/.test(String(object(r).sha256))))throw new Error('引用缺少内容指纹');
  if(hash(canonical(p))!==value.sha256)throw new Error('提案内容与指纹不一致');
  return value as unknown as Packet;
}
export function intentFor(p:Proposal):string {
  return `# Intent: ${p.title}\n\n## Problem\n${p.problem}\n\n来源任务：${p.source_task}。提案：${p.id}。原始引用与内容指纹见 rsi-proposal.json。\n\n## Proposed outcome\n${p.change}\n\n验收：${p.acceptance}\n\n对照方法：${p.comparison}\n\n## Affected users and systems\n当前 SDLC 插件；类别：${p.focus}。来源任务仅提供执行证据。\n\n## Constraints\n按正常 SDLC 流程实现和验证；不能从一次样本声称普遍改善。来源记录完整：${p.source_evidence_complete}。导入指纹仅检查传输内容一致，不是独立复核。\n\n## Open questions\n待验证的原因：${p.hypothesis}\n\n尚未排除的解释：${p.alternatives}\n`;
}
async function invoke(ctx:Context,exec:ToolRunContext,name:string,args:Record<string,unknown>) {
  const result=await ctx.tools.execute({name,arguments:args,callId:randomUUID() as never,rootCallId:exec.rootCallId,parent:exec.token,agent:exec.agent,signal:exec.signal});
  for(const context of result.additionalContexts??[])exec.deferContext(context);
  if(result.isError)throw new Error(result.error.message);
  if(result.concludesTurn)exec.concludeTurn();
  return object(result.value);
}
const json=(value:unknown)=>JSON.parse(JSON.stringify(value));
const output={schema:{type:'object',additionalProperties:true} as const,render:(_args:unknown,value:unknown)=>[{type:'text' as const,text:JSON.stringify(value,null,2)}]};
export function registerImprovementTools(ctx:Context,root:string,tasks:TaskCollector):void {
  ctx.effect(()=>ctx.tools.register(defineTool({name:'sdlc_rsi_propose',description:'Save an evidence-linked hypothesis for improving the SDLC plugin. Run analyze and inspect the cited evidence first. Returns a portable summary packet without raw traces; hypotheses are caller analysis, not established causes.',parameters:{
    task_id:{type:'string',required:true},proposal:{type:'json',required:true,description:'{title,problem,hypothesis,change,alternatives,acceptance,comparison,focus:capture|workflow|verification|other,references:[{path,observation}]}. Paths relative to RSI root, from the selected task or its registered runs. Supply reviewed summaries without credentials.'},
  },output,async execute(args,exec){
    const input=proposalInput(args.proposal),source=await tasks.inspect(exec,args.task_id),store=new Store(ctx,exec,root);
    if(object(source.evidence).evidence_complete!==true&&input.focus!=='capture')throw new Error('来源证据不完整：先处理有证据支持的采集问题，不能据此提出效果改进结论');
    const proposalId=randomUUID();
    const references:Proposal['references']=[];
    for(const ref of input.references) {
      if(!ref.path.startsWith(`tasks/${source.task.task_id}/`)&&!source.task.runs.some(id=>ref.path.startsWith(`runs/${id}/`)))throw new Error('引用不属于所选任务');
      const evidence=await store.read(ref.path),snapshot_path=`proposals/${proposalId}/evidence/${references.length}.json`;
      await store.write(snapshot_path,evidence);
      references.push({...ref,snapshot_path,sha256:hash(canonical(evidence))});
    }
    const proposal:Proposal={schema_version:1,id:proposalId,at:new Date().toISOString(),source_task:source.task.task_id,
      source_workspace:source.task.workspace,source_evidence_complete:object(source.evidence).evidence_complete===true,
      baseline_suite:source.task.loaded_suite,baseline_suites:object(source.evidence).execution_suites??[],...input,references,attribution:'caller_analysis'};
    const packet=seal(proposal);await store.write(`proposals/${proposal.id}.json`,packet);
    await tasks.proposed(exec,args.task_id,proposal.id);
    return json({proposal_id:proposal.id,path:`${root}/proposals/${proposal.id}.json`,packet,
      next_step:'在 SDLC 插件源码工作区调用 sdlc_rsi_improve，传入 packet 与开发任务 ID。'});
  }})));
  ctx.effect(()=>ctx.tools.register(defineTool({name:'sdlc_rsi_improve',description:'Import a reviewed RSI proposal into an ordinary SDLC development task in the plugin source workspace. Creates intent and provenance through normal tools. Does not implement, approve, install or deploy a candidate.',parameters:{
    packet:{type:'json',required:true,description:'Exact packet returned by sdlc_rsi_propose.'},task_id:{type:'string',required:true},
  },output,async execute(args,exec){
    const packet=parsePacket(args.packet),id=normalizeTaskId(args.task_id),store=new Store(ctx,exec,root);
    const pkg=object(await new Store(ctx,exec,'packages/sdlc').read('package.json'));
    if(pkg.name!=='@ai-native-sdlc-plugin/dsh-sdlc')throw new Error('请在 SDLC 插件源码仓库中创建改进任务');
    for(const name of ['sdlc_task_create','sdlc_artifact_write'])if(!ctx.tools.get(name,exec.agent))throw new Error(`当前 preset 缺少 ${name}`);
    const created=await invoke(ctx,exec,'sdlc_task_create',{task_id:id,title:packet.proposal.title,problem:packet.proposal.problem});
    const dir=safeRelative(path.relative(cwdOf(exec),String(created.task_dir)).split(path.sep).join('/'));
    try {
      await new Store(ctx,exec,dir).write('rsi-proposal.json',packet);
      const previous=await store.optional(`proposals/${packet.proposal.id}.json`);
      if(previous&&object(previous).sha256!==packet.sha256)throw new Error('相同提案 ID 对应不同内容');
      if(!previous)await store.write(`proposals/${packet.proposal.id}.json`,packet);
      await store.write(`imports/${id}.json`,{task_id:id,proposal_id:packet.proposal.id,packet_sha256:packet.sha256,at:new Date().toISOString()});
      const intent=await invoke(ctx,exec,'sdlc_artifact_write',{task_id:id,kind:'intent',content:intentFor(packet.proposal)});
      return json({task_id:id,task_dir:dir,status:'INTENT',proposal_id:packet.proposal.id,intent,recording_errors:created.recording_errors??[],
        source_validation:'传输指纹已核对；外部工作区的原始证据需要按引用复核，尚未采纳改动。'});
    }catch(error) {
      return json({task_id:id,task_dir:dir,status:'INTENT',proposal_id:packet.proposal.id,incomplete:true,error:message(error),
        next_step:'普通任务已创建。保留它并用 sdlc_artifact_write 补齐 intent；不要重复创建或覆盖已有任务。'});
    }
  }})));
}
