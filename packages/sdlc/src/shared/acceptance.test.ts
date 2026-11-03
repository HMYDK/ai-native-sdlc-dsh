import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseSpecAcceptance, registerAcceptance, requireAcceptance, checkSubmittedCriteria, acceptanceCoverage, summarizeAcceptance, verificationAcceptance, criterionText, additionalCriteria} from './acceptance.js';
import {checkAdvance, parseTaskState, serializeTaskState, type TaskState} from '../task/state.js';
import {criterionEntries, enforceCriteriaPolicy} from '../verify/verdict.js';
import {load, JSON_SCHEMA} from 'js-yaml';

const spec = '# Spec\n\n## Acceptance Criteria\n- AC-001: 优惠金额正确\n- AC-002: 并发不重复消费\n- AC-003: 失败不生成错误订单\n\n## Design\n事务处理。\n';
const registration = () => registerAcceptance('spec.md',spec,'spec-v1','2026-11-02T00:00:00Z','fixture');
const results = () => registration().criteria.map(c=>({criterion_id:c.id,result:'met',evidence:'probe: PASS'}));
const document = () => ({schema_version:3,acceptance:registration(),criteria:registration().criteria.map(criterionText),additional_criteria:[],verdict:{status:'approve',findings:[],criteria_results:results()}});

test('Spec parses explicit IDs, Chinese heading and CRLF; narrative outside the section stays outside',()=>{
  assert.equal(parseSpecAcceptance(spec).length,3);
  assert.deepEqual(parseSpecAcceptance(spec.replace('Acceptance Criteria','验收标准').replaceAll('\n','\r\n')),registration().criteria);
  assert.equal(parseSpecAcceptance(spec)[1].id,'AC-002');
});
test('missing, empty, duplicate and ambiguous AC sections fail instead of silently dropping requirements',()=>{
  for (const bad of ['', '## Acceptance Criteria\n', spec+spec, spec.replace('AC-002','AC-001'), spec.replace('- AC-002:', '- AC-002'), spec.replace('并发不重复消费','<待填>'), spec.replace('- AC-003:', '  continuation '), '```md\n'+spec+'\n```', '<!--\n'+spec+'\n-->']) assert.throws(()=>parseSpecAcceptance(bad));
  assert.throws(()=>parseSpecAcceptance(spec.replace('## Design','### Nested')),/格式不合法/);
  assert.throws(()=>parseSpecAcceptance(spec.replace('- AC-002:', '```\n- AC-002:')),/代码块/);
});
test('the registered whole-Spec hash protects descriptions and narrative before the first verification',()=>{
  assert.deepEqual(requireAcceptance(registration(),'spec.md',spec),registration());
  for (const changed of [spec.replace('并发不重复消费','允许重复消费'),spec.replace('事务处理。','说明文字调整。')]) assert.throws(()=>requireAcceptance(registration(),'spec.md',changed),/Spec 与已登记版本不同/);
  assert.throws(()=>requireAcceptance(registration(),'other.md',spec));
  assert.throws(()=>requireAcceptance({...registration(),criteria:registration().criteria.slice(0,1)},'spec.md',spec),/不一致/);
});
test('caller subsets, same-size replacements and duplicates cannot choose task verification scope',()=>{
  const c=registration().criteria;
  assert.doesNotThrow(()=>checkSubmittedCriteria(c));
  assert.doesNotThrow(()=>checkSubmittedCriteria(c,c.map(criterionText).reverse()));
  assert.doesNotThrow(()=>checkSubmittedCriteria(c,c.map(x=>x.text)));
  assert.throws(()=>checkSubmittedCriteria(c,[criterionText(c[0])]),/AC-002, AC-003/);
  assert.throws(()=>checkSubmittedCriteria(c,[...c.slice(0,2).map(criterionText),'AC-003: easier']),/改写/);
  assert.throws(()=>checkSubmittedCriteria(c,[...c.map(criterionText),criterionText(c[0])]),/重复/);
});
test('all target stages at and after PLANNED require the contract, including jumps and backwards moves',()=>{
  const state:TaskState={task:'T-1',title:'fixture',status:'INTENT',created:'x',updated:'x',history:[],artifacts:{intent:'intent.md',spec:'spec.md',plan:'plan.md',verification:'verification.json',review:'review.json'}};
  for (const to of ['PLANNED','IMPLEMENTING','VERIFYING','REVIEWING','DONE'] as const) {
    assert.equal(checkAdvance('INTENT',to,state,()=>true,'jump',spec).ok,false);
    assert.equal(checkAdvance('INTENT',to,{...state,acceptance:registration()},()=>true,'jump',spec).ok,true);
    assert.equal(checkAdvance('INTENT',to,{...state,acceptance:registration()},()=>true,'jump',spec+'edited').ok,false);
  }
  assert.equal(checkAdvance('VERIFYING','PLANNED',state,()=>true,'return',spec).ok,false);
  assert.equal(checkAdvance('VERIFYING','SPEC',state,()=>true,'repair missing baseline').ok,true);
});
test('state round-trip preserves registration and does not invent one for historical tasks',()=>{
  const s={task:'T-1',title:'fixture',status:'SPEC' as const,created:'x',updated:'x',history:[],artifacts:{spec:'spec.md'},acceptance:registration()};
  assert.deepEqual(parseTaskState('T-1',load(serializeTaskState(s),{schema:JSON_SCHEMA})).acceptance,s.acceptance);
  assert.equal(parseTaskState('T-1',{...s,acceptance:undefined}).acceptance,undefined);
  assert.throws(()=>parseTaskState('T-1',{...s,acceptance:{}}));
});
test('new explicit IDs preserve their meaning; historical strings retain hash IDs',()=>{
  const entries=registration().criteria;
  assert.deepEqual(criterionEntries(entries),entries);
  const old=criterionEntries(['AC-001: 优惠金额正确']);
  assert.match(old[0].id,/^AC-[a-f0-9]{16}$/);
  assert.notEqual(old[0].id,'AC-001');
  assert.throws(()=>verificationAcceptance({...document(),schema_version:2}),/历史裁决/);
});
test('same ID with changed semantics or a new registration cannot reuse a previous verdict',()=>{
  assert.throws(()=>verificationAcceptance(document(),registerAcceptance('spec.md',spec.replace('并发不重复消费','允许重复消费'),'v2','2026-11-02T00:00:01Z','fixture')),/版本已失效/);
  assert.throws(()=>verificationAcceptance(document(),{...registration(),id:'v2'}),/版本已失效/);
});
test('missing, duplicate, unknown, no-evidence and contradictory results never approve',()=>{
  const entries=registration().criteria;
  for (const invalid of [results().slice(0,1),[...results(),results()[0]],results().map((r,i)=>i===2?{...r,criterion_id:'AC-999'}:r),results().map((r,i)=>i===2?{...r,evidence:''}:r),results().map((r,i)=>i===2?{...r,result:'not_met' as const}:r),results().map((r,i)=>i===2?{...r,result:'cannot_tell' as const}:r)]) {
    assert.notEqual(enforceCriteriaPolicy({status:'approve',summary:'fixture',findings:[],criteria_results:invalid as never},entries,'fixture','ids').status,'approve');
  }
  assert.equal(acceptanceCoverage(entries,[...results().reverse()]).met,3);
});
test('the board reports expected three, answered one, and the two missing IDs even for a corrupted subset verdict',()=>{
  const doc=document();doc.criteria=doc.criteria.slice(0,1);doc.verdict.criteria_results=doc.verdict.criteria_results.slice(0,1);
  const s=summarizeAcceptance(registration(),'spec.md',spec,doc);
  assert.equal(s.status,'incomplete');assert.equal(s.expected,3);assert.equal(s.answered,1);
  assert.deepEqual(s.missing,['AC-002','AC-003']);
  assert.equal(summarizeAcceptance(registration(),'spec.md',spec,document()).status,'verified');
  assert.equal(summarizeAcceptance(registration(),'spec.md',spec+'edited',document()).status,'changed');
  assert.equal(summarizeAcceptance(undefined,'spec.md',spec,{schema_version:2,verdict:{status:'approve'}}).status,'unregistered');
});
test('additional checks cannot replace mandatory ACs or inflate the mandatory coverage count',()=>{
  const doc={...document(),additional_criteria:['extra probe']};
  const extra=additionalCriteria(doc.additional_criteria);
  doc.criteria=[...registration().criteria,...extra].map(criterionText);
  doc.verdict.criteria_results.push({criterion_id:extra[0].id,result:'met',evidence:'extra: PASS'});
  assert.equal(summarizeAcceptance(registration(),'spec.md',spec,doc).status,'verified');
  assert.equal(summarizeAcceptance(registration(),'spec.md',spec,doc).met,3);
  doc.verdict.criteria_results=doc.verdict.criteria_results.slice(1);
  assert.equal(summarizeAcceptance(registration(),'spec.md',spec,doc).status,'incomplete');
});
