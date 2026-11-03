import type {Context} from '@deepseek-ai/cordis';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {randomUUID} from 'node:crypto';
import {actOnIssue, type IssueInput} from './flow.js';
import {actorOf, mutateTask} from './io.js';
import {normalizeTaskId, checkAdvance} from './state.js';
import {requireSessionCwd, resolveOptions} from '../shared/helpers.js';
import {recordTask} from '../shared/task-recording.js';
import {readTaskSpec} from './acceptance.js';

export function registerIssueTool(ctx: Context, tasksDir: string): void {
  ctx.tools.register(defineTool({
    name: 'sdlc_task_issue',
    description: 'Record review findings and handle verification findings. start records the issue AND stage return in one write; submit means awaiting independent re-verification, never resolved. defer requires a reason and cannot defer blocking issues. Use cancel_verification only to abandon an interrupted run; a late result cannot then complete the task.',
    parameters: {
      task_id: {type:'string',required:true},
      action: {type:'string',required:true,enum:['report','start','submit','defer','cancel_verification']},
      issue_id: {type:'string',description:'Existing ID from state.workflow.issues or sdlc_task_status. Omit only for report/cancel_verification.'},
      reason: {type:'string',required:true,description:'What is wrong, why this destination, or what changed; never just say done.'},
      evidence: {type:'string',description:'File/test/probe references; required for submit. Author evidence remains unconfirmed until independent review.'},
      to: {type:'string',description:'For start: SPEC, PLANNED, IMPLEMENTING; current stage only for evidence/documentation work.'},
      severity: {type:'string',enum:['blocking','important','minor'],description:'Required for report; blocking issues must be independently resolved.'},
    },
    output: {schema:{type:'json'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v,null,2)}]},
    async execute(args,exec) {
      const id = normalizeTaskId(args.task_id), dir = `${requireSessionCwd(exec,'sdlc_task_issue')}/${tasksDir}/${id}`;
      const next = await mutateTask(ctx,exec,dir,id,async state => {
        const next = actOnIssue(state,args as IssueInput,actorOf(exec),exec.callId ?? randomUUID(),new Date().toISOString());
        if (next.status !== state.status) {
          const present = new Map<string,boolean>();
          for (const rel of Object.values(state.artifacts)) present.set(rel, (await ctx.fs.stat(await ctx.fs.resolve(`${dir}/${rel}`,resolveOptions(exec)),exec.signal))?.type === 'file');
          const spec = ['INTENT','SPEC'].includes(next.status) ? undefined : await readTaskSpec(ctx,exec,dir,next);
          const check = checkAdvance(state.status,next.status,next,p => present.get(p) === true,args.reason,spec);
          if (!check.ok) throw new Error(check.problems.join('; '));
        }
        return {state:next,value:next};
      });
      const errors = await recordTask(ctx,{kind:'advanced',task_dir:`${tasksDir}/${id}`,state:next},exec);
      return JSON.parse(JSON.stringify({task:id,status:next.status,issues:next.workflow!.issues,recording_errors:errors}));
    },
  }));
}
