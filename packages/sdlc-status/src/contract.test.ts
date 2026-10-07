/**
 * 与 sdlc-task 的**文件契约**测试。
 *
 * ## 为什么需要这个文件
 *
 * dsh 插件是独立 bundle，`dsh plugin add` 走 pnpm 从 registry 安装，
 * 所以跨包 import 走不通（实测：装了 `@ai-native-sdlc/dsh-sdlc-task` 的
 * dependencies 后安装直接失败）。于是本包复制了一份状态机常量。
 *
 * **静默复制会让漂移没人知道**——本项目已经吃过一次"两份真相漂移"的亏
 * （sdlc-verify 的裁决 schema 与工具输出 schema 各写一遍，漂移后整条通路失效）。
 *
 * 所以这里的做法是：**复制 + 显式契约 + 漂移可被发现**。
 * 这个测试直接读 `packages/sdlc-task/src/state.ts` 的**源码文本**，
 * 抽出权威的常量表，与本包的实际行为逐项对照。改了那边没改这边，测试就红。
 *
 * 它不 import 那边的代码——只读文本。这样既不引入包依赖，又能发现漂移。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanTasks, type ScanInput } from './scan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 从 lib/ 回到源码树；仓库布局是 packages/sdlc-{status,task}。 */
const AUTHORITY = path.resolve(HERE, '../../sdlc-task/src/state.ts');

/** 权威源码必须能被找到——找不到就说明路径变了，测试要红而不是静默跳过。 */
function readAuthority(): string {
  if (!fs.existsSync(AUTHORITY)) {
    assert.fail(
      `找不到权威状态机定义：${AUTHORITY}\n` +
        '本测试用于检测两份状态机常量的漂移；路径失效时必须失败，不能静默跳过。',
    );
  }
  return fs.readFileSync(AUTHORITY, 'utf8');
}

/** 从 `export const STATUSES = [...] as const;` 抽出状态顺序。 */
function authorityStatuses(src: string): string[] {
  // 匹配 STATUSES 的数组字面量（跨行）
  const m = /export const STATUSES = \[([\s\S]*?)\] as const;/.exec(src);
  assert.ok(m, '在 sdlc-task/src/state.ts 里找不到 STATUSES 定义');
  return [...(m[1] ?? '').matchAll(/'([A-Z]+)'/g)].map((x) => x[1] ?? '');
}

/** 从 `export const REQUIRED_ARTIFACTS: Record<TaskStatus, readonly string[]> = {...}` 抽出门槛表。 */
function authorityRequired(src: string): Record<string, string[]> {
  const m = /export const REQUIRED_ARTIFACTS[^=]*= \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(m, '在 sdlc-task/src/state.ts 里找不到 REQUIRED_ARTIFACTS 定义');
  const out: Record<string, string[]> = {};
  for (const line of (m[1] ?? '').split('\n')) {
    const kv = /^\s*([A-Z]+):\s*\[([^\]]*)\]/.exec(line);
    if (kv?.[1] === undefined) continue;
    out[kv[1]] = [...(kv[2] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1] ?? '');
  }
  return out;
}

/** 从 `export const KNOWN_ARTIFACTS: Record<string, string> = {...}` 抽出文件名映射。 */
function authorityKnown(src: string): Record<string, string> {
  const m = /export const KNOWN_ARTIFACTS[^=]*= \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(m, '在 sdlc-task/src/state.ts 里找不到 KNOWN_ARTIFACTS 定义');
  const out: Record<string, string> = {};
  for (const line of (m[1] ?? '').split('\n')) {
    const kv = /^\s*([a-z_]+):\s*'([^']+)'/.exec(line);
    if (kv?.[1] !== undefined && kv[2] !== undefined) out[kv[1]] = kv[2];
  }
  return out;
}

test('契约前置：能读到权威状态机定义', () => {
  const src = readAuthority();
  assert.ok(src.includes('export const STATUSES'), '权威源码里应有 STATUSES');
  assert.ok(src.includes('export const REQUIRED_ARTIFACTS'), '权威源码里应有 REQUIRED_ARTIFACTS');
  assert.ok(src.includes('export const KNOWN_ARTIFACTS'), '权威源码里应有 KNOWN_ARTIFACTS');
});

test('漂移检测：状态序列与 sdlc-task 完全一致', () => {
  const authority = authorityStatuses(readAuthority());
  assert.deepEqual(
    authority,
    ['INTENT', 'SPEC', 'PLANNED', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'DONE'],
    'sdlc-task 的状态序列变了——本包的副本需要同步',
  );
});

test('漂移检测：每个状态的门槛与 sdlc-task 完全一致', () => {
  const authority = authorityRequired(readAuthority());
  assert.ok(Object.keys(authority).length >= 7, `权威门槛表应覆盖 7 个状态，实际 ${Object.keys(authority).length}`);

  // 用行为对照：对每个状态造一个"只登记了该状态门槛所需制品"的任务，
  // 扫描结果必须是 ok；再删掉一个制品，必须变成 incomplete。
  // 这样校验的是**本包的实际判定行为**，而不只是常量文本。
  for (const [status, required] of Object.entries(authority)) {
    if (required.length === 0) continue;

    const files: Record<string, string> = {
      'state.yaml': [
        `task: T-${status}`,
        'title: "t"',
        `status: ${status}`,
        'created: "2026-01-01T00:00:00Z"',
        'updated: "2026-01-01T00:00:00Z"',
        'artifacts:',
        ...required.map((k) => `  ${k}: "${k}.md"`),
        'history: []',
        '',
      ].join('\n'),
    };
    for (const k of required) files[`${k}.md`] = 'x';

    const mk = (f: Record<string, string>): ScanInput => ({
      dirs: [{ task: `T-${status}`, files: Object.keys(f) }],
      readFile: (_t, rel) => f[rel],
    });

    const okResult = scanTasks(mk(files));
    assert.equal(
      okResult.tasks[0]?.health,
      'ok',
      `状态 ${status}：按 sdlc-task 的门槛登记 ${required.join('/')} 之后，看板应判为 ok。` +
        `实际 ${okResult.tasks[0]?.health}，缺 ${JSON.stringify(okResult.tasks[0]?.missingForStatus)}` +
        '——说明本包的门槛表与 sdlc-task 漂移了',
    );

    // 去掉最后一个制品 → 必须 incomplete（证明门槛不是"永远通过"）
    const last = required[required.length - 1];
    if (last !== undefined && required.length > 1) {
      const trimmed = { ...files };
      delete trimmed[`${last}.md`];
      trimmed['state.yaml'] = (trimmed['state.yaml'] ?? '').replace(`  ${last}: "${last}.md"\n`, '');
      const bad = scanTasks(mk(trimmed));
      assert.equal(
        bad.tasks[0]?.health,
        'incomplete',
        `状态 ${status}：去掉 ${last} 之后应判为 incomplete，实际 ${bad.tasks[0]?.health}`,
      );
    }
  }
});

test('漂移检测：制品文件名映射与 sdlc-task 完全一致', () => {
  const authority = authorityKnown(readAuthority());
  assert.ok(Object.keys(authority).length >= 5, '权威文件名映射应至少 5 项');

  // 行为对照：缺哪个制品时，看板的"缺"提示里应出现权威定义的文件名。
  for (const [kind, filename] of Object.entries(authority)) {
    if (kind === 'intent') continue; // intent 是 INTENT 状态的唯一门槛，缺了状态本身就不成立
    const files: Record<string, string> = {
      'state.yaml': [
        'task: T1',
        'title: "t"',
        'status: DONE',
        'created: "2026-01-01T00:00:00Z"',
        'updated: "2026-01-01T00:00:00Z"',
        'artifacts:',
        '  intent: "intent.md"',
        'history: []',
        '',
      ].join('\n'),
      'intent.md': 'x',
    };
    const r = scanTasks({
      dirs: [{ task: 'T1', files: Object.keys(files) }],
      readFile: (_t, rel) => files[rel],
    });
    const missing = (r.tasks[0]?.missingForStatus ?? []).join(',');
    assert.ok(
      missing.includes(filename),
      `缺 ${kind} 时提示里应出现权威文件名 ${filename}（来自 sdlc-task），实际：${missing}`,
    );
  }
});
