/**
 * sdlc-task 的运行时冒烟测试。
 *
 * 用**真实的 Cordis 上下文 + 真实 ToolRuntime**挂载插件，`ctx.fs` 用一个
 * 内存文件系统桩（这样能真的跑完 create → status → advance 全流程，
 * 不需要碰用户的仓库）。不需要重启 App，也不碰用户 profile。
 *
 * 之所以要这一层：单测覆盖了纯逻辑，但覆盖不到"工具能不能真的被调用"、
 * "contextual 类型对不对"、"错误信息是否可读"。上一轮的经验是——
 * 加载成功 ≠ 可用，必须真的 dispatch 工具调用。
 *
 * 用法：
 *   BASE="/Applications/DeepSeek Harness.app/Contents"
 *   ELECTRON_RUN_AS_NODE=1 "$BASE/MacOS/DeepSeek Harness" --expose-internals \
 *     packages/sdlc-task/smoke.mjs
 */

import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

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
if (typeof plugin.Config?.['~standard']?.validate === 'function') {
  ok('Config 是 Standard Schema 校验器');
} else {
  bad('Config 不是 Standard Schema（会抛 reading \'validate\'）');
}
const validated = plugin.Config['~standard'].validate({});
if (validated.issues) bad(`配置校验失败: ${JSON.stringify(validated.issues)}`);
else ok(`默认配置: ${JSON.stringify(validated.value)}`);

console.log('\n== 2. 挂载到真实上下文（ctx.fs 用内存桩）==');
const ctx = new Context();

// systemPrompt 桩：ToolRuntime 构造时会调 tools()
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

// 内存文件系统桩：只实现插件用到的 resolve/stat/readText/writeText
const files = new Map();
ctx.provide('fs', {
  async resolve(p) {
    return { targetKey: p, displayPath: p };
  },
  async stat(target) {
    if (files.has(target.displayPath)) return { type: 'file', version: 'v1' };
    if (target.displayPath.endsWith('/')) return { type: 'directory', version: 'v1' };
    return undefined;
  },
  async readText(target) {
    const v = files.get(target.displayPath);
    if (v === undefined) throw new Error(`ENOENT: ${target.displayPath}`);
    return v;
  },
  async writeText(target, content) {
    files.set(target.displayPath, content);
    return { version: 'v1' };
  },
});

const rt = new ToolRuntime(ctx, 'tools');
if (ctx.tools === undefined) bad('ToolRuntime 未挂到 ctx.tools');
else ok('真实 ToolRuntime 已挂载');

// session.header.cwd 是插件定位仓库根的依据
const agent = { id: 'smoke-session', session: { header: { cwd: '/repo' } } };

function apply(config) {
  plugin.apply(ctx, config ?? validated.value);
}

try {
  apply();
  ok('apply() 正常返回');
} catch (e) {
  bad(`apply() 抛错: ${e.message}`);
  process.exit(1);
}

console.log('\n== 3. 工具注册 ==');
for (const n of ['sdlc_task_create', 'sdlc_task_status', 'sdlc_task_advance']) {
  if (ctx.tools.get(n) === undefined) bad(`${n} 未注册`);
  else ok(`${n} 已注册`);
}
if (sections.length === 1) ok(`提示词段: ${sections[0].name} order=${sections[0].order}`);
else bad(`提示词段数量=${sections.length}，期望 1`);

console.log('\n== 4. 真正调用工具（create → status → advance）==');
let seq = 0;
const dispatch = (name, args) =>
  ctx.tools.execute({
    callId: `smoke-${name}-${(seq += 1)}`,
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  });

// 4a. create
const created = await dispatch('sdlc_task_create', {
  task_id: 'proj-7',
  title: '客户自助查询理赔状态',
});
if (created.isError) bad(`create 失败: ${JSON.stringify(created.error)}`);
else {
  ok(`create → task=${created.value.task} status=${created.value.status}`);
  if (created.value.task === 'PROJ-7') ok('task id 已归一化为大写');
  else bad(`task id 未归一化: ${created.value.task}`);
  if (files.has('/repo/.ai/tasks/PROJ-7/state.yaml')) ok('state.yaml 已写入');
  else bad('state.yaml 未写入');
  if (files.has('/repo/.ai/tasks/PROJ-7/intent.md')) ok('intent.md 骨架已写入');
  else bad('intent.md 未写入');
}

// 4b. 重复 create 必须被拒
const dup = await dispatch('sdlc_task_create', { task_id: 'PROJ-7', title: '再来一次' });
if (dup.isError && /已存在/.test(JSON.stringify(dup.content ?? dup.error))) {
  ok('重复创建被拒（并说明已存在）');
} else {
  bad(`重复创建未被拒: ${JSON.stringify(dup.value ?? dup.error)}`);
}

// 4c. status 应报告"下一状态需要 spec"
const st = await dispatch('sdlc_task_status', { task_id: 'PROJ-7' });
if (st.isError) bad(`status 失败: ${JSON.stringify(st.error)}`);
else {
  ok(`status → ${st.value.status}, 自洽=${st.value.consistent}`);
  if (Array.isArray(st.value.next_required) && st.value.next_required.includes('spec')) {
    ok('status 报出下一状态需要 spec');
  } else {
    bad(`next_required 不含 spec: ${JSON.stringify(st.value.next_required)}`);
  }
}

// 4d. 缺 spec 时 advance 必须被拒，且说明缺什么
const badAdvance = await dispatch('sdlc_task_advance', {
  task_id: 'PROJ-7',
  to: 'SPEC',
  reason: '接受意图',
});
if (badAdvance.isError && /spec/.test(JSON.stringify(badAdvance.content ?? badAdvance.error))) {
  ok('缺 spec 时 advance 被拒，并点名缺 spec');
} else {
  bad(`advance 未被正确拒绝: ${JSON.stringify(badAdvance.value ?? badAdvance.error)}`);
}

// 4d-2. 文件在磁盘上但**没登记**进 artifacts，同样不许前进——
//       状态机守的是 state.yaml 这个事实来源，不是"碰巧存在的文件"。
{
  files.set('/repo/.ai/tasks/PROJ-7/spec.md', '# Spec (未登记)\n');
  const r = await dispatch('sdlc_task_advance', {
    task_id: 'PROJ-7',
    to: 'SPEC',
    reason: '接受意图',
  });
  const text = JSON.stringify(r.content ?? r.error ?? '');
  if (r.isError && /没有登记/.test(text)) {
    ok('文件在但未登记 → 仍被拒（守的是事实来源，不是碰巧存在的文件）');
  } else {
    bad(`未登记却被放行: ${JSON.stringify(r.value ?? r.error)}`);
  }
  if (/artifacts 参数登记/.test(text)) ok('拒绝信息提示了可用 artifacts 参数登记');
  else bad('拒绝信息没有告诉人怎么满足门槛');
}

// 4e. 空 reason 被拒
const noReason = await dispatch('sdlc_task_advance', { task_id: 'PROJ-7', to: 'SPEC', reason: '   ' });
if (noReason.isError) ok('空 reason 的迁移被拒');
else bad('空 reason 的迁移被放行');

// 4f. 补齐 spec 并登记后可以前进
{
  // 注意：不要用字符串替换去改 YAML —— 值的引号形态会随序列化实现变化
  // （修引号 bug 后 "intent.md" 带上了引号，字符串替换就失效了）。
  // 解析 → 改结构 → 重新序列化，才是稳的。
  const { load, dump, JSON_SCHEMA } = require('js-yaml');
  const stateFile = '/repo/.ai/tasks/PROJ-7/state.yaml';
  const doc = load(files.get(stateFile), { schema: JSON_SCHEMA });
  doc.artifacts.spec = 'spec.md';
  files.set(stateFile, dump(doc, { schema: JSON_SCHEMA, noRefs: true }));
  files.set('/repo/.ai/tasks/PROJ-7/spec.md', '# Spec\n');
  const good = await dispatch('sdlc_task_advance', {
    task_id: 'PROJ-7',
    to: 'SPEC',
    reason: '产品负责人接受意图',
    artifacts: { spec: 'spec.md' },
  });
  if (good.isError) bad(`补齐 spec 后 advance 仍失败: ${JSON.stringify(good.error)}`);
  else ok(`advance → ${good.value.from} → ${good.value.to} (${good.value.direction})`);
}

// 4g. 回退允许
{
  const back = await dispatch('sdlc_task_advance', {
    task_id: 'PROJ-7',
    to: 'INTENT',
    reason: '发现意图本身需要修正',
  });
  if (back.isError) bad(`回退被拒（不该）: ${JSON.stringify(back.error)}`);
  else ok(`回退允许 → ${back.value.direction}`);
}

// 4h. 非法目标状态
const badTo = await dispatch('sdlc_task_advance', { task_id: 'PROJ-7', to: 'NOPE', reason: 'x' });
if (badTo.isError && /允许值/.test(JSON.stringify(badTo.content ?? badTo.error))) {
  ok('非法目标状态被拒，并列出允许值');
} else {
  bad('非法目标状态未被正确拒绝');
}

// 4i. 不存在的任务
const missing = await dispatch('sdlc_task_status', { task_id: 'NOPE-1' });
if (missing.isError) ok('不存在的任务给出错误（而不是空结果）');
else bad('不存在的任务未报错');

// 4j. 没有 cwd 的会话
{
  const noCwd = await ctx.tools.execute({
    callId: 'smoke-nocwd',
    name: 'sdlc_task_status',
    arguments: { task_id: 'PROJ-7' },
    agent: { id: 'no-cwd-agent' },
    signal: new AbortController().signal,
  });
  if (noCwd.isError && /cwd/.test(JSON.stringify(noCwd.content ?? noCwd.error))) {
    ok('拿不到 cwd 时给出可读错误（而不是崩）');
  } else {
    bad(`拿不到 cwd 时的行为不符: ${JSON.stringify(noCwd.value ?? noCwd.error)}`);
  }
}

console.log('\n== 5. 落盘的 state.yaml 内容自查 ==');
{
  const text = files.get('/repo/.ai/tasks/PROJ-7/state.yaml') ?? '';
  const { JSON_SCHEMA, load } = require('js-yaml');
  try {
    const parsed = load(text, { schema: JSON_SCHEMA });
    if (parsed.status === 'INTENT' && Array.isArray(parsed.history) && parsed.history.length >= 3) {
      ok(`state.yaml 可解析，status=${parsed.status}，history ${parsed.history.length} 条（只追加）`);
    } else {
      bad(`state.yaml 内容不符: ${JSON.stringify(parsed).slice(0, 160)}`);
    }
  } catch (e) {
    bad(`写出的 state.yaml 无法解析: ${e.message.split('\n')[0]}`);
  }
}

console.log('');
console.log(`断言总数：${passCount + failures}（通过 ${passCount}，失败 ${failures}）`);
if (failures === 0) {
  console.log('全部通过');
  process.exit(0);
}
process.exit(1);
