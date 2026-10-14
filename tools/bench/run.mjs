#!/usr/bin/env node
/**
 * 基准的**统一入口**：跑全部用例。
 *
 *     node tools/bench/run.mjs            # 全部用例
 *     node tools/bench/run.mjs --json     # 机器可读
 *     node tools/bench/run.mjs --list     # 只列用例
 *
 * 退出码：0 = **每个**用例都成立（基线被证伪、修复版满足判据）；1 = 有不成立的。
 *
 * ## 什么算"成立"
 *
 * 每个用例都是**两侧对照**（见 `lib.mjs`）：
 *
 *     基线版（有缺陷）  必须违反至少一条判据
 *     修复版            必须一条都不违反
 *
 * 少了任何一侧，这个用例就是恒真断言——本项目实测发生过一次
 * （STATUS-PAGE 第三轮：新加的冒烟夹具只有 10 个任务，而 ≤50 时两种实现
 * 返回完全一样，**那条断言在被修好的代码和被 reject 的代码上都是绿的**）。
 *
 * ## ⚠️ 读结果时的一个陷阱
 *
 * 用例钉在**历史提交**上，所以它的失败报告会包含**那个时代的真实缺陷**。
 * 实测踩到：验证者跑冻结的 60825a2，报 `冒烟 59/60 · 停滞计数应为 1，实际 4`，
 * 我把它当成当前待办——其实那条早在 c4712d8 就修了，当前代码是 69/69。
 * **报告里出现的失败，先问一句"这是历史快照的问题，还是当前的？"**
 */
import { main as caseStatusPage } from './case-status-page.mjs';
import caseFalseAlarm from './case-false-alarm.mjs';
import { main as casePwsh } from './case-pwsh-toolfilter.mjs';

/** 新增用例加到这里。 */
const CASES = [
  { id: 'STATUS-PAGE-1', run: caseStatusPage },
  { id: 'FALSE-ALARM-1', run: caseFalseAlarm },
  { id: 'PWSH-1', run: casePwsh },
];

const json = process.argv.includes('--json');

if (process.argv.includes('--list')) {
  for (const c of CASES) console.log(c.id);
  process.exit(0);
}

console.log(`基准：${CASES.length} 个用例\n${'='.repeat(60)}`);
const results = [];
for (const c of CASES) {
  try {
    results.push(await c.run({ json }));
  } catch (e) {
    results.push({ id: c.id, ok: false, error: e.message });
    console.log(`\n### ${c.id} — ❌ 运行失败：${e.message}`);
  }
}

if (json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log(`\n${'='.repeat(60)}`);
  console.log('汇总：');
  for (const r of results) {
    const mark = r.error ? '✗ 运行失败' : r.ok ? '✅ 成立' : '❌ 不成立';
    const detail = r.error
      ? r.error.slice(0, 60)
      : `基线违反 ${r.baseFails} 条 / 修复版违反 ${r.fixedFails} 条`;
    console.log(`  ${mark}  ${r.id.padEnd(18)}  ${detail}`);
  }
}

const bad = results.filter((r) => !r.ok).length;
if (!json) {
  console.log(bad === 0
    ? '\n✅ 全部用例成立：每个都在基线版上被证伪、在修复版上满足。'
    : `\n❌ ${bad} 个用例不成立。`);
  console.log('⚠️ 用例钉在历史提交上，失败报告可能说的是**那个时代**的缺陷——先分辨再动手。');
}
process.exit(bad === 0 ? 0 : 1);
