/**
 * 验收标准强制策略的单测。
 *
 * 为什么这段逻辑要单独测：它是**唯一一处插件会改写验证者结论**的地方，
 * 改错了会导致两种严重后果——要么"没有标准也放行"（回到老问题），
 * 要么把正当的 reject 也改坏。穿过整个工具调度去测它成本太高，
 * 所以它是纯函数并直接单测。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceCriteriaPolicy, type Verdict } from './verdict.js';

const approve = (over: Partial<Verdict> = {}): Verdict => ({
  status: 'approve',
  summary: '看起来没问题',
  findings: [],
  ...over,
});

const met = (criterion: string) => ({ criterion, result: 'met' as const, evidence: 'e' });

/** 省略 `criterion` 的形态：**新推荐写法**（按序号匹配）。 */
const metNoEcho = { result: 'met' as const, evidence: 'e' };
const notMetNoEcho = { result: 'not_met' as const, evidence: '实测不成立' };

// ── 判据对齐：两种写法都要收，防篡改保证一样 ────────────────────────
//
// 背景：以前 `criterion` 必填且要逐字回抄。实测（2026-10-15）逐字回抄把
// structured_output 的参数撑大，导致一次 5 条判据的验证**参数流整段为空**，
// 72 次工具调用的成果全部作废。所以改成"可省"，但**不能因此丢掉防篡改**。

test('省略 criterion（按序号匹配）且条数齐全时，不算漏报', () => {
  const v = approve({ criteria_results: [metNoEcho, metNoEcho] });
  const r = enforceCriteriaPolicy(v, ['a', 'b'], 's');
  assert.equal(r.status, 'approve', '按序号对齐成立就该放行');
  assert.equal(r.findings.length, 0, `不该报漏报，实际: ${JSON.stringify(r.findings)}`);
});

test('省略 criterion 但条数不足时，逐条点名缺的是哪些', () => {
  const v = approve({ criteria_results: [metNoEcho] });
  const r = enforceCriteriaPolicy(v, ['第一条', '第二条', '第三条'], 's');
  const miss = r.findings.find((f) => f.category === 'missing_evidence');
  assert.ok(miss, '必须报漏报');
  assert.match(miss.reason, /漏报了 2 条/);
  // ⚠️ 必须点名"第二条"和"第三条"，不能只说"漏了 2 条"——
  //    否则调用方不知道哪条没被检查过。
  assert.match(miss.evidence, /第二条/);
  assert.match(miss.evidence, /第三条/);
});

test('中间漏一条也要查出来（不能只看条数）', () => {
  // 三条标准，报了两条——条数不符好发现；但这条测的是**按序号对齐后
  // 中间那格被跳过**的情形：报了第 1 条和第 3 条，第 2 条没报。
  const v = approve({
    criteria_results: [
      { criterion: '第一条', result: 'met', evidence: 'e' },
      { criterion: '第三条', result: 'met', evidence: 'e' },
    ],
  });
  const r = enforceCriteriaPolicy(v, ['第一条', '第二条', '第三条'], 's');
  const miss = r.findings.find((f) => f.category === 'missing_evidence');
  assert.ok(miss, '中间漏一条必须被报出来');
  assert.match(miss.reason, /漏报了 1 条/);
  assert.match(miss.evidence, /第二条/);
});

test('改写标准文本不能让它匹配上（防篡改仍在）', () => {
  // 验证者把"必须支持 offset"软化成"看起来还行"——不能算报过。
  const v = approve({
    criteria_results: [
      { criterion: '看起来还行', result: 'met', evidence: 'e' },
      { criterion: 'b', result: 'met', evidence: 'e' },
    ],
  });
  const r = enforceCriteriaPolicy(v, ['a', 'b'], 's');
  const miss = r.findings.find((f) => f.category === 'missing_evidence');
  assert.ok(miss, '改写标准文本必须被判为漏报');
  assert.match(miss.evidence, /a/);
});

test('两条标准报成同一条 → 另一条算漏报', () => {
  const v = approve({
    criteria_results: [
      { criterion: 'a', result: 'met', evidence: 'e' },
      { criterion: 'a', result: 'met', evidence: 'e' },
    ],
  });
  const r = enforceCriteriaPolicy(v, ['a', 'b'], 's');
  const miss = r.findings.find((f) => f.category === 'missing_evidence');
  assert.ok(miss, '重复报同一条必须让另一条算漏报');
  assert.match(miss.evidence, /b/);
});

test('按序号对齐时，not_met 仍然触发降级（对齐方式不影响强制策略）', () => {
  const v = approve({ criteria_results: [metNoEcho, notMetNoEcho] });
  const r = enforceCriteriaPolicy(v, ['a', 'b'], 's');
  assert.equal(r.status, 'needs_human');
  assert.match(r.summary, /已降级为 needs_human/);
});

test('没给 criteria 时，approve 被降级为 needs_human', () => {
  const r = enforceCriteriaPolicy(approve(), [], 'sess-1');
  assert.equal(r.status, 'needs_human');
  assert.equal(r.verifier_session, 'sess-1');
  const blocking = r.findings.filter((f) => f.severity === 'blocking');
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0]?.category, 'missing_evidence');
  assert.match(blocking[0]?.reason ?? '', /验收标准/);
  // 必须保留验证者的原话——降级不该隐藏它
  assert.match(blocking[0]?.evidence ?? '', /看起来没问题/);
  assert.match(r.summary, /已降级为 needs_human/);
});

test('给齐 criteria 且全部 met 时放行（不改动）', () => {
  const v = approve({ criteria_results: [met('a'), met('b')] });
  const r = enforceCriteriaPolicy(v, ['a', 'b'], 's');
  assert.equal(r.status, 'approve');
  assert.equal(r.findings.length, 0);
  assert.ok(!/已降级/.test(r.summary), '不该出现降级说明');
});

test('漏报标准 → 补一条 important finding，但不改状态', () => {
  const v = approve({ criteria_results: [met('a')] });
  const r = enforceCriteriaPolicy(v, ['a', 'b', 'c'], 's');
  assert.equal(r.status, 'approve', '漏报不该直接降级（验证者说 approve 且有 met 证据）');
  const imp = r.findings.filter((f) => f.severity === 'important');
  assert.equal(imp.length, 1);
  assert.match(imp[0]?.reason ?? '', /漏报了 2 条/);
  assert.match(imp[0]?.evidence ?? '', /b/);
  assert.match(imp[0]?.evidence ?? '', /c/);
});

test('有 cannot_tell 且 approve → 降级', () => {
  const v = approve({
    criteria_results: [met('a'), { criterion: 'b', result: 'cannot_tell', evidence: '范围外' }],
  });
  const r = enforceCriteriaPolicy(v, ['a', 'b'], 's');
  assert.equal(r.status, 'needs_human');
  assert.match(r.summary, /cannot_tell/);
});

test('有 not_met 且 approve → 降级', () => {
  const v = approve({
    criteria_results: [{ criterion: 'a', result: 'not_met', evidence: '实测不成立' }],
  });
  const r = enforceCriteriaPolicy(v, ['a'], 's');
  assert.equal(r.status, 'needs_human');
  assert.match(r.summary, /not_met/);
});

test('reject 不被改动（降级只针对 approve）', () => {
  const v: Verdict = {
    status: 'reject',
    summary: '有阻断问题',
    findings: [{ severity: 'blocking', category: 'logic_error', reason: 'r', evidence: 'e' }],
  };
  const r = enforceCriteriaPolicy(v, [], 's');
  assert.equal(r.status, 'reject');
  assert.equal(r.findings.length, 1, '不该额外加 finding');
});

test('needs_human 不被改动，也不重复加 finding', () => {
  const v: Verdict = { status: 'needs_human', summary: '拿不准', findings: [] };
  const r = enforceCriteriaPolicy(v, [], 's');
  assert.equal(r.status, 'needs_human');
  assert.equal(r.findings.length, 0);
});

test('criteria_results 缺失时按"一条都没报"处理（不是当成没有 criteria）', () => {
  // 这条区分很重要：没给 criteria 与 给了但验证者没报，是两件事，
  // 提示信息与处置都不同。
  const r = enforceCriteriaPolicy(approve(), ['a', 'b'], 's');
  assert.equal(r.status, 'approve', '只漏报不该降级');
  assert.match(r.findings[0]?.reason ?? '', /漏报了 2 条/);
});

test('标准文本比对做 trim（验证者抄标准时多空格不该算漏报）', () => {
  const v = approve({ criteria_results: [met('  a  ')] });
  const r = enforceCriteriaPolicy(v, ['a'], 's');
  assert.equal(r.findings.length, 0, 'trim 后匹配就不该报漏报');
});

test('原有 findings 被保留，不会被覆盖', () => {
  const v = approve({
    findings: [
      { severity: 'minor', category: 'other', reason: '原有一条', evidence: 'e' },
    ],
    criteria_results: [{ criterion: 'a', result: 'not_met', evidence: 'x' }],
  });
  const r = enforceCriteriaPolicy(v, ['a'], 's');
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0]?.reason ?? '', /原有一条/);
});
