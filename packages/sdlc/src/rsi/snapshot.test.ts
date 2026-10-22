import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {captureCode,captureWorkspace} from './snapshot.js';
test('快照保留未提交修改和新文件，记录目录不会污染下一次比较',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rsi-snapshot-'));
  const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
  const read=(p:string)=>fs.readFile(path.join(root,p));
  try {
    git('init');await fs.writeFile(path.join(root,'code.txt'),'before\n');git('add','code.txt');
    git('-c','user.name=RSI Test','-c','user.email=test@example.invalid','commit','-m','fixture');
    const before=await captureCode(root,read);assert.equal(before.complete,true);
    await fs.writeFile(path.join(root,'code.txt'),'after\n');await fs.writeFile(path.join(root,'new.txt'),'new\n');
    const after=await captureCode(root,read);assert.notEqual(after.fingerprint,before.fingerprint);assert.match(after.diff??'',/after/);
    assert.equal(Buffer.from(after.untracked[0].content_base64,'base64').toString(),'new\n');
    await fs.mkdir(path.join(root,'.ai/rsi/runs'),{recursive:true});await fs.writeFile(path.join(root,'.ai/rsi/runs/log.json'),'record');
    assert.equal((await captureCode(root,read)).fingerprint,after.fingerprint);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test('拿不到 Git 起点或读取文件失败必须标记不完整',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rsi-no-git-'));
  try {const result=await captureCode(root,async()=>new Uint8Array());assert.equal(result.complete,false);assert.ok(result.issues.length);}
  finally {await fs.rm(root,{recursive:true,force:true});}
});
test('提交任务记录只改变历史位置，不改变代码身份',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rsi-record-commit-'));
  const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
  try {
    git('init');await fs.writeFile(path.join(root,'code.txt'),'code');git('add','code.txt');
    git('-c','user.name=RSI Test','-c','user.email=test@example.invalid','commit','-m','fixture');
    const before=await captureCode(root,p=>fs.readFile(path.join(root,p)));
    await fs.mkdir(path.join(root,'.ai/tasks/T-1'),{recursive:true});
    await fs.writeFile(path.join(root,'.ai/tasks/T-1/intent.md'),'task record');git('add','.ai/tasks/T-1/intent.md');
    git('-c','user.name=RSI Test','-c','user.email=test@example.invalid','commit','-m','record');
    const after=await captureCode(root,p=>fs.readFile(path.join(root,p)));
    assert.notEqual(after.head,before.head);assert.equal(after.complete,true);
    assert.equal(after.fingerprint,before.fingerprint);
  }finally {await fs.rm(root,{recursive:true,force:true});}
});
test('Git 根目录中的符号链接也不能被保存成普通文件并宣称完整',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rsi-link-'));
  const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
  try {
    git('init');await fs.writeFile(path.join(root,'code.txt'),'code');git('add','code.txt');
    git('-c','user.name=RSI Test','-c','user.email=test@example.invalid','commit','-m','fixture');
    await fs.symlink('code.txt',path.join(root,'link.txt'));
    const untracked=await captureWorkspace(root,p=>fs.readFile(path.join(root,p)));
    assert.equal(untracked.complete,false);assert.match(untracked.issues.join(' '),/符号链接/);
    git('add','link.txt');git('-c','user.name=RSI Test','-c','user.email=test@example.invalid','commit','-m','track link');
    assert.equal((await captureWorkspace(root,p=>fs.readFile(path.join(root,p)))).complete,false);
  }finally {await fs.rm(root,{recursive:true,force:true});}
});
test('多仓库工作区分别保存代码，仓库外配置变化也会使对照失效',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rsi-multi-'));
  const read=(p:string)=>fs.readFile(path.join(root,p));
  try {
    for(const name of ['frontend','backend']) {
      const dir=path.join(root,name);await fs.mkdir(dir);
      const git=(...args:string[])=>execFileSync('git',['-C',dir,...args],{stdio:'pipe'});
      git('init');await fs.writeFile(path.join(dir,'code.txt'),'before');git('add','code.txt');
      git('-c','user.name=RSI Test','-c','user.email=test@example.invalid','commit','-m','fixture');
    }
    await fs.writeFile(path.join(root,'AGENTS.md'),'original instructions');
    const first=await captureWorkspace(root,read);assert.equal(first.complete,true);assert.equal(first.repositories?.length,2);
    await fs.mkdir(path.join(root,'.ai/rsi'),{recursive:true});await fs.writeFile(path.join(root,'.ai/rsi/record.json'),'record');
    assert.equal((await captureWorkspace(root,read)).fingerprint,first.fingerprint);
    await fs.writeFile(path.join(root,'backend/code.txt'),'changed');
    const second=await captureWorkspace(root,read);assert.notEqual(second.fingerprint,first.fingerprint);
    assert.match(second.repositories?.find(r=>r.path==='backend')?.snapshot.diff??'',/changed/);
    await fs.writeFile(path.join(root,'AGENTS.md'),'different instructions');
    assert.notEqual((await captureWorkspace(root,read)).fingerprint,second.fingerprint);
    await fs.symlink('/tmp',path.join(root,'outside'));
    assert.equal((await captureWorkspace(root,read)).complete,false);
  }finally {await fs.rm(root,{recursive:true,force:true});}
});
