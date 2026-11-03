import type {Context} from '@deepseek-ai/cordis';
import {randomUUID} from 'node:crypto';
import {actorOf, taskFile, type TaskExec} from './io.js';
import {statusOrder, type TaskState, type TaskStatus} from './state.js';
import {registerAcceptance, requireAcceptance} from '../shared/acceptance.js';

export async function readTaskSpec(ctx: Context, exec: TaskExec, dir: string, state: TaskState): Promise<string> {
  if (!state.artifacts.spec) throw new Error('任务未登记 spec 制品');
  return ctx.fs.readText(await taskFile(ctx,exec,dir,state.artifacts.spec),exec.signal);
}
export async function requireTaskAcceptance(ctx: Context, exec: TaskExec, dir: string, state: TaskState) {
  return requireAcceptance(state.acceptance,state.artifacts.spec,await readTaskSpec(ctx,exec,dir,state));
}
/** Crossing the specification boundary, including skipped stages, registers the baseline atomically with state. */
export async function prepareStageAcceptance(ctx: Context, exec: TaskExec, dir: string, state: TaskState, to: TaskStatus): Promise<{state:TaskState; spec?:string}> {
  if (statusOrder(to) < statusOrder('PLANNED')) return {state};
  const spec = await readTaskSpec(ctx,exec,dir,state);
  if (statusOrder(state.status) <= statusOrder('SPEC')) {
    return {state:{...state,acceptance:registerAcceptance(state.artifacts.spec,spec,randomUUID(),new Date().toISOString(),actorOf(exec))},spec};
  }
  requireAcceptance(state.acceptance,state.artifacts.spec,spec);
  return {state,spec};
}
