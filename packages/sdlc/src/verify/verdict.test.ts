/**
 * 验证提示词内容的单测。
 *
 * ## 为什么内容也要测
 *
 * 这些断言不是"文字品味"，而是**从真实漏放案例里长出来的判据**：
 * FeatureBench 的 7 个 V1 `approve → unresolved` 案例里，验证者逐条 AC 都验了、
 * 也写了自编探针，但被验证的功能真实入口（构建/CLI/集成）在当前代码上直接
 * `NameError` / `AttributeError`，而验证者以"基线也失败 / 不在接口描述范围"
 * 为由仍然给出 `approve`。所以提示词必须显式写明：
 *
 * 1. 自编探针不能替代真实消费入口；
 * 2. 真实入口失败时不得 `approve`，基线也失败不是豁免；
 * 3. `unverified` 里与交付直接相关的项不能被 `approve` 掩盖。
 *
 * 这些句子一旦被"顺手改短"删掉，行为会静默退回旧状态——所以用单测钉住。
 * 断言用短而稳定的短语，不复制整段措辞，避免正常改写就误报。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerificationPrompt, VERIFIER_PERSONA } from './verdict.js';

test('提示词包含验证者身份纪律（回归）', () => {
  const prompt = buildVerificationPrompt({ intentOfChange: '测试变更' });
  assert.ok(prompt.includes(VERIFIER_PERSONA), '提示词必须包含完整的 VERIFIER_PERSONA');
});

test('要求运行变更的直接目标功能的真实消费入口，而不是只写探针', () => {
  const prompt = buildVerificationPrompt({ intentOfChange: '测试变更' });
  assert.match(prompt, /交付路径检查/, '缺少交付路径检查章节');
  assert.match(prompt, /真实消费入口/, '必须要求真实消费入口');
  assert.match(prompt, /不是作者新增的测试，也不是你自己写的探针/);
});

test('真实入口失败时不得 approve；基线同样失败不构成豁免', () => {
  const prompt = buildVerificationPrompt({ intentOfChange: '测试变更' });
  assert.match(prompt, /不得 `approve`/, '必须明确禁止 approve');
  assert.match(prompt, /改动前的基线也一样失败/, '必须点名"基线也失败"这种错误豁免');
  assert.match(prompt, /不是豁免理由/);
});

test('任务说明的 out of scope 不能当作外部验收的豁免', () => {
  const prompt = buildVerificationPrompt({ intentOfChange: '测试变更' });
  assert.match(prompt, /"out of scope" 只决定你要检查什么/, '必须区分验证范围与外部验收');
  assert.match(prompt, /不构成外部验收的证据/);
});

test('上游/重建的官方验收测试：失败不得 approve，但冲突时不能仅凭它 reject（防反向误判）', () => {
  const prompt = buildVerificationPrompt({ intentOfChange: '测试变更' });
  assert.match(prompt, /取得\/重建官方验收测试/, '必须覆盖上游/重建 oracle 的使用');
  assert.match(prompt, /这是评分风险，不是可忽略的探针/);
  assert.match(prompt, /不要仅凭重建测试就 `reject`/);
});

test('unverified 里与交付直接相关的项不能被 approve 掩盖', () => {
  const prompt = buildVerificationPrompt({ intentOfChange: '测试变更' });
  assert.match(prompt, /`unverified` 里与本次交付直接相关的项/, '缺少 unverified 与 approve 的关系');
  assert.match(prompt, /顶层裁决不得为 `approve`/);
});

test('与变更目标无关的既有失败不触发交付路径拦截（避免误拒扩大）', () => {
  const prompt = buildVerificationPrompt({ intentOfChange: '测试变更' });
  assert.match(prompt, /与变更目标无关的既有失败/, '必须给无关失败留出正常通道');
});

test('传入 criteria 时逐条列出且不影响验收覆盖（回归）', () => {
  const prompt = buildVerificationPrompt({
    intentOfChange: '测试变更',
    criteria: ['AC-001: 第一条要求', 'AC-002: 第二条要求'],
  });
  assert.match(prompt, /必须逐条裁决的验收标准/);
  assert.match(prompt, /AC-001: 第一条要求/);
  assert.match(prompt, /AC-002: 第二条要求/);
  assert.match(prompt, /cannot_tell/);
});

test('作者提供的测试证据仍标注为需要复核（回归）', () => {
  const prompt = buildVerificationPrompt({
    intentOfChange: '测试变更',
    testEvidence: 'pytest -q：10 passed',
  });
  assert.match(prompt, /作者提供的测试证据/);
  assert.match(prompt, /需要你自己复核/);
  assert.match(prompt, /pytest -q：10 passed/);
});

// ── #21：验收充分性反查（消费 Delivery Contract）────────────────────

test('消费 Delivery Contract 五子节，并保留旧任务的散文回退（不自动阻断）', () => {
  const prompt = buildVerificationPrompt({ intentOfChange: '测试变更' });
  assert.match(prompt, /验收充分性反查/);
  assert.match(prompt, /## Delivery Contract/);
  for (const section of ['Source', 'Outcome', 'Boundary', 'Oracle', 'AC mapping']) {
    assert.match(prompt, new RegExp(`### ${section}`), `缺少 ${section} 子节`);
  }
  assert.match(prompt, /旧任务没有 Delivery Contract 时，从 Intent\/Spec 散文推导/);
  assert.match(prompt, /提取 1–3 个关键 Outcome/);
  assert.match(prompt, /支撑它的 AC ID/);
  assert.match(prompt, /AC mapping` 只用于反查充分性/);
  assert.match(prompt, /唯一权威 AC 清单/);
  assert.match(prompt, /不能缩减必验 AC/);
});

test('旧任务回退不自动阻断 approve；只有实质影响时才 needs_human', () => {
  const prompt = buildVerificationPrompt({ intentOfChange: '测试变更' });
  assert.match(prompt, /如果推导清晰且不影响交付结论，在 `summary` 里一句话注明/);
  assert.match(prompt, /不要.*写进 `unverified`/);
  assert.match(prompt, /不要因此阻断 `approve`/);
  assert.match(prompt, /只有推导出的目标\/范围本身存在实质不确定性并影响结论时，才写进 `unverified` 并用 `needs_human`/);
  assert.doesNotMatch(prompt, /在 `unverified` 里写明「目标来自推导/);
  assert.match(prompt, /与本次交付直接相关的项.*不得为 `approve`/);
});

test('区分查找顺序与事实权威；hidden tests 不进入 Outcome', () => {
  const prompt = buildVerificationPrompt({ intentOfChange: '测试变更' });
  assert.match(prompt, /查找顺序/);
  assert.match(prompt, /事实权威/);
  assert.match(prompt, /用户原始需求\/Issue 原文 > Actor 撰写的 Delivery Contract > Actor 自述/);
  assert.match(prompt, /Source 只是引用，不是已验证事实/);
  assert.match(prompt, /不要采纳 Actor 的自洽改写/);
  assert.match(prompt, /Source 原文与 Outcome\/Boundary 冲突时指出矛盾/);
  assert.match(prompt, /hidden tests \/ 官方 Grader 不进入 Outcome 列表/);
});

test('具体反例门槛：AC 全 met 但 Outcome 仍失败；无反例不报，缺证据不默认 approve', () => {
  const prompt = buildVerificationPrompt({ intentOfChange: '测试变更' });
  assert.match(prompt, /最小具体反例/);
  assert.match(prompt, /全部 `met`、该 Outcome 仍失败/);
  assert.match(prompt, /必须落在已确认 Boundary 内/);
  assert.match(prompt, /必须能被实现出来/);
  assert.match(prompt, /说不出来就不要报缺口/);
  assert.match(prompt, /决定性交付证据缺失/);
  assert.match(prompt, /关键真实入口无法执行/);
  assert.match(prompt, /把原因写进 `unverified`/);
  assert.match(prompt, /影响本次交付结论.*needs_human/);
  assert.match(prompt, /不要默认 `approve`/);
  assert.match(prompt, /不要制造阻断/);
});

test('状态矩阵：reject / needs_human / 无关失败 / 范围外不扩需求', () => {
  const prompt = buildVerificationPrompt({ intentOfChange: '测试变更' });
  assert.match(prompt, /已证实真实消费入口\/已确认 Outcome 失败且属本次承诺 → `reject`/);
  assert.ok(prompt.includes('命令 + 关键输出 + Source 位置 + 影响'), 'reject evidence 必须包含命令 + 关键输出 + Source 位置 + 影响');
  assert.match(prompt, /已证实 AC 不足以证明 Outcome、但尚未证明实际交付失败/);
  assert.match(prompt, /关键证据无法确认/);
  assert.match(prompt, /顶层 `needs_human`/);
  assert.match(prompt, /不要用 `approve` \+ blocking finding 代替/);
  assert.match(prompt, /`enforceCriteriaPolicy\(\)` 会把它改成 `reject`/);
  assert.match(prompt, /Source\/Boundary 实质歧义/);
  assert.match(prompt, /只在歧义影响本次交付结论时阻断/);
  assert.match(prompt, /无关既有失败 → 留证，不自动拒绝/);
  assert.match(prompt, /已确认只涉及 Source\/Boundary 明确排除、且与已承诺消费路径无关的独立功能/);
  assert.match(prompt, /记录外部评分风险，不单独阻断 `approve`/);
  assert.match(prompt, /测试来源、失败范围或与真实消费路径的依赖关系不确定/);
});

test('范围外独立测试与已承诺真实入口失败使用同一套裁决', () => {
  const prompt = buildVerificationPrompt({ intentOfChange: '测试变更' });
  assert.match(prompt, /先判断失败是否落在本次承诺的真实消费路径\/必要依赖上/);
  assert.match(prompt, /是：\*\*不得 `approve`\*\*；可证实本次交付缺陷 → `reject`；依赖关系不确定 → `needs_human`/);
  assert.match(prompt, /已确认只涉及 Source\/Boundary 明确排除、且与已承诺消费路径无关的独立功能/);
  assert.match(prompt, /不单独阻断 `approve`/);
  assert.match(prompt, /不能用一句 "out of scope" 免除真实目标功能失败/);
  assert.match(prompt, /如果被声明排除的模块正是该功能真实消费路径的一部分且当前失败，按本条处理/);
  assert.match(prompt, /取得\/重建官方验收测试/);
});

test('幂等：不重复报同一问题，也不因提过自动放行；AC 缺口退回 SPEC', () => {
  const prompt = buildVerificationPrompt({ intentOfChange: '测试变更' });
  assert.match(prompt, /前轮已记录\/已处理的同一反例/);
  assert.match(prompt, /没有新证据不得重复创建 finding 或无意义返工/);
  assert.match(prompt, /不得因「此前提过」自动放行/);
  assert.match(prompt, /区分 issue 生命周期与 `issue_results`/);
  assert.match(prompt, /`issue_results.result` 只能填 `resolved` \/ `unresolved` \/ `cannot_tell`/);
  assert.match(prompt, /不要把 `clarified` \/ `deferred` 写进 `issue_results`/);
  assert.match(prompt, /`sdlc_task_issue` 退回 SPEC/);
  assert.match(prompt, /不要在 VERIFYING 里直接改标准/);
});

test('优先契约 Oracle，但必须是真实消费入口；只跑一条代表路径', () => {
  const prompt = buildVerificationPrompt({ intentOfChange: '测试变更' });
  assert.match(prompt, /优先用契约的 Oracle/);
  assert.match(prompt, /必须确认它是真实消费入口，不是作者自测/);
  assert.match(prompt, /只跑这一条，不跑全量 E2E/);
});

test('验收充分性反查排在交付路径检查之前', () => {
  const prompt = buildVerificationPrompt({ intentOfChange: '测试变更' });
  const sufficiency = prompt.indexOf('## 验收充分性反查');
  const delivery = prompt.indexOf('## 交付路径检查');
  assert.ok(sufficiency >= 0, '缺少验收充分性反查章节');
  assert.ok(delivery >= 0, '缺少交付路径检查章节');
  assert.ok(sufficiency < delivery, '验收充分性反查必须在交付路径检查之前');
});
