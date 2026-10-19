import type {Context} from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import {defineTool} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-skill';
import type {} from '../verify/recording.js';
import {randomUUID} from 'node:crypto';
import {Collector} from './collector.js';
import {Store,safeRelative,safeSegment,message} from './store.js';
import {analyzeRuns} from './analysis.js';
import {parseExperiment,runExperiment} from './experiment.js';
import {replayInput,replayCase} from './replay.js';
import {learningSkill} from './skill.js';
export const name='sdlc-rsi';
export const inject=['tools','fs','sandboxPolicy','skills'];
export const Config=z.object({root:z.string().default('.ai/rsi')});
const output={schema:{type:'object',additionalProperties:true} as const,render:(_args:unknown,value:unknown)=>[{type:'text' as const,text:JSON.stringify(value,null,2)}]};
const json=(value:unknown)=>JSON.parse(JSON.stringify(value));
export function apply(ctx:Context,config:{root:string}):void {
  safeRelative(config.root);
  const collector=new Collector(ctx,config.root);
  ctx.on('sdlc-verify/record',(record,exec)=>collector.record(record,exec));
  ctx.on('session/event',(session,event)=>collector.observe(session,event));
  ctx.on('session/flush',()=>collector.flush());
  ctx.effect(()=>()=>collector.flush());
  ctx.effect(()=>ctx.skills.register(learningSkill));
  const register=(tool:Parameters<typeof ctx.tools.register>[0])=>ctx.effect(()=>ctx.tools.register(tool));
  register(defineTool({name:'sdlc_rsi_runs',description:'List recorded verification attempts, including missing verdicts, errors and interrupted runs. A completed needs_human verdict differs from no verdict.',parameters:{
    run_id:{type:'string',description:'Read one run and its full recorded lifecycle.'},
    limit:{type:'integer',description:'Maximum summaries, 1..200; default 30.'},
  },output,async execute(args,exec){
    await collector.flush();const store=new Store(ctx,exec,config.root);
    if(args.run_id) {safeSegment(args.run_id);return json(await store.run(args.run_id));}
    const limit=args.limit??30;if(limit<1||limit>200)throw new Error('limit 必须是 1..200');
    const runs=[];const errors=[];
    for(const id of await store.list('runs')) {
      try {runs.push((await store.run(id)).summary);}catch(error){errors.push({run_id:id,error:message(error)});}
    }
    runs.sort((a,b)=>(b.started_at??'').localeCompare(a.started_at??'')||a.run_id.localeCompare(b.run_id));
    return json({total:runs.length,runs:runs.slice(0,limit),errors});
  }}));
  register(defineTool({name:'sdlc_rsi_analyze',description:'Summarize observed failures, retry cost and unfinished evidence. Returns source references and hypotheses, not proven root causes or an automatic rule change.',parameters:{
    run_ids:{type:'array',items:{type:'string'},description:'Optional selected source runs; default all recorded runs.'},
  },output,async execute(args,exec){
    await collector.flush();const store=new Store(ctx,exec,config.root);
    const ids=args.run_ids??await store.list('runs');const runs=[];const errors=[];
    for(const id of ids)try{runs.push(await store.run(safeSegment(id)));}catch(error){errors.push({run_id:id,error:message(error)});}
    const result=analyzeRuns(runs);const feedback=[];
    for(const file of await store.list('feedback'))try{feedback.push(await store.read(`feedback/${file}`));}catch(error){errors.push({run_id:file,error:message(error)});}
    return json({...result,errors,feedback});
  }}));
  register(defineTool({name:'sdlc_rsi_experiment',description:'Run paid model verification calls for an exploratory guidance comparison. Replays recorded inputs under the currently loaded verifier. Changes only added guidance, persists protocol first, alternates arms, and detects changed code/artifacts. Reference labels require external evidence. They are omitted from prompts but accessible in the shared filesystem, so these observations cannot justify adoption.',parameters:{
    hypothesis:{type:'string',required:true},baseline_guidance:{type:'string',required:true},candidate_guidance:{type:'string',required:true},
    repetitions:{type:'integer',description:'1..5 repeats per case per arm; default 1.'},
    cases:{type:'json',required:true,description:'Array of {id, source_run_id, expected: approve|reject|needs_human, evidence, holdout}. Include bad, good and insufficient-evidence cases. Evidence is a source for the supplied reference label, not the verifier own verdict.'},
  },output,async execute(args,exec){
    const spec=parseExperiment(args);const store=new Store(ctx,{agent:exec.agent},config.root);
    for(const c of spec.cases)await replayInput(store,c.source_run_id);
    const id=randomUUID();await store.write(`experiments/${id}/protocol.json`,spec);
    let revision=0;
    const report=await runExperiment(spec,{
      signal:exec.signal,
      limitations:['参考答案与验证者共享文件系统，未实现盲评隔离；本次仅作探索，不能据此推荐采用。'],
      execute:(c,guidance)=>replayCase(ctx,exec,store,collector,c,guidance),
      save:async(report)=>{await store.write(`experiments/${id}/results/${String(revision++).padStart(6,'0')}.json`,report);},
    });
    return json({experiment_id:id,path:`${config.root}/experiments/${id}`,report});
  }}));
  register(defineTool({name:'sdlc_rsi_feedback',description:'Persist an externally supported correction or adoption/rejection decision. Does not change plugin settings. Attach the development task when adopting an improvement.',parameters:{
    run_id:{type:'string'},experiment_id:{type:'string'},
    note:{type:'string',required:true},evidence:{type:'string',required:true},
    decision:{type:'string',description:'Optional adopt, reject, or inconclusive; describes a supplied decision, not automatic approval.'},
    task_id:{type:'string',description:'Development task carrying an adopted change.'},
  },output,async execute(args,exec){
    const store=new Store(ctx,exec,config.root);
    if(!args.run_id&&!args.experiment_id)throw new Error('反馈至少关联一个运行或实验');
    if(!args.note.trim()||!args.evidence.trim()||args.note.length>8000||args.evidence.length>8000)throw new Error('说明和证据必须非空且各不超过 8000 字符');
    if(args.run_id)await store.read(`runs/${safeSegment(args.run_id)}/000000.json`);
    if(args.experiment_id)await store.read(`experiments/${safeSegment(args.experiment_id)}/protocol.json`);
    if(args.decision&&!['adopt','reject','inconclusive'].includes(args.decision))throw new Error('decision 必须是 adopt/reject/inconclusive');
    if(args.decision==='adopt'&&!args.task_id)throw new Error('采用改进需要关联正常开发任务 task_id');
    if(args.task_id)safeSegment(args.task_id);
    const id=randomUUID();const feedback={id,at:new Date().toISOString(),...args,attribution:'caller_supplied'};
    await store.write(`feedback/${id}.json`,feedback);return json({feedback_id:id,path:`${config.root}/feedback/${id}.json`});
  }}));
}
