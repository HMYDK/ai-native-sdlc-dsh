import type { Context } from '@deepseek-ai/cordis';
import type { ToolExecutionInput, ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools';

/**
 * 插件内部的工具调用不是新的模型 batch：必须保留 parent/rootCallId、
 * 取消信号、权限检查及后置策略。0.2.2 的 tools.execute 只接收模型 batch，
 * 内部调用改用宿主导出的共享 pipeline；0.2.1 继续走原来的公开接口。
 */
export async function invokeTool(
  ctx: Context,
  parent: ToolRunContext,
  call: Pick<ToolExecutionInput, 'callId' | 'name' | 'arguments'>,
): Promise<ToolExecutionResult> {
  const input = {
    ...call,
    rootCallId: parent.rootCallId,
    parent: parent.token,
    agent: parent.agent,
    signal: parent.signal,
    // 新版为每个模型 step 保留的工具集合，也适用于内部调用。
    ...('toolSet' in parent ? { toolSet: parent.toolSet } : {}),
  };
  if (!('setExecutor' in ctx.tools) || typeof ctx.tools.setExecutor !== 'function') {
    return ctx.tools.execute(input);
  }
  // 旧运行时没有这个子路径，必须按需加载，不能在模块顶层静态 import。
  const moduleName = '@deepseek-ai/dsh-tools/pipeline';
  const { ToolExecutionPipeline } = await import(moduleName);
  const pipeline = new ToolExecutionPipeline(ctx);
  const prepared = await pipeline.prepare(input);
  const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared;
  return pipeline.complete(prepared.exec, outcome);
}
