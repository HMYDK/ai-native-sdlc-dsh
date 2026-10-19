import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {captureCode} from './snapshot.js';
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
