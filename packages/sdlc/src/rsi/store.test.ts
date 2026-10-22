import test from 'node:test';
import assert from 'node:assert/strict';
import {safeRelative,safeSegment,cwdOf} from './store.js';
import {Store} from './store.js';
import type {Context} from '@deepseek-ai/cordis';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
test('运行 ID 不允许路径穿越与控制字符',()=>{
  for(const value of ['..','a/b','a\\b','../other','x\n','']) assert.throws(()=>safeSegment(value),/路径|标识/);
  assert.equal(safeSegment('run-123'),'run-123');
});
test('记录根必须相对仓库，不能借配置逃出工作区',()=>{
  for(const value of ['/tmp/out','../out','a/../../out','C:\\tmp','a\\..\\b','']) assert.throws(()=>safeRelative(value),/相对/);
  assert.equal(safeRelative('.ai/rsi'),'.ai/rsi');
});
test('没有 session cwd 时不能悄悄写宿主默认目录',()=>{
  assert.throws(()=>cwdOf({}),/工作目录/);
  assert.equal(cwdOf({agent:{session:{header:{cwd:'/repo'}}}}),'/repo');
});
test('真实文件上的逐事件写入不能覆盖旧记录，损坏的运行仍可查询',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rsi-store-'));
  const ctx={fs:{
    resolve:async(p:string,o:{cwd:string})=>({displayPath:path.resolve(o.cwd,p)}),
    contains:(a:{displayPath:string},b:{displayPath:string})=>b.displayPath===a.displayPath||b.displayPath.startsWith(a.displayPath+path.sep),
    readText:async(t:{displayPath:string})=>fs.readFile(t.displayPath,'utf8'),
    stat:async(t:{displayPath:string})=>{try{return await fs.stat(t.displayPath);}catch{return undefined;}},
    listDir:async(t:{displayPath:string})=>(await fs.readdir(t.displayPath,{withFileTypes:true})).map(e=>({name:e.name,type:e.isDirectory()?'directory':'file'})),
    writeText:async(t:{displayPath:string},v:string,intent:{kind:string},_s:unknown,policy:{workspaceRoot:string})=>{
      assert.equal(policy.workspaceRoot,root); await fs.mkdir(path.dirname(t.displayPath),{recursive:true});
      await fs.writeFile(t.displayPath,v,{flag:intent?.kind==='createIfAbsent'?'wx':'w'});
    }
  },sandboxPolicy:{resolve:()=>({workspaceRoot:root,mode:'workspace-write'})}} as unknown as Context;
  try {
    const store=new Store(ctx,{agent:{session:{header:{cwd:root}}}},'.ai/rsi');
    const record={schema_version:1,run_id:'run-1',seq:0,at:new Date().toISOString(),kind:'started',data:{}};
    await store.write('runs/run-1/000000.json',record);
    await assert.rejects(()=>store.write('runs/run-1/000000.json',{changed:true}));
    assert.deepEqual(await store.read('runs/run-1/000000.json'),record);
    await fs.writeFile(path.join(root,'.ai/rsi/runs/run-1/000001.json'),'{bad');
    const run=await store.run('run-1');
    assert.equal(run.summary.complete,false);assert.match(run.summary.issues.join(' '),/000001/);
    await store.write('runs/run-1/000002.json',{...record,seq:2,kind:'attempt_session',data:{session_id:'child'}});
    await store.write('runs/run-1/code.json',{complete:true,fingerprint:'fixture'});
    await store.write('runs/run-1/capture.json',{sessions:[{session_id:'child',configs:[{}],observed_events:1,source_verified:true}]});
    const partial=await store.run('run-1');
    assert.equal(partial.evidence.complete,true);assert.equal(partial.summary.replay_ready,false,'完整会话副本不能掩盖生命周期损坏');
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
