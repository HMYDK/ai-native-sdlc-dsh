import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {message,safeRelative} from './store.js';
const execFileAsync=promisify(execFile);
export const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export interface CodeSnapshot {complete:boolean; fingerprint:string|null; head:string|null; diff:string|null; untracked:{path:string;content_base64:string;sha256:string}[]; excluded:string[]; issues:string[]}
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
