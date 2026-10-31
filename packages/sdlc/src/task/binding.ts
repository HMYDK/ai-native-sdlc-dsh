/** Content identities, not commit IDs: committing unchanged files must not invalidate a verdict. */
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-fs';
import type {TaskExec} from './io.js';
import {resolveOptions, requireSessionCwd} from '../shared/helpers.js';
const execFileAsync = promisify(execFile);
const hash = (x: string | Uint8Array) => createHash('sha256').update(x).digest('hex');
export interface VerificationBinding {
  version: 1; roots: string[]; fingerprint: string; code_fingerprint: string; files: number;
  artifacts: Record<string, {path: string; sha256: string}>;
}
const ignored = (name: string) => name.split('/').some(s => ['.ai','.dsh','node_modules','.git'].includes(s));
async function discover(cwd: string): Promise<string[]> {
  const roots: string[] = []; let visited = 0;
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (++visited > 2000) throw new Error('工作区目录过多，请用 code_roots 指定本任务仓库');
    const entries = await readdir(path.join(cwd, relative), {withFileTypes: true});
    if (entries.some(e => e.name === '.git')) {roots.push(relative || '.'); return;}
    for (const e of entries) {
      const name = relative ? `${relative}/${e.name}` : e.name;
      if (ignored(name) || !e.isDirectory() || e.isSymbolicLink()) continue;
      if (depth >= 4) throw new Error('工作区超出搜索深度，请用 code_roots 指定本任务仓库');
      await visit(name, depth + 1);
    }
  };
  await visit('', 0); return roots.sort();
}
export async function captureBinding(ctx: Context, exec: TaskExec, artifacts: Record<string,string>, requested?: string[]): Promise<VerificationBinding> {
  const cwd = requireSessionCwd(exec, '验证版本记录');
  const roots = [...new Set(requested?.length ? requested : await discover(cwd))].sort();
  if (!roots.length || roots.length > 32) throw new Error('没有可核对的 Git 仓库或仓库超过 32 个，请指定 code_roots');
  const workspace = await ctx.fs.resolve('.', resolveOptions(exec));
  let total = 0, count = 0;
  const digest = createHash('sha256');
  const read = async (name: string): Promise<Uint8Array> => {
    const target = await ctx.fs.resolve(name, resolveOptions(exec));
    if (!ctx.fs.contains(workspace, target)) throw new Error('验证范围经链接越出工作区');
    const info = await ctx.fs.stat(target, exec.signal);
    if (!info || info.type !== 'file' || (info.size ?? 0) > 8*1024*1024) throw new Error(`文件无法核对或超过 8 MiB：${name}`);
    const bytes = await ctx.fs.readBytes(target, exec.signal, 8*1024*1024);
    total += bytes.byteLength;
    if (total > 128*1024*1024) throw new Error('验证代码超过 128 MiB，请缩小任务仓库范围');
    if ((await ctx.fs.stat(target, exec.signal))?.version !== info.version) throw new Error('取版本期间文件变化，请重试');
    return bytes;
  };
  for (const root of roots) {
    if (path.isAbsolute(root) || root.split(/[\\/]/).some(p => p === '..') || ignored(root)) throw new Error('code_roots 必须是工作区内仓库的相对路径');
    const git = async (...args: string[]) => (await execFileAsync('git', ['-C',path.join(cwd, root),...args],
      {encoding:'utf8',maxBuffer:8*1024*1024,timeout:10000,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout;
    if ((await git('rev-parse','--show-prefix')).trim()) throw new Error(`code_roots 不是仓库根：${root}`);
    const inventory = async () => {
      const tracked = (await git('ls-files','--stage','-z')).split('\0').filter(Boolean);
      const files = new Map<string,string>();
      for (const row of tracked) {
        const tab = row.indexOf('\t'), name = row.slice(tab+1), mode = row.slice(0,6);
        if (ignored(name)) continue;
        if (mode === '120000' || mode === '160000' || !row.slice(0,tab).endsWith(' 0')) throw new Error('验证范围含链接、子模块或冲突，无法确认完整版本');
        files.set(name, mode);
      }
      for (const name of (await git('ls-files','--others','--exclude-standard','-z')).split('\0').filter(Boolean)) if (!ignored(name)) files.set(name,'100644');
      // Deleted tracked paths are part of the content identity too.
      for (const name of (await git('ls-files','--deleted','-z')).split('\0').filter(Boolean)) files.delete(name);
      return [...files].sort(([a],[b]) => a.localeCompare(b));
    };
    const files = await inventory(); count += files.length;
    if (count > 20000) throw new Error('验证文件超过 20000 个，请拆分任务范围');
    for (let i=0;i<files.length;i+=8) {
      const batch = await Promise.all(files.slice(i,i+8).map(async ([name,mode]) => [name,mode,hash(await read(path.posix.join(root,name)))]));
      for (const row of batch) digest.update(JSON.stringify([root,...row])+'\n');
    }
    if (JSON.stringify(files) !== JSON.stringify(await inventory())) throw new Error('取版本期间文件清单变化，请重试');
  }
  const code_fingerprint = digest.copy().digest('hex');
  const bound: VerificationBinding['artifacts'] = {};
  for (const key of ['intent','spec','plan']) {
    const file = artifacts[key]; if (!file) throw new Error(`验证缺少 ${key} 制品`);
    const relative = path.relative(cwd, path.resolve(cwd, file)).split(path.sep).join('/');
    bound[key] = {path: relative, sha256: hash(await read(relative))};
  }
  digest.update(JSON.stringify(bound));
  return {version:1,roots,fingerprint:digest.digest('hex'),code_fingerprint,files:count,artifacts:bound};
}
