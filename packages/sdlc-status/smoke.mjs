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

// ───────────────────────────────────── 分页与单任务详情（spec: STATUS-PAGE）
//
// 这一节用**第三个**临时根（60 个任务），不干扰上面的计数断言。
// 60 > 默认页大小 50，所以它专门测"超过一页时那个语义差异"——
// 而那个差异在 ≤50 个任务的仓库里**天然测不到**（见 spec 的 Areas of concern）。
{
  console.log('\n== 分页与单任务详情 ==');
  const pageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-status-page-'));
  const pageTasks = path.join(pageRoot, '.ai/tasks');
  const pageAgent = { id: 'smoke-page', session: { header: { cwd: pageRoot } } };
  const pageCall = (args) =>
    ctx.tools.execute({
      callId: `smoke-page-${Math.random().toString(36).slice(2)}`,
      name: 'sdlc_status',
      arguments: args,
      agent: pageAgent,
      signal: new AbortController().signal,
    });

  const N = 60;
  for (let i = 1; i <= N; i += 1) {
    const id = `PG-${String(i).padStart(3, '0')}`;
    fs.mkdirSync(path.join(pageTasks, id), { recursive: true });
    fs.writeFileSync(
      path.join(pageTasks, id, 'state.yaml'),
      [
        `task: ${id}`,
        `title: "${id}"`,
        'status: SPEC',
        'created: "2026-10-07T10:00:00.000Z"',
        'updated: "2026-10-07T10:00:00.000Z"',
        'artifacts:',
        '  intent: "intent.md"',
        '  spec: "spec.md"',
        'history: []',
        '',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(path.join(pageTasks, id, 'intent.md'), '# I\n', 'utf8');
    fs.writeFileSync(path.join(pageTasks, id, 'spec.md'), '# S\n', 'utf8');
  }

  // R1：默认调用 —— 前 50 个 + 旧截断行，且**不出现**新的窗口说明
  const d0 = await pageCall({});
  if (d0.value.total === N) ok(`默认调用：total=${N}（总数，不是显示数）`);
  else bad(`total 应为 ${N}，实际 ${d0.value.total}`);
  if (d0.value.tasks.length === 51) ok('默认显示 50 条 + 1 行旧截断提示');
  else bad(`默认 tasks 长度应为 51，实际 ${d0.value.tasks.length}`);
  if (d0.value.truncated === true) ok('truncated=true（默认被截断）');
  else bad('truncated 应为 true');
  if (d0.value.complete === false) ok('complete=false（确实没看全）');
  else bad('complete 应为 false');
  // ⚠️ 这里我犯过一次错，被独立验证者抓住，记录在案：
  // 我原来断言"默认路径**应当**产生 note（因为它更可操作）"，
  // 于是把 spec R1「不传新参数时输出逐字不变」这条承诺改掉了。
  // 验证者用 HEAD 的旧代码逐字对比证明：默认路径也渲染 note，
  // 且**空仓库**会得到「没有更多了：offset=0 已越过总数 0」——
  // 没有任务却报"已越过总数"。所以那条"更可操作"是拿正确性换的。
  // 现在：默认路径逐字回到旧行为，note 只在显式传了参数时产出。
  if (d0.value.note === undefined) {
    ok('默认路径不产生 note（R1：输出逐字不变）');
  } else bad(`默认路径不该有 note，实际：${d0.value.note}`);
  if (d0.value.tasks.some((l) => /还有 10 个未显示/.test(l))) {
    ok('旧的截断行仍然保留（向后兼容）');
  } else bad('旧截断行丢了 —— 不再向后兼容');
  // 反过来：显式传了 offset 时**必须**给出可操作的下一步
  const page1 = await pageCall({ offset: 0 });
  if (typeof page1.value.note === 'string' && /offset=50/.test(page1.value.note)) {
    ok('显式分页时 note 给出了可操作的下一步（offset=50）');
  } else bad(`显式分页应有可操作的 note，实际：${page1.value.note}`);

  // R2：翻页不重不漏
  const seen = [];
  for (let offset = 0; offset < N; offset += 50) {
    const r = await pageCall({ offset });
    seen.push(...r.value.tasks.map((l) => (l.match(/^(?:[·!⏳⏸✓✗]\s+)?(PG-\d+)/) ?? [])[1]).filter(Boolean));
  }
  const uniq = new Set(seen);
  if (seen.length === N) ok(`翻页拿全了 ${N} 个（各页之和）`);
  else bad(`翻页各页之和应为 ${N}，实际 ${seen.length}`);
  if (uniq.size === N) ok('翻页无重复（id 去重后仍是 60）');
  else bad(`翻页有重复：去重后 ${uniq.size}`);

  // R2/R3：最后一页 / 越界
  const lastPage = await pageCall({ offset: 50 });
  if (lastPage.value.tasks.length === 10) ok('offset=50 拿到 10 个（最后一页）');
  else bad(`offset=50 应为 10 个，实际 ${lastPage.value.tasks.length}`);
  if (lastPage.value.complete === true) ok('最后一页 complete=true（看全了）');
  else bad('最后一页 complete 应为 true');
  // ⚠️ 我原来断言"末尾也要有 note"，那是**错的**：
  // offset=50 显示第 51-60 个，已到末尾且 complete=true，
  // 此时"没有更多"由 complete 表达，再来一句 note 是噪音。
  // 真正需要明确说的是**越界**（见下面 offset=999 那条）。
  if (lastPage.value.note === undefined) {
    ok('完整显示到末尾时没有多余 note（complete=true 已经说明了一切）');
  } else bad(`末尾不该有 note（complete=true 已足够），实际：${lastPage.value.note}`);

  const over = await pageCall({ offset: 999 });
  if (over.value.tasks.length === 0) ok('offset 越界：tasks 为空');
  else bad(`offset 越界应返回空，实际 ${over.value.tasks.length} 条`);
  if (typeof over.value.note === 'string' && /没有更多/.test(over.value.note)) {
    ok('offset 越界：明确说"没有更多"（不是沉默的空）');
  } else bad(`offset 越界应说明没有更多，实际：${over.value.note}`);

  // R4：单任务详情
  const one = await pageCall({ task_id: 'PG-042' });
  if (one.value.tasks.length === 1 && /PG-042/.test(one.value.tasks[0] ?? '')) {
    ok('task_id 只返回那一个任务');
  } else bad(`task_id 应只返回 1 条，实际 ${one.value.tasks.length}`);
  if (one.value.complete === true) ok('单任务详情 complete=true');
  else bad('单任务详情 complete 应为 true');

  const ignored = await pageCall({ task_id: 'PG-042', offset: 10, limit: 5 });
  if (ignored.value.tasks.length === 1 && /PG-042/.test(ignored.value.tasks[0] ?? '')) {
    ok('task_id 优先于 offset/limit');
  } else bad('task_id 应优先于 offset/limit');
  if (typeof ignored.value.note === 'string' && /忽略/.test(ignored.value.note)) {
    ok('说明忽略了哪些参数（不静默丢弃）');
  } else bad(`应说明忽略的参数，实际：${ignored.value.note}`);

  const missing = await pageCall({ task_id: 'NOPE-9' });
  if (missing.isError) ok('task_id 未命中 → 报错（不是空数组）');
  else bad('task_id 未命中应报错');
  if (missing.isError && /NOPE-9/.test(JSON.stringify(missing.content ?? missing.error))) {
    ok('未命中的错误信息带上了那个 id');
  } else bad('错误信息应带上找不到的 id');

  // R5：limit 夹到上限
  // ⚠️ 独立验证者指出这条曾经是**空断言**：
  // 原条件 `tasks.length === 200 || total < 200`，而夹具只有 60 个任务，
  // 于是 `total < 200` 恒真——即使实现完全不夹、直接返回 60 条也会绿。
  // 修法：另造一个 >200 的仓库，让"被夹到 200"真的可证伪。
  const bigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-status-big-'));
  const bigTasks = path.join(bigRoot, '.ai/tasks');
  const BIG = 250;
  for (let i = 1; i <= BIG; i += 1) {
    const id = `BIG-${String(i).padStart(3, '0')}`;
    fs.mkdirSync(path.join(bigTasks, id), { recursive: true });
    fs.writeFileSync(
      path.join(bigTasks, id, 'state.yaml'),
      `task: ${id}\ntitle: "${id}"\nstatus: SPEC\ncreated: "2026-10-07T10:00:00.000Z"\nupdated: "2026-10-07T10:00:00.000Z"\nartifacts:\n  intent: "i.md"\n  spec: "s.md"\nhistory: []\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(bigTasks, id, 'i.md'), '# I\n', 'utf8');
    fs.writeFileSync(path.join(bigTasks, id, 's.md'), '# S\n', 'utf8');
  }
  const bigAgent = { id: 'smoke-big', session: { header: { cwd: bigRoot } } };
  const bigCall = (args) =>
    ctx.tools.execute({
      callId: `smoke-big-${Math.random().toString(36).slice(2)}`,
      name: 'sdlc_status',
      arguments: args,
      agent: bigAgent,
      signal: new AbortController().signal,
    });

  const clamped = await bigCall({ limit: 1000 });
  if (clamped.value.total === BIG) ok(`夹具是真的 ${BIG} 个任务（让下面这条可证伪）`);
  else bad(`夹具应为 ${BIG} 个，实际 ${clamped.value.total}`);
  if (clamped.value.tasks.length === 200) {
    ok(`limit=1000 被夹到 200（${BIG} 个任务的仓库里真的显示 200 条）`);
  } else bad(`limit 应被夹到 200，实际 ${clamped.value.tasks.length}（夹具 ${BIG} 个）`);
  if (typeof clamped.value.note === 'string' && /1000/.test(clamped.value.note)) {
    ok('note 说明了请求的是 1000（不静默夹）');
  } else bad(`应说明请求值，实际：${clamped.value.note}`);

  // 回归：**显式分页时不得追加那条旧的截断提示行**。
  // 我第一版把 `truncated` 字段的新式子（!complete）也用在渲染上，
  // 于是显式分页也加了一行"… 还有 N 个未显示"，把一个真实任务挤出窗口
  // （250 个任务下显示 201 条而不是 200）。这条断言把它钉住。
  const phantom = clamped.value.tasks.some((l) => /未显示/.test(l));
  if (!phantom) ok('显式分页的 tasks 里没有"未显示"那行（不会挤出真实任务）');
  else bad('显式分页不该追加截断提示行 —— 它会把真实任务挤出窗口');

  // 上限之外的任务仍然可达（这是本任务的原始目标）
  const tail = await bigCall({ offset: 200 });
  const tailIds = tail.value.tasks
    .map((l) => (l.match(/BIG-\d+/) ?? [])[0])
    .filter(Boolean);
  if (tailIds.length === 50) ok(`offset=200 取到最后 50 个（BIG-201..250）—— 上限之外可达`);
  else bad(`offset=200 应取到 50 个，实际 ${tailIds.length}`);
  if (tailIds[0] === 'BIG-201' && tailIds[49] === 'BIG-250') {
    ok('末尾那一页正是 BIG-201..BIG-250（顺序与内容都对）');
  } else bad(`末尾页内容不对：${tailIds[0]}..${tailIds[tailIds.length - 1]}`);
  fs.rmSync(bigRoot, { recursive: true, force: true });

  // 参数校验：非法值必须报错，不静默纠正
  for (const [arg, label] of [
    [{ offset: -1 }, 'offset=-1'],
    [{ offset: 1.5 }, 'offset=1.5'],
    [{ limit: 0 }, 'limit=0'],
    [{ limit: 'abc' }, "limit='abc'"],
  ]) {
    const bad_ = await pageCall(arg);
    if (bad_.isError && new RegExp(Object.keys(arg)[0]).test(JSON.stringify(bad_.content ?? bad_.error))) {
      ok(`${label} → 报错且指出参数名`);
    } else bad(`${label} 应报错并指出参数名，实际 isError=${bad_.isError}`);
  }

  // R7：分页路径也必须只读
  const snapshotTree = (dir, prefix = '', out = {}) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + e.name;
      if (e.isDirectory()) snapshotTree(path.join(dir, e.name), rel + '/', out);
      else out[rel] = fs.statSync(path.join(dir, e.name)).mtimeMs;
    }
    return out;
  };
  const treeBefore = JSON.stringify(snapshotTree(pageRoot));
  await pageCall({ offset: 25, limit: 10 });
  await pageCall({ task_id: 'PG-001' });
  const treeAfter = JSON.stringify(snapshotTree(pageRoot));
  if (treeBefore === treeAfter) ok('R7：分页与详情调用后，文件树与 mtime 完全未变（只读）');
  else bad('R7：分页调用改动了文件树 —— 只读被破坏');

  fs.rmSync(pageRoot, { recursive: true, force: true });
}

console.log('\n== 7b. 空看板的渲染必须与旧行为逐字一致 ==');
{
  // 独立验证者的 blocking 发现：默认路径渲染 multi-line note，
  // 于是**空仓库**（本仓库与测试场开局都是这个状态）从
  //   "没有任务。\n"
  // 变成
  //   "没有任务。\n没有更多了：offset=0 已越过总数 0\n"
  // —— 没有任务却报"已越过总数"。这条断言把它钉住。
  const emptyRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-status-empty2-'));
  const emptyAgent = { id: 'smoke-empty2', session: { header: { cwd: emptyRoot2 } } };
  const er = await ctx.tools.execute({
    callId: `smoke-empty2-${Math.random().toString(36).slice(2)}`,
    name: 'sdlc_status',
    arguments: {},
    agent: emptyAgent,
    signal: new AbortController().signal,
  });
  const text = er.value.tasks !== undefined || er.value.summary !== undefined
    ? (() => {
        const v = er.value;
        const lines = Array.isArray(v.tasks) ? v.tasks : [];
        const note = typeof v.note === 'string' && v.note !== '' ? v.note : undefined;
        return [String(v.summary), ...(note !== undefined ? [note] : []), '', ...lines].join('\n');
      })()
    : '';
  if (text === '没有任务。\n') {
    ok(`空看板渲染逐字等于旧行为：${JSON.stringify(text)}`);
  } else bad(`空看板渲染变了：${JSON.stringify(text)}（应为 "没有任务。\\n"）`);
  if (er.value.note === undefined) ok('空看板不产生 note（不再出现"已越过总数 0"）');
  else bad(`空看板不该有 note，实际：${er.value.note}`);
  fs.rmSync(emptyRoot2, { recursive: true, force: true });
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
