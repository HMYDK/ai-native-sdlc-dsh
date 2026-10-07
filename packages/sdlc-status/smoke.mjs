/**
 * sdlc-status 的运行时冒烟测试。
 *
 * ## 这个脚本与其它三个不同：它用**真实文件系统**
 *
 * 前三个插件的冒烟都用内存 `ctx.fs` 桩。那次经历留下了教训：
 * **桩忽略参数 = 测试对这类问题失明**（沙箱接线 bug 就是这样漏过去的）。
 *
 * 所以这里用真实的 `ctx.fs`（宿主提供的那个），在**临时目录**里造出真实的任务树。
 * 好处是它同时验证了：真实 fs 的 `listDir`/`stat`/`readText` 行为、
 * 真实沙箱策略下的路径解析、以及插件在真实目录布局下的判定。
 *
 * 不写用户仓库——全部在 `mkdtemp` 出来的临时目录里，结束时删除。
 *
 * 用法：
 *   BASE="/Applications/DeepSeek Harness.app/Contents"
 *   ELECTRON_RUN_AS_NODE=1 "$BASE/MacOS/DeepSeek Harness" --expose-internals \
 *     packages/sdlc-status/smoke.mjs
 */

import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_MODULES =
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules';
const require = createRequire(path.join(APP_MODULES, 'noop.js'));

const { Context } = require('@deepseek-ai/cordis');
const { ToolRuntime } = require('@deepseek-ai/dsh-tools');

let failures = 0;
let passCount = 0;
const ok = (m) => {
  passCount++;
  console.log(`  \u2713 ${m}`);
};
const bad = (m) => {
  failures++;
  console.log(`  \u2717 ${m}`);
};

console.log('== 1. 加载插件 ==');
const plugin = await import(pathToFileURL(path.join(PLUGIN_DIR, 'lib/index.js')).href);
ok(`name=${plugin.name}  inject=[${plugin.inject.join(', ')}]`);
if (typeof plugin.Config?.['~standard']?.validate === 'function') ok('Config 是 Standard Schema 校验器');
else bad("Config 不是 Standard Schema");
const validated = plugin.Config['~standard'].validate({});
if (validated.issues) bad(`配置校验失败: ${JSON.stringify(validated.issues)}`);
else ok(`默认配置: ${JSON.stringify(validated.value)}`);

console.log('\n== 2. 造一个真实的任务树（临时目录）==');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-status-smoke-'));
const tasksRoot = path.join(root, '.ai/tasks');
const mk = (p) => {
  fs.mkdirSync(path.join(tasksRoot, p), { recursive: true });
};
// 说明：本脚本会造出**两个** error 任务——
//   PROJ-5   state.yaml 内容坏掉
//   NO-STATE 目录里根本没有 state.yaml
// 两者都该被报成 error，且 error 组内按字母序排列。
const write = (p, content) => {
  const full = path.join(tasksRoot, p);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
};

const stateYaml = (task, status, artifacts, updated) =>
  [
    `task: ${task}`,
    `title: "${task} 的标题"`,
    `status: ${status}`,
    'created: "2026-10-07T10:00:00.000Z"',
    `updated: "${updated ?? '2026-10-07T10:00:00.000Z'}"`,
    'artifacts:',
    ...Object.entries(artifacts).map(([k, v]) => `  ${k}: "${v}"`),
    'history: []',
    '',
  ].join('\n');

// A：齐备且验证通过
mk('PROJ-1');
write('PROJ-1/state.yaml', stateYaml('PROJ-1', 'VERIFYING', { intent: 'intent.md', spec: 'spec.md', plan: 'plan.md' }));
write('PROJ-1/intent.md', '# Intent\n');
write('PROJ-1/spec.md', '# Spec\n');
write('PROJ-1/plan.md', '# Plan\n');
write(
  'PROJ-1/verification.json',
  JSON.stringify({
    task: 'PROJ-1',
    at: '2026-10-07T12:00:00.000Z',
    criteria: ['c1', 'c2'],
    verdict: {
      status: 'approve',
      summary: 'ok',
      findings: [],
      criteria_results: [
        { criterion: 'c1', result: 'met', evidence: 'e' },
        { criterion: 'c2', result: 'met', evidence: 'e' },
      ],
    },
  }),
);

// B：裁决 needs_human，且有 cannot_tell
mk('PROJ-2');
write('PROJ-2/state.yaml', stateYaml('PROJ-2', 'VERIFYING', { intent: 'intent.md', spec: 'spec.md', plan: 'plan.md' }));
write('PROJ-2/intent.md', 'x');
write('PROJ-2/spec.md', 'x');
write('PROJ-2/plan.md', 'x');
write(
  'PROJ-2/verification.json',
  JSON.stringify({
    task: 'PROJ-2',
    at: '2026-10-07T13:00:00.000Z',
    criteria: ['c1', 'c2'],
    verdict: {
      status: 'needs_human',
      summary: 's',
      findings: [],
      criteria_results: [
        { criterion: 'c1', result: 'met', evidence: 'e' },
        { criterion: 'c2', result: 'cannot_tell', evidence: 'e' },
      ],
    },
  }),
);

// C：制品不全（PLANNED 但缺 spec/plan）
mk('PROJ-3');
write('PROJ-3/state.yaml', stateYaml('PROJ-3', 'PLANNED', { intent: 'intent.md' }));
write('PROJ-3/intent.md', 'x');

// D：登记了制品但文件不在
mk('PROJ-4');
write('PROJ-4/state.yaml', stateYaml('PROJ-4', 'SPEC', { intent: 'intent.md', spec: 'spec.md' }));
write('PROJ-4/intent.md', 'x');
// spec.md 故意不写

// E：state.yaml 坏掉
mk('PROJ-5');
write('PROJ-5/state.yaml', '这不是 YAML: [ 未闭合\n');

// F：空目录（应被跳过）
mk('NOT-A-TASK');

// G：目录里没有 state.yaml
mk('NO-STATE');
write('NO-STATE/readme.txt', 'x');

// H：**真停滞**——IMPLEMENTING 但 3 天没动（用固定旧时间，确保稳定可判）
mk('PROJ-6');
write(
  'PROJ-6/state.yaml',
  stateYaml('PROJ-6', 'IMPLEMENTING', { intent: 'i.md', spec: 's.md', plan: 'p.md' }, '2020-01-01T00:00:00.000Z'),
);
write('PROJ-6/i.md', 'x');
write('PROJ-6/s.md', 'x');
write('PROJ-6/p.md', 'x');

// I：刚动过——不该被判成停滞
mk('PROJ-7');
write(
  'PROJ-7/state.yaml',
  stateYaml('PROJ-7', 'IMPLEMENTING', { intent: 'i.md', spec: 's.md', plan: 'p.md' }, new Date().toISOString()),
);
write('PROJ-7/i.md', 'x');
write('PROJ-7/s.md', 'x');
write('PROJ-7/p.md', 'x');

ok(`临时任务树已建好：${tasksRoot}`);

console.log('\n== 3. 挂载到真实上下文（真实 ctx.fs）==');
const ctx = new Context();
ctx.provide('systemPrompt', {
  section: () => () => {},
  tools: () => () => {},
  variable: () => () => {},
  context: () => () => {},
  getSectionOrder: () => 0,
  getContextOrder: () => 0,
});

// 用宿主**真实的** fs 实现，而不是内存桩。
// 包名是 dsh-fs-local，导出 LocalFileSystem（dsh-fs 里的 FileSystem 是抽象类）。
// LocalFileSystem.Config 是 schemastery，所以用它校验出默认配置。
const { LocalFileSystem } = require('@deepseek-ai/dsh-fs-local');
const fsConfig = LocalFileSystem.Config['~standard'].validate({});
if (fsConfig.issues) {
  bad(`fs-local 配置校验失败: ${JSON.stringify(fsConfig.issues)}`);
  process.exit(1);
}
// 注意：LocalFileSystem 继承 Service，**构造时自己就注册了 `fs` 服务**，
// 所以不能再 ctx.provide('fs', ...)——那会抛 "service fs has been registered"。
new LocalFileSystem(ctx, fsConfig.value);
if (ctx.fs === undefined) bad('LocalFileSystem 构造后 ctx.fs 仍不可用');
else ok('真实 LocalFileSystem 已挂载（不是内存桩）');
ctx.provide('sandboxPolicy', {
  resolve: ({ session }) =>
    session === undefined
      ? undefined
      : { mode: 'danger-full-access', workspaceRoot: root },
});

new ToolRuntime(ctx, 'tools');
if (ctx.tools === undefined) bad('ToolRuntime 未挂到 ctx.tools');
else ok('真实 ToolRuntime 已挂载');

try {
  plugin.apply(ctx, validated.value);
  ok('apply() 正常返回');
} catch (e) {
  bad(`apply() 抛错: ${e.message}`);
  process.exit(1);
}

console.log('\n== 4. 工具注册 ==');
if (ctx.tools.get('sdlc_status') === undefined) bad('sdlc_status 未注册');
else ok('sdlc_status 已注册');

const agent = { id: 'smoke', session: { header: { cwd: root } } };
const call = (args) =>
  ctx.tools.execute({
    callId: `smoke-${Math.random().toString(36).slice(2)}`,
    name: 'sdlc_status',
    arguments: args,
    agent,
    signal: new AbortController().signal,
  });

console.log('\n== 5. 真实扫描 ==');
const r = await call({});
if (r.isError) {
  bad(`调用失败: ${JSON.stringify(r.error)}`);
} else {
  const v = r.value;
  ok(`概览：${v.summary}`);
  if (v.total === 8) ok(`识别出 8 个任务（空目录被跳过）`);
  else bad(`任务数应为 8，实际 ${v.total}（目录：${fs.readdirSync(tasksRoot).join(',')}）`);

  const joined = (v.tasks ?? []).join('\n');
  const expect = [
    ['PROJ-1', /PROJ-1[\s\S]*?裁决: approve[\s\S]*?met 2/],
    ['PROJ-2', /PROJ-2[\s\S]*?裁决: needs_human[\s\S]*?cannot_tell 1/],
    ['PROJ-3 制品不全', /PROJ-3[\s\S]*?缺: .*spec/],
    ['PROJ-4 文件不在', /PROJ-4[\s\S]*?文件不在: spec\.md/],
    ['PROJ-5 读不出来', /PROJ-5[\s\S]*?读不出来/],
    ['NO-STATE', /NO-STATE[\s\S]*?没有 state\.yaml/],
  ];
  for (const [label, re] of expect) {
    if (re.test(joined)) ok(`报出了 ${label}`);
    else bad(`漏报 ${label}\n    实际输出：\n${joined.split('\n').map((l) => '      ' + l).join('\n')}`);
  }

  if (!/NOT-A-TASK/.test(joined)) ok('空目录 NOT-A-TASK 未被当成任务');
  else bad('空目录被误报成任务');

  // 坏任务必须显眼且不拖垮其它任务。
  // 注意这里有两个坏任务：PROJ-5（state.yaml 坏掉）与 NO-STATE（目录里没有
  // state.yaml）——两者都是 error，且它们按**字母序**在 error 组内排列。
  const lines = v.tasks ?? [];
  if (lines[0]?.includes('NO-STATE') && lines[1]?.includes('PROJ-5')) {
    ok('两个坏任务都排在最前（error 组内按字母序）');
  } else {
    bad(`坏任务未排在前面，前两行：${lines[0]} / ${lines[1]}`);
  }
  if (v.error === 2) ok('错误计数为 2（PROJ-5 与 NO-STATE）');
  else bad(`错误计数应为 2，实际 ${v.error}`);

  // ── 时间维度 ───────────────────────────────────────────────
  if (v.stale === 1) ok('停滞计数为 1（只有 PROJ-6 是 IMPLEMENTING 且三天没动）');
  else bad(`停滞计数应为 1，实际 ${v.stale}`);

  const staleLine = lines.find((l) => l.includes('PROJ-6')) ?? '';
  if (/停滞/.test(staleLine)) ok(`PROJ-6 被标为停滞：${staleLine.trim().slice(0, 70)}…`);
  else bad(`PROJ-6 未被标为停滞：${staleLine}`);

  const freshLine = lines.find((l) => l.includes('PROJ-7')) ?? '';
  if (!/停滞/.test(freshLine)) ok('PROJ-7（刚动过）未被误判为停滞');
  else bad(`PROJ-7 被误判为停滞：${freshLine}`);
  if (v.ok >= 2) ok(`健康任务 ${v.ok} 个（坏任务没有拖垮它们）`);
  else bad(`健康任务只有 ${v.ok} 个——坏任务不该影响其它任务`);
}

console.log('\n== 6. 只读性（绝不写任何东西）==');
{
  const snapshot = () => {
    const out = {};
    const walk = (dir, prefix = '') => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix + e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rel + '/');
        else out[rel] = fs.statSync(path.join(dir, e.name)).mtimeMs;
      }
    };
    walk(root);
    return out;
  };
  const before = snapshot();
  await call({});
  const after = snapshot();
  if (JSON.stringify(before) === JSON.stringify(after)) ok('调用前后文件树与 mtime 完全一致（确认只读）');
  else bad(`调用改动了文件树：${JSON.stringify({ before, after }).slice(0, 200)}`);
}

console.log('\n== 7. 边界情况 ==');
{
  const noCwd = await ctx.tools.execute({
    callId: 'smoke-nocwd',
    name: 'sdlc_status',
    arguments: {},
    agent: { id: 'no-cwd' },
    signal: new AbortController().signal,
  });
  if (noCwd.isError && /cwd/.test(JSON.stringify(noCwd.content ?? noCwd.error))) {
    ok('拿不到 cwd 时给出可读错误');
  } else bad(`无 cwd 时行为不符: ${JSON.stringify(noCwd.value ?? noCwd.error)}`);

  // 任务目录不存在 → 空看板，而不是报错
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-status-empty-'));
  const emptyAgent = { id: 'e', session: { header: { cwd: emptyRoot } } };
  const empty = await ctx.tools.execute({
    callId: 'smoke-empty',
    name: 'sdlc_status',
    arguments: {},
    agent: emptyAgent,
    signal: new AbortController().signal,
  });
  if (empty.isError) bad(`没有任务目录时应返回空看板，却报错：${JSON.stringify(empty.error)}`);
  else if (empty.value.total === 0 && /没有任务/.test(empty.value.summary)) {
    ok('没有任务目录 → 空看板（不是错误）');
  } else bad(`空目录时输出不符: ${JSON.stringify(empty.value)}`);
  fs.rmSync(emptyRoot, { recursive: true, force: true });
}

console.log('\n== 8. 清理 ==');
fs.rmSync(root, { recursive: true, force: true });
if (!fs.existsSync(root)) ok(`临时目录已删除（${root}）`);
else bad('临时目录未清理');

console.log('');
console.log(`断言总数：${passCount + failures}（通过 ${passCount}，失败 ${failures}）`);
if (failures === 0) {
  console.log('全部通过');
  process.exit(0);
}
process.exit(1);
