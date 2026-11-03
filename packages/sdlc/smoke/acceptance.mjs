/** Issue #2, both sides: SDLC_TEST_LIB=<old lib> SDLC_ACCEPTANCE_EXPECT=vulnerable also exercises the defective version. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const require=createRequire(path.join(process.env.DSH_APP??'/Applications/DeepSeek Harness.app','Contents/Resources/app.asar/dsh/node_modules/noop.js'));
const {Context}=require('@deepseek-ai/cordis'),{ToolRuntime}=require('@deepseek-ai/dsh-tools'),{LocalFileSystem}=require('@deepseek-ai/dsh-fs-local');
const lib=path.resolve(process.env.SDLC_TEST_LIB??path.join(import.meta.dirname,'../lib'));
const vulnerable=process.env.SDLC_ACCEPTANCE_EXPECT==='vulnerable';
const task=await import(pathToFileURL(path.join(lib,'task/index.js'))),verify=await import(pathToFileURL(path.join(lib,'verify/index.js'))),artifact=await import(pathToFileURL(path.join(lib,'artifact/index.js')));
const {load,JSON_SCHEMA}=require('js-yaml');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'sdlc-acceptance-')),ctx=new Context();
const agent={id:'author',session:{id:'author',header:{cwd:root}}};
const criteria=['AC-001: 优惠金额计算正确','AC-002: 并发请求不会重复使用优惠券','AC-003: 优惠失败不能生成错误订单'];
const spec='# Spec\n\n## Requirements\n优惠券正确消费。\n\n## Acceptance Criteria\n'+criteria.map(c=>'- '+c).join('\n')+'\n\n## Design\n事务中处理优惠券与订单。\n\n## Areas of concern\n并发与失败回滚。\n';
const intent='# Intent\n\n## Problem\n优惠券消费可能出错。\n\n## Proposed outcome\n金额、并发、失败三项通过。\n\n## Affected users and systems\n订单服务。\n\n## Constraints\n三项全部必验。\n\n## Open questions\n无。\n';
const plan='# Plan\n\n## Files that change\napp.js\n\n## Order of work\n计算、消费、回滚。\n\n## Risks\n重复消费。\n\n## Proof\n按 Spec 逐项验证。\n';
let seq=0,checks=0,starts=0,mode='all',during,seenIds=[],issueResults=[];
const check=(value,label)=>{assert.ok(value,label);checks++;console.log('  ✓ '+label);};
const call=(name,args)=>ctx.tools.execute({callId:`acceptance-${++seq}`,name,arguments:Object.fromEntries(Object.entries(args).filter(([,v])=>v!==undefined)),agent,signal:new AbortController().signal});
const success=async(name,args)=>{const r=await call(name,args);assert.ok(!r.isError,JSON.stringify(r));return r.value;};
const dir=id=>path.join(root,'.ai/tasks',id);
const state=async id=>load(await fs.readFile(path.join(dir(id),'state.yaml'),'utf8'),{schema:JSON_SCHEMA});
const advance=(id,to,artifacts)=>call('sdlc_task_advance',{task_id:id,to,reason:'Issue 2 controlled fixture',...(artifacts?{artifacts}:{})});
const verifyTask=(id,extra={})=>call('sdlc_verify',{task_id:id,intent_of_change:'Fulfill all three Spec requirements',criteria,...extra});
const create=async(id,content=spec,stage='VERIFYING')=>{
  await success('sdlc_task_create',{task_id:id,title:'Acceptance fixture '+id});
  for(const [kind,contentValue] of Object.entries({intent,spec:content,plan})) {
    const r=await success('sdlc_artifact_write',{task_id:id,kind,content:contentValue});
    assert.equal(r.structure_ok,true);
  }
  if(stage!=='INTENT') {
    const r=await advance(id,stage);assert.ok(!r.isError,JSON.stringify(r));
  }
};
const complete=async(id,allowed)=>{
  const review=await advance(id,'REVIEWING');check(!review.isError===allowed,id+' review gate');
  await fs.writeFile(path.join(dir(id),'review.json'),JSON.stringify({status:'approve',summary:'Controlled review fixture'}));
  const done=await advance(id,'DONE',{review:'review.json'});check(!done.isError===allowed,id+' completion gate');
};
try {
  execFileSync('git',['-C',root,'init'],{stdio:'pipe'});
  await fs.writeFile(path.join(root,'app.js'),'export const value = 1;\n');
  execFileSync('git',['-C',root,'add','app.js'],{stdio:'pipe'});
  execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture'],{stdio:'pipe'});
  new LocalFileSystem(ctx,LocalFileSystem.Config['~standard'].validate({}).value);
  ctx.provide('sandboxPolicy',{resolve:()=>({mode:'workspace-write',workspaceRoot:root,writableRoots:[root]})});
  ctx.provide('systemPrompt',{section:()=>()=>{},tools:()=>()=>{},variable:()=>()=>{},context:()=>()=>{},getSectionOrder:()=>0,getContextOrder:()=>0});
  new ToolRuntime(ctx,'tools');
  ctx.provide('agentPresets',{register:async()=>()=>{},resolve:async id=>({id,name:'fixture'})});
  ctx.provide('subagents',{startActivation:async({request})=>{
    starts++;
    const prompt=request.prompt.map(p=>p.text??'').join('\n');
    seenIds=[...prompt.matchAll(/^((?:AC|EXTRA)-[A-Za-z0-9-]+): /gm)].map(m=>m[1]);
    let rows=seenIds.map(criterion_id=>({criterion_id,result:'met',evidence:'deterministic verifier fixture'}));
    if(mode==='subset') rows=rows.slice(0,1);
    if(mode==='duplicate') rows=[...rows,rows[0]];
    if(mode==='unknown') rows[2]={...rows[2],criterion_id:'AC-999'};
    if(mode==='no-evidence') rows[2]={...rows[2],evidence:''};
    if(['not_met','cannot_tell'].includes(mode))rows[2]={...rows[2],result:mode};
    if(during)await during();
    return {childId:'verifier-'+starts,result:Promise.resolve({output:[],stopReason:'completed',structured:{status:'approve',summary:'Controlled verdict',findings:[],criteria_results:rows,...(issueResults.length?{issue_results:issueResults}:{})}}),dispose:()=>{}};
  }});
  for(const plugin of [task,artifact,verify])plugin.apply(ctx,plugin.Config['~standard'].validate({}).value);

  await create('SUBSET');
  let before=starts,r=await verifyTask('SUBSET',{criteria:criteria.slice(0,1)});
  check(vulnerable ? !r.isError&&r.value.status==='approve' : r.isError&&/AC-002.*AC-003/.test(r.error.message),'caller subset '+(vulnerable?'reproduces false approval':'rejected with missing IDs'));
  if(!vulnerable)check(starts===before,'subset rejected before verifier dispatch');
  await complete('SUBSET',vulnerable);

  await create('FULL');r=await verifyTask('FULL');
  check(!r.isError&&r.value.status==='approve','full valid criteria remain approvable');
  if(!vulnerable)check(seenIds.join(',')==='AC-001,AC-002,AC-003','prompt uses explicit Spec IDs');
  await complete('FULL',true);

  mode='subset';await create('MISSING-RESULTS');r=await verifyTask('MISSING-RESULTS');
  check(!r.isError&&r.value.status==='needs_human','verifier omission is caught on both versions');
  await complete('MISSING-RESULTS',false);mode='all';

  await create('PRE-FIRST');await fs.appendFile(path.join(dir('PRE-FIRST'),'spec.md'),'\nA narrative edit before the first verification.\n');
  before=starts;r=await verifyTask('PRE-FIRST');
  check(vulnerable ? !r.isError&&r.value.status==='approve' : r.isError&&/Spec/.test(r.error.message),'pre-first-verification Spec edit '+(vulnerable?'is adopted by old version':'is rejected against registered baseline'));
  if(!vulnerable)check(starts===before,'unregistered edit never starts the verifier');

  await create('FORGED-RESULT');r=await verifyTask('FORGED-RESULT');assert.ok(!r.isError);
  const saved=await state('FORGED-RESULT'),file=path.join(dir('FORGED-RESULT'),saved.artifacts.verification);
  const doc=JSON.parse(await fs.readFile(file,'utf8'));
  doc.criteria=doc.criteria.slice(0,1);doc.verdict.criteria_results=doc.verdict.criteria_results.slice(0,1);
  await fs.writeFile(file,JSON.stringify(doc));
  await complete('FORGED-RESULT',vulnerable);

  if(!vulnerable) {
    for(const stage of ['PLANNED','IMPLEMENTING','VERIFYING']) {
      const id='JUMP-'+stage;await create(id,spec,stage);
      const s=await state(id);check(s.acceptance.criteria.length===3&&s.history.length===2,'INTENT -> '+stage+' registers acceptance despite skipping SPEC');
    }
    await create('NO-BASELINE',spec,'INTENT');
    const bad=await state('NO-BASELINE');bad.status='VERIFYING';
    await fs.writeFile(path.join(dir('NO-BASELINE'),'state.yaml'),JSON.stringify(bad));
    check((await verifyTask('NO-BASELINE')).isError,'direct verify cannot create a missing baseline');
    check((await advance('NO-BASELINE','REVIEWING')).isError,'stage gate independently rejects a missing baseline');

    await create('AUTO');r=await verifyTask('AUTO',{criteria:undefined});
    check(!r.isError&&r.value.status==='approve'&&seenIds.length===3,'omitted caller criteria automatically verifies all registered ACs');
    await complete('AUTO',true);
    await create('EXTRA');r=await verifyTask('EXTRA',{criteria:undefined,additional_criteria:['extra check']});
    check(!r.isError&&r.value.status==='approve'&&seenIds.length===4&&seenIds[3].startsWith('EXTRA-'),'additional checks are additive');
    await complete('EXTRA',true);

    for(const kind of ['duplicate','unknown','no-evidence','not_met','cannot_tell']) {
      mode=kind;const id='INVALID-'+kind.replaceAll('_','-').toUpperCase();await create(id);r=await verifyTask(id);
      check(!r.isError&&r.value.status!=='approve',kind+' cannot approve');await complete(id,false);
    }
    mode='all';await create('DURING');during=()=>fs.appendFile(path.join(dir('DURING'),'spec.md'),'\nEdited during verification.\n');
    r=await verifyTask('DURING');during=undefined;
    check(r.isError||r.value.status!=='approve','Spec edit during verifier execution cannot approve');
    check(!(await state('DURING')).workflow.active_run,'failed verification releases active marker');
    await create('AFTER');r=await verifyTask('AFTER');assert.ok(!r.isError);
    await fs.appendFile(path.join(dir('AFTER'),'spec.md'),'\nEdited after verification.\n');await complete('AFTER',false);

    const issue=await success('sdlc_task_issue',{task_id:'PRE-FIRST',action:'report',severity:'blocking',reason:'Spec changed outside SPEC'});
    const issue_id=issue.issues[0].id;
    const wrong=await call('sdlc_task_issue',{task_id:'PRE-FIRST',action:'start',issue_id,to:'IMPLEMENTING',reason:'try to avoid SPEC'});
    check(wrong.isError&&/Spec/.test(wrong.error.message),'issue start cannot bypass the Spec baseline');
    await success('sdlc_task_issue',{task_id:'PRE-FIRST',action:'start',issue_id,to:'SPEC',reason:'record Spec rework'});
    await success('sdlc_task_issue',{task_id:'PRE-FIRST',action:'submit',issue_id,reason:'Spec change reviewed',evidence:'Updated Spec narrative'});
    const prior=(await state('PRE-FIRST')).acceptance.id;
    check(!(await advance('PRE-FIRST','VERIFYING')).isError,'recorded return permits new registration');
    check((await state('PRE-FIRST')).acceptance.id!==prior,'re-registration has a new version even when AC IDs are unchanged');

    await create('LEGACY',spec,'INTENT');
    const oldText=JSON.stringify({schema_version:2,task:'LEGACY',criteria:['historical criterion'],verdict:{status:'approve',summary:'historical',findings:[],criteria_results:[{criterion:'historical criterion',result:'met',evidence:'historical evidence'}]}});
    await fs.writeFile(path.join(dir('LEGACY'),'verification.json'),oldText);
    const legacy=await state('LEGACY');legacy.status='VERIFYING';legacy.artifacts.verification='verification.json';
    await fs.writeFile(path.join(dir('LEGACY'),'state.yaml'),JSON.stringify(legacy));
    check((await verifyTask('LEGACY')).isError,'legacy task cannot invent a confirmed baseline from current files');
    const migrated=await state('LEGACY');
    const archive=path.join(dir('LEGACY'),migrated.workflow.runs[0].file);
    check(await fs.readFile(archive,'utf8')===oldText,'legacy verdict is archived verbatim');
    check(!(await advance('LEGACY','SPEC')).isError,'legacy task can explicitly return to SPEC');
    check(!(await advance('LEGACY','VERIFYING')).isError,'legacy task registers current Spec after recorded return');
    r=await verifyTask('LEGACY',{criteria:undefined});check(!r.isError&&r.value.status==='approve','migrated task verifies explicit IDs in a new round');
    await complete('LEGACY',true);check(await fs.readFile(archive,'utf8')===oldText,'new verification never rewrites historical IDs');

    await create('LEGACY-FAIL',spec,'INTENT');
    const {criterionEntries}=await import(pathToFileURL(path.join(lib,'verify/verdict.js')));
    const historicalId=criterionEntries(['historical criterion'])[0].id;
    const rejected=JSON.stringify({schema_version:2,task:'LEGACY-FAIL',criteria:['historical criterion'],verdict:{status:'reject',summary:'historical failure',findings:[],criteria_results:[{criterion_id:historicalId,result:'not_met',evidence:'historical failed probe'}]}});
    await fs.writeFile(path.join(dir('LEGACY-FAIL'),'verification.json'),rejected);
    const lf=await state('LEGACY-FAIL');lf.status='VERIFYING';lf.artifacts.verification='verification.json';
    await fs.writeFile(path.join(dir('LEGACY-FAIL'),'state.yaml'),JSON.stringify(lf));
    check((await verifyTask('LEGACY-FAIL')).isError,'legacy failure is imported without being erased by migration');
    const oldIssue=(await state('LEGACY-FAIL')).workflow.issues.find(i=>i.criterion_id===historicalId);
    assert.ok(oldIssue);
    await success('sdlc_task_issue',{task_id:'LEGACY-FAIL',action:'start',issue_id:oldIssue.id,to:'SPEC',reason:'register reviewed Spec and address old requirement'});
    await success('sdlc_task_issue',{task_id:'LEGACY-FAIL',action:'submit',issue_id:oldIssue.id,reason:'resolved old defect',evidence:'author regression evidence'});
    check(!(await advance('LEGACY-FAIL','VERIFYING')).isError,'legacy failed task registers after explicit repair submission');
    issueResults=[{issue_id:oldIssue.id,result:'resolved',evidence:'independent confirmation of historical defect'}];
    r=await verifyTask('LEGACY-FAIL',{criteria:undefined});issueResults=[];
    check(!r.isError&&r.value.status==='approve','old hash-numbered issue can be explicitly reverified alongside new AC IDs');
    const resolved=(await state('LEGACY-FAIL')).workflow.issues.find(i=>i.id===oldIssue.id);
    check(resolved.criterion_id===historicalId&&resolved.status==='resolved','issue retains its original hash ID and records an explicit independent resolution');
    await complete('LEGACY-FAIL',true);
  }
  const standalone=await call('sdlc_verify',{intent_of_change:'standalone scope',criteria:['a standalone check']});
  check(!standalone.isError&&standalone.value.status==='approve'&&/^AC-[a-f0-9]{16}$/.test(seenIds[0]),'standalone verification retains hash IDs');
  console.log(`ACCEPTANCE ${vulnerable?'baseline (defect reproduced)':'current'}: ${checks} assertions passed; ${starts} deterministic verifier starts`);
} finally {await ctx.fiber.dispose();await fs.rm(root,{recursive:true,force:true});}
