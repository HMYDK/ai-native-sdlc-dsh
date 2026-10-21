import type {Context} from '@deepseek-ai/cordis';
import type {TaskState} from '../task/state.js';

export interface TaskRecord {
  kind:'created'|'advanced';
  task_dir:string;
  state:TaskState;
}
export interface TaskRecordExec {agent?:unknown;signal?:AbortSignal;callId?:string}
declare module '@deepseek-ai/cordis' {
  interface Events {
    'sdlc-task/record'(record:TaskRecord,exec:TaskRecordExec):Promise<void>|void;
  }
}

/** Recording errors are visible without pretending a successful state write failed. */
export async function recordTask(ctx:Context,record:TaskRecord,exec:TaskRecordExec):Promise<string[]> {
  try {await ctx.parallel('sdlc-task/record',structuredClone(record),exec);return [];}
  catch(error) {return (error instanceof AggregateError?[...error.errors]:[error]).map(e=>`RSI: ${e instanceof Error?e.message:String(e)}`);}
}
