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
    return await subagentsStub.impl(provider, request);
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
const dispatch = (name, args, agent) =>
  ctx.tools.execute({
    callId: `smoke-${name}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    arguments: args,
    ...(agent ? { agent } : {}),
    signal: new AbortController().signal,
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

console.log('\n== 8. SubagentRun 必须被 dispose（契约要求，原先漏了）==');
// 断言「每次 sdlc_verify 调用都恰好 dispose 一次」——用两个实际计数比对，
// 而不是写死数字（写死会在新增用例时假失败，而假失败会掩盖真问题）。
if (disposeCalls.length === verifyCalls && verifyCalls > 0) {
  ok(`dispose 次数(${disposeCalls.length}) == sdlc_verify 调用次数(${verifyCalls})`);
} else {
  bad(`dispose ${disposeCalls.length} 次 vs sdlc_verify ${verifyCalls} 次，必须一一对应`);
}
// 第 7 节在断言前清空过 started，这里顺便记录该次请求确实带了测试证据
{
  const last = started[started.length - 1];
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
