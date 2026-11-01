#!/usr/bin/env node
/**
 * 基准用例 FALSE-ALARM-1：看板的「在等人」是不是**真的**在等人。
 *
 * 两侧对照：
 *   基线 d946c9d   所有 REVIEWING 都算 waiting
 *   修复 6ae7e09   只有"下一步该人动"的才算 waiting
 *
 * ## 这个 bug 的性质：**误伤**，不是漏检
 *
 * 基线版的毛病是**多报**：一个已经 `approve`、一行命令就能推进到 DONE 的任务，
 * 被标成「在等人」。真实仓库里实测到过（测试场 PLAY-2，当时的输出是
 * 「2 个任务，1 个在等人」）——那是**假的求助信号**，会让人以为有事要处理。
 *
 * 本项目反复记过："门禁的误伤和漏检一样是缺陷——误伤会让人绕开门禁走"。
 * 看板的假信号同理：报得多了，真的那一两个就没人看了。
 *
 * ## 判据分两组（守恒组是重点）
 *
 *   BUG 组（该变）：REVIEWING + approve → 不得是 waiting
 *   守恒组（不该变）：needs_human / reject / 无裁决 / DONE / IMPLEMENTING
 *                     —— 修复**不能**把"真该等人"的一起改掉
 */
import { pathToFileURL } from 'node:url';
import { compileFiles, loadModule, runCase } from './lib.mjs';

const SRC = ['scan.ts'];

/** now 之后的阈值基准。夹具的时间都相对它，所以不随日历漂。 */
const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const HOUR = 3600_000;
const at = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toISOString();

function judge(mod) {
  const out = [];
  const cls = (status, verdictStatus, hoursAgo) =>
    mod.classifyStaleness({
      status, verdictStatus, updated: at(hoursAgo), now: NOW, staleAfterHours: 24,
    }).class;

  // ── BUG 组：修复前是 waiting（假的求助信号），修复后不是 ──────────
  {
    const c = cls('REVIEWING', 'approve', 2);
    out.push(['REVIEWING + approve（2h）不是「在等人」', c !== 'waiting', `class=${c}`]);
  }
  {
    const c = cls('REVIEWING', 'approve', 48);
    out.push(['REVIEWING + approve（48h）不是「在等人」', c !== 'waiting', `class=${c}`]);
  }

  // ── 守恒组：真的该等人 / 该停滞 / 该关掉的，一位都不能动 ──────────
  const invariants = [
    ['REVIEWING + needs_human 仍是「在等人」', 'REVIEWING', 'needs_human', 2, 'waiting'],
    ['REVIEWING + reject 仍是「在等人」', 'REVIEWING', 'reject', 2, 'waiting'],
    ['REVIEWING + 无裁决 仍是「在等人」', 'REVIEWING', undefined, 2, 'waiting'],
    ['IMPLEMENTING + approve（48h）仍是停滞', 'IMPLEMENTING', 'approve', 48, 'stale'],
    ['DONE + approve（48h）仍是终态', 'DONE', 'approve', 48, 'closed'],
  ];
  for (const [name, status, verdict, hours, want] of invariants) {
    const c = cls(status, verdict, hours);
    out.push([name, c === want, `class=${c}（期望 ${want}）`]);
  }
  return out;
}

// ⚠️ `compileFiles` 返回的是**产物目录**，不是加载好的模块。
// 早期版本返回模块；改成返回目录之后这里必须自己 `loadModule`——
// 踩过：直接把目录当模块用，judge 里 `mod.classifyStaleness` 不是函数。
const compile = (rev, work) =>
  loadModule(compileFiles(rev, 'packages/sdlc-status/src', SRC, work));

export default async function main({ json } = {}) {
  return runCase({
    id: 'FALSE-ALARM-1',
    title: '看板把「已 approve 的 REVIEWING」误报成在等人',
    baselineRev: 'd946c9d',
    fixedRev: '6ae7e09',
    baselineLabel: '基线 d946c9d（所有 REVIEWING 都算 waiting）',
    fixedLabel: '修复 6ae7e09（按"下一步该谁动"分）',
    compile,
    judge,
    json,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await main({ json: process.argv.includes('--json') });
  process.exit(r.ok ? 0 : 1);
}
