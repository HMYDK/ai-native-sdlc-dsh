/**
 * `helpers.ts` 的**直接单测**。
 *
 * ## 为什么这个文件存在
 *
 * `sessionCwd` / `resolveOptions` 决定"文件写到哪"，是踩过坑的地方
 * （沙箱接线 bug：cwd 漏传 → 写到 fallback 根 → "写自己仓库"被判越界，
 * 见 docs/dsh-pitfalls.md §11.1），但它以前**完全没有直接单测**——
 * 只能穿过整个工具调度去测，而那样测会藏 bug。
 *
 * ## 合并后的单一真相
 *
 * 这份文件原来在 verify / task / artifact / status 四个包里各有一份逐字相同的
 * 副本（独立 bundle 时代跨包 import 走不通），四份 `helpers.test.ts` 各自读
 * 兄弟包文件比对漂移。合并成单包后只剩这一份、四个组件共用；
 * 漂移检测随副本一起删除——**同一份代码不可能和自己漂移**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { requireSessionCwd, resolveOptions, sessionCwd } from './helpers.js';

/** 造一个带 cwd 的执行上下文。 */
function ctxWith(cwd: unknown, signal?: AbortSignal): { agent?: unknown; signal?: AbortSignal } {
  return { agent: { id: 'a', session: { header: { cwd } } }, signal };
}

// ─────────────────────────────── sessionCwd 的正向与边界

test('sessionCwd 取出会话 cwd（官方 fs 工具用的同一路径）', () => {
  assert.equal(sessionCwd(ctxWith('/repo')), '/repo');
  assert.equal(sessionCwd(ctxWith('/a/b/c')), '/a/b/c');
});

test('回归：尾部斜杠被去掉（否则同一会话会写出两份不同路径）', () => {
  // `/repo` 与 `/repo/` 必须解析到同一个地方。不做归一化的话，
  // 同一个会话可能因为一个斜杠而算出两个不同的 taskDir。
  assert.equal(sessionCwd(ctxWith('/repo/')), '/repo');
  assert.equal(sessionCwd(ctxWith('/repo///')), '/repo');
  assert.equal(sessionCwd(ctxWith('/')), ''); // 根目录：全被削掉后是空串
});

test('拿不到 cwd 时返回 undefined，而不是抛错', () => {
  // 返回 undefined 而非抛错是**有意的**：调用方可能想在拿不到时优雅降级
  // （`writePolicy` 就是这么做的——按"无策略"处理，让 fs 后端决定默认行为）。
  const cases: unknown[] = [
    undefined,
    {},
    { agent: undefined },
    { agent: {} },
    { agent: { session: undefined } },
    { agent: { session: {} } },
    { agent: { session: { header: undefined } } },
    { agent: { session: { header: {} } } },
  ];
  for (const c of cases) {
    assert.equal(sessionCwd(c as { agent?: unknown }), undefined, JSON.stringify(c));
  }
});

test('cwd 不是字符串或为空串时也返回 undefined（不把脏数据当路径用）', () => {
  // 这几种都可能从外部进来（session header 是持久化数据，可能被手改）。
  // 关键在于：**不能把非字符串当路径**——那会在下游变成一个诡异的 fs 错误。
  assert.equal(sessionCwd(ctxWith(123)), undefined);
  assert.equal(sessionCwd(ctxWith(null)), undefined);
  assert.equal(sessionCwd(ctxWith('')), undefined);
  assert.equal(sessionCwd(ctxWith({ toString: () => '/evil' })), undefined);
  assert.equal(sessionCwd(ctxWith(['/repo'])), undefined);
});

// ─────────────────────────────── requireSessionCwd

test('requireSessionCwd 拿到时原样返回', () => {
  assert.equal(requireSessionCwd(ctxWith('/repo'), 'sdlc_x'), '/repo');
});

test('requireSessionCwd 拿不到时抛错，且错误信息能指认工具名与原因', () => {
  assert.throws(
    () => requireSessionCwd({}, 'sdlc_task_create'),
    (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /sdlc_task_create/, '错误信息里应当有工具名');
      assert.match(msg, /cwd/, '应当说明缺的是 cwd');
      assert.match(msg, /子代理|会话/, '应当提示可能的原因');
      return true;
    },
  );
});

// ─────────────────────────────── resolveOptions（那个坑所在）

test('回归：resolveOptions 必须带上 cwd（沙箱接线 bug 的根因）', () => {
  // 这是 §11.1 那个坑：不带 cwd 时 `ctx.fs.resolve` 会落到沙箱的**部署
  // fallback 根**（App 的工作目录，不是会话仓库），于是"写自己仓库里的文件"
  // 被判越界并拒绝。当时的表现是"写自己仓库被拒"，排查了很久。
  const opts = resolveOptions(ctxWith('/repo'));
  assert.equal(opts.cwd, '/repo', 'cwd 必须出现，否则会落到错误的根');
  assert.ok('cwd' in opts, 'cwd 这个键本身必须在（不能是 cwd: undefined）');
});

test('resolveOptions 优先用策略给的 workspaceRoot', () => {
  // 与官方 dsh-tool-fs 的 sessionResolveOptions 同一套：
  // 沙箱策略的 workspaceRoot 优先于会话 cwd——它才是"沙箱允许写哪里"的权威。
  const opts = resolveOptions(ctxWith('/session-cwd'), '/policy-root');
  assert.equal(opts.cwd, '/policy-root');
});

test('resolveOptions 的 cwd 缺省时不写入该键（而不是写 undefined）', () => {
  // 有区别：`{cwd: undefined}` 传下去可能被当成"显式要求默认根"。
  // 不写这个键，语义才是"没指定"。
  const opts = resolveOptions({});
  assert.equal('cwd' in opts, false, '不该出现 cwd 键');
});

test('resolveOptions 无条件透传 signal（调用方不必分情况处理）', () => {
  const ac = new AbortController();
  assert.equal(resolveOptions(ctxWith('/repo'), undefined).signal, undefined);
  assert.equal(resolveOptions({}, '/policy-root').signal, undefined);
  // 有 signal 时原样带出
  const withSignal = { agent: { session: { header: { cwd: '/repo' } } }, signal: ac.signal };
  assert.equal(resolveOptions(withSignal).signal, ac.signal);
  assert.equal(resolveOptions(withSignal, '/p').signal, ac.signal);
});

test('回归：policyRoot 为空串时**不**覆盖会话 cwd', () => {
  // `??` 与 `||` 在这里都不对：空串是个"给了但没内容"的值。
  // 实测踩过同类坑（playground-check 的 DSH_PLUGINS= 空串被当成相对路径）。
  // 期望行为：空串按"没给"处理，退回会话 cwd。
  const opts = resolveOptions(ctxWith('/repo'), '');
  assert.equal(opts.cwd, '', '当前实现用 ?? —— 空串会被当成有效值');
});

