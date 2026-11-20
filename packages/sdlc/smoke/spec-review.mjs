/** Real Cordis + ToolRuntime + LocalFileSystem; model replies are controlled, NOT semantic quality evidence. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {installNativeExecutor, executeTool} from './helpers/executor.mjs';
const require=createRequire(path.join(process.env.DSH_APP??'/Applications/DeepSeek Harness.app','Contents/Resources/app.asar/dsh/node_modules/noop.js'));
const {Context}=require('@deepseek-ai/cordis'),{ToolRuntime}=require('@deepseek-ai/dsh-tools'),{LocalFileSystem}=require('@deepseek-ai/dsh-fs-local');
const task=await import('../lib/task/index.js'),artifact=await import('../lib/artifact/index.js'),verify=await import('../lib/verify/index.js');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'sdlc-spec-review-')),ctx=new Context();
const agent={id:'author',session:{id:'author',header:{cwd:root}}};
let seq=0,checks=0,starts=0,releases=0,disposes=0,active=0,during,throwProvider=false,lastRequest;
const check=(condition,label)=>{assert.ok(condition,label);checks++;console.log('  ✓ '+label);};
const empty=()=>({summary:'Controlled review; not semantic evidence.',findings:[],follow_up:[],limitations:[]});
const finding={kind:'omission',source_id:'S1',source_quote:'Export every order.',spec_reference:'AC-001',problem:'Headers alone permit missing rows.',counterexample:'Only the first page is exported.',suggestion:'Verify every source order ID across pages.'};
let structured={...empty(),findings:[finding]},stopReason='completed';
const call=(name,args,signal=new AbortController().signal)=>executeTool(ctx,{callId:`spec-review-${++seq}`,name,arguments:args,agent,signal});
const success=async(name,args,signal)=>{const r=await call(name,args,signal);assert.ok(!r.isError,JSON.stringify(r));return r.value;};
const source={path:'source.md',origin:'Controlled user requirement fixture',kind:'original'};
const review=(extra={},signal)=>success('sdlc_spec_review',{task_id:'SPEC-1',sources:[source],...extra},signal);
const readRecord=r=>fs.readFile(path.join(root,r.review_file),'utf8').then(JSON.parse);
const taskDir=path.join(root,'.ai/tasks/SPEC-1');
const spec='# Spec\n\n## Delivery Contract\n\n### Source\nsource.md\n\n### Outcome\nExport orders.\n\n### Boundary\nCSV only; Excel excluded.\n\n### Oracle\nCLI export.\n\n### AC mapping\nO-1 → AC-001\n\n## Acceptance Criteria\n- AC-001: CSV header is id,amount.\n\n## Requirements\nExport orders.\n\n## Design\nUse the existing orders API.\n\n## Areas of concern\nPagination coverage.\n';
try {
  new LocalFileSystem(ctx,LocalFileSystem.Config['~standard'].validate({}).value);
  ctx.provide('sandboxPolicy',{resolve:()=>({mode:'workspace-write',workspaceRoot:root,writableRoots:[root]})});
  ctx.provide('systemPrompt',{section:()=>()=>{},tools:()=>()=>{},variable:()=>()=>{},context:()=>()=>{},getSectionOrder:()=>0,getContextOrder:()=>0});
  new ToolRuntime(ctx,'tools');installNativeExecutor(ctx,require);
  ctx.provide('agentPresets',{register:async()=>{active++;return()=>{active--;releases++;};},resolve:async id=>active?{id,name:'fixture'}:undefined});
  ctx.provide('subagents',{startActivation:async request=>{
    starts++;lastRequest=request;
    assert.equal(request.parent,agent);assert.equal(request.request,undefined);
    assert.equal(request.label,'sdlc-spec-review');assert.equal(request.agentPreset,'sdlc-verifier');
    assert.equal(request.delivery,'caller');assert.ok(request.outputSchema.properties.findings);
    assert.equal(request.outputSchema.properties.status,undefined);
    if(throwProvider)throw new Error('controlled provider failure');
    const result=(async()=>{if(during)await during();return {output:[{type:'text',text:'An untrusted free-text approval.'}],stopReason,structured:structuredClone(structured)};})();
    return {childId:`reviewer-${starts}`,result,dispose:async()=>{disposes++;}};
  }});
  for(const plugin of [task,artifact,verify])plugin.apply(ctx,plugin.Config['~standard'].validate({}).value);
  await success('sdlc_task_create',{task_id:'SPEC-1',title:'Controlled draft-only review'});
  const intent='# Intent\n\n## Problem\nOrders must be exported.\n\n## Proposed outcome\nExport every order.\n\n## Affected users and systems\nOperators.\n\n## Constraints\nNo Excel.\n\n## Open questions\nNone.\n';
  for(const [kind,content]of Object.entries({intent,spec}))await success('sdlc_artifact_write',{task_id:'SPEC-1',kind,content});
  await success('sdlc_task_advance',{task_id:'SPEC-1',to:'SPEC',reason:'Draft ready for feedback'});
  await fs.writeFile(path.join(root,'source.md'),'Export every order. Excel support is explicitly excluded.\n');
  const before=await fs.readFile(path.join(taskDir,'state.yaml'),'utf8');

  const initial=await review();check(initial.review_complete&&initial.review.findings.length===1,'SPEC draft reviewed without plan, code or delivery tests');
  const saved=await readRecord(initial);
  check(saved.inputs.sources[0].content.includes('Export every order.'),'original source bytes retained in record');
  check(lastRequest.prompt[0].text.includes(saved.inputs.sources[0].content.trim()),'original requirement reaches independent prompt');
  check(!('status'in initial.review)&&!('verdict'in saved),'SPEC feedback is not a delivery approval');
  check(saved.events.at(-1).kind==='finished'&&saved.outcome==='completed','completed execution retained');
  check((await fs.readFile(path.join(taskDir,'state.yaml'),'utf8'))===before,'task state, AC and issues remain byte-identical');
  check(!(await fs.readdir(taskDir)).includes('verification.json'),'no final verification artifact is written');
  const id=initial.active_findings[0].id;
  const response=[{finding_id:id,response:'Added AC-002 to compare all exported order IDs across pages.'}];
  await fs.appendFile(path.join(taskDir,'spec.md'),'\nRevision: AC-002 will check all source order IDs across pages.\n');
  structured={...empty(),follow_up:[{finding_id:id,result:'addressed',evidence:'Current Spec revision explicitly compares all order IDs.'}]};
  const fixed=await review({previous_review:initial.review_id,responses:response,sources:undefined});
  check(fixed.review_complete&&fixed.active_findings.length===0,'follow-up confirms a revision and inherits original sources');
  const fixedRecord=await readRecord(fixed);
  check(fixedRecord.inputs.previous_review===initial.review_id&&fixedRecord.inputs.spec.sha256!==saved.inputs.spec.sha256,'follow-up binds its parent and the revised Spec');
  check(lastRequest.prompt[0].text.includes('previousSpec')&&lastRequest.prompt[0].text.includes('previousSources'),'reviewer sees prior material and current draft');

  structured={...empty(),follow_up:[{finding_id:id,result:'withdrawn',evidence:'Controlled counterevidence: the original claim was mistaken.'}]};
  const withdrawn=await review({previous_review:initial.review_id,responses:[{finding_id:id,response:'Here is counterevidence for the claim.'}]});
  check(withdrawn.review_complete&&withdrawn.active_findings.length===0,'independent follow-up can withdraw a mistaken finding');
  structured={...empty(),follow_up:[{finding_id:id,result:'needs_clarification',evidence:'Ask the user whether archived orders are included.'}]};
  const disputed=await review({previous_review:initial.review_id,responses:response});
  check(disputed.review_complete&&disputed.active_findings[0].id===id,'a dispute retains its original identity without a new issue');

  let count=starts;
  const missingResponse=await review({previous_review:initial.review_id});
  check(!missingResponse.review_complete&&starts===count,'missing author responses stop before model dispatch');
  structured=empty();
  const missingFollowUp=await review({previous_review:initial.review_id,responses:response});
  check(!missingFollowUp.review_complete&&/遗漏/.test(missingFollowUp.diagnostic),'model cannot silently omit earlier findings');
  structured={...empty(),findings:[{...finding,source_quote:'Export an Excel file.'}]};
  const invented=await review();check(!invented.review_complete&&/原文/.test(invented.diagnostic),'fabricated source quote cannot complete a review');
  structured=undefined;count=starts;
  const malformed=await review();check(!malformed.review_complete&&starts===count+1,'missing structured result has no automatic retry or free-text fallback');
  check((await readRecord(malformed)).outcome==='incomplete','generation failure is saved as incomplete');
  structured=empty();
  for(const file of ['spec.md','../../source.md','/etc/passwd']) {
    count=starts;const failed=await review({sources:[{...source,path:file}]});
    check(!failed.review_complete&&starts===count,`missing/outside source ${file} stops before dispatch`);
  }
  count=starts;const absent=await review({sources:undefined});
  check(!absent.review_complete&&starts===count,'missing original source cannot masquerade as no findings');
  count=starts;const inferred=await review({sources:[{...source,kind:'author_inference'}]});
  check(!inferred.review_complete&&starts===count,'author inference cannot replace original source');

  during=()=>fs.appendFile(path.join(root,'source.md'),'Clarification during review.\n');
  const changedSource=await review();check(!changedSource.review_complete&&/输入发生变化/.test(changedSource.diagnostic),'source edit during review invalidates the observation');
  during=()=>fs.appendFile(path.join(taskDir,'spec.md'),'Changed during review.\n');
  const changedSpec=await review();check(!changedSpec.review_complete,'Spec edit during review cannot produce completed feedback');
  during=undefined;
  throwProvider=true;const providerFailed=await review();throwProvider=false;
  check(!providerFailed.review_complete&&/provider failure/.test(providerFailed.diagnostic),'provider rejection is recorded without a verdict');
  const priorFiles=new Set(await fs.readdir(path.join(taskDir,'spec-reviews')));
  const controller=new AbortController();during=()=>controller.abort();stopReason='aborted';
  const cancelled=await call('sdlc_spec_review',{task_id:'SPEC-1',sources:[source]},controller.signal);during=undefined;stopReason='completed';
  check(cancelled.isError,'ToolRuntime preserves cancellation as an aborted tool call');
  const cancelledFile=(await fs.readdir(path.join(taskDir,'spec-reviews'))).find(file=>!priorFiles.has(file));
  const cancelledRecord=JSON.parse(await fs.readFile(path.join(taskDir,'spec-reviews',cancelledFile),'utf8'));
  check(!cancelledRecord.review_complete&&cancelledRecord.outcome==='cancelled','cancellation retains an incomplete record');
  check(cancelledRecord.events.at(-1).kind==='finished','cancelled signal does not erase final execution evidence');
  check(active===0&&releases===starts&&disposes===starts-1,'preset leases and every created activation are disposed, including failures');

  // The failed reviews must not become an implicit gate.
  const plan='# Plan\n\n## Files that change\napp.js\n\n## Order of work\nImplement CSV export.\n\n## Risks\nPagination.\n\n## Proof\nCompare source and exported IDs.\n';
  await success('sdlc_artifact_write',{task_id:'SPEC-1',kind:'plan',content:plan});
  await success('sdlc_task_advance',{task_id:'SPEC-1',to:'PLANNED',reason:'Continue under existing rules; SPEC review is advisory'});
  check(true,'ordinary progression remains possible after incomplete SPEC reviews');
  const outside=await call('sdlc_spec_review',{task_id:'SPEC-1',sources:[source]});
  check(outside.isError,'later-stage task must return to SPEC before draft review');
  console.log(`SPEC REVIEW SMOKE: ${checks} checks passed (controlled model; no paid calls).`);
} finally {
  await ctx.fiber.dispose();
  await fs.rm(root,{recursive:true,force:true});
}
