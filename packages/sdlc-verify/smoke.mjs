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
const ok = (m) => console.log(`  \u2713 ${m}`);
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

// 记录 subagent 请求，用于断言插件传了什么
const started = [];
ctx.provide('subagents', {
  start: async (provider, request) => {
    started.push({ provider, request });
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
      dispose: async () => {},
    };
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

const fakeAgent = { id: 'smoke-session-A' };

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

console.log('\n== 6. 插件传给验证者的请求是否正确 ==');
if (started.length !== 1) {
  bad(`subagents.start 被调用 ${started.length} 次，期望 1 次`);
} else {
  const { provider, request } = started[0];
  const checks = [
    ['provider 为 spawn', provider === 'spawn'],
    ['outputSchema 已传（强制结构化）', request.outputSchema?.type === 'object'],
    [
      'toolFilter 是只读白名单',
      JSON.stringify(request.toolFilter) === '{"allow":["read","grep","glob","bash"]}',
    ],
    ['persona 已传且非空', typeof request.persona === 'string' && request.persona.length > 50],
    ['persona 提醒了工具子集（防御 toolFilter 不隐藏静态提示词）', /do not have|read-only subset/i.test(request.persona)],
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

console.log('');
if (failures === 0) {
  console.log('全部通过');
  process.exit(0);
}
console.log(`${failures} 项失败`);
process.exit(1);
