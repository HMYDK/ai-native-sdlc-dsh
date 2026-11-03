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
const currentVersion=JSON.parse(await fs.readFile(path.join(lib,'../package.json'),'utf8')).version;
const rsi=await import(pathToFileURL(path.join(lib,'rsi/index.js')));
const verify=await import(pathToFileURL(path.join(lib,'verify/index.js')));
const artifactPlugin=await import(pathToFileURL(path.join(lib,'artifact/index.js')));
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
  ctx.provide('subagents',{startActivation:async({request})=>{
    const criterion_id=(request.prompt??[]).map(p=>p.text??'').join(' ').match(/AC-[A-Za-z0-9-]+/)?.[0];
    const id=`child-${++childCounter}`,session={id,header:{cwd:root,parentSession:'author',origin:'subagent'}};
    const child={},scope=createScope(ctx,child,{parent:verifierKey}),events=[];
    sources.set(id,{header:session.header,events});
    emit(session,child,events,'request/header',{header:{config:{model:'fixture'}}});
    // Deliberately miss a live event: reconciliation must recover it from the authoritative log.
    events.push({seq:events.length,time:Date.now(),type:'tool/call',data:{name:'bash',arguments:'{"command":"test"}'}});
    emit(session,child,events,'tool/result',{message:{content:[{type:'text',text:'test passed'}]}});
    emit(session,child,events,'turn/end',{stopReason:'completed'});
    return {childId:id,result:Promise.resolve({output:[],stopReason:'completed',structured:{status:'approve',summary:'fixture',findings:[],criteria_results:[{...(criterion_id?{criterion_id}:{}),result:'met',evidence:'fixture result'}]}}),dispose:()=>scope.dispose()};
  }});
  rsi.apply(sdlc.ctx,rsi.Config['~standard'].validate({}).value);
  verify.apply(sdlc.ctx,verify.Config['~standard'].validate({}).value);
  taskPlugin.apply(sdlc.ctx,taskPlugin.Config['~standard'].validate({}).value);
  artifactPlugin.apply(sdlc.ctx,artifactPlugin.Config['~standard'].validate({}).value);
  const unrelated={id:'unrelated',header:{cwd:root}},unrelatedEvents=[];
  emit(unrelated,standardKey,unrelatedEvents,'request/header',{header:{config:{model:'unrelated'}}});
  const result=await call('sdlc_verify',{intent_of_change:'scope regression',criteria:['the fixture passes']});
  check(!result.isError&&result.value.status==='approve','independent verdict still returns');
  const run=result.value.verification_run_id;
  const capture=JSON.parse(await fs.readFile(path.join(root,'.ai/rsi/runs',run,'capture.json'),'utf8'));
  const recorded=await call('sdlc_rsi_runs',{run_id:run});
  const recording=await import(pathToFileURL(path.join(lib,'verify/recording.js')));
  const observation={suite_fingerprint:recording.fingerprintJavaScript(lib),tool_results:capture.sessions[0]?.tool_results??0,configs:capture.sessions[0]?.configs.length??0,
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
    // Task-bound verification now requires real foundation artifacts and the actual verification stage.
    const setupFile=path.join(root,'.ai/tasks/SCOPE-1/state.yaml');
    const yaml=require('js-yaml');const setup=yaml.load(await fs.readFile(setupFile,'utf8'),{schema:yaml.JSON_SCHEMA});
    for(const kind of ['intent','spec','plan']) {setup.artifacts[kind]=`${kind}.md`;await fs.writeFile(path.join(root,'.ai/tasks/SCOPE-1',`${kind}.md`),'# fixture');}
    await fs.writeFile(path.join(root,'.ai/tasks/SCOPE-1/spec.md'),'## Acceptance Criteria\n- AC-001: fixture passes\n');
    await fs.writeFile(setupFile,yaml.dump(setup,{schema:yaml.JSON_SCHEMA}));
    const setupAdvance=await call('sdlc_task_advance',{task_id:'SCOPE-1',to:'VERIFYING',reason:'register fixture Spec'});
    assert.ok(!setupAdvance.isError,JSON.stringify(setupAdvance));
    const verified=await call('sdlc_verify',{task_id:'SCOPE-1',intent_of_change:'fixture',criteria:['fixture passes']});
    check(!verified.isError,'verification attaches to the explicit task');
    const task=await call('sdlc_rsi_tasks',{task_id:'SCOPE-1'});
    check(!task.isError&&task.value.task.runs.includes(verified.value.verification_run_id),'task owns verification run');
    check(task.value.task.sessions.some(s=>s.role==='author')&&task.value.task.sessions.some(s=>s.role==='verifier'),'task includes author and verifier');
    check(task.value.evidence.evidence_complete===true,'task evidence is distinct from unfinished business status');
    check(task.value.evidence.task_complete===false,'recording success never completes the business task');
    const concurrent=await Promise.all([1,2].map(()=>call('sdlc_verify',{task_id:'SCOPE-1',intent_of_change:'parallel',criteria:['fixture passes']})));
    const ids=concurrent.filter(r=>!r.isError).map(r=>r.value.verification_run_id);
    const parallelTask=await call('sdlc_rsi_tasks',{task_id:'SCOPE-1'});
    check(ids.length===1&&concurrent.filter(r=>r.isError).length===1&&ids.every(id=>parallelTask.value.task.runs.includes(id)),'same-task concurrent verification is refused; both invocations remain attributable');
    const {TaskCollector}=await import(pathToFileURL(path.join(lib,'rsi/tasks.js')));
    const {Collector}=await import(pathToFileURL(path.join(lib,'rsi/collector.js')));
    const recovered=await new TaskCollector(sdlc.ctx,'.ai/rsi',new Collector(sdlc.ctx,'.ai/rsi')).inspect({agent:author},'SCOPE-1');
    check(recovered.evidence.evidence_complete&&recovered.task.runs.length===3,'a new collector recovers persisted ownership and reconciles the source');
    const proposal={title:'Fix evidence loss',problem:'The source shows a gap',hypothesis:'Sibling scopes hide events',change:'Reconcile owned sessions',alternatives:'Source query could also fail',acceptance:'Old fails, new captures the child',comparison:'Run the same runtime fixture with two plugin versions',focus:'capture',references:[{path:'tasks/SCOPE-1/evidence.json',observation:'Reviewed task evidence summary'}]};
    const proposed=await call('sdlc_rsi_propose',{task_id:'SCOPE-1',proposal});
    check(!proposed.isError&&proposed.value.packet.sha256,'reviewed hypothesis contains evidence hashes: '+JSON.stringify(proposed));
    const pin=proposed.value.packet.proposal.references[0];
    const pinned=JSON.parse(await fs.readFile(path.join(root,'.ai/rsi',pin.snapshot_path),'utf8'));
    check(pinned.review_status==='collecting','proposal pins the cited revision before the mutable task summary changes');
    const wrong=await call('sdlc_rsi_propose',{task_id:'SCOPE-1',proposal:{...proposal,references:[{path:'tasks/OTHER/evidence.json',observation:'unrelated'}]}});
    check(wrong.isError,'unrelated task evidence cannot be silently attached');
    const outside=await call('sdlc_rsi_improve',{task_id:'IMPROVE-1',packet:proposed.value.packet});
    check(outside.isError,'a business workspace cannot accidentally receive a plugin development task');
    await fs.mkdir(path.join(root,'packages/sdlc'),{recursive:true});
    await fs.writeFile(path.join(root,'packages/sdlc/package.json'),JSON.stringify({name:'@ai-native-sdlc-plugin/dsh-sdlc'}));
    const imported=await call('sdlc_rsi_improve',{task_id:'IMPROVE-1',packet:proposed.value.packet});
    check(!imported.isError&&!imported.value.incomplete&&imported.value.intent.structure_ok,'proposal creates an ordinary task and structurally valid intent');
    const state=await fs.readFile(path.join(root,'.ai/tasks/IMPROVE-1/state.yaml'),'utf8');
    check(state.includes('INTENT')&&state.includes('intent.md'),'proposal never bypasses ordinary task stages');
    const switchEvent=emit(authorSession,author,authorEvents,'tool/call',{name:'sdlc_task_create',arguments:'{"task_id":"SWITCH-1"}',callId:`test-${callCounter+1}`});
    await call('sdlc_task_create',{task_id:'SWITCH-1',title:'Explicit task switch'});
    const beforeSwitch=await call('sdlc_rsi_tasks',{task_id:'IMPROVE-1'}),afterSwitch=await call('sdlc_rsi_tasks',{task_id:'SWITCH-1'});
    check(beforeSwitch.value.task.sessions.find(s=>s.role==='author').windows.at(-1).to===switchEvent.seq&&afterSwitch.value.task.sessions.find(s=>s.role==='author').windows[0].from===switchEvent.seq,'same-session task switch uses the explicit invocation boundary without overlap');
    const duplicate=await call('sdlc_rsi_improve',{task_id:'IMPROVE-1',packet:proposed.value.packet});
    check(duplicate.isError,'duplicate import preserves the existing task');
    const adopt=await call('sdlc_rsi_feedback',{proposal_id:proposed.value.proposal_id,task_id:'IMPROVE-1',decision:'adopt',note:'try',evidence:'missing comparison'});
    check(adopt.isError,'adoption without two-version evidence is rejected');
    // Isolate provenance validation: this fixture supplies DONE directly, without claiming to test the task gate.
    const developmentDir=path.join(root,'.ai/tasks/IMPROVE-1');
    await fs.writeFile(path.join(developmentDir,'state.yaml'),state.replace('status: INTENT','status: DONE'));
    await fs.writeFile(path.join(developmentDir,'comparison.json'),JSON.stringify({baseline:{revision:'old',fingerprint:'old-content'},candidate:{revision:'new',fingerprint:'new-content'},command:'fixture comparison',cases:[{id:'case',baseline_pass:false,candidate_pass:true,evidence:'fixture observations'}]}));
    await fs.writeFile(path.join(developmentDir,'rsi-proposal.json'),JSON.stringify({...proposed.value.packet,sha256:'wrong-link'}));
    const wrongAdoption=await call('sdlc_rsi_feedback',{proposal_id:proposed.value.proposal_id,task_id:'IMPROVE-1',decision:'adopt',comparison_report:'comparison.json',note:'try',evidence:'wrong proposal'});
    check(wrongAdoption.isError,'DONE task and comparison cannot be borrowed by an unrelated proposal');
    await fs.writeFile(path.join(developmentDir,'rsi-proposal.json'),JSON.stringify(proposed.value.packet));
    const linkedAdoption=await call('sdlc_rsi_feedback',{proposal_id:proposed.value.proposal_id,task_id:'improve-1',decision:'adopt',comparison_report:'comparison.json',note:'fixture decision',evidence:'linked comparison'});
    check(!linkedAdoption.isError,'matching completed development task accepts a supplied comparison with normalized task ID');
    await fs.writeFile(path.join(developmentDir,'state.yaml'),state);
    const feedback=await call('sdlc_rsi_feedback',{proposal_id:proposed.value.proposal_id,task_id:'IMPROVE-1',decision:'inconclusive',note:'Need more evidence',evidence:'runtime fixture only',followup_task_id:'SCOPE-1'});
    check(!feedback.isError,'feedback can retain a later task and its actually recorded plugin version');
    const legacyDir=path.join(root,'.ai/tasks/LEGACY-1');await fs.mkdir(legacyDir,{recursive:true});
    await fs.writeFile(path.join(legacyDir,'state.yaml'),state.replaceAll('IMPROVE-1','LEGACY-1'));
    const legacyRun=path.join(root,'.ai/rsi/runs/legacy-run');await fs.cp(path.join(root,'.ai/rsi/runs',ids[0]),legacyRun,{recursive:true});
    const legacyStart=JSON.parse(await fs.readFile(path.join(legacyRun,'000000.json'),'utf8'));legacyStart.data.inputs.task_id='LEGACY-1';
    await fs.writeFile(path.join(legacyRun,'000000.json'),JSON.stringify(legacyStart));
    const legacy=await call('sdlc_rsi_tasks',{task_id:'LEGACY-1'});
    check(!legacy.isError&&legacy.value.task.runs.includes('legacy-run'),'legacy run restored only through explicit task_id');
    check(!legacy.value.evidence.evidence_complete&&legacy.value.evidence.issues.some(s=>s.includes('起点')),'historical log recovery cannot invent a task start snapshot');
    check(legacy.value.task.loaded_suite===null,'legacy task cannot claim the current recorder version as its execution version');
    queryAvailable=false;
    const lost=await call('sdlc_verify',{intent_of_change:'unavailable source',criteria:['fixture']});
    check(!lost.isError&&lost.value.status==='approve'&&lost.value.recording_errors?.length,'capture failure is visible without replacing verdict');
    const broken=await call('sdlc_rsi_runs',{run_id:lost.value.verification_run_id});
    check(!broken.value.summary.replay_ready&&broken.value.summary.complete,'verdict completion cannot hide missing source evidence');
    const report=await call('sdlc_rsi_analyze',{run_ids:[lost.value.verification_run_id]});
    check(report.value.observations.some(o=>o.kind==='incomplete_capture'),'analysis detects its own missing evidence');
    const invalidProposal=await call('sdlc_rsi_propose',{task_id:'LEGACY-1',proposal:{...proposal,focus:'workflow'}});
    check(invalidProposal.isError,'incomplete source cannot justify an effect-improvement proposal');
    queryAvailable=true;
    const author2Session={id:'author2',header:{cwd:root},seq:0};
    const author2={id:'author2',session:author2Session};
    const author2Scope=createScope(ctx,author2,{parent:sdlcKey});author2.ctx=author2Scope.ctx;
    const author2Events=[];sources.set('author2',{header:author2Session.header,events:author2Events});
    emit(author2Session,author2,author2Events,'user/message',{content:[{type:'text',text:'continue SCOPE-1'}]});
    emit(author2Session,author2,author2Events,'turn/start',{});
    emit(author2Session,author2,author2Events,'request/header',{header:{config:{model:'author-2'}}});
    const call2=(name,args={})=>ctx.tools.execute({callId:`author2-${++callCounter}`,name,arguments:args,agent:author2,signal:new AbortController().signal});
    const written=await call2('sdlc_artifact_write',{task_id:'SCOPE-1',kind:'intent',overwrite:true,content:'# Intent\n\n## Problem\nA problem\n\n## Proposed outcome\nAn outcome\n\n## Affected users and systems\nUsers\n\n## Constraints\nNo constraints\n\n## Open questions\nNone\n'});
    emit(author2Session,author2,author2Events,'tool/result',{message:{content:[{type:'text',text:'AUTHOR2_WORK_MARKER'}]}});
    emit(author2Session,author2,author2Events,'turn/end',{stopReason:'completed'});
    const afterAuthor2=await call('sdlc_rsi_tasks',{task_id:'SCOPE-1'});
    check(!written.isError&&afterAuthor2.value.task.sessions.some(s=>s.id==='author2'),'artifact-only continuation records the new author');
    await author2Scope.dispose();

    const restored=new TaskCollector(sdlc.ctx,'.ai/rsi',new Collector(sdlc.ctx,'.ai/rsi'));
    const getState=async id=>JSON.parse(await fs.readFile(path.join(root,'.ai/rsi/tasks',id,'checkpoints',JSON.parse(await fs.readFile(path.join(root,'.ai/rsi/tasks',id,'task.json'),'utf8')).checkpoints[0]+'.json'),'utf8')).state;
    const lastSwitch=await getState('SWITCH-1');
    const nextState={...lastSwitch,task:'RESTART-1'};
    await fs.mkdir(path.join(root,'.ai/tasks/RESTART-1'),{recursive:true});
    await fs.writeFile(path.join(root,'.ai/tasks/RESTART-1/state.yaml'),JSON.stringify(nextState));
    emit(authorSession,author,authorEvents,'user/message',{content:[{type:'text',text:'new task after restart'}]});
    emit(authorSession,author,authorEvents,'turn/start',{});
    emit(authorSession,author,authorEvents,'request/header',{header:{config:{model:'author-model'}}});
    const boundary=emit(authorSession,author,authorEvents,'tool/call',{name:'sdlc_task_create',arguments:'{"task_id":"RESTART-1"}',callId:'restart-create'});
    await restored.record({kind:'created',task_dir:'.ai/tasks/RESTART-1',state:nextState},{agent:author,callId:'restart-create'});
    const marker=emit(authorSession,author,authorEvents,'tool/result',{message:{content:[{type:'text',text:'NEW_TASK_MARKER'}]}});
    const old=await restored.inspect({agent:author},'SWITCH-1');
    const oldTrace=JSON.parse(await fs.readFile(path.join(root,'.ai/rsi/tasks/SWITCH-1/sessions/author.json'),'utf8'));
    check(old.task.sessions.find(s=>s.id==='author').windows.at(-1).to===boundary.seq&&!JSON.stringify(oldTrace).includes('NEW_TASK_MARKER'),'restart closes persisted old ownership before the new task begins');
    await restored.flush();


    await call('sdlc_task_create',{task_id:'FAULT-1',title:'recording failure fixture'});
    const faultState=await getState('FAULT-1');
    const nextFaultState={...faultState,status:'SPEC',artifacts:{intent:'intent.md',spec:'spec.md'}};
    await fs.writeFile(path.join(root,'.ai/tasks/FAULT-1/state.yaml'),JSON.stringify(nextFaultState));
    await fs.writeFile(path.join(root,'.ai/tasks/FAULT-1/intent.md'),'valid fixture intent');
    await fs.writeFile(path.join(root,'.ai/tasks/FAULT-1/spec.md'),'valid fixture spec');
    const {Store}=await import(pathToFileURL(path.join(lib,'rsi/store.js')));
    const originalWrite=Store.prototype.write;
    Store.prototype.write=async function(relative,...args) {
      if(relative.startsWith('tasks/FAULT-1/checkpoints/'))throw new Error('fixture checkpoint write failed');
      return originalWrite.call(this,relative,...args);
    };
    const faultCollector=new TaskCollector(sdlc.ctx,'.ai/rsi',new Collector(sdlc.ctx,'.ai/rsi'));
    let failure;
    try {await faultCollector.record({kind:'advanced',task_dir:'.ai/tasks/FAULT-1',state:nextFaultState},{agent:author});}
    catch(error){failure=error.message;}
    finally {Store.prototype.write=originalWrite;}
    const afterFailureRestart=await new TaskCollector(sdlc.ctx,'.ai/rsi',new Collector(sdlc.ctx,'.ai/rsi')).inspect({agent:author},'FAULT-1');
    check(failure&&afterFailureRestart.task.status==='SPEC'&&!afterFailureRestart.evidence.evidence_complete,'failed checkpoint remains visible after restart and current task state wins');

    const firstCheckpoint=afterFailureRestart.task.checkpoints[0];
    const checkpointPath=path.join(root,'.ai/rsi/tasks/FAULT-1/checkpoints',firstCheckpoint+'.json');
    const firstVersion=JSON.parse(await fs.readFile(checkpointPath,'utf8'));
    firstVersion.loaded_suite={version:'0.3.9',javascript_sha256:'older-js',patch_sha256:'older-patch'};
    await fs.writeFile(checkpointPath,JSON.stringify(firstVersion));
    const upgraded=new TaskCollector(sdlc.ctx,'.ai/rsi',new Collector(sdlc.ctx,'.ai/rsi'));
    await upgraded.record({kind:'advanced',task_dir:'.ai/tasks/FAULT-1',state:nextFaultState},{agent:author});
    const versions=await upgraded.inspect({agent:author},'FAULT-1');
    check(versions.evidence.execution_suites.some(s=>s.suite?.version==='0.3.9')&&versions.evidence.execution_suites.some(s=>s.suite?.version===currentVersion),'task continuing across plugin versions retains each recorded execution version');

    await call('sdlc_task_create',{task_id:'VERSION-ONLY',title:'Artifact operation after upgrade'});
    const versionManifest=JSON.parse(await fs.readFile(path.join(root,'.ai/rsi/tasks/VERSION-ONLY/task.json'),'utf8'));
    const versionCheckpoint=path.join(root,'.ai/rsi/tasks/VERSION-ONLY/checkpoints',versionManifest.checkpoints[0]+'.json');
    const olderCheckpoint=JSON.parse(await fs.readFile(versionCheckpoint,'utf8'));olderCheckpoint.loaded_suite=firstVersion.loaded_suite;
    await fs.writeFile(versionCheckpoint,JSON.stringify(olderCheckpoint));
    const operationDirectory=path.join(root,'.ai/rsi/operations/author');
    for(const file of await fs.readdir(operationDirectory).catch(()=>[])) {
      const operation=JSON.parse(await fs.readFile(path.join(operationDirectory,file),'utf8'));
      if(operation.task_id==='VERSION-ONLY') {operation.loaded_suite=firstVersion.loaded_suite;await fs.writeFile(path.join(operationDirectory,file),JSON.stringify(operation));}
    }
    emit(authorSession,author,authorEvents,'tool/call',{name:'sdlc_artifact_write',arguments:'{"task_id":"VERSION-ONLY","kind":"spec"}',callId:`test-${callCounter+1}`});
    const artifactOnly=await call('sdlc_artifact_write',{task_id:'VERSION-ONLY',kind:'spec'});
    const artifactVersions=await new TaskCollector(sdlc.ctx,'.ai/rsi',new Collector(sdlc.ctx,'.ai/rsi')).inspect({agent:author},'VERSION-ONLY');
    check(!artifactOnly.isError&&artifactVersions.evidence.execution_suites.some(s=>s.suite?.version===currentVersion),'artifact-only continuation persists actual execution version across restart');

    emit(authorSession,author,authorEvents,'turn/start',{});
    await call('sdlc_task_create',{task_id:'WRITE-OLD',title:'Old task before failed switch'});
    const stateOld=await getState('WRITE-OLD');
    const stateNew={...stateOld,task:'WRITE-NEW',title:'New task despite failed recording'};
    await fs.mkdir(path.join(root,'.ai/tasks/WRITE-NEW'),{recursive:true});
    await fs.writeFile(path.join(root,'.ai/tasks/WRITE-NEW/state.yaml'),JSON.stringify(stateNew));
    const failedSwitch=new TaskCollector(sdlc.ctx,'.ai/rsi',new Collector(sdlc.ctx,'.ai/rsi'));
    const oldWrite=Store.prototype.write;
    Store.prototype.write=async function(relative,...args) {
      if(relative==='tasks/WRITE-OLD/task.json')throw new Error('old task index write failed');
      return oldWrite.call(this,relative,...args);
    };
    emit(authorSession,author,authorEvents,'tool/call',{name:'sdlc_task_create',arguments:'{"task_id":"WRITE-NEW"}',callId:'failed-switch'});
    let switchError;
    try {await failedSwitch.record({kind:'created',task_dir:'.ai/tasks/WRITE-NEW',state:stateNew},{agent:author,callId:'failed-switch'});}
    catch(error){switchError=error.message;}
    finally {Store.prototype.write=oldWrite;}
    emit(authorSession,author,authorEvents,'tool/result',{message:{content:[{type:'text',text:'BELONGS_TO_WRITE_NEW'}]}});
    const restartAfterFailure=new TaskCollector(sdlc.ctx,'.ai/rsi',new Collector(sdlc.ctx,'.ai/rsi'));
    const oldAfterFailure=await restartAfterFailure.inspect({agent:author},'WRITE-OLD');
    const oldAfterFailureTrace=JSON.parse(await fs.readFile(path.join(root,'.ai/rsi/tasks/WRITE-OLD/sessions/author.json'),'utf8'));
    const newAfterFailure=await restartAfterFailure.inspect({agent:author},'WRITE-NEW');
    check(switchError&&!JSON.stringify(oldAfterFailureTrace).includes('BELONGS_TO_WRITE_NEW')&&!newAfterFailure.evidence.evidence_complete,'failed old-task index write cannot leak new-task events after restart');

    console.log(`RSI scoped integration: ${checks} checks passed`);
  }
}finally {
  await authorScope.dispose();await sdlc.dispose();await verifier.dispose();await standard.dispose();await ctx.fiber.dispose();
  await fs.rm(root,{recursive:true,force:true});
}
