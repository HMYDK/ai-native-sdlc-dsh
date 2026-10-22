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
import {TaskCollector} from './tasks.js';
import {registerImprovementTools,parsePacket} from './improvement.js';
import {hash} from './snapshot.js';
import {JSON_SCHEMA,load as parseYaml} from 'js-yaml';
import {parseTaskState,normalizeTaskId} from '../task/state.js';
import {cwdOf} from './store.js';
import {object} from './analysis.js';
export const name='sdlc-rsi';
export const inject=['tools','fs','sandboxPolicy','skills'];
export const Config=z.object({root:z.string().default('.ai/rsi')});
const output={schema:{type:'object',additionalProperties:true} as const,render:(_args:unknown,value:unknown)=>[{type:'text' as const,text:JSON.stringify(value,null,2)}]};
const json=(value:unknown)=>JSON.parse(JSON.stringify(value));
export function apply(ctx:Context,config:{root:string}):void {
  safeRelative(config.root);
  const collector=new Collector(ctx,config.root);
  const tasks=new TaskCollector(ctx,config.root,collector);
  registerImprovementTools(ctx,config.root,tasks);
  ctx.on('tools/execute',async(exec,next)=>{
    let issue:string|undefined;
    const taskId=object(exec.arguments).task_id;
    // One ownership path for task tools, artifact edits/checks, fixes and verification.
    // RSI queries describe existing evidence and must not reassign the task to the reader.
    if(exec.name.startsWith('sdlc_')&&!exec.name.startsWith('sdlc_rsi_')&&exec.name!=='sdlc_task_create'&&typeof taskId==='string') {
      try {await tasks.touch(exec,taskId);}catch(error) {issue=`RSI 任务关联失败: ${message(error)}`;}
    }
    const result=await next();
    return issue?{...result,content:[...result.content,{type:'text' as const,text:issue}]}:result;
  });
  ctx.on('sdlc-task/record',(record,exec)=>tasks.record(record,exec));
  ctx.on('sdlc-verify/record',async(record,exec)=>{
    // The run must settle before its task summary reads it; still preserve the task link on recording failure.
    let failure:unknown;
    try {await collector.record(record,exec);}catch(error) {failure=error;}
    try {await tasks.verification(record,exec);}catch(error) {if(failure===undefined)failure=error;}
    if(failure!==undefined)throw failure;
  });
  // Presets are sibling scopes. Collector admits only explicitly associated sessions.
  ctx.on('session/event',(session,event)=>{collector.observe(session,event);tasks.observe(session,event);},{global:true});
  ctx.on('session/flush',async()=>{await collector.flush();await tasks.flush();},{global:true});
  ctx.effect(()=>async()=>{await collector.flush();await tasks.flush();});
  ctx.effect(()=>ctx.skills.register(learningSkill));
  const register=(tool:Parameters<typeof ctx.tools.register>[0])=>ctx.effect(()=>ctx.tools.register(tool));
  register(defineTool({name:'sdlc_rsi_tasks',description:'Read task-level RSI evidence for the current workspace. Separates task completion, evidence completeness and replay eligibility; reconciles registered sessions against the DSH log. Never guesses an unregistered task/session relationship.',parameters:{
    task_id:{type:'string',description:'Inspect and reconcile one task; omit to list recorded tasks.'},
  },output,async execute(args,exec){
    await collector.flush();
    return json(args.task_id?await tasks.inspect(exec,args.task_id):{tasks:await tasks.list(exec)});
  }}));
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
    task_id:{type:'string',description:'Analyze a whole task, including author and verifier evidence and missing checkpoints.'},
  },output,async execute(args,exec){
    await collector.flush();const store=new Store(ctx,exec,config.root);
    const task=args.task_id?await tasks.inspect(exec,args.task_id):undefined;
    const ids=args.run_ids??task?.task.runs??await store.list('runs');const runs=[];const errors=[];
    for(const id of ids)try{runs.push(await store.run(safeSegment(id)));}catch(error){errors.push({run_id:id,error:message(error)});}
    const result=analyzeRuns(runs);const feedback=[];
    for(const file of await store.list('feedback'))try{feedback.push(await store.read(`feedback/${file}`));}catch(error){errors.push({run_id:file,error:message(error)});}
    return json({...result,errors,feedback,...(task?{task,
      analysis_brief:'根据任务与会话证据区分业务缺陷、插件机制缺陷、环境故障和未知原因。每个改进必须引用来源、说明尚未排除的解释、给出可证伪的验收标准。多次 reject 本身不是插件故障；证据不完整时只提出有现存证据支持的采集修复。候选应进入插件仓库的正常开发任务。',
      evidence_paths:[`tasks/${task.task.task_id}/task.json`,`tasks/${task.task.task_id}/evidence.json`,...task.task.checkpoints.map(id=>`tasks/${task.task.task_id}/checkpoints/${id}.json`),...task.task.sessions.map(s=>`tasks/${task.task.task_id}/sessions/${s.id}.json`)],
    }:{})});
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
    run_id:{type:'string'},experiment_id:{type:'string'},proposal_id:{type:'string'},
    comparison_report:{type:'string',description:'JSON comparison report relative to the development task directory; required for adopting a proposal. Includes baseline/candidate {revision,fingerprint}, command, and cases [{id,baseline_pass,candidate_pass,evidence}].'},
    followup_task_id:{type:'string',description:'A later real task in this workspace, whose recorded plugin version and evidence will be attached.'},
    note:{type:'string',required:true},evidence:{type:'string',required:true},
    decision:{type:'string',description:'Optional adopt, reject, or inconclusive; describes a supplied decision, not automatic approval.'},
    task_id:{type:'string',description:'Development task carrying an adopted change.'},
  },output,async execute(args,exec){
    const store=new Store(ctx,exec,config.root);
    if(!args.run_id&&!args.experiment_id&&!args.proposal_id)throw new Error('反馈至少关联一个运行、实验或提案');
    if(!args.note.trim()||!args.evidence.trim()||args.note.length>8000||args.evidence.length>8000)throw new Error('说明和证据必须非空且各不超过 8000 字符');
    if(args.run_id)await store.read(`runs/${safeSegment(args.run_id)}/000000.json`);
    if(args.experiment_id)await store.read(`experiments/${safeSegment(args.experiment_id)}/protocol.json`);
    if(args.decision&&!['adopt','reject','inconclusive'].includes(args.decision))throw new Error('decision 必须是 adopt/reject/inconclusive');
    if(args.decision==='adopt'&&!args.task_id)throw new Error('采用改进需要关联正常开发任务 task_id');
    const developmentId=args.task_id?normalizeTaskId(args.task_id):undefined;
    const proposal=args.proposal_id?parsePacket(await store.read(`proposals/${safeSegment(args.proposal_id)}.json`)):undefined;
    let comparison:unknown;
    if(args.proposal_id&&args.decision==='adopt') {
      if(!args.comparison_report)throw new Error('采用提案需要新旧版本对照报告');
      const id=developmentId!;
      const target=await ctx.fs.resolve(`.ai/tasks/${id}/state.yaml`,{cwd:cwdOf(exec)});
      if(parseTaskState(id,parseYaml(await ctx.fs.readText(target),{schema:JSON_SCHEMA})).status!=='DONE')throw new Error('改进任务尚未完成正常开发验证流程，不能记录为已采用');
      const imported=parsePacket(await new Store(ctx,exec,`.ai/tasks/${id}`).read('rsi-proposal.json'));
      if(proposal?.proposal.id!==args.proposal_id||imported.proposal.id!==args.proposal_id||imported.sha256!==proposal.sha256)throw new Error('开发任务未关联当前提案，不能借用其他任务的完成状态');
    }
    if(args.comparison_report) {
      if(!args.task_id)throw new Error('对照报告必须属于开发任务');
      const report=object(await new Store(ctx,exec,`.ai/tasks/${developmentId}`).read(safeRelative(args.comparison_report)));
      const baseline=object(report.baseline),candidate=object(report.candidate);
      if(!baseline.revision||!candidate.revision||!baseline.fingerprint||!candidate.fingerprint||baseline.fingerprint===candidate.fingerprint||!report.command)throw new Error('报告缺少不同基线/候选版本、内容指纹或复跑命令');
      if(!Array.isArray(report.cases)||!report.cases.length||report.cases.some(c=>typeof object(c).baseline_pass!=='boolean'||typeof object(c).candidate_pass!=='boolean'||!object(c).evidence))throw new Error('报告缺少两侧观测值与证据');
      if(args.decision==='adopt'&&(!report.cases.some(c=>object(c).baseline_pass===false)||report.cases.some(c=>object(c).candidate_pass!==true)))throw new Error('当前对照尚未证明旧版失败、新版满足判据');
      comparison={report,sha256:hash(JSON.stringify(report)),attribution:'caller_supplied_report'};
    }
    const followup=args.followup_task_id?await tasks.inspect(exec,args.followup_task_id):undefined;
    const id=randomUUID();const feedback={id,at:new Date().toISOString(),...args,task_id:developmentId,comparison,followup:followup?{task_id:followup.task.task_id,initial_suite:followup.task.loaded_suite,execution_suites:object(followup.evidence).execution_suites,evidence:followup.evidence}:undefined,attribution:'caller_supplied'};
    await store.write(`feedback/${id}.json`,feedback);return json({feedback_id:id,path:`${config.root}/feedback/${id}.json`});
  }}));
}
