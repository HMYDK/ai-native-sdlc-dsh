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
