/** Historical FLOW-1 regressions; run by Electron against either archived or current library. */
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const lib=process.argv[2],req=createRequire('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/noop.js');
const {Context}=req('@deepseek-ai/cordis'),{ToolRuntime}=req('@deepseek-ai/dsh-tools'),{load,dump,JSON_SCHEMA}=req('js-yaml');
const task=await import(pathToFileURL(path.join(lib,'task/index.js'))),verdict=await import(pathToFileURL(path.join(lib,'verify/verdict.js'))),ui=await import(pathToFileURL(path.join(lib,'ui/execution.js')));
const ctx=new Context(),files=new Map(),rows=[];
const fs={
 async resolve(p,o){const f=path.resolve(o?.cwd??'/repo',p);return {targetKey:f,displayPath:f};},
 contains(a,b){return b.displayPath===a.displayPath||b.displayPath.startsWith(a.displayPath+'/');},
 async stat(t){return files.has(t.displayPath)?{type:'file',version:'1',size:Buffer.byteLength(files.get(t.displayPath))}:undefined;},
 async readText(t){if(!files.has(t.displayPath))throw new Error('ENOENT');return files.get(t.displayPath);},
 async readBytes(t,_s,cap){const bytes=Buffer.from(await this.readText(t));if(bytes.length>cap)throw new Error('over limit');return bytes;},
 async writeText(t,s){files.set(t.displayPath,s);return {version:'1'};},
 async listDir(t){return [...new Set([...files.keys()].filter(f=>f.startsWith(t.displayPath+'/')).map(f=>f.slice(t.displayPath.length+1).split('/')[0]))].map(name=>({name,type:files.has(t.displayPath+'/'+name)?'file':'directory'}));},
};
ctx.provide('fs',fs);ctx.provide('sandboxPolicy',{resolve:()=>({mode:'workspace-write',workspaceRoot:'/repo'})});
ctx.provide('systemPrompt',Object.fromEntries(['section','tools','variable','context','getSectionOrder','getContextOrder'].map(k=>[k,()=>()=>{}])));new ToolRuntime(ctx,'tools');task.apply(ctx,task.Config['~standard'].validate({}).value);
let seq=0;const agent={id:'probe',session:{id:'probe',header:{cwd:'/repo'}}};
const call=(name,args)=>ctx.tools.execute({callId:'probe-'+ ++seq,name,arguments:args,agent,signal:new AbortController().signal});
try {
 for(const [name,body] of [['reject',JSON.stringify({task:'TEST',verdict:{status:'reject',findings:[]}})],['invalid_json','{bad'],['approve_without_results',JSON.stringify({task:'TEST',verdict:{status:'approve',findings:[]}})]]){
  files.clear();await call('sdlc_task_create',{task_id:'TEST',title:'fixture'});
  const dir='/repo/.ai/tasks/TEST',s=load(files.get(dir+'/state.yaml'),{schema:JSON_SCHEMA});s.status='VERIFYING';s.artifacts={intent:'intent.md',spec:'spec.md',plan:'plan.md',verification:'verification.json',review:'review.json'};
  for(const [k,v]of Object.entries(s.artifacts))files.set(dir+'/'+v,k==='verification'?body:k==='review'?'{}':'fixture');files.set(dir+'/state.yaml',dump(s));
  for(const to of ['REVIEWING','DONE']){const r=await call('sdlc_task_advance',{task_id:'TEST',to,reason:'gate probe'});rows.push([`${name} cannot enter ${to}`,r.isError===true,JSON.stringify({accepted:!r.isError})]);}
 }
 const criteria=Array.from({length:8},(_,i)=>`完整验收标准 ${i+1}：原行为保持不变`),v={status:'approve',summary:'probe',findings:[],criteria_results:criteria.map((_,i)=>({criterion:`缩写 ${i+1}`,result:'met',evidence:'probe'}))};
 const checked=verdict.enforceCriteriaPolicy(v,criteria);rows.push(['abbreviated unmatched results cannot stay approve',checked.status!=='approve',checked.status]);
 const valid=verdict.enforceCriteriaPolicy({...v,criteria_results:criteria.map(c=>({criterion:c,result:'met',evidence:'probe'}))},criteria);rows.push(['complete legacy mapping remains readable',valid.status==='approve',valid.status]);
 files.clear();const base='/repo/.ai/tasks/TEST',rsi='/repo/.ai/rsi';
 files.set(base+'/state.yaml',dump({task:'TEST',title:'fixture',status:'VERIFYING',created:'2026-10-01T00:00:00Z',updated:'2026-10-01T00:00:00Z',artifacts:{},history:[]}));
 files.set(rsi+'/tasks/TEST/task.json',JSON.stringify({schema_version:1,task_id:'TEST',task_dir:'.ai/tasks/TEST',workspace:'/repo',runs:[],issues:[],sessions:[{id:'author',role:'author',windows:[{from:0,to:null}]}]}));
 files.set(rsi+'/tasks/TEST/sessions/author.json',JSON.stringify({session_id:'author',role:'author',source_verified:true,truncated:false,issues:[],padding:'x'.repeat(6*1024*1024),events:[{seq:0,time:1,type:'tool/call',data:{callId:'fix',name:'sdlc_fix_start',arguments:JSON.stringify({task_id:'TEST',reason:'recorded repair'})}},{seq:1,time:2,type:'tool/result',data:{message:{toolCallId:'fix',isError:false}}}]}));
 const large=await ui.readExecution(fs,{repoRoot:'/repo',taskId:'TEST'});rows.push(['6 MiB recorded author repair remains visible',large.repairs.length===1,JSON.stringify({repairs:large.repairs.length,issues:large.issues})]);
 files.delete(rsi+'/tasks/TEST/task.json');
 for(let i=0;i<6;i++)for(const [seq,kind,data] of [[0,'started',{inputs:{task_id:'TEST',criteria:['criterion']}}],[1,'prepared',{artifacts:{spec:base+'/spec.md'}}],[2,'finished',{outcome:'completed',result:{status:'reject',summary:'fixture',findings:[]}}]])files.set(`${rsi}/runs/run-${i}/${String(seq).padStart(6,'0')}.json`,JSON.stringify({schema_version:1,run_id:'run-'+i,seq,kind,at:'2026-10-01T00:00:00Z',data}));
 const history=await ui.readExecution(fs,{repoRoot:'/repo',taskId:'TEST'});rows.push(['unindexed owned verification history preserves six rounds',history.rounds.length===6,String(history.rounds.length)]);
 console.log('FLOW_PROBE '+JSON.stringify(rows));
}finally{await ctx.fiber.dispose();}
