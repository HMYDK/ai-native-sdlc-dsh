/**
 * sdlc-artifact 的运行时冒烟测试。
 *
 * 用**真实 Cordis 上下文 + 真实 ToolRuntime**挂载插件，`ctx.fs` 用内存桩，
 * 真的 dispatch 工具调用。不需要重启 App，也不碰用户 profile。
 *
 * 用法：
 *   BASE="/Applications/DeepSeek Harness.app/Contents"
 *   ELECTRON_RUN_AS_NODE=1 "$BASE/MacOS/DeepSeek Harness" --expose-internals \
 *     packages/sdlc-artifact/smoke.mjs
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
  bad("Config 不是 Standard Schema（会抛 reading 'validate'）");
}
const validated = plugin.Config['~standard'].validate({});
if (validated.issues) bad(`配置校验失败: ${JSON.stringify(validated.issues)}`);
else ok(`默认配置: ${JSON.stringify(validated.value)}`);

console.log('\n== 2. 挂载到真实上下文 ==');
const ctx = new Context();
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

const files = new Map();
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

const WORKSPACE_ROOT = '/repo';
ctx.provide('sandboxPolicy', {
  resolve({ session }) {
    return session === undefined
      ? undefined
      : { mode: 'workspace-write', workspaceRoot: WORKSPACE_ROOT };
  },
});

const rt = new ToolRuntime(ctx, 'tools');
if (ctx.tools === undefined) bad('ToolRuntime 未挂到 ctx.tools');
else ok('真实 ToolRuntime 已挂载');

const agent = { id: 'smoke', session: { header: { cwd: '/repo' } } };

try {
  plugin.apply(ctx, validated.value);
  ok('apply() 正常返回');
} catch (e) {
  bad(`apply() 抛错: ${e.message}`);
  process.exit(1);
}

console.log('\n== 3. 工具注册与提示词段 ==');
for (const n of ['sdlc_artifact_write', 'sdlc_artifact_check']) {
  if (ctx.tools.get(n) === undefined) bad(`${n} 未注册`);
  else ok(`${n} 已注册`);
}
if (sections.length === 1) ok(`提示词段: ${sections[0].name} order=${sections[0].order}`);
else bad(`提示词段数量=${sections.length}，期望 1`);

let seq = 0;
const dispatch = (name, args) =>
  ctx.tools.execute({
    callId: `smoke-${name}-${(seq += 1)}`,
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  });

// ── 一个合格的任务 state.yaml 与合格制品
const TASK = 'PROJ-3';
const taskDir = `/repo/.ai/tasks/${TASK}`;
files.set(
  `${taskDir}/state.yaml`,
  [
    `task: ${TASK}`,
    'title: "冒烟任务"',
    'status: INTENT',
    'created: "2026-10-07T10:00:00.000Z"',
    'updated: "2026-10-07T10:00:00.000Z"',
    'artifacts:',
    '  intent: "intent.md"',
    'history: []',
    '',
  ].join('\n'),
);

const goodIntent = [
  '# Intent: 冒烟',
  '',
  '## Problem',
  '',
  '客服每天接到大量只问进度电话，占了大约三分之一通话时长。',
  '',
  '## Proposed outcome',
  '',
  '客户在门户里能看到状态、下一步和预计时间。',
  '',
  '## Affected users and systems',
  '',
  '理赔专员、门户团队、claims-core API。',
  '',
  '## Constraints',
  '',
  '门户会话里不引入新的 PII；只用现有认证。不新建微服务。',
  '',
  '## Open questions',
  '',
  '第三方定损师是否也需要访问？',
  '',
].join('\n');

console.log('\n== 4. sdlc_artifact_check：先查草稿，不写盘 ==');
{
  const before = files.size;
  const r = await dispatch('sdlc_artifact_check', { kind: 'intent', content: goodIntent });
  if (r.isError) bad(`check 失败: ${JSON.stringify(r.error)}`);
  else {
    if (r.value.ok === true) ok('合格草稿判为通过');
    else bad(`合格草稿被判不通过: ${JSON.stringify(r.value.details)}`);
    if (files.size === before) ok('check 没有写任何文件（只读）');
    else bad('check 竟然写了文件');
    if (Array.isArray(r.value.required_sections) && r.value.required_sections.length === 5) {
      ok('报告里列出了 5 个必需章节');
    } else {
      bad('required_sections 不对');
    }
  }

  // 有标题无正文 —— 最危险的一类
  const emptySection = goodIntent.replace(
    /## Open questions\n\n[^\n]*\n/,
    '## Open questions\n\n',
  );
  const r2 = await dispatch('sdlc_artifact_check', { kind: 'intent', content: emptySection });
  if (r2.isError) bad('check 报错');
  else if (r2.value.ok === false && r2.value.empty.includes('Open questions')) {
    ok('「有标题但无正文」被单列为 empty（不是 missing）');
  } else {
    bad(`空章节未被正确识别: ${JSON.stringify(r2.value)}`);
  }
}

console.log('\n== 5. sdlc_artifact_write：写文件 + 登记 ==');
{
  const r = await dispatch('sdlc_artifact_write', {
    task_id: TASK,
    kind: 'intent',
    content: goodIntent,
  });
  if (r.isError) bad(`write 失败: ${JSON.stringify(r.error)}`);
  else {
    ok(`写入 ${r.value.path}`);
    if (r.value.structure_ok === true) ok('结构检查通过');
    else bad(`结构检查未通过: ${JSON.stringify(r.value.findings)}`);
    if (files.get(`${taskDir}/intent.md`) === goodIntent) ok('文件内容与传入一致（逐字）');
    else bad('写下的内容与传入不一致');
    if (/制品登记：intent/.test(r.value.registration)) ok('已登记进 state.yaml');
    else bad(`未登记: ${r.value.registration}`);
    if (r.value.quality_checked === false) ok('如实声明"没有检查质量"');
    else bad('quality_checked 应为 false（我们只查结构）');
  }

  // 拒绝静默覆盖
  const dup = await dispatch('sdlc_artifact_write', {
    task_id: TASK,
    kind: 'intent',
    content: goodIntent,
  });
  if (dup.isError && /已存在/.test(JSON.stringify(dup.content ?? dup.error))) {
    ok('重复写入被拒（防静默替换「当初要求的是什么」）');
  } else {
    bad(`重复写入未被拒: ${JSON.stringify(dup.value ?? dup.error)}`);
  }

  // 明确覆盖才放行
  const forced = await dispatch('sdlc_artifact_write', {
    task_id: TASK,
    kind: 'intent',
    content: goodIntent + '\n补充：已与法务确认无需额外授权。\n',
    overwrite: true,
  });
  if (forced.isError) bad(`overwrite 被拒（不该）: ${JSON.stringify(forced.error)}`);
  else ok('overwrite: true 时允许覆盖');
}

console.log('\n== 6. 结构不合格时的行为 ==');
{
  const incomplete = '# Spec: 半成品\n\n## Requirements\n\n有需求。\n';
  const r = await dispatch('sdlc_artifact_write', {
    task_id: TASK,
    kind: 'spec',
    content: incomplete,
  });
  if (r.isError) bad(`write 失败: ${JSON.stringify(r.error)}`);
  else {
    if (r.value.structure_ok === false) ok('不合格制品被判结构不通过');
    else bad('不合格制品被判通过');
    const missingCount = r.value.findings.length;
    if (missingCount === 2) ok('报出 2 项缺失（Design / Areas of concern）');
    else bad(`应报 2 项，实际 ${missingCount}: ${JSON.stringify(r.value.findings)}`);
    if (/未登记/.test(r.value.registration)) ok('结构不通过时不登记（状态机不会看到半成品）');
    else bad(`结构不通过却登记了: ${r.value.registration}`);
  }

  // 骨架必须是"明显没写完"的状态
  const sk = await dispatch('sdlc_artifact_write', {
    task_id: TASK,
    kind: 'plan',
    title: '冒烟计划',
  });
  if (sk.isError) bad(`骨架写入失败: ${JSON.stringify(sk.error)}`);
  else if (sk.value.structure_ok === false) {
    ok('骨架故意判为不通过（免得生成骨架就算完成）');
  } else {
    bad('骨架竟然通过了结构检查——那门禁毫无意义');
  }
}

console.log('\n== 7. 从磁盘检查已有制品 ==');
{
  const r = await dispatch('sdlc_artifact_check', { kind: 'intent', task_id: TASK });
  if (r.isError) bad(`按 task_id 检查失败: ${JSON.stringify(r.error)}`);
  else if (r.value.ok === true) ok('按 task_id 读磁盘制品并判为通过');
  else bad(`磁盘上的 intent 未通过: ${JSON.stringify(r.value.details)}`);

  // 用真正不存在的类型：第 6 节写过半成品 spec.md、也写过 plan 骨架，
  // 所以只有这两者之外的路径才是"不存在"。（第一版这里写错了，被自己的测试抓到。）
  files.delete(`${taskDir}/spec.md`);
  const miss = await dispatch('sdlc_artifact_check', { kind: 'spec', task_id: TASK });
  if (miss.isError && /没有 spec\.md/.test(JSON.stringify(miss.content ?? miss.error))) {
    ok('不存在的制品给出可读错误');
  } else {
    bad(`不存在的制品行为不符: ${JSON.stringify(miss.value ?? miss.error)}`);
  }
}

console.log('\n== 8. 输入校验 ==');
{
  for (const [label, args] of [
    ['非法 kind', { kind: 'review', content: 'x' }],
    ['既无 content 也无 task_id', { kind: 'intent' }],
  ]) {
    const r = await dispatch('sdlc_artifact_check', args);
    if (r.isError) ok(`${label} 被拒`);
    else bad(`${label} 未报错`);
  }
  const noCwd = await ctx.tools.execute({
    callId: 'smoke-nocwd',
    name: 'sdlc_artifact_check',
    arguments: { kind: 'intent', task_id: TASK },
    agent: { id: 'no-cwd' },
    signal: new AbortController().signal,
  });
  if (noCwd.isError && /cwd/.test(JSON.stringify(noCwd.content ?? noCwd.error))) {
    ok('拿不到 cwd 时给出可读错误');
  } else {
    bad(`无 cwd 时行为不符: ${JSON.stringify(noCwd.value ?? noCwd.error)}`);
  }
}

console.log('\n== 9. 沙箱接线（漏传 cwd/policy 会导致写入被拒）==');
{
  const missingCwd = resolveCalls.filter((c) => c.cwd === undefined);
  if (missingCwd.length === 0) ok(`每次 fs.resolve 都带了 cwd（共 ${resolveCalls.length} 次）`);
  else bad(`${missingCwd.length} 次 resolve 没有 cwd，例：${missingCwd[0].path}`);

  const wrongRoot = resolveCalls.filter((c) => c.cwd !== undefined && c.cwd !== WORKSPACE_ROOT);
  if (wrongRoot.length === 0) ok('resolve 的 cwd 一律是会话的 workspace 根');
  else bad(`有 ${wrongRoot.length} 次用了别的 cwd：${wrongRoot[0].cwd}`);

  const noPolicy = writeCalls.filter((w) => w.policy === undefined);
  if (writeCalls.length === 0) bad('没有任何 writeText 调用');
  else if (noPolicy.length === 0) ok(`每次 writeText 都带了沙箱策略（共 ${writeCalls.length} 次）`);
  else bad(`${noPolicy.length} 次 writeText 没带策略`);
}

console.log('\n== 10. 落盘内容自查 ==');
{
  const intentText = files.get(`${taskDir}/intent.md`) ?? '';
  if (intentText.includes('## Open questions')) ok('落盘的 intent.md 含 Open questions');
  else bad('落盘的 intent.md 缺章节');

  const st = files.get(`${taskDir}/state.yaml`) ?? '';
  if (/^\s{2}intent:\s*"intent\.md"/m.test(st)) ok('state.yaml 里登记了 intent');
  else bad(`state.yaml 未登记 intent:\n${st}`);
  if (/^\s{2}plan:/m.test(st)) bad('结构不合格的 plan 竟然被登记了');
  else ok('骨架那一份**没有**被登记（结构不通过）');
}

console.log('');
console.log(`断言总数：${passCount + failures}（通过 ${passCount}，失败 ${failures}）`);
if (failures === 0) {
  console.log('全部通过');
  process.exit(0);
}
process.exit(1);
