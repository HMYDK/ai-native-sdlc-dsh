import { installNativeExecutor, executeTool } from './helpers/executor.mjs';
import { runtimeModules } from './helpers/runtime.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { invokeTool } from '../lib/shared/invoke-tool.js';

// 0.6.1 起最低支持 DSH 0.2.2；DSH_SMOKE_MODULES 可指向另一份同代依赖复核同一组行为。
const require = createRequire(path.join(runtimeModules, 'noop.js'));
const { Context } = require('@deepseek-ai/cordis');
const { ToolRuntime, defineTool } = require('@deepseek-ai/dsh-tools');
const ctx = new Context();
ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} });
new ToolRuntime(ctx, 'tools');
installNativeExecutor(ctx, require);
const seen = new Map();
let bodies = 0;
let blocked = false;
const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
ctx.on('tools/pre-execute', async (exec, next) => { seen.set(exec.name, exec); return next(); });
ctx.tools.guard(exec => blocked && exec.name === 'leaf' ? 'fixture denial' : undefined);
ctx.tools.register(defineTool({ name: 'leaf', description: 'Nested fixture', parameters: {}, output,
  async execute() { bodies++; return { reached: true }; },
}));
ctx.tools.register(defineTool({ name: 'outer', description: 'Composite fixture', parameters: {}, output,
  async execute(_args, exec) {
    return { child: await invokeTool(ctx, exec, { callId: 'child-call', name: 'leaf', arguments: {} }) };
  },
}));
const call = signal => executeTool(ctx, { callId: 'root-call', name: 'outer', arguments: {}, signal: signal ?? new AbortController().signal });
try {
  const result = await call();
  assert.equal(result.isError, false);
  assert.equal(result.value.child.value.reached, true);
  assert.equal(seen.get('leaf').parent, seen.get('outer').token);
  assert.equal(seen.get('leaf').rootCallId, 'root-call');
  assert.equal(seen.get('leaf').callId, 'child-call');
  assert.notEqual(seen.get('leaf').token, seen.get('outer').token);
  blocked = true;
  const denied = await call();
  assert.equal(denied.value.child.isError, true);
  assert.match(denied.value.child.error.message, /fixture denial/);
  assert.equal(bodies, 1, 'guard 拒绝时不能调用 body');
  blocked = false;
  const release = ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'leaf'
    ? { kind: 'block', feedback: [{ type: 'text', text: 'post-policy denial' }] } : next());
  const post = await call();
  assert.equal(post.value.child.isError, true, '不能跳过后置策略');
  release();
  const cancellation = new AbortController();
  cancellation.abort();
  assert.equal((await call(cancellation.signal)).isError, true);
  assert.equal(bodies, 2, '取消后不能继续执行');
  console.log('Nested tool compatibility: 12 assertions passed (real runtime, parent identity, guards, post-policy, cancellation)');
} finally { await ctx.fiber.dispose(); }
