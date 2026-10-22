import test from 'node:test';
import assert from 'node:assert/strict';
import {proposalInput,seal,parsePacket,intentFor,type Proposal} from './improvement.js';
import {checkArtifact} from '../artifact/artifact.js';
const input={title:'修复跨 preset 记录',problem:'六次 trace 为空',hypothesis:'作用域导致漏事件',change:'按已登记 ID 收集并对账',alternatives:'查询服务不可用也会缺记录',acceptance:'旧版漏、新版全',comparison:'相同运行时夹具分别加载旧新 lib',focus:'capture',references:[{path:'tasks/T-1/evidence.json',observation:'配置和事件为空'}]};
test('提案不能省略证据、其他解释或可证伪方法',()=>{
  for(const key of ['hypothesis','alternatives','acceptance','comparison','references'])assert.throws(()=>proposalInput({...input,[key]:undefined}));
  assert.throws(()=>proposalInput({...input,references:[{path:'../secret',observation:'x'}]}));
});
test('转交只包含摘要和引用；内容变化导致指纹失配，意图经过正常结构检查',()=>{
  const p={schema_version:1,id:'proposal',at:'2026-10-21',source_task:'T-1',source_workspace:'/source',source_evidence_complete:false,
    baseline_suite:{version:'0.3.1'},...proposalInput(input),references:[{...input.references[0],sha256:'a'.repeat(64)}],attribution:'caller_analysis'} as Proposal;
  const packet=seal(p);assert.deepEqual(parsePacket(JSON.parse(JSON.stringify(packet))),packet);
  assert.throws(()=>parsePacket({...packet,proposal:{...p,change:'偷偷改动'}}),/指纹/);
  assert.equal(checkArtifact('intent',intentFor(p)).ok,true);
});
