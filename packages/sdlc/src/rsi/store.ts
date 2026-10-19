import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-sandbox-policy';
import { object, summarizeRun, type RecordEvent } from './analysis.js';

export type Execution = {agent?:unknown; signal?:AbortSignal};
export function safeSegment(value:string):string {
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value)) throw new Error('非法路径标识');
  return value;
}
export function safeRelative(value:string):string {
  if(!value || value.startsWith('/') || /[\\:\x00-\x1f]/.test(value) || value.split('/').some(s=>!s||s==='.'||s==='..')) throw new Error('必须使用仓库内的相对路径');
  return value;
}
export function cwdOf(exec:Execution):string {
  const cwd=object(object(object(exec.agent).session).header).cwd;
  if(typeof cwd!=='string'||!cwd) throw new Error('RSI 需要带工作目录的会话');
  return cwd;
}
export class Store {
  constructor(readonly ctx:Context,readonly exec:Execution,readonly root:string) {safeRelative(root);cwdOf(exec);}
  private async target(relative:string) {
    safeRelative(relative);
    const options={cwd:cwdOf(this.exec),signal:this.exec.signal};
    const workspace=await this.ctx.fs.resolve('.',options);
    const base=await this.ctx.fs.resolve(this.root,options);
    const target=await this.ctx.fs.resolve(`${this.root}/${relative}`,options);
    if(!this.ctx.fs.contains(workspace,base)||!this.ctx.fs.contains(base,target)) throw new Error('RSI 路径经符号链接逃出了记录目录');
    return target;
  }
  async write(relative:string,value:unknown,replace=false):Promise<void> {
    const session=object(this.exec.agent).session;
    if(!session) throw new Error('写记录需要 session 沙箱策略');
    const policy=this.ctx.sandboxPolicy.resolve({session:session as never});
    await this.ctx.fs.writeText(await this.target(relative),JSON.stringify(value,null,2)+'\n',replace?undefined:{kind:'createIfAbsent'},this.exec.signal,policy);
  }
  async read(relative:string):Promise<unknown> {return JSON.parse(await this.ctx.fs.readText(await this.target(relative),this.exec.signal));}
  async list(relative:string):Promise<string[]> {
    const target=await this.target(relative);
    if(!await this.ctx.fs.stat(target,this.exec.signal)) return [];
    return (await this.ctx.fs.listDir(target,this.exec.signal)).map(e=>e.name).sort();
  }
  async run(id:string) {
    safeSegment(id);
    const records:RecordEvent[]=[]; const issues:string[]=[];
    for(const file of await this.list(`runs/${id}`)) {
      if(!/^\d{6}\.json$/.test(file)) continue;
      try {
        const data=object(await this.read(`runs/${id}/${file}`));
        if(typeof data.seq!=='number'||typeof data.kind!=='string'||typeof data.at!=='string'||!data.data||typeof data.data!=='object') throw new Error('事件形状不合法');
        records.push(data as unknown as RecordEvent);
      } catch(e) {issues.push(`${file}: ${message(e)}`);}
    }
    const summary=summarizeRun(id,records);summary.issues.push(...issues);
    if(issues.length) summary.complete=false;
    return {summary,records};
  }
}
export function message(error:unknown):string {return error instanceof Error?error.message:String(error);}
