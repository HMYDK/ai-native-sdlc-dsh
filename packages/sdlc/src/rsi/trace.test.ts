import test from 'node:test';
import assert from 'node:assert/strict';
import {Trace,readSession} from './trace.js';
import type {Context} from '@deepseek-ai/cordis';
const events=[{seq:0,type:'request/header',data:{header:{config:{model:'A'}}}},
  {seq:1,type:'tool/call',data:{name:'bash',arguments:'{}'}},{seq:2,type:'tool/result',data:{message:{content:[]}}}];
test('实时漏事件由原始日志补齐，重复补录不重复统计',()=>{
  const trace=new Trace('child','parent');trace.observe(events[2]);trace.reconcile(events);trace.reconcile(events);
  assert.equal(trace.summary().observed_events,3);assert.equal(trace.tool_results,1);
  assert.equal(trace.source_verified,true);assert.deepEqual(trace.snapshot().events,events);
});
test('序号缺口、同序号内容变化、截断不能伪装为完整',()=>{
  const gap=new Trace('child','parent');gap.reconcile([events[0],events[2]]);assert.equal(gap.source_verified,false);
  const changed=new Trace('child','parent');changed.observe(events[0]);changed.reconcile([{...events[0],data:{header:{config:{model:'B'}}}}]);assert.equal(changed.source_verified,false);
  const huge=new Trace('child','parent');huge.reconcile([{seq:0,type:'tool/result',data:{text:'x'.repeat(600000)}}]);
  assert.equal(huge.truncated,true);assert.equal(huge.tool_results,1);
});
test('会话查询必须核对工作区和父级，并在拒绝时释放观察',async()=>{
  let disposed=0;
  const ctx={get:()=>({observeSession:async()=>({header:{cwd:'/workspace',parentSession:'parent'},events,[Symbol.dispose]:()=>{disposed++;}})})} as unknown as Context;
  assert.equal((await readSession(ctx,'child','/workspace','parent')).events.length,3);
  await assert.rejects(()=>readSession(ctx,'child','/other','parent'),/工作区/);
  await assert.rejects(()=>readSession(ctx,'child','/workspace','wrong'),/父级/);
  assert.equal(disposed,3);
});
