/**
 * sdlc-workflow 的运行时冒烟测试。
 *
 * ## 它证明什么（以及为什么不只是"形状对"）
 *
 * 单测（`lib/skill.test.js`）只保证**内容**齐备。加载成功 ≠ 注册成功：
 * 一个插件可以完美导出，却在 `apply()` 里因为 `inject` 少写一个服务、
 * 或注册形状不对而**什么都没注册**——而失败的现场只是"这个 Skill 不出现"。
 *
 * 所以这里用**真实 Cordis Context** 挂载插件，`ctx.skills` 用一个**桩**去接，
 * 断言：注册被调用、内容原样到达、dispose 归还。
 *
 * 用法：
 *   BASE="/Applications/DeepSeek Harness.app/Contents"
 *   ELECTRON_RUN_AS_NODE=1 "$BASE/MacOS/DeepSeek Harness" --expose-internals \
 *     packages/sdlc-workflow/smoke.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_MODULES =
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules';
const require = createRequire(path.join(APP_MODULES, 'noop.js'));

let passCount = 0;
let failures = 0;
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
  ok('Config 是 Standard Schema 校验器（本仓库踩过裸对象报 validate 的坑）');
} else {
  bad('Config 不是 Standard Schema');
}
const validated = plugin.Config['~standard'].validate({});
if (validated.issues) bad(`配置校验失败: ${JSON.stringify(validated.issues)}`);
else ok(`默认配置: ${JSON.stringify(validated.value ?? {})}`);

console.log('\n== 2. 真实 Cordis 上下文里挂载，并接住注册 ==');
const { Context } = require('@deepseek-ai/cordis');
const ctx = new Context();

/** 桩：记录注册与返还，并暴露成 `ctx.skills`。 */
const registered = [];
let disposed = 0;
ctx.provide('skills', {
  register(skill) {
    registered.push(skill);
    return () => {
      disposed += 1;
    };
  },
});

const cfg = plugin.Config['~standard'].validate({});
plugin.apply(ctx, cfg.value);

if (registered.length === 1) ok('apply() 恰好注册了 1 个 Skill');
else bad(`应当注册 1 个，实际 ${registered.length} 个`);

const skill = registered[0];
if (skill === undefined) {
  bad('没有拿到注册内容，后面无法继续');
} else {
  console.log('\n== 3. 注册内容的形状与内容 ==');
  if (typeof skill.name === 'string' && skill.name.length > 0) ok(`name=${skill.name}`);
  else bad(`name 不合法：${JSON.stringify(skill.name)}`);
  if (typeof skill.description === 'string' && skill.description.length > 0) {
    ok(`description=${skill.description.slice(0, 60)}…`);
  } else bad('description 缺失或为空');
  if (skill.source === 'bundled') ok("source='bundled'（register() 的必填项）");
  else bad(`source 应为 bundled，实际 ${JSON.stringify(skill.source)}`);
  if (typeof skill.content === 'string' && skill.content.length > 200) {
    ok(`content ${skill.content.length} 字符`);
  } else bad(`content 太短：${String(skill.content).length} 字符`);

  // 内容必须**原样**到达——不是被截断或被包装过的
  const mod = await import(pathToFileURL(path.join(PLUGIN_DIR, 'lib/skill.js')).href);
  if (skill.content === mod.SKILL_CONTENT) ok('注册的内容与模块导出的正文逐字一致（未被改动）');
  else bad('注册的内容与模块正文不一致');
  if (skill.name === mod.SKILL_NAME) ok('注册的名字与模块常量一致');
  else bad('注册的名字与模块常量不一致');

  // 它必须真的是"给验证者的"，而不是通用规范
  if (/验证者/.test(skill.content) && /质问作者/.test(skill.content)) {
    ok('内容明确指向「由验证者质问作者」（这是它区别于一份规范的地方）');
  } else bad('内容没有指向验证者——它退化成一份文档了');
}

console.log('\n== 4. 卸载时归还（不留悬空注册） ==');
try {
  // ⚠️ 正确的卸载入口是 `ctx.fiber.dispose()`，不是 `ctx.dispose()`
  //（后者不存在——我第一版写错了，冒烟立刻报 TypeError）。
  await ctx.fiber.dispose();
  if (disposed === 1) ok('dispose 后桩记录的归还次数为 1');
  else bad(`dispose 归还次数应为 1，实际 ${disposed}`);
} catch (e) {
  bad(`ctx.fiber.dispose() 抛错：${String(e).slice(0, 120)}`);
}

console.log('');
console.log(`断言总数：${passCount + failures}（通过 ${passCount}，失败 ${failures}）`);
if (failures > 0) {
  console.log('有失败项');
  process.exit(1);
}
console.log('全部通过');
