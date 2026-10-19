import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const app=process.env.DSH_APP??'/Applications/DeepSeek Harness.app';
const require=createRequire(path.join(app,'Contents/Resources/app.asar/dsh/node_modules/noop.js'));
const {Context}=require('@deepseek-ai/cordis');
const {ToolRuntime}=require('@deepseek-ai/dsh-tools');
const {LocalFileSystem}=require('@deepseek-ai/dsh-fs-local');
const {createUserMessage}=require('@deepseek-ai/dsh-llm');
const rsi=await import('./lib/index.js');
const verify=await import('../sdlc-verify/lib/index.js');
let assertions=0;
const failedChecks=[];
const check=(condition,label)=>{
  assertions++;
  if(condition)console.log(`  ✓ ${label}`);
  else {failedChecks.push(label);console.error(`  ✗ ${label}`);}
};
const root=await fs.mkdtemp(path.join(os.tmpdir(),'rsi-smoke-'));
const git=(...args)=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
const ctx=new Context();
let skillDisposed=0;
let behavior='normal'; let calls=0; let prompts=[];
let cancellation;
const starts=[];
const readableReferences=[];
const taskArtifact='.ai/tasks/RSI-FIXTURE/intent.md';
const originalArtifact='The fixture intent before every experiment.\n';
try {
  git('init');await fs.writeFile(path.join(root,'code.txt'),'real fixture\n');git('add','code.txt');git('-c','user.name=RSI Test','-c','user.email=test@example.invalid','commit','-m','fixture');
  ctx.provide('systemPrompt',{section:()=>()=>{},tools:()=>()=>{},variable:()=>()=>{},context:()=>()=>{},getSectionOrder:()=>0,getContextOrder:()=>0});
  ctx.provide('skills',{register:()=>()=>{skillDisposed++;}});
  new LocalFileSystem(ctx,LocalFileSystem.Config['~standard'].validate({}).value);
  ctx.provide('sandboxPolicy',{resolve:()=>({mode:'workspace-write',workspaceRoot:root,writableRoots:[root]})});
  ctx.provide('agentPresets',{register:async()=>()=>{},resolve:async id=>({id,name:'fixture verifier'})});
  ctx.provide('subagents',{startActivation:async(spec)=>{
    const request=spec.request;const signal=spec.signal;
    calls++; const id=randomUUID();const text=request.prompt.map(p=>p.text??'').join('\n');prompts.push(text);
    const session={id,header:{id,cwd:root,parentSession:'parent',origin:'subagent'}};
    const models=behavior==='config-drift'
      ? text.includes('candidate-guidance')?['model-A','model-B']:['model-B','model-A']
      : ['fixture-model'];
    for(const [seq,model] of models.entries())ctx.emit('session/event',session,{type:'request/header',seq,data:{header:{config:{provider:'fixture',model,maxTokens:4096}},reason:seq?'change':'initial'}});
    if(behavior==='reference-probe') {
      for(const directory of await fs.readdir(path.join(root,'.ai/rsi/experiments'))) {
        const target=await ctx.fs.resolve(`.ai/rsi/experiments/${directory}/protocol.json`,{cwd:root});
        const protocol=JSON.parse(await ctx.fs.readText(target));
        readableReferences.push(...protocol.cases.map(c=>({expected:c.expected,evidence:c.evidence})));
      }
    }
    if(behavior==='artifact-drift'&&text.includes('CASE_HELP')&&text.includes('candidate-guidance')) {
      await fs.writeFile(path.join(root,taskArtifact),'Changed during the final candidate call.\n');
    }
    if(behavior==='throw-with-noise'&&!text.includes('UNRELATED_CALL')) {
      // A later unrelated run makes "pick the latest run" an invalid substitute for call-id correlation.
      await ctx.tools.execute({callId:randomUUID(),name:'sdlc_verify',arguments:{intent_of_change:'UNRELATED_CALL',criteria:['check behavior']},agent:request.parent,signal});
    }
    if(behavior==='throw'||behavior==='throw-with-noise'&&!text.includes('UNRELATED_CALL')) throw new Error('provider unavailable');
    const status=text.includes('CASE_HELP')?'needs_human':text.includes('CASE_BAD')&&!text.includes('candidate-guidance')?'approve':text.includes('CASE_BAD')?'reject':'approve';
    const structured={status,summary:'fixture verdict',findings:[],criteria_results:[{result:status==='approve'?'met':status==='reject'?'not_met':'cannot_tell',evidence:'fixture observation'}]};
    const result=behavior==='none'?{output:[],stopReason:'error',diagnostic:'fixture malformed'}:{output:[],stopReason:'completed',structured};
    if(behavior==='cancel') {
      const pending=new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('fixture cancelled'),{name:'AbortError'})),{once:true}));
      setTimeout(()=>cancellation.abort(),10);
      return {childId:id,result:pending,dispose:async()=>{}};
    }
    return {childId:id,result:Promise.resolve(result),dispose:async()=>{}};
  }});
  new ToolRuntime(ctx,'tools');
  rsi.apply(ctx,rsi.Config['~standard'].validate({}).value);
  verify.apply(ctx,verify.Config['~standard'].validate({}).value);
  ctx.on('sdlc-verify/record',record=>{if(record.kind==='started')starts.push(structuredClone(record));});
  check(!!ctx.tools.get('sdlc_rsi_runs'),'真实 ToolRuntime 注册查询工具');
  const agent={id:'parent',session:{id:'parent',header:{cwd:root}}};
  const call=(name,args={},signal=new AbortController().signal)=>ctx.tools.execute({callId:randomUUID(),name,arguments:args,agent,signal});
  await fs.mkdir(path.dirname(path.join(root,taskArtifact)),{recursive:true});
  await fs.writeFile(path.join(root,taskArtifact),originalArtifact);
  const source=[];
  for(const label of ['CASE_BAD','CASE_GOOD','CASE_HELP']) {
    const result=await call('sdlc_verify',{intent_of_change:label,criteria:['check behavior'],artifacts:{code:'code.txt',intent:taskArtifact}});
    check(!result.isError&&result.value.verification_complete===true,`${label} 的真实验证调用留下裁决`);
    source.push(result.value.verification_run_id);
  }
  behavior='none';const missing=await call('sdlc_verify',{intent_of_change:'no verdict',criteria:['check behavior']});
  check(!missing.isError&&!missing.value.verification_complete,'没有裁决不会被记录成正常 needs_human');
  const failures=await call('sdlc_rsi_runs',{});check(!failures.isError&&failures.value.runs.length===4,'四次验证各有独立目录');
  const lost=failures.value.runs.find(r=>r.run_id===missing.value.verification_run_id);
  check(lost.outcome==='no_verdict'&&lost.attempts===2,'失败与重试进入可查询记录');
  behavior='throw';const errored=await call('sdlc_verify',{intent_of_change:'throw',criteria:['check behavior']});
  check(errored.isError,'provider 异常仍保留原错误');
  const withError=await call('sdlc_rsi_runs',{});check(withError.value.runs.some(r=>r.outcome==='error'),'异常退出也有结束记录');
  behavior='normal';
  const analysis=await call('sdlc_rsi_analyze',{});check(!analysis.isError&&analysis.value.observations.some(o=>o.kind==='no_verdict'),'复盘引用无裁决事件');
  const cases=source.map((id,i)=>({id:`case-${i}`,source_run_id:id,expected:['reject','approve','needs_human'][i],evidence:'REFERENCE-ANSWER-DO-NOT-SEND',holdout:i===1}));
  const experimentArgs={hypothesis:'candidate guidance catches the fixture bug',baseline_guidance:'',candidate_guidance:'candidate-guidance',repetitions:1,cases};
  behavior='reference-probe';
  const experiment=await call('sdlc_rsi_experiment',experimentArgs);
  check(!experiment.isError,`实验工具可调用: ${experiment.isError?JSON.stringify(experiment.error):''}`);
  check(experiment.value.report.rows.length===6,'基线和候选对三个用例各执行一次');
  check(!prompts.some(p=>p.includes('REFERENCE-ANSWER-DO-NOT-SEND')),'参考答案未直接拼进 prompt（不代表文件读取已隔离）');
  check(readableReferences.length>=3&&readableReferences.some(c=>c.expected==='reject'&&c.evidence==='REFERENCE-ANSWER-DO-NOT-SEND'),'同一 cwd 的文件接口确实能读到协议中的参考答案');
  check(experiment.value.report.metrics.baseline.missed_defects===1&&experiment.value.report.metrics.candidate.missed_defects===0,'对照报告保留观察到的漏检差异');
  check(experiment.value.report.recommendation==='inconclusive','未隔离参考答案时，即使质量数字改善也不得建议候选');
  check(experiment.value.report.issues.some(issue=>/参考答案.*(隔离|盲评)|reference.*isolat/i.test(issue)),'报告明确说明参考答案未隔离，不能只靠泛泛的小样本提示');
  const files=await fs.readdir(path.join(root,'.ai/rsi/experiments'));check(files.length===1,'实验协议和结果实际落盘');
  const plan=JSON.parse(await fs.readFile(path.join(root,'.ai/rsi/experiments',files[0],'protocol.json'),'utf8'));check(plan.hypothesis.includes('candidate'),'协议在运行前保存');

  behavior='artifact-drift';
  const artifactExperiment=await call('sdlc_rsi_experiment',experimentArgs);
  check(!artifactExperiment.isError,'制品漂移实验保留报告');
  const lastArtifactRow=artifactExperiment.value.report.rows.at(-1);
  check(lastArtifactRow?.arm==='candidate'&&lastArtifactRow.case_id==='case-2','制品只在最后一个候选调用中修改，后续调用无法代替结束检查');
  check(await fs.readFile(path.join(root,taskArtifact),'utf8')!==originalArtifact,'制品漂移夹具确实修改了输入');
  check(lastArtifactRow?.observation.comparable===false&&lastArtifactRow.observation.issues.some(issue=>/制品.*(变|结束)|artifact.*chang/i.test(issue)),'结束检查发现 .ai/tasks 制品变化并标记该行不可比');
  await fs.writeFile(path.join(root,taskArtifact),originalArtifact);

  behavior='config-drift';
  const configExperiment=await call('sdlc_rsi_experiment',experimentArgs);
  check(!configExperiment.isError,'模型配置漂移实验保留报告');
  check(configExperiment.value.report.rows.every(row=>!row.observation.comparable),'B→A 与 A→B 的请求配置不能因为集合相同就视为可比');
  check(configExperiment.value.report.rows.every(row=>row.observation.issues.some(issue=>/配置.*(漂移|变化|不同|多个)|configuration.*(chang|drift)|multiple.*config/i.test(issue))),'每行都指出单次验证内部的实际配置变化');

  behavior='throw-with-noise';
  const errorStart=starts.length;
  const errorExperiment=await call('sdlc_rsi_experiment',experimentArgs);
  check(!errorExperiment.isError&&errorExperiment.value.report.rows.length===6,'实验中的 provider 异常保留全部六行');
  const errorRows=errorExperiment.value.report.rows;
  for(const row of errorRows) {
    const label=['CASE_BAD','CASE_GOOD','CASE_HELP'][Number(row.case_id.split('-')[1])];
    const expectedStart=starts.slice(errorStart).find(record=>record.data.inputs.intent_of_change===label&&record.data.inputs.experimental_guidance===(row.arm==='candidate'?'candidate-guidance':''));
    check(!!expectedStart?.data.call_id&&row.observation.run_id===expectedStart.run_id,`${row.case_id}/${row.arm} 按调用 ID 关联原始失败运行，不误拿较晚的无关运行`);
    check(row.observation.attempts===1&&!row.observation.complete,`${row.case_id}/${row.arm} 异常调用保留一次真实派发且不算完成`);
    if(row.observation.run_id) {
      const durable=await call('sdlc_rsi_runs',{run_id:row.observation.run_id});
      check(!durable.isError&&durable.value.summary.outcome==='error'&&durable.value.summary.attempts===1,`${row.case_id}/${row.arm} 实验行可追到持久化错误证据`);
    }
  }
  check(new Set(errorRows.map(row=>row.observation.run_id)).size===6,'六次错误调用保持六个独立运行 ID');

  behavior='normal';
  // Exercise the composite-tool contract with the actual verifier body and registry.
  // ToolRunContext.concludeTurn marks the final agent-turn result; it is not an abort.
  // The official PTC transport forwards this marker then settles the child normally,
  // without cancelling its program or suppressing the program's later dispatches.
  const verifierTool=ctx.tools.get('sdlc_verify');
  const originalVerify=verifierTool.execute;
  let contextScenario='accepted';let verificationCount=0;
  const deferred=[];
  verifierTool.execute=async(args,exec)=>{
    const value=await originalVerify(args,exec);
    if(++verificationCount===1)exec.concludeTurn();
    return value;
  };
  const disposeContexts=ctx.on('tools/post-execute',async(exec,_result,next)=>{
    if(exec.name!=='sdlc_verify')return next();
    const context=createUserMessage({source:{kind:'rsi-smoke-followup'},content:[{type:'text',text:`Follow-up ${contextScenario}/${deferred.length+1}`} ]});
    deferred.push(context);
    if(contextScenario==='blocked'&&deferred.length===1) {
      return {kind:'block',feedback:[{type:'text',text:'Fixture policy blocked the first terminal result.'}],additionalContexts:[context]};
    }
    return {kind:'accept',additionalContexts:[context]};
  });
  try {
    const callsBeforeContexts=calls;
    const contextExperiment=await call('sdlc_rsi_experiment',experimentArgs);
    check(!contextExperiment.isError,'带后续上下文的嵌套验证仍返回实验结果');
    check(calls-callsBeforeContexts===6&&contextExperiment.value.report.rows.length===6&&contextExperiment.value.report.status==='completed','首个成功子调用的终局标记不冒充取消，仍完成既定六次实验调用');
    check(contextExperiment.concludesTurn===true,'复合实验转交首个成功子调用的 concludesTurn 标记');
    check(deferred.length===6&&JSON.stringify(contextExperiment.additionalContexts)===JSON.stringify(deferred),'六条 additionalContexts 按调用顺序转交，保留身份、来源和正文');

    contextScenario='blocked';verificationCount=0;deferred.length=0;
    const blockedContextExperiment=await call('sdlc_rsi_experiment',experimentArgs);
    check(!blockedContextExperiment.isError&&blockedContextExperiment.value.report.rows.length===6,'首个嵌套结果被后置策略拒绝后仍保留后续实验行');
    check(blockedContextExperiment.value.report.rows[0].observation.complete===false,'后置策略确实将原本成功的首个嵌套验证改为失败');
    check(blockedContextExperiment.concludesTurn!==true,'被后置策略拒绝的子调用不能将终局标记泄漏给外层');
    check(deferred.length===6&&JSON.stringify(blockedContextExperiment.additionalContexts)===JSON.stringify(deferred),'失败子调用的后续上下文也完整转交，不被只取 value/error 吞掉');
  } finally {disposeContexts();verifierTool.execute=originalVerify;}

  const concurrent=await Promise.all(['CONCURRENT_A','CONCURRENT_B'].map(intent_of_change=>call('sdlc_verify',{intent_of_change,criteria:['check behavior']})));
  check(concurrent.every(result=>!result.isError&&result.value.verification_complete),'并发验证都能完成');
  const concurrentIds=concurrent.map(result=>result.value.verification_run_id);
  check(new Set(concurrentIds).size===2,'并发验证不共用运行目录');
  const concurrentRuns=await Promise.all(concurrentIds.map(run_id=>call('sdlc_rsi_runs',{run_id})));
  check(concurrentRuns.every((run,i)=>!run.isError&&run.value.summary.complete&&run.value.summary.attempts===1&&run.value.records[0].data.inputs.intent_of_change===['CONCURRENT_A','CONCURRENT_B'][i]),'并发记录各自保留自己的输入与一次尝试');
  check(new Set(concurrentRuns.flatMap(run=>run.value.summary.session_ids)).size===2,'并发运行的子会话证据不串线');

  behavior='cancel';cancellation=new AbortController();
  const cancellationStart=starts.length;
  const cancelled=await call('sdlc_verify',{intent_of_change:'CANCEL_DURING_ATTEMPT',criteria:['check behavior']},cancellation.signal);
  check(cancelled.isError,'运行中取消仍返回取消错误');
  const cancelledStart=starts.slice(cancellationStart).find(record=>record.data.inputs.intent_of_change==='CANCEL_DURING_ATTEMPT');
  const cancelledRun=await call('sdlc_rsi_runs',{run_id:cancelledStart.run_id});
  check(!cancelledRun.isError&&cancelledRun.value.summary.outcome==='cancelled'&&!cancelledRun.value.summary.complete,'取消后仍持久化结束事实，不能写成 needs_human 裁决');
  check(cancelledRun.value.summary.attempts===1&&cancelledRun.value.records.at(-1)?.kind==='finished','取消不重试，也不遗漏最后一个生命周期事件');
  // The synthetic provider tests wiring, NOT model performance.
  await ctx.fiber.dispose();check(skillDisposed===1,'卸载归还 Skill');
  assert.equal(failedChecks.length,0,`Runtime smoke failures:\n${failedChecks.join('\n')}`);
  console.log(`\nRSI runtime smoke: ${assertions} passed; ${calls} real tool-dispatched child starts (deterministic provider fixture, not a model benchmark).`);
} finally {await ctx.fiber.dispose().catch(()=>{});await fs.rm(root,{recursive:true,force:true});}
