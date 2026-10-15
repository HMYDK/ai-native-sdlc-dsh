/**
 * 插件运行时冒烟测试。
 *
 * 为什么需要它：之前三次翻车都是把"加载成功"当成了"可用"。
 * 这个脚本用**真实的 Cordis 上下文 + 真实的 ToolRuntime**挂载插件，
 * 然后**真的调用工具**，从而在不需要重启 App、不碰用户 profile 的前提下
 * 验证到"工具能被调用"这一层。
 *
 * 它已经抓到过一个真实缺陷：
 *   `Config` 必须是 Standard Schema 校验器（普通对象会导致
 *   `Cannot read properties of undefined (reading 'validate')`）。
 *
 * 用法（必须用 App 自带运行时才能解析 @deepseek-ai/*）：
 *   BASE="/Applications/DeepSeek Harness.app/Contents"
 *   ELECTRON_RUN_AS_NODE=1 "$BASE/MacOS/DeepSeek Harness" --expose-internals \
 *     packages/sdlc-verify/smoke.mjs
 */

import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

// 必须用 fileURLToPath：URL.pathname 不解码 %20，仓库路径含空格时会找不到文件。
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

// 从 App 的安装锚点解析 —— 绝不能用工作区那份（版本可能不同，且会破坏单例）
const APP_MODULES =
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules';
const require = createRequire(path.join(APP_MODULES, 'noop.js'));

const { Context } = require('@deepseek-ai/cordis');
const toolsMod = require('@deepseek-ai/dsh-tools');

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

console.log('== 1. 加载插件模块 ==');
const plugin = await import(pathToFileURL(path.join(PLUGIN_DIR, 'lib/index.js')).href);
ok(`name=${plugin.name}  inject=[${plugin.inject.join(', ')}]  apply=${typeof plugin.apply}`);

const isStandardSchema = typeof plugin.Config?.['~standard']?.validate === 'function';
if (isStandardSchema) ok('Config 是 Standard Schema 校验器');
else bad('Config 不是 Standard Schema（会抛 reading \'validate\'）');

console.log('\n== 2. Config 默认值解析 ==');
const validated = plugin.Config['~standard'].validate({});
if (validated.issues) bad(`校验失败: ${JSON.stringify(validated.issues)}`);
else ok(`默认值: ${JSON.stringify(validated.value)}`);

console.log('\n== 3. 挂载到真实 Cordis 上下文 ==');
const ctx = new Context();

// ToolRuntime 的 static inject 需要 systemPrompt。
// 桩要覆盖 ToolRuntime 与插件用到的全部方法（构造时就调 tools()）。
const sections = [];
ctx.provide('systemPrompt', {
  section: (s) => {
    sections.push(s);
    return () => {};
  },
  tools: () => () => {},
  variable: () => () => {},
  context: () => () => {},
  getSectionOrder: () => 0,
  getContextOrder: () => 0,
});

// 内存文件系统桩：sdlc_verify 现在会在给了 task_id 时读 state.yaml、
// 并把裁决写到 verification.json。
const files = new Map();
// 记录 cwd 与 policy：这是锁住"沙箱接线正确"的关键。
// 之前的桩忽略这两个参数，于是"落盘被沙箱拒绝"这个 bug 逃过了测试。
const resolveCalls = [];
const writeCalls = [];
ctx.provide('fs', {
  async resolve(p, o) {
    resolveCalls.push({ path: p, cwd: o?.cwd });
    return { targetKey: p, displayPath: p };
  },
  async stat(target) {
    return files.has(target.displayPath) ? { type: 'file', version: 'v1' } : undefined;
  },
  async readText(target) {
    const v = files.get(target.displayPath);
    if (v === undefined) throw new Error(`ENOENT: ${target.displayPath}`);
    return v;
  },
  async writeText(target, content, _intent, _signal, policy) {
    writeCalls.push({ path: target.displayPath, policy });
    files.set(target.displayPath, content);
    return { version: 'v1' };
  },
});

// 沙箱策略服务桩：会话 cwd 就是 workspace-write 的边界
const WORKSPACE_ROOT = '/repo';
ctx.provide('sandboxPolicy', {
  resolve({ session }) {
    return session === undefined
      ? undefined
      : { mode: 'workspace-write', workspaceRoot: WORKSPACE_ROOT };
  },
});

// 记录 subagent 请求，用于断言插件传了什么
const started = [];
const disposeCalls = [];
let verifyCalls = 0;
let runHandles = 0;
let capturedCriteriaPrompt = '';
const subagentsStub = {
  impl: async (provider, request) => {
    return {
      id: 'smoke-child',
      localAgent: undefined,
      result: Promise.resolve({
        output: [{ type: 'text', text: 'smoke verifier output' }],
        structured: {
          status: 'reject',
          summary: '冒烟测试桩：故意返回 reject，验证裁决能穿透',
          findings: [
            {
              severity: 'blocking',
              category: 'test_integrity',
              reason: '桩发现',
              evidence: 'smoke.mjs 的 stub',
            },
          ],
        },
        stopReason: 'completed',
      }),
      dispose: async () => {
        disposeCalls.push('smoke-child');
      },
    };
  },
};
ctx.provide('subagents', {
  start: async (provider, request) => {
    // 计数器放在这个**唯一入口**：5c 会临时替换 impl，放在 impl 里会漏计
    verifyCalls += 1;
    started.push({ provider, request });
    const handle = await subagentsStub.impl(provider, request);
    runHandles += 1;
    return handle;
  },
});

const ToolRuntime = toolsMod.ToolRuntime;
if (typeof ToolRuntime !== 'function') {
  bad('dsh-tools 未导出 ToolRuntime');
  process.exit(1);
}
const tools = new ToolRuntime(ctx, 'tools');
// 注意：Service 的构造函数返回的是它自己提供的实例，`new` 表达式的值不一定
// 与 ctx.tools 是同一个引用。判据是 ctx.tools 上有没有我们注册的东西，
// 而不是引用相等——所以这里只确认服务已就位。
if (ctx.tools === undefined) bad('ToolRuntime 未挂到 ctx.tools');
else ok('真实 ToolRuntime 已挂载到 ctx.tools');

try {
  plugin.apply(ctx, validated.value);
  ok('apply() 正常返回，未抛错');
} catch (e) {
  bad(`apply() 抛错: ${e.message}`);
  process.exit(1);
}

// ⚠️ inject 里写了不存在的服务 → 真实运行时里插件停在 `fiberPhase: "pending"`。
//
// 实测（2026-10-15）：我往 inject 加了 `logger`，App 里这个插件就变成
// `enabled: true, fiberPhase: "pending"`，**三个工具全部消失**
// （调用报 `Error: unknown tool "sdlc_verify"`），而 App 照常启动、
// 其它插件全是 active。没有报错、没有日志，只有工具不见了。
//
// 为什么必须在这里断言：冒烟是**直接调 apply()** 的，绕过了 Cordis 的服务
// 等待——所以"缺服务"这条路径在冒烟里完全不体现。那一次 86/86 全绿，
// 而插件在真实 App 里根本没激活。
//
// 判据用 `ctx.get(name)`（Cordis 的服务解析接口）而不是 `ctx[name]`：
// 后者对 `logger` 这类**内置属性**总是有值，判不出它是不是可注入的服务。
{
  const names = Array.isArray(plugin.inject) ? plugin.inject : [];
  const missing = [];
  for (const name of names) {
    let gotten;
    try {
      gotten = ctx.get(name);
    } catch {
      gotten = undefined;
    }
    if (gotten === undefined) missing.push(name);
  }
  if (missing.length === 0) {
    ok(`inject 的每个名字都能被 Cordis 解析到（${names.join(', ')}）`);
  } else {
    bad(
      `inject 里有 ${missing.length} 个服务解析不到：${missing.join(', ')}——` +
        '真实运行时不会激活这个插件，而且是**静默**的（fiberPhase=pending，工具全部消失）',
    );
  }
}

console.log('\n== 4. 工具注册情况 ==');
for (const n of ['sdlc_verify', 'sdlc_fix_start', 'sdlc_fix_end']) {
  const t = ctx.tools.get(n);
  if (t === undefined) bad(`${n} 未注册`);
  else ok(`${n} 已注册（execute=${typeof t.execute}）`);
}

if (sections.length === 1) ok(`提示词段已注册: ${sections[0].name} order=${sections[0].order}`);
else bad(`提示词段注册数=${sections.length}，期望 1`);

console.log('\n== 5. 真正调用工具（之前从没做到这一步）==');

/** 用真实 registry 派发一次调用 */
const dispatch = (name, args, agent, signal = new AbortController().signal) =>
  ctx.tools.execute({
    callId: `smoke-${name}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    arguments: args,
    ...(agent ? { agent } : {}),
    signal,
  });

// 5a. 先注册一个假的写工具，用来验证冻结 guard 真的会拒绝
ctx.tools.register({
  name: 'write',
  description: 'smoke stub for freeze verification',
  parameters: { file_path: { type: 'string', required: true }, content: { type: 'string' } },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
  execute: async (args) => `wrote ${args.file_path}`,
});

// pwsh 桩：Windows 上只有 pwsh 没有 bash，冻结必须在它上面同样生效
ctx.tools.register({
  name: 'pwsh',
  description: 'smoke stub for pwsh channel',
  parameters: { command: { type: 'string', required: true } },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
  execute: async (args) => `ran pwsh: ${args.command}`,
});

// bash 桩：shell 通道原先在运行时层完全没有覆盖，而这正是绕过点藏身之处。
const executedCommands = [];
ctx.tools.register({
  name: 'bash',
  description: 'smoke stub for shell-channel freeze verification',
  parameters: { command: { type: 'string', required: true } },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
  execute: async (args) => {
    executedCommands.push(args.command);
    return `ran: ${args.command}`;
  },
});

const fakeAgent = { id: 'smoke-session-A', session: { header: { cwd: '/repo' } } };

const r1 = await dispatch('sdlc_fix_start', { reason: 'smoke freeze' }, fakeAgent);
if (r1.isError) bad(`sdlc_fix_start 报错: ${JSON.stringify(r1.error)}`);
else ok(`sdlc_fix_start -> ${JSON.stringify(r1.value)}`);

// 冻结生效后：写测试文件必须被拒
const r2 = await dispatch('write', { file_path: 'tests/test_x.py', content: 'x' }, fakeAgent);
const deniedText = JSON.stringify(r2.content ?? r2.error ?? '');
if (r2.isError && deniedText.includes('冻结期内不可修改')) {
  ok('write 到 tests/ 被 guard 拒绝（冻结真的生效）');
} else if (r2.isError) {
  bad(`write 被拒但原因不符: ${deniedText.slice(0, 120)}`);
} else {
  bad(`write 到 tests/ 未被拒绝！value=${JSON.stringify(r2.value)}`);
}

// 冻结生效后：经 shell 改测试也必须被拒（这是原先没覆盖的通道）
for (const [label, command, tool = 'bash'] of [
  ['重定向（带空格）', "echo pass > tests/test_x.py"],
  ['重定向（不带空格）', "echo pass >tests/test_x.py"],
  ['解释器内写入', `python3 -c "open('tests/test_x.py','w')"`],
  ['find -delete', 'find tests -name "*.py" -delete'],
  ['dd of= 前缀', 'dd if=/dev/zero of=tests/x.py bs=1 count=0'],
  ['快照批量更新（带路径）', 'npx jest -u tests/'],
  ['快照批量更新（不带路径，独立信号）', 'npx jest -u'],
  ['PowerShell 写入 cmdlet', 'Set-Content tests/test_x.py "pass"'],
]) {
  const before = executedCommands.length;
  const r = await dispatch(tool, { command }, fakeAgent);
  const denied = r.isError && JSON.stringify(r.content ?? '').includes('冻结期内');
  // 关键：不仅要「返回 isError」，还要证明命令**没有真的执行**。
  // 否则若将来 guard 的执行时机挪到 dispatch 之后，这条测试仍会通过。
  const ranAnyway = executedCommands.length > before;
  if (denied && !ranAnyway) {
    ok(`shell 通道被拦且未执行: ${label}`);
  } else if (denied && ranAnyway) {
    bad(`shell 通道返回拒绝但命令仍被执行了（${label}）: ${command}`);
  } else {
    bad(`shell 通道未拦（${label}）: ${command}`);
  }
}

// 只读 shell 命令必须放行（防误伤）
for (const command of ['pytest tests/test_x.py -q', 'cat tests/test_x.py', 'git diff tests/']) {
  const before = executedCommands.length;
  const r = await dispatch('bash', { command }, fakeAgent);
  if (r.isError) bad(`只读 shell 被误伤: ${command}`);
  else if (executedCommands.length === before) bad(`只读 shell 未真正执行: ${command}`);
  else ok(`只读 shell 放行并执行: ${command}`);
}

// 进程级冻结：换一个 agent id、甚至不带 agent，测试资产同样不可改。
// 这是把冻结从"按 agent"改成"进程级"的直接后果，也是防 subagent 绕过的依据。
{
  const otherAgent = { id: 'smoke-session-B-different' };
  const r1 = await dispatch('write', { file_path: 'tests/test_z.py', content: 'x' }, otherAgent);
  if (r1.isError) ok('进程级冻结：另一个 agent id 写 tests/ 同样被拒');
  else bad('进程级冻结失效：另一个 agent id 写 tests/ 被放行');

  const r2 = await dispatch('write', { file_path: 'tests/test_w.py', content: 'x' });
  if (r2.isError) ok('进程级冻结：不带 agent 的调用同样被拒');
  else bad('进程级冻结失效：不带 agent 的调用被放行');
}

// 但写产品代码必须放行
const r3 = await dispatch('write', { file_path: 'src/app.py', content: 'x' }, fakeAgent);
if (r3.isError) bad(`write 到 src/ 被误伤: ${JSON.stringify(r3.error)}`);
else ok('write 到 src/ 正常放行（无误伤）');

// 解冻后写测试应放行
const r4 = await dispatch('sdlc_fix_end', { reason: 'smoke done' }, fakeAgent);
if (r4.isError) bad(`sdlc_fix_end 报错: ${JSON.stringify(r4.error)}`);
else ok('sdlc_fix_end 正常');
const r5 = await dispatch('write', { file_path: 'tests/test_y.py', content: 'x' }, fakeAgent);
if (r5.isError) bad(`解冻后仍被拦: ${JSON.stringify(r5.error)}`);
else ok('解冻后 write 到 tests/ 放行');

// 5b. sdlc_verify 走 subagent 桩：验证裁决能穿透到返回值
const r6 = await dispatch(
  'sdlc_verify',
  {
    intent_of_change: '冒烟测试：验证裁决能穿透',
    artifacts: { intent: '.ai/tasks/SMOKE/intent.md', plan: '.ai/tasks/SMOKE/plan.md' },
  },
  fakeAgent,
);
if (r6.isError) {
  bad(`sdlc_verify 报错: ${JSON.stringify(r6.error)}`);
} else {
  const v = r6.value;
  if (v?.status === 'reject' && Array.isArray(v?.findings) && v.findings.length === 1) {
    ok(`裁决穿透: status=${v.status} findings=${v.findings.length} session=${v.verifier_session}`);
  } else {
    bad(`裁决形状不符: ${JSON.stringify(v)}`);
  }
}

console.log('\n== 5c. needs_human + unverified 必须能穿透（原 schema 漂移点）==');
{

  // 桩默认返回 reject；这里临时替换成带 unverified 的 needs_human。
  // 这条断言存在的理由很具体：工具输出 schema 曾漏声明 unverified，
  // 配合 additionalProperties:false 会让**这一条裁决**变成工具错误，
  // 于是"证据不足就上报给人"的整条通路失效。原冒烟没覆盖它。
  const original = subagentsStub.impl;
  subagentsStub.impl = async () => ({
    id: 'smoke-child-2',
    localAgent: undefined,
    result: Promise.resolve({
      output: [{ type: 'text', text: 'needs human' }],
      structured: {
        status: 'needs_human',
        summary: '证据不足以判断，需要人工介入',
        findings: [],
        unverified: ['无法确认生产环境的实际并发量', '缺少回滚演练记录'],
      },
      stopReason: 'completed',
    }),
    dispose: async () => { disposeCalls.push('smoke-child-2'); },
  });
  const r = await dispatch('sdlc_verify', { intent_of_change: 'needs_human 穿透测试' }, fakeAgent);
  if (r.isError) {
    bad(`needs_human + unverified 变成工具错误（正是原缺陷）: ${JSON.stringify(r.error)}`);
  } else if (r.value?.status === 'needs_human' && Array.isArray(r.value?.unverified) && r.value.unverified.length === 2) {
    ok(`needs_human 携带 unverified 正常穿透（${r.value.unverified.length} 条未决问题）`);
  } else {
    bad(`needs_human 裁决形状不符: ${JSON.stringify(r.value)}`);
  }
  subagentsStub.impl = original;
}

console.log('\n== 5d. 任务身份：从 state.yaml 解析制品并把裁决落盘 ==');
{
  // 预置一个任务的 state.yaml（形状与 sdlc-task 写出的完全一致）
  files.set(
    '/repo/.ai/tasks/PROJ-9/state.yaml',
    [
      'task: PROJ-9',
      'title: "带任务身份的验证"',
      'status: PLANNED',
      'created: "2026-10-07T10:00:00.000Z"',
      'updated: "2026-10-07T10:00:00.000Z"',
      'artifacts:',
      '  intent: "intent.md"',
      '  spec: "spec.md"',
      '  plan: "plan.md"',
      'history: []',
      '',
    ].join('\n'),
  );

  started.length = 0;
  const r = await dispatch(
    'sdlc_verify',
    { intent_of_change: '任务身份接线测试', task_id: 'proj-9' },
    fakeAgent,
  );

  if (r.isError) {
    bad(`带 task_id 的调用失败: ${JSON.stringify(r.error)}`);
  } else {
    ok('带 task_id 的 sdlc_verify 正常返回');
    // 请求里应当带上**自动解析出**的制品绝对路径（调用方没传 artifacts）
    const req = started[started.length - 1]?.request;
    const txt = (req?.prompt ?? []).map((b) => b.text ?? '').join('\n');
    const expect = [
      ['intent', '/repo/.ai/tasks/PROJ-9/intent.md'],
      ['spec', '/repo/.ai/tasks/PROJ-9/spec.md'],
      ['plan', '/repo/.ai/tasks/PROJ-9/plan.md'],
    ];
    for (const [kind, full] of expect) {
      if (txt.includes(full)) ok(`自动解析出 ${kind} → ${full}`);
      else bad(`未把 ${kind} 的路径解析进提示词（期望含 ${full}）`);
    }
    // 裁决必须落盘，否则状态机到 REVIEWING 时看不到 verification 制品
    const vf = files.get('/repo/.ai/tasks/PROJ-9/verification.json');
    if (vf === undefined) {
      bad('裁决未写入 verification.json');
    } else {
      try {
        const parsed = JSON.parse(vf);
        if (parsed.task === 'PROJ-9' && parsed.verdict?.status !== undefined) {
          ok(`裁决已落盘：task=${parsed.task} status=${parsed.verdict.status}`);
        } else {
          bad(`落盘内容不符: ${vf.slice(0, 120)}`);
        }
      } catch (e) {
        bad(`落盘的 verification.json 不是合法 JSON: ${e.message}`);
      }
    }

    // 光写到磁盘不够：状态机的门槛看的是 state.yaml 的 artifacts。
    // 不登记的话，advance 到 REVIEWING 会说"缺 verification 制品"——
    // 而它明明就在旁边。（独立验证者指出的不一致。）
    const st = files.get('/repo/.ai/tasks/PROJ-9/state.yaml') ?? '';
    if (/^\s{2}verification:\s*"verification\.json"/m.test(st)) {
      ok('verification 已登记进 state.yaml 的 artifacts');
    } else {
      bad(`verification 未登记进 artifacts，状态机到 REVIEWING 会看不到它。state.yaml=\n${st}`);
    }
    // 登记结果必须**报出来**：这个函数有多条静默放弃路径，
    // 而静默成功与静默失败在制品上无法区分（独立验证者指出的）。
    const summary = String(r.value?.summary ?? '');
    if (/制品登记：verification/.test(summary)) {
      ok('summary 里报出了登记结果（静默失败与成功可区分）');
    } else {
      bad(`summary 未报告登记结果：${summary.slice(-160)}`);
    }

    // 而且不能把别的制品弄丢
    for (const [k, v] of [['intent', 'intent.md'], ['spec', 'spec.md'], ['plan', 'plan.md']]) {
      if (new RegExp(`^\\s{2}${k}:\\s*"${v}"`, 'm').test(st)) ok(`登记后 ${k} 仍在 artifacts 里`);
      else bad(`登记 verification 时把 ${k} 弄丢了`);
    }
  }

  // 任务不存在时要报错而不是静默降级
  const missing = await dispatch(
    'sdlc_verify',
    { intent_of_change: 'x', task_id: 'NOPE-1' },
    fakeAgent,
  );
  if (missing.isError && /没有 state.yaml/.test(JSON.stringify(missing.content ?? missing.error))) {
    ok('task_id 不存在时报错（不静默降级）');
  } else {
    bad('task_id 不存在时未报错');
  }
}

console.log('\n== 5d-2. 沙箱接线（落盘曾因漏传策略被拒）==');
{
  const missingCwd = resolveCalls.filter((c) => c.cwd === undefined);
  if (missingCwd.length === 0) {
    ok(`每次 fs.resolve 都带了 cwd（共 ${resolveCalls.length} 次）`);
  } else {
    bad(
      `${missingCwd.length} 次 resolve 没有 cwd —— 会落到沙箱的 fallback 根，` +
        `写 verification.json 会被误判越界。例：${missingCwd[0].path}`,
    );
  }
  const wrongRoot = resolveCalls.filter((c) => c.cwd !== undefined && c.cwd !== WORKSPACE_ROOT);
  if (wrongRoot.length === 0) ok('resolve 的 cwd 一律是会话的 workspace 根');
  else bad(`有 ${wrongRoot.length} 次 resolve 用了别的 cwd：${wrongRoot[0].cwd}`);

  const noPolicy = writeCalls.filter((w) => w.policy === undefined);
  if (writeCalls.length === 0) {
    bad('没有任何 writeText 调用，落盘路径没被覆盖');
  } else if (noPolicy.length === 0) {
    ok(`每次 writeText 都带了沙箱策略（共 ${writeCalls.length} 次）`);
  } else {
    bad(`${noPolicy.length} 次 writeText 没带策略（落盘会被拒）`);
  }
}

console.log('\n== 5d-3. 静默失败必须变成可报告的警告 ==');
{
  // 把 state.yaml 改成没有 artifacts 段的形态（模拟被人手改）
  files.set(
    '/repo/.ai/tasks/PROJ-8/state.yaml',
    ['task: PROJ-8', 'title: "手改过"', 'status: PLANNED', 'created: "x"', 'updated: "x"', 'history: []', ''].join('\n'),
  );
  const r = await dispatch(
    'sdlc_verify',
    { intent_of_change: '静默失败测试', task_id: 'PROJ-8' },
    fakeAgent,
  );
  const summary = String(r.value?.summary ?? r.error ?? '');
  if (/找不到 `artifacts:` 段/.test(summary)) {
    ok('找不到 artifacts 锚点时给出可读警告（而非静默跳过）');
  } else {
    bad(`锚点缺失时没有可读警告：${summary.slice(-200)}`);
  }
  if (/手动登记/.test(summary)) ok('警告里给出了补救办法（手动登记）');
  else bad('警告没有给出补救办法');
}

console.log('\n== 5d-4. criteria 强制策略（由 harness 执行，不靠提示词）==');
{
  // 桩返回什么裁决，就由这里控制。
  // 形状必须与 SubagentRun 一致：{id, localAgent, result: Promise<SubagentResult>}。
  // （第一版写成了裸的 SubagentResult，于是插件读 run.result.structured 时
  // 报 "Cannot read properties of undefined"——自己的测试抓到的。）
  const craftVerdict = (over) => ({
    id: 'smoke-criteria-child',
    localAgent: undefined,
    result: Promise.resolve({
      output: [{ type: 'text', text: 'criteria 桩输出' }],
      structured: { status: 'approve', summary: '看起来没问题', findings: [], ...over },
      stopReason: 'end_turn',
    }),
    // dispose 必须提供：dispose 断言是「调用次数 == dispose 次数」，
    // 桩少给一个 dispose 就会让那个断言失衡（这正是它抓到的）。
    dispose: async () => {
      disposeCalls.push('smoke-criteria-child');
    },
  });

  // (1) 没给 criteria + 验证者说 approve → 必须降级
  {
    const original = subagentsStub.impl;
    subagentsStub.impl = async () => craftVerdict({});
    const r = await dispatch('sdlc_verify', { intent_of_change: '无标准测试' }, fakeAgent);
    subagentsStub.impl = original;
    if (r.isError) bad(`调用失败: ${JSON.stringify(r.error)}`);
    else {
      if (r.value.status === 'needs_human') ok('没给 criteria 时 approve 被降级为 needs_human');
      else bad(`未降级，status=${r.value.status}（这是最危险的一条：没有定义就算通过）`);
      const blocking = (r.value.findings ?? []).filter((f) => f.severity === 'blocking');
      if (blocking.length > 0 && /验收标准/.test(blocking[0].reason)) {
        ok('降级时附了一条 blocking finding（说明为什么）');
      } else {
        bad(`降级没有可复核的理由: ${JSON.stringify(r.value.findings)}`);
      }
      if (/验证者原结论/.test(JSON.stringify(r.value.findings))) {
        ok('降级保留了验证者的原始结论（不隐藏它）');
      } else {
        bad('降级把验证者的原话丢了');
      }
    }
  }

  // (2) 给了 criteria、逐条 met → 允许 approve
  {
    const original = subagentsStub.impl;
    subagentsStub.impl = async (_p, req) => {
      const txt = (req.prompt ?? []).map((b) => b.text ?? '').join('\n');
      // 顺手断言：criteria 必须真的进了提示词
      capturedCriteriaPrompt = txt;
      return craftVerdict({
        criteria_results: [
          { criterion: '接口在 p99 < 200ms', result: 'met', evidence: '压测输出见 /tmp/x' },
          { criterion: '旧客户端不受影响', result: 'met', evidence: '契约测试通过' },
        ],
      });
    };
    const r = await dispatch(
      'sdlc_verify',
      { intent_of_change: '有标准测试', criteria: ['接口在 p99 < 200ms', '旧客户端不受影响'] },
      fakeAgent,
    );
    subagentsStub.impl = original;
    if (r.isError) bad(`调用失败: ${JSON.stringify(r.error)}`);
    else if (r.value.status === 'approve') ok('逐条 met 时允许 approve');
    else bad(`不该降级，status=${r.value.status}`);

    if (/必须逐条裁决的验收标准/.test(capturedCriteriaPrompt)) {
      ok('criteria 段确实进了提示词');
    } else {
      bad('criteria 没有进提示词');
    }
    if (/p99 < 200ms/.test(capturedCriteriaPrompt) && /旧客户端不受影响/.test(capturedCriteriaPrompt)) {
      ok('两条标准原文都在提示词里');
    } else {
      bad('标准原文没进提示词');
    }
    if (/cannot_tell/.test(capturedCriteriaPrompt)) ok('提示词说明了 cannot_tell 是正当答案');
    else bad('提示词没说 cannot_tell');
  }

  // (3) 有 cannot_tell + approve → 降级
  {
    const original = subagentsStub.impl;
    subagentsStub.impl = async () =>
      craftVerdict({
        criteria_results: [
          { criterion: 'a', result: 'met', evidence: 'x' },
          { criterion: 'b', result: 'cannot_tell', evidence: '范围外' },
        ],
      });
    const r = await dispatch(
      'sdlc_verify',
      { intent_of_change: 't', criteria: ['a', 'b'] },
      fakeAgent,
    );
    subagentsStub.impl = original;
    if (r.value?.status === 'needs_human') ok('有 cannot_tell 时 approve 被降级');
    else bad(`有 cannot_tell 却放行: ${r.value?.status}`);
  }

  // (4) 有 not_met + approve → 降级
  {
    const original = subagentsStub.impl;
    subagentsStub.impl = async () =>
      craftVerdict({
        criteria_results: [{ criterion: 'a', result: 'not_met', evidence: '实测不成立' }],
      });
    const r = await dispatch('sdlc_verify', { intent_of_change: 't', criteria: ['a'] }, fakeAgent);
    subagentsStub.impl = original;
    if (r.value?.status === 'needs_human') ok('有 not_met 时 approve 被降级');
    else bad(`有 not_met 却放行: ${r.value?.status}`);
  }

  // (5) 漏报标准 → 补一条 important finding
  {
    const original = subagentsStub.impl;
    subagentsStub.impl = async () =>
      craftVerdict({ criteria_results: [{ criterion: 'a', result: 'met', evidence: 'x' }] });
    const r = await dispatch(
      'sdlc_verify',
      { intent_of_change: 't', criteria: ['a', 'b', 'c'] },
      fakeAgent,
    );
    subagentsStub.impl = original;
    const imp = (r.value?.findings ?? []).filter(
      (f) => f.severity === 'important' && /漏报/.test(f.reason),
    );
    if (imp.length > 0) ok('漏报的标准被补成 finding（2 条没报）');
    else bad(`漏报未被发现: ${JSON.stringify(r.value?.findings)}`);
    if (/^2 条/.test(imp[0]?.reason ?? '') || /漏报了 2 条/.test(imp[0]?.reason ?? '')) {
      ok('finding 里报出了漏报的条数');
    } else {
      bad(`漏报条数不对: ${imp[0]?.reason}`);
    }
  }

  // (5c) 结构化裁决没产出 → 必须重试一次，且第二次的裁决被采纳
  //
  // 这一条对应一个实测到的**真缺陷**（2026-10-15）：验证者把调查全做完
  // （72 次工具调用、421 秒），却在写 structured_output 时参数流整段为空，
  // 报 `tool input is invalid JSON`。不重试 = 整轮调查白做。
  {
    const original = subagentsStub.impl;
    let calls = 0;
    const retryChild = (over) => ({
      id: `retry-child-${calls}`,
      localAgent: undefined,
      result: Promise.resolve({
        output: [{ type: 'text', text: '重试桩输出' }],
        structured: over,
        stopReason: over === undefined ? 'error' : 'end_turn',
        ...(over === undefined ? { diagnostic: 'tool input is invalid JSON' } : {}),
      }),
      dispose: async () => {
        disposeCalls.push('retry-child');
      },
    });
    subagentsStub.impl = async () => {
      calls += 1;
      // 第一次模拟"参数流为空"：structured 缺失；第二次正常返回。
      return calls === 1
        ? retryChild(undefined)
        : retryChild({ status: 'reject', summary: '第二次给出了裁决', findings: [] });
    };
    const r = await dispatch('sdlc_verify', { intent_of_change: '重试测试' }, fakeAgent);
    subagentsStub.impl = original;

    if (calls === 2) ok('第一次没产出结构化裁决时，自动重试了一次');
    else bad(`重试没发生，实际派发 ${calls} 次`);

    if (r.value?.status === 'reject' && r.value?.summary === '第二次给出了裁决') {
      ok('采纳的是重试那次的裁决（不是退回 needs_human）');
    } else {
      bad(`重试结果没被采纳: status=${r.value?.status} summary=${r.value?.summary}`);
    }
    if (r.value?.verifier_attempts === 2 && Array.isArray(r.value?.verifier_sessions)
        && r.value.verifier_sessions.length === 2) {
      ok('裁决里如实带出了"派发了 2 次"及每次的会话 id');
    } else {
      bad(`重试记录没带出: attempts=${r.value?.verifier_attempts} sessions=${JSON.stringify(r.value?.verifier_sessions)}`);
    }
  }

  // (5d) 两次都没产出 → needs_human，且**不许**从自由文本猜
  {
    const original = subagentsStub.impl;
    let calls = 0;
    subagentsStub.impl = async () => {
      calls += 1;
      return {
        id: `hopeless-${calls}`,
        localAgent: undefined,
        result: Promise.resolve({
          // 自由文本里写着"我判 reject"——**不能**采信它去猜。
          output: [{ type: 'text', text: '我的结论是 reject，有 3 条问题' }],
          structured: undefined,
          stopReason: 'error',
          diagnostic: 'tool input is invalid JSON',
        }),
        dispose: async () => {
          disposeCalls.push('hopeless');
        },
      };
    };
    const r = await dispatch('sdlc_verify', { intent_of_change: '猜不猜测试' }, fakeAgent);
    subagentsStub.impl = original;

    if (calls === 2) ok('两次都失败时确实尝试了两次（不是一次了事）');
    else bad(`重试次数不对: ${calls}`);
    if (r.value?.status === 'needs_human') {
      ok('两次都拿不到裁决 → needs_human（明确失败，不猜）');
    } else {
      bad(`应当 needs_human，实际 ${r.value?.status}——从自由文本猜出来的结论最危险`);
    }
    if (/invalid JSON/.test(r.value?.diagnostic ?? '')) {
      ok('把子代理的失败详情（diagnostic）带了出来，便于定位');
    } else {
      bad(`diagnostic 没带出: ${r.value?.diagnostic}`);
    }
  }

  // (6) reject 不受降级影响（降级只针对 approve）
  {
    const original = subagentsStub.impl;
    subagentsStub.impl = async () =>
      craftVerdict({ status: 'reject', summary: '有阻断问题', findings: [
        { severity: 'blocking', category: 'logic_error', reason: 'r', evidence: 'e' },
      ] });
    const r = await dispatch('sdlc_verify', { intent_of_change: 't' }, fakeAgent);
    subagentsStub.impl = original;
    if (r.value?.status === 'reject') ok('reject 不被改动（降级只针对 approve）');
    else bad(`reject 被改成了 ${r.value?.status}`);
  }
}

console.log('\n== 5e. 冻结绑定任务身份 ==');
{
  const t1 = { id: 'agent-1', session: { header: { cwd: '/repo' } } };
  const t2 = { id: 'agent-2', session: { header: { cwd: '/repo' } } };
  await dispatch('sdlc_fix_end', { reason: '清理', task_id: 'PROJ-9' }, t1);
  const started2 = await dispatch(
    'sdlc_fix_start',
    { reason: '固定', task_id: 'PROJ-9' },
    t1,
  );
  if (started2.isError) bad(`带 task_id 的 fix_start 失败: ${JSON.stringify(started2.error)}`);
  else ok('fix_start 接受 task_id');

  // 用另一个 task 解冻必须被拒
  const wrongEnd = await dispatch(
    'sdlc_fix_end',
    { reason: '想解冻别人的', task_id: 'OTHER-1' },
    t2,
  );
  if (wrongEnd.isError && /属于任务 PROJ-9/.test(JSON.stringify(wrongEnd.content ?? wrongEnd.error))) {
    ok('用错 task_id 解冻被拒（并指明冻结属于哪个任务）');
  } else {
    bad(`错 task_id 解冻未被拒: ${JSON.stringify(wrongEnd.value ?? wrongEnd.error)}`);
  }

  // 拒绝信息里应当带上任务归属
  const blockedWrite = await dispatch(
    'write',
    { file_path: 'tests/x.py', content: 'x' },
    t2,
  );
  const text = JSON.stringify(blockedWrite.content ?? '');
  if (blockedWrite.isError && text.includes('PROJ-9')) {
    ok('冻结拒绝信息里带上了任务归属');
  } else {
    bad('冻结拒绝信息未指明所属任务');
  }

  await dispatch('sdlc_fix_end', { reason: '收尾', task_id: 'PROJ-9' }, t1);
}

console.log('\n== 6. 插件传给验证者的请求是否正确 ==');
{
  started.length = 0;
  await dispatch(
    'sdlc_verify',
    {
      intent_of_change: '第 6 节的基准调用',
      artifacts: { intent: '.ai/tasks/SMOKE/intent.md', plan: '.ai/tasks/SMOKE/plan.md' },
    },
    fakeAgent,
  );
}
if (started.length < 1) {
  bad('subagents.start 从未被调用');
} else {
  // 断言**第 5 节**那次调用（started[0]）——它带 artifacts。
  // 后面 5c/7 节还会各发起一次，所以这里不假设总数为 1。
  const { provider, request } = started[0];
  const checks = [
    ['provider 为 spawn', provider === 'spawn'],
    ['outputSchema 已传（强制结构化）', request.outputSchema?.type === 'object'],
    // 断言**关键性质**而不是硬编码列表：写能力工具必须不在 allow 里。
    // 硬编码整个数组会让"加一个只读工具"也报错，掩盖真正的回归。
    [
      'toolFilter 不含写能力工具（write/edit）',
      Array.isArray(request.toolFilter?.allow) &&
        !request.toolFilter.allow.includes('write') &&
        !request.toolFilter.allow.includes('edit'),
    ],
    // 跨平台回归：allow 里只能出现**本平台真实存在**的 shell 工具。
    // tools.restrict() 对不存在的工具名直接抛错，把 bash 与 pwsh 都写上会让
    // 另一个平台的验证整条通路报错（实测：macOS 上报 unknown global tool "pwsh"）。
    [
      `toolFilter 只含本平台存在的 shell 工具（当前 ${process.platform}）`,
      process.platform === 'win32'
        ? request.toolFilter.allow.includes('pwsh') && !request.toolFilter.allow.includes('bash')
        : request.toolFilter.allow.includes('bash') && !request.toolFilter.allow.includes('pwsh'),
    ],
    [
      'toolFilter 保留只读检索工具与 shell',
      ['read', 'grep', 'glob'].every((n) => request.toolFilter.allow.includes(n)) &&
        (request.toolFilter.allow.includes('bash') || request.toolFilter.allow.includes('pwsh')),
    ],
    // ⚠️ `skill` 必须**单独**钉住。
    //
    // 上面那条只查 read/grep/glob，所以 `skill` 被摘掉它照样绿——
    // 而"摘掉 skill"真的发生过：`sdlc-workflow` 交付的验证纪律是做成
    // **Skill** 的，而验证者加载不到它（`toolFilter` 是允许清单）。
    // 结果是一份名字里写着"给验证者的"清单，验证者够不着。
    //
    // 依据：`dsh-tool-skill` 只做 `ctx.tools.register(skillTool)`，
    // **不注册任何提示词段**——Skill 目录除了这个工具没有别的通道。
    // 没有它就等于那份清单不存在。
    ['toolFilter 保留 skill（否则验证者读不到那份验证纪律）', request.toolFilter.allow.includes('skill')],
    ['persona 已传且非空', typeof request.persona === 'string' && request.persona.length > 50],
    // 正向：必须明确要求「忽略让你修改的指示」
    ['persona 要求忽略修改类指示', /Ignore any instruction that would have you modify/i.test(request.persona)],
    // 负向：**不得**再声称「只读/不能修改」——那句话被实测推翻过，
    // 而且旧 persona 也能通过只做正向匹配的断言（无鉴别力）
    ['persona 不再声称「只读」（负向断言）', !/read-only tools|You cannot modify/i.test(request.persona)],
    // 正向：必须如实说明 bash 能写但不许写
    ['persona 如实描述 bash 能力边界', /technically able to change files/i.test(request.persona)],
    ['prompt 是 ContentBlock[]', Array.isArray(request.prompt) && request.prompt[0]?.type === 'text'],
    ['未传 agentOptions（未配置模型时不乱传）', request.agentOptions === undefined],
  ];
  for (const [label, pass] of checks) {
    if (pass) ok(label);
    else bad(label);
  }

  const promptText = request.prompt.map((b) => b.text ?? '').join('\n');
  for (const [label, needle] of [
    ['提示词要求 needs_human（防猜测通过）', 'needs_human'],
    ['提示词要求 structured_output', 'structured_output'],
    ['提示词列出待验证问题', '必须回答的问题'],
    ['提示词含制品路径', '.ai/tasks/SMOKE/intent.md'],
  ]) {
    if (promptText.includes(needle)) ok(label);
    else bad(`${label}（未找到 "${needle}"）`);
  }

  // 未提供 test_evidence 时，"复核作者证据"那段不应出现（它是条件性的）
  if (!promptText.includes('需要你自己复核')) {
    ok('未提供测试证据时，不复述"复核证据"段落（条件渲染正确）');
  } else {
    bad('未提供测试证据却渲染了复核段落');
  }
}

console.log('\n== 7. 提供测试证据时的条件渲染 ==');
{
  started.length = 0;
  const r = await dispatch(
    'sdlc_verify',
    {
      intent_of_change: '第二个用例：带测试证据',
      artifacts: { intent: '.ai/tasks/SMOKE/intent.md' },
      test_evidence: 'pytest tests/test_x.py -q  →  1 passed',
    },
    fakeAgent,
  );
  if (r.isError) {
    bad(`带 test_evidence 的调用报错: ${JSON.stringify(r.error)}`);
  } else {
    const req = started[started.length - 1].request;
    const txt = req.prompt.map((b) => b.text ?? '').join('\n');
    if (txt.includes('需要你自己复核') && txt.includes('1 passed')) {
      ok('提供测试证据时，该段落出现且含证据原文');
    } else {
      bad('提供测试证据时未渲染复核段落');
    }
  }
}

console.log('\n== 7b. 每次验证都留下成对记录，失败不能伪装成裁决 ==');
{
  const records = [];
  const unsubscribe = ctx.on('sdlc-verify/record', async (record, exec) => {
    await Promise.resolve();
    records.push(structuredClone(record));
    if (!exec?.agent) throw new Error('记录事件没有传 exec.agent');
  });
  const original = subagentsStub.impl;
  const resultHandle = (result, id = 'record-child') => ({
    id, localAgent: undefined, result: Promise.resolve(result),
    dispose: async () => { disposeCalls.push(id); },
  });
  const check = (label, condition) => condition ? ok(label) : bad(label);
  const run = async (impl, args = {}, agent = fakeAgent) => {
    records.length = 0;
    subagentsStub.impl = impl;
    return await dispatch('sdlc_verify', { intent_of_change: '运行记录测试', ...args }, agent);
  };
  const paired = () => records[0]?.kind === 'started' && records.at(-1)?.kind === 'finished'
    && records.filter((r) => r.kind === 'finished').length === 1;
  try {
    const missing = { output: [{ type: 'text', text: 'approve 自由文本不能当裁决' }], stopReason: 'error', diagnostic: 'missing structured' };
    const r = await run(async () => resultHandle(missing));
    check('无裁决仍发出 started/finished', paired());
    check('无裁决明确标 verification_complete=false', r.value?.verification_complete === false);
    check('无裁决终点为 no_verdict，结果仍是 needs_human', records.at(-1)?.data.outcome === 'no_verdict' && r.value?.status === 'needs_human');
    check('两次尝试分别留下 started/session/finished', ['attempt_started', 'attempt_session', 'attempt_finished'].every((kind) => records.filter((r) => r.kind === kind).length === 2));
    check('运行 UUID 与返回值一致、seq 从 0 连续', typeof r.value?.verification_run_id === 'string' && records.every((record, i) => record.seq === i && record.run_id === r.value.verification_run_id && record.schema_version === 1));

    await run(async () => { throw new Error('provider dispatch failed'); });
    check('派发异常也有完整运行与尝试终点', paired() && records.at(-1)?.data.outcome === 'error' && records.some((r) => r.kind === 'attempt_finished' && /dispatch failed/.test(r.data.error)));

    await run(async () => ({
      id: 'rejected-result-child', localAgent: undefined,
      result: Promise.resolve().then(() => { throw new Error('result infrastructure failed'); }),
      dispose: async () => { disposeCalls.push('rejected-result-child'); },
    }));
    check('子代理结果拒绝有 attempt_session 与带 child id 的失败记录', paired() && records.at(-1)?.data.outcome === 'error' && records.some((r) => r.kind === 'attempt_finished' && r.data.session_id === 'rejected-result-child' && /infrastructure failed/.test(r.data.error)));

    records.length = 0;
    const controller = new AbortController();
    let abortCalls = 0;
    let finalSignal;
    const observeSignal = ctx.on('sdlc-verify/record', (record, exec) => {
      if (record.kind === 'finished') finalSignal = exec.signal;
    });
    subagentsStub.impl = async () => {
      abortCalls += 1;
      return {
        id: 'abort-result-child', localAgent: undefined,
        result: Promise.resolve().then(() => {
          controller.abort();
          throw new DOMException('用户中止验证', 'AbortError');
        }),
        dispose: async () => { disposeCalls.push('abort-result-child'); },
      };
    };
    await dispatch('sdlc_verify', { intent_of_change: '实际信号取消' }, fakeAgent, controller.signal);
    observeSignal();
    check('中途 AbortSignal 取消仍成对记录且只派发一次', abortCalls === 1 && paired() && records.at(-1)?.data.outcome === 'cancelled');
    check('取消后的结束记录没有被已取消 signal 连带阻止', finalSignal === undefined);

    await run(original, { task_id: 'MISSING-RECORD-TASK' });
    check('任务解析失败之前已记 started，之后记 error', paired() && records.at(-1)?.data.outcome === 'error' && !records.some((r) => r.kind === 'prepared'));

    let cancellationCalls = 0;
    const cancelled = await run(async () => {
      cancellationCalls += 1;
      return resultHandle({ output: [], stopReason: 'aborted' });
    });
    check('取消不再触发第二次派发', cancellationCalls === 1);
    check('取消明确收尾为 cancelled 而非 no_verdict', paired() && records.at(-1)?.data.outcome === 'cancelled' && cancelled.value?.verification_complete === false);

    const rejectingRecorder = ctx.on('sdlc-verify/record', async () => { throw new Error('record disk full'); });
    const withRecorderError = await run(original);
    rejectingRecorder();
    check('记录器失败保留真正的 reject', !withRecorderError.isError && withRecorderError.value?.status === 'reject');
    check('记录器失败在返回结果里可见', withRecorderError.value?.recording_errors?.some((e) => /record disk full/.test(e)));

    files.set('spec-for-record.md', '可复核的制品正文');
    const complete = await run(async () => resultHandle({ output: [], stopReason: 'completed', structured: { status: 'needs_human', summary: '证据不足', findings: [] } }), {
      criteria: ['判据原文'], artifacts: { spec: 'spec-for-record.md', missing: 'missing.md' }, experimental_guidance: 'EXPERIMENT-ONLY-GUIDANCE',
    }, { ...fakeAgent, session: { ...fakeAgent.session, id: 'actual-parent-session' } });
    const prep = records.find((r) => r.kind === 'prepared')?.data;
    check('有效 needs_human 裁决算结构化完成', complete.value?.verification_complete === true && records.at(-1)?.data.outcome === 'completed');
    check('prepared 留下制品原文哈希与读取失败', prep?.artifact_snapshots?.spec?.content === '可复核的制品正文' && /^[a-f0-9]{64}$/.test(prep?.artifact_snapshots?.spec?.sha256 ?? '') && typeof prep?.artifact_snapshots?.missing?.error === 'string');
    check('实验指导只追加提示词，判据/schema/工具权限保留', prep?.prompt?.includes('EXPERIMENT-ONLY-GUIDANCE') && JSON.stringify(prep?.criteria) === JSON.stringify(['判据原文']) && prep?.outputSchema?.type === 'object' && !started.at(-1)?.request.toolFilter.allow.includes('write'));
    check('父会话身份来自 session.id', records[0]?.data.parent_session_id === 'actual-parent-session');
    check('started 保留有效配置、请求模型标记与导入时指纹', records[0]?.data.config.verifierProvider === 'spawn' && records[0]?.data.requested_model?.source === 'requested' && /^[a-f0-9]{64}$/.test(records[0]?.data.verifier_fingerprint ?? ''));
  } finally {
    subagentsStub.impl = original;
    unsubscribe();
  }
}

console.log('\n== 8. SubagentRun 必须被 dispose（契约要求，原先漏了）==');
// 断言「每次 sdlc_verify 调用都恰好 dispose 一次」——用两个实际计数比对，
// 而不是写死数字（写死会在新增用例时假失败，而假失败会掩盖真问题）。
if (disposeCalls.length === runHandles && runHandles > 0) {
  ok(`dispose 次数(${disposeCalls.length}) == 取得的子代理句柄数(${runHandles})`);
} else {
  bad(`dispose ${disposeCalls.length} 次 vs 子代理句柄 ${runHandles} 个，必须一一对应`);
}
// 第 7 节在断言前清空过 started，这里顺便记录该次请求确实带了测试证据
{
  const last = started.find((entry) => entry.request.prompt?.some((b) => b.text?.includes('1 passed')));
  const txt = (last?.request?.prompt ?? []).map((b) => b.text ?? '').join('\n');
  if (txt.includes('1 passed')) ok('第 7 节请求确实携带了测试证据原文');
  else bad('第 7 节请求缺少测试证据原文');
}

console.log('');
console.log(`断言总数：${passCount + failures}（通过 ${passCount}，失败 ${failures}）`);
if (failures === 0) {
  console.log('全部通过');
  process.exit(0);
}
process.exit(1);
