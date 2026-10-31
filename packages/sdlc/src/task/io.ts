import type {Context} from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-fs';
import {JSON_SCHEMA, load} from 'js-yaml';
import {parseTaskState, serializeTaskState, type TaskState} from './state.js';
import {resolveOptions, writePolicy} from '../shared/helpers.js';
export interface TaskExec {agent?: unknown; signal?: AbortSignal; callId?: string}
const locks = new Map<string, Promise<void>>();

/** Shared between preset fibers. Guarded filesystem writes also detect other processes. */
export async function mutateTask<T>(ctx: Context, exec: TaskExec, dir: string, id: string,
  change: (state: TaskState) => Promise<{state: TaskState; value: T}> | {state: TaskState; value: T}): Promise<T> {
  const target = await ctx.fs.resolve(`${dir}/state.yaml`, resolveOptions(exec));
  const key = String(target.targetKey), previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>(resolve => {release = resolve;});
  const tail = previous.then(() => held); locks.set(key, tail); await previous;
  try {
    const info = await ctx.fs.stat(target, exec.signal);
    if (!info || info.type !== 'file') throw new Error(`任务 ${id} 没有 state.yaml`);
    const before = await ctx.fs.readText(target, exec.signal);
    const state = parseTaskState(id, load(before, {schema: JSON_SCHEMA}));
    const result = await change(state);
    if (result.state !== state) {
      if (await ctx.fs.readText(target, exec.signal) !== before) throw new Error('任务记录被并发修改，请重新读取后重试');
      const policy = await writePolicy(ctx, exec);
      await ctx.fs.writeText(target, serializeTaskState(result.state), {kind: 'replaceIfVersion', version: info.version}, exec.signal, policy);
    }
    return result.value;
  } finally {release(); if (locks.get(key) === tail) locks.delete(key);}
}
export async function readTask(ctx: Context, exec: TaskExec, dir: string, id: string): Promise<TaskState> {
  const target = await ctx.fs.resolve(`${dir}/state.yaml`, resolveOptions(exec));
  return parseTaskState(id, load(await ctx.fs.readText(target, exec.signal), {schema: JSON_SCHEMA}));
}
export function actorOf(exec: TaskExec): string {
  const agent = exec.agent as {id?: string; session?: {id?: string}} | undefined;
  return agent?.session?.id ?? agent?.id ?? 'unknown-session';
}
export async function taskFile(ctx: Context, exec: TaskExec, dir: string, file: string) {
  if (!file || file.startsWith('/') || file.split(/[\\/]/).some(s => s === '..' || !s)) throw new Error('任务文件必须位于任务目录内');
  const base = await ctx.fs.resolve(dir, resolveOptions(exec));
  const target = await ctx.fs.resolve(`${dir}/${file}`, resolveOptions(exec));
  if (!ctx.fs.contains(base, target)) throw new Error('任务文件越出任务目录');
  return target;
}
