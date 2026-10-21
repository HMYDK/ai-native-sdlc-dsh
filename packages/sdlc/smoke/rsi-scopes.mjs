import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const require=createRequire(path.join(process.env.DSH_APP??'/Applications/DeepSeek Harness.app','Contents/Resources/app.asar/dsh/node_modules/noop.js'));
const {Context}=require('@deepseek-ai/cordis');
const {ToolRuntime}=require('@deepseek-ai/dsh-tools');
const {LocalFileSystem}=require('@deepseek-ai/dsh-fs-local');
const {createScope,scopeTarget}=require('@deepseek-ai/dsh-scope');
const {SkillRegistry}=require('@deepseek-ai/dsh-skill');
const lib=process.env.RSI_BENCH_LIB??path.resolve(import.meta.dirname,'../lib');
const rsi=await import(pathToFileURL(path.join(lib,'rsi/index.js')));
const verify=await import(pathToFileURL(path.join(lib,'verify/index.js')));
const taskPlugin=await import(pathToFileURL(path.join(lib,'task/index.js')));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'rsi-scopes-'));
const ctx=new Context(),sources=new Map();
const sdlcKey={},verifierKey={},standardKey={};
const sdlc=createScope(ctx,sdlcKey),verifier=createScope(ctx,verifierKey),standard=createScope(ctx,standardKey);
let childCounter=0,queryAvailable=true,checks=0;
const check=(value,label)=>{assert.ok(value,label);checks++;};
const authorSession={id:'author',header:{cwd:root},seq:0};
const author={id:'author',session:authorSession};
const authorScope=createScope(ctx,author,{parent:sdlcKey});author.ctx=authorScope.ctx;
const authorEvents=[];sources.set('author',{header:authorSession.header,events:authorEvents});
const emit=(session,key,events,type,data)=>{
  const event={seq:events.length,time:Date.now(),type,data};events.push(event);session.seq=events.length;
  ctx.emit(scopeTarget(session,key),'session/event',session,event);return event;
};
let callCounter=0;
const call=(name,args={})=>ctx.tools.execute({callId:`test-${++callCounter}`,name,arguments:args,agent:author,signal:new AbortController().signal});
try {
  execFileSync('git',['-C',root,'init'],{stdio:'pipe'});
  await fs.writeFile(path.join(root,'code.txt'),'fixture\n');execFileSync('git',['-C',root,'add','code.txt']);
  execFileSync('git',['-C',root,'-c','user.name=RSI Test','-c','user.email=test@example.invalid','commit','-m','fixture'],{stdio:'pipe'});
  new LocalFileSystem(ctx,LocalFileSystem.Config['~standard'].validate({}).value);
  ctx.provide('sandboxPolicy',{resolve:()=>({mode:'workspace-write',workspaceRoot:root,writableRoots:[root]})});
  ctx.provide('systemPrompt',{section:()=>()=>{},tools:()=>()=>{},variable:()=>()=>{},context:()=>()=>{},getSectionOrder:()=>0,getContextOrder:()=>0});
  new ToolRuntime(ctx,'tools');new SkillRegistry(ctx);
  ctx.provide('sessionQuery',{observeSession:async id=>{
    if(!queryAvailable)throw new Error('fixture query unavailable');
    const source=sources.get(id);if(!source)throw new Error('fixture missing source');
    return {...source,[Symbol.dispose]:()=>{}};
  }});
  ctx.provide('agentPresets',{register:async()=>()=>{},resolve:async id=>({id,name:'fixture verifier'})});
  ctx.provide('subagents',{startActivation:async()=>{
    const id=`child-${++childCounter}`,session={id,header:{cwd:root,parentSession:'author',origin:'subagent'}};
    const child={},scope=createScope(ctx,child,{parent:verifierKey}),events=[];
    sources.set(id,{header:session.header,events});
    emit(session,child,events,'request/header',{header:{config:{model:'fixture'}}});
    // Deliberately miss a live event: reconciliation must recover it from the authoritative log.
    events.push({seq:events.length,time:Date.now(),type:'tool/call',data:{name:'bash',arguments:'{"command":"test"}'}});
    emit(session,child,events,'tool/result',{message:{content:[{type:'text',text:'test passed'}]}});
    emit(session,child,events,'turn/end',{stopReason:'completed'});
    return {childId:id,result:Promise.resolve({output:[],stopReason:'completed',structured:{status:'approve',summary:'fixture',findings:[],criteria_results:[{result:'met',evidence:'fixture result'}]}}),dispose:()=>scope.dispose()};
  }});
  rsi.apply(sdlc.ctx,rsi.Config['~standard'].validate({}).value);
  verify.apply(sdlc.ctx,verify.Config['~standard'].validate({}).value);
  taskPlugin.apply(sdlc.ctx,taskPlugin.Config['~standard'].validate({}).value);
  const unrelated={id:'unrelated',header:{cwd:root}},unrelatedEvents=[];
  emit(unrelated,standardKey,unrelatedEvents,'request/header',{header:{config:{model:'unrelated'}}});
  const result=await call('sdlc_verify',{intent_of_change:'scope regression',criteria:['the fixture passes']});
  check(!result.isError&&result.value.status==='approve','independent verdict still returns');
  const run=result.value.verification_run_id;
  const capture=JSON.parse(await fs.readFile(path.join(root,'.ai/rsi/runs',run,'capture.json'),'utf8'));
  const recorded=await call('sdlc_rsi_runs',{run_id:run});
  const observation={tool_results:capture.sessions[0]?.tool_results??0,configs:capture.sessions[0]?.configs.length??0,
    source_verified:capture.sessions[0]?.source_verified===true,evidence_complete:recorded.value.summary.evidence_complete===true,
    missing_event_recovered:JSON.parse(await fs.readFile(path.join(root,'.ai/rsi/runs',run,'sessions/child-1.json'),'utf8')).events.some(e=>e.type==='tool/call')};
  if(process.env.RSI_BENCH_ONLY==='1')console.log('RSI_SCOPE_RESULT '+JSON.stringify(observation));
  else {
    check(observation.tool_results===1&&observation.configs===1,'sibling preset contributes its actual events and configuration');
    check(observation.source_verified&&observation.evidence_complete,'source log reconciliation confirms completeness');
    check(observation.missing_event_recovered,'missed notification recovered without duplicate results');
    check(capture.sessions.length===1&&!JSON.stringify(capture).includes('unrelated'),'unrelated standard session excluded');
    const standardActor={};const standardActorScope=createScope(ctx,standardActor,{parent:standardKey});
    check(ctx.tools.get('sdlc_rsi_tasks',standardActor)===undefined,'standard agent has no RSI tools');await standardActorScope.dispose();
    emit(authorSession,author,authorEvents,'request/header',{header:{config:{model:'author-model'}}});
    emit(authorSession,author,authorEvents,'user/message',{content:[{type:'text',text:'implement fixture task'}]});
    emit(authorSession,author,authorEvents,'turn/start',{});
    const created=await call('sdlc_task_create',{task_id:'SCOPE-1',title:'Task evidence fixture'});
    check(!created.isError&&!created.value.recording_errors,'task creation persists a start checkpoint');
    emit(authorSession,author,authorEvents,'tool/result',{message:{content:[{type:'text',text:'author implementation'}]}});
    const verified=await call('sdlc_verify',{task_id:'SCOPE-1',intent_of_change:'fixture',criteria:['fixture passes']});
    check(!verified.isError,'verification attaches to the explicit task');
    const task=await call('sdlc_rsi_tasks',{task_id:'SCOPE-1'});
    check(!task.isError&&task.value.task.runs.includes(verified.value.verification_run_id),'task owns verification run');
    check(task.value.task.sessions.some(s=>s.role==='author')&&task.value.task.sessions.some(s=>s.role==='verifier'),'task includes author and verifier');
    check(task.value.evidence.evidence_complete===true,'task evidence is distinct from unfinished business status');
    check(task.value.evidence.task_complete===false,'recording success never completes the business task');
    queryAvailable=false;
    const lost=await call('sdlc_verify',{intent_of_change:'unavailable source',criteria:['fixture']});
    check(!lost.isError&&lost.value.status==='approve'&&lost.value.recording_errors?.length,'capture failure is visible without replacing verdict');
    const broken=await call('sdlc_rsi_runs',{run_id:lost.value.verification_run_id});
    check(!broken.value.summary.replay_ready&&broken.value.summary.complete,'verdict completion cannot hide missing source evidence');
    const report=await call('sdlc_rsi_analyze',{run_ids:[lost.value.verification_run_id]});
    check(report.value.observations.some(o=>o.kind==='incomplete_capture'),'analysis detects its own missing evidence');
    queryAvailable=true;
    console.log(`RSI scoped integration: ${checks} checks passed`);
  }
}finally {
  await authorScope.dispose();await sdlc.dispose();await verifier.dispose();await standard.dispose();await ctx.fiber.dispose();
  await fs.rm(root,{recursive:true,force:true});
}
