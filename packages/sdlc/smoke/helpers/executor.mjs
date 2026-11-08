import './runtime.mjs';

/**
 * DSH 0.2.2 把工具执行器从 ToolRuntime 拆成独立插件。
 * 裸 Cordis 冒烟也要选择 App 自带的真实执行器，才能实际调用工具。
 * 旧版 ToolRuntime 没有 setExecutor，继续使用它内置的执行路径。
 */
export function installNativeExecutor(ctx, runtimeRequire) {
  if (typeof ctx.tools.setExecutor !== 'function') return;
  const { NativeToolExecutor } = runtimeRequire('@deepseek-ai/dsh-tool-executor-native');
  ctx.tools.setExecutor(new NativeToolExecutor(ctx));
}

/** 保留单次调用的测试接口；新版通过真实执行器派发单条 batch。 */
export async function executeTool(ctx, input) {
  if (typeof ctx.tools.setExecutor !== 'function') return ctx.tools.execute(input);
  const { callId, name, arguments: args, ...options } = input;
  const batch = await ctx.tools.execute({
    ...options,
    calls: [{ id: callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }],
  });
  if (batch.results.length !== 1 || batch.results[0].callId !== callId) {
    throw new Error(`工具执行器未返回 ${callId} 的唯一结果`);
  }
  return batch.results[0].result;
}
