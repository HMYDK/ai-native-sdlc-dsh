#!/usr/bin/env node
/**
 * 基准用例 PWSH-1：验证者工具白名单的**平台分支**。
 *
 * 两侧对照：
 *   基线 896d569   白名单同时写 `bash` 与 `pwsh`
 *   修复 52212ad   按 `process.platform` 只放本平台存在的那个
 *
 * ## 为什么它是一个"类"而不是一个"点"
 *
 * `ctx.tools.restrict()` 对**不存在的工具名直接抛错**：
 *
 *     tools.restrict() names unknown global tool "pwsh"; known global tools: bash, glob, grep, read
 *
 * 而任一平台上 `bash` / `pwsh` 只有一个存在（官方 bundle 按平台禁用另一个）。
 * 实测（本用例）：**两个平台都坏**——
 *   · darwin：`pwsh` 不存在 → 拒绝
 *   · win32：`bash` 不存在 → 拒绝
 *
 * 所以这不是"mac 上的 bug"，是「**为平台 A 做的修复弄坏了平台 B**」这一类。
 * 本项目对"修复引入回归"有专门的记忆（STATUS-PAGE 第二轮也是这个形态）。
 *
 * ## win32 分支**真的被测到了**
 *
 * `process.platform` 是普通可配置属性，`Object.defineProperty` 能改
 * （实测 darwin → win32 → darwin 成功）。所以不需要 Windows 机器。
 * 值得记：先前 AGENTS.md 写着"未在 Windows 上实测"，而实际障碍不是
 * "没有 Windows"，是**没想到平台可以伪造**。
 *
 * ## 怎么拿到白名单
 *
 * `verifierToolAllow()` 没有导出，唯一出口是导出的 `apply()`：
 * 用**真实 Cordis Context + 真实 ToolRuntime**（其余服务用桩）调真实 `apply()`，
 * 再用真实 `ctx.tools.execute()` 派发 `sdlc_verify`，在 `subagents.start`
 * 的桩里捕获 `SubagentStartRequest`。**不需要 Electron、不需要 App、不需要 profile。**
 */
import path from 'node:path';
import { compileFiles, runCase, require } from './lib.mjs';
import { pathToFileURL } from 'node:url';

const BASELINE_REV = '896d569';
const FIX_REV = '52212ad';
// ⚠️ 这里**不能**写 `helpers.ts`：这两个历史 revision 的 src 下从来没有它
// （实测 `git show 896d569:packages/sdlc-verify/src/helpers.ts` → 不存在）。
// `compileFiles` 会静默跳过缺失文件，写错一个名字会让人误以为它被编译了。
const SRC = ['index.ts', 'verdict.ts', 'test-freeze.ts'];

/** 各平台**真实存在**的全局工具（按官方 bundle 的启用规则）。 */
const KNOWN_TOOLS = {
  darwin: ['read', 'grep', 'glob', 'bash', 'skill'],
  linux: ['read', 'grep', 'glob', 'bash', 'skill'],
  win32: ['read', 'grep', 'glob', 'pwsh', 'skill'],
};

/** 真实 Cordis + 真实 ToolRuntime；其余服务用桩；捕获子代理请求。 */
async function capture(mod, platform) {
  const { Context } = require('@deepseek-ai/cordis');
  const { ToolRuntime } = require('@deepseek-ai/dsh-tools');
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    const ctx = new Context();
    ctx.provide('systemPrompt', {
      section: () => () => {}, tools: () => () => {}, variable: () => () => {},
      context: () => () => {}, getSectionOrder: () => 0, getContextOrder: () => 0,
    });
    const captured = { requests: [] };
    ctx.provide('subagents', {
      start: async (_provider, request) => {
        captured.requests.push(request);
        return {
          id: 'probe-child', localAgent: undefined,
          result: Promise.resolve({
            output: [{ type: 'text', text: 'probe' }],
            structured: { status: 'needs_human', summary: 'probe', findings: [], unverified: ['probe'] },
            stopReason: 'end_turn',
          }),
          dispose: async () => {},
        };
      },
    });
    ctx.provide('fs', {
      resolve: async (p) => ({ targetKey: p, displayPath: p }),
      stat: async () => undefined,
      readText: async () => { throw new Error('ENOENT'); },
      writeText: async () => ({ version: 'v1' }),
    });
    ctx.provide('sandboxPolicy', { resolve: () => undefined });
    new ToolRuntime(ctx, 'tools');

    const validated = mod.Config['~standard'].validate({});
    if (validated.issues) throw new Error(`Config 校验失败: ${JSON.stringify(validated.issues)}`);
    mod.apply(ctx, validated.value);

    // ⚠️ 必须走真实 ToolRuntime：直接调 `tool.execute({arguments:{…}})`
    // 会被参数包装拒绝（实测报 missing required property "intent_of_change"，
    // 即使那个属性明明传了）。
    await ctx.tools.execute({
      callId: 'probe-1', name: 'sdlc_verify',
      arguments: { intent_of_change: '探针', criteria: ['a'] },
      agent: { id: 'probe', session: { header: { cwd: '/repo' } } },
      signal: new AbortController().signal,
    });
    const req = captured.requests[0];
    if (!req) throw new Error('subagents.start 没被调用（捕获不到 toolFilter）');
    return { allow: req.toolFilter?.allow ?? [] };
  } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true });
  }
}

async function judge(mod) {
  const out = [];
  for (const p of ['darwin', 'win32']) {
    const known = KNOWN_TOOLS[p];
    const want = p === 'win32' ? 'pwsh' : 'bash';
    try {
      const { allow } = await capture(mod, p);
      const unknown = allow.filter((t) => !known.includes(t));
      const shells = allow.filter((t) => t === 'bash' || t === 'pwsh');
      out.push([`${p}: 白名单里没有该平台不存在的工具`, unknown.length === 0,
        unknown.length ? `不存在的: ${unknown.join(', ')}` : allow.join(', ')]);
      out.push([`${p}: shell 恰好一个且是 ${want}`, shells.length === 1 && shells[0] === want,
        `shell=[${shells.join(',')}]`]);
      out.push([`${p}: 只读三件套在`, ['read', 'grep', 'glob'].every((t) => allow.includes(t)),
        allow.join(', ')]);
      out.push([`${p}: 不含写能力`, !allow.includes('write') && !allow.includes('edit'),
        allow.join(', ')]);
    } catch (e) {
      out.push([`${p}: apply/execute 不抛错`, false, e.message.slice(0, 140)]);
    }
  }
  return out;
}

/**
 * ⚠️ 验证者的产物需要 **ESM** 加载：它 `import` 别的模块，
 * 而 `makeWorkdir` 默认声明 `commonjs`。所以这里给该版本单独标 `type: module`。
 * （`52212ad` 的包本来就是 `"type": "module"`。）
 *
 * ⚠️ 编译用 `noCheck`（只转译、不类型检查）——这是**实测诊断**出来的，不是猜：
 *
 *     $ tsc -p …/896d569-module/tsconfig.json
 *     src/index.ts(297,11): error TS2353: 'toolFilter' does not exist in type 'SubagentStartRequest'
 *     src/index.ts(313,58): error TS2339: Property 'start' does not exist on type 'SubagentRuntime'
 *
 * 原因是 2026-10-19 App 升到 DSH 0.2.1 后，`ctx.subagents.start()` 与
 * `SubagentStartRequest.toolFilter` 已从运行时类型里删除（见 AGENTS.md
 * 「0.2.1 兼容性」）。这两个 revision 是针对 0.2.0 API 写的，拿今天的
 * node_modules 类型去检查**必然**失败；而本用例比较的是**运行时行为**
 * （白名单按平台选），与类型漂移无关。所以正确处置是换成只转译，
 * **不是**改历史源码去迁就新类型。
 */
const compile = async (rev, work) => {
  const lib = compileFiles(rev, 'packages/sdlc-verify/src', SRC, work, { noCheck: true });
  return import(pathToFileURL(path.join(lib, 'index.js')).href);
};

export async function main({ json } = {}) {
  return runCase({
    id: 'PWSH-1',
    title: '验证者工具白名单没按平台选（两个平台都会报错）',
    baselineRev: BASELINE_REV,
    fixedRev: FIX_REV,
    baselineLabel: `基线 ${BASELINE_REV}（bash + pwsh 都写）`,
    fixedLabel: `修复 ${FIX_REV}（按平台选）`,
    compile,
    judge: (mod) => judge(mod),
    json,
    moduleType: 'module',
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const r = await main({ json: process.argv.includes('--json') });
  process.exit(r.ok ? 0 : 1);
}
