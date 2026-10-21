import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {message,safeRelative} from './store.js';
const execFileAsync=promisify(execFile);
export const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export interface CodeSnapshot {complete:boolean; fingerprint:string|null; head:string|null; diff:string|null; untracked:{path:string;content_base64:string;sha256:string}[]; excluded:string[]; issues:string[]}
export interface WorkspaceSnapshot extends CodeSnapshot {
  repositories?: {path:string;snapshot:CodeSnapshot}[];
  workspace_files?: CodeSnapshot['untracked'];
}

/** Discover repositories inside the workspace, never walk through links or dependencies. */
export async function captureWorkspace(cwd:string,read:(path:string,maxBytes:number)=>Promise<Uint8Array>,recordRoot='.ai/rsi'):Promise<WorkspaceSnapshot> {
  const skip=new Set(['node_modules','.ai','.dsh','.git','.DS_Store']);
  const inventory=async()=>{
    const repositories:string[]=[],files:string[]=[],issues:string[]=[];
    let visited=0;
    const visit=async(relative:string,depth:number):Promise<void>=>{
      const entries=await readdir(path.join(cwd,relative),{withFileTypes:true});
      if(entries.some(e=>e.name==='.git')) {repositories.push(relative||'.');return;}
      for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
        const name=relative?`${relative}/${entry.name}`:entry.name;
        if(skip.has(entry.name)||name===recordRoot||name.startsWith(`${recordRoot}/`))continue;
        if(++visited>1000) {issues.push('工作区扫描超过 1000 项，范围不完整');return;}
        if(entry.isSymbolicLink()) {issues.push(`未展开符号链接: ${name}`);continue;}
        if(entry.isDirectory()) {
          if(depth>=4)issues.push(`目录超过扫描深度: ${name}`);
          else await visit(name,depth+1);
        } else if(entry.isFile())files.push(name);
      }
    };
    await visit('',0);return {repositories,files,issues};
  };
  try {
    const found=await inventory();
    if(found.repositories.length===1&&found.repositories[0]==='.')return captureCode(cwd,read,recordRoot);
    const result:WorkspaceSnapshot={complete:false,fingerprint:null,head:null,diff:null,untracked:[],
      excluded:[recordRoot,'.ai','.dsh','node_modules'],issues:[...found.issues],repositories:[],workspace_files:[]};
    if(!found.repositories.length)result.issues.push('工作区内没有可保存 Git 起点的仓库');
    if(found.repositories.length>32)result.issues.push('工作区仓库超过 32 个，快照不完整');
    for(const relative of found.repositories.slice(0,32)) {
      const snapshot=await captureCode(path.join(cwd,relative),(file,max)=>read(`${relative}/${file}`,max),recordRoot);
      result.repositories!.push({path:relative,snapshot});
      if(!snapshot.complete)result.issues.push(...snapshot.issues.map(issue=>`${relative}: ${issue}`));
    }
    let bytes=0;
    if(found.files.length>200)result.issues.push('仓库外工作区文件超过 200 个，快照不完整');
    for(const file of found.files.slice(0,200)) {
      const content=await read(file,1024*1024);bytes+=content.byteLength;
      if(content.byteLength>1024*1024||bytes>8*1024*1024) {result.issues.push('仓库外文件快照超过限制');break;}
      result.workspace_files!.push({path:file,content_base64:Buffer.from(content).toString('base64'),sha256:hash(content)});
    }
    if(JSON.stringify(found)!==JSON.stringify(await inventory()))result.issues.push('取快照期间工作区目录变化');
    for(const file of result.workspace_files!)if(hash(await read(file.path,1024*1024))!==file.sha256)result.issues.push(`取快照期间文件变化: ${file.path}`);
    // Recheck early repositories too: the second repository may have changed the first.
    for(const repository of result.repositories!) {
      const after=await captureCode(path.join(cwd,repository.path),(file,max)=>read(`${repository.path}/${file}`,max),recordRoot);
      if(!after.complete||after.fingerprint!==repository.snapshot.fingerprint)result.issues.push(`取快照期间仓库变化: ${repository.path}`);
    }
    result.complete=result.issues.length===0;
    if(result.complete)result.fingerprint=hash(JSON.stringify({repositories:result.repositories!.map(r=>({path:r.path,fingerprint:r.snapshot.fingerprint})),files:result.workspace_files!.map(({path,sha256})=>({path,sha256}))}));
    return result;
  } catch(error) {return {complete:false,fingerprint:null,head:null,diff:null,untracked:[],excluded:[recordRoot,'.ai'],issues:[message(error)]};}
}
export async function captureCode(cwd:string,read:(path:string,maxBytes:number)=>Promise<Uint8Array>,recordRoot='.ai/rsi'):Promise<CodeSnapshot> {
  const result:CodeSnapshot={complete:false,fingerprint:null,head:null,diff:null,untracked:[],excluded:[safeRelative(recordRoot),'.ai/tasks'],issues:[]};
  // Git is read-only and uses argv, never a shell. File contents still go through ctx.fs.
  const git=async(...args:string[])=>(await execFileAsync('git',['-C',cwd,...args],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:10000,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout;
  const paths=['.',...result.excluded.map(p=>`:(exclude)${p}/**`)];
  try {
    if((await git('rev-parse','--show-prefix')).trim()) throw new Error('当前目录不是 Git 仓库根，不能完整还原相对路径');
    const head=(await git('rev-parse','HEAD')).trim();
    const diff=await git('diff','--binary','--no-ext-diff','--no-textconv','HEAD','--',...paths);
    const names=(await git('ls-files','--others','--exclude-standard','-z','--',...paths)).split('\0').filter(Boolean).sort();
    if(names.length>200) throw new Error('未跟踪文件超过 200 个，快照不完整');
    let bytes=Buffer.byteLength(diff);
    for(const name of names) {
      safeRelative(name);
      const content=await read(name,1024*1024);
      bytes+=content.byteLength;
      if(content.byteLength>1024*1024||bytes>8*1024*1024) throw new Error('代码快照超过 8 MiB 或单文件超过 1 MiB');
      result.untracked.push({path:name,content_base64:Buffer.from(content).toString('base64'),sha256:hash(content)});
    }
    if(/^160000 /m.test(await git('ls-files','--stage','--',...paths))) throw new Error('仓库含 submodule，首版无法完整保存子仓库现场');
    if(head!==(await git('rev-parse','HEAD')).trim()||diff!==await git('diff','--binary','--no-ext-diff','--no-textconv','HEAD','--',...paths)
      ||names.join('\0')!==(await git('ls-files','--others','--exclude-standard','-z','--',...paths)).split('\0').filter(Boolean).sort().join('\0')) throw new Error('取快照期间代码发生变化');
    for(const file of result.untracked) if(hash(await read(file.path,1024*1024))!==file.sha256) throw new Error('取快照期间未跟踪文件发生变化');
    result.head=head;result.diff=diff;result.complete=true;
    result.fingerprint=hash(JSON.stringify({head,diff,untracked:result.untracked.map(({path,sha256})=>({path,sha256})),excluded:result.excluded}));
  } catch(error) {result.issues.push(message(error));}
  return result;
}
