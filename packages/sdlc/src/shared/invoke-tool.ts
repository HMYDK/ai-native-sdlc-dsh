import type { Context } from '@deepseek-ai/cordis';
import type { ToolExecutionInput, ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools';

/**
 * 插件内部的工具调用不是新的模型 batch：必须保留 parent/rootCallId、
 * 取消信号、权限检查及后置策略。DSH 0.2.2 的 `tools.execute()` 只接收
 * 模型 batch，内部嵌套调用统一走宿主导出的共享 pipeline。
 *
 * 0.6.1 起最低支持 DSH 0.2.2，不再保留 0.2.1 的单调用回退分支。
 */
export async function invokeTool(
  ctx: Context,
  parent: ToolRunContext,
  call: Pick<ToolExecutionInput, 'callId' | 'name' | 'arguments'>,
): Promise<ToolExecutionResult> {
  const input: ToolExecutionInput = {
    ...call,
    rootCallId: parent.rootCallId,
    parent: parent.token,
    agent: parent.agent,
    signal: parent.signal,
    // 新版为每个模型 step 保留的工具集合，也适用于内部调用。
    ...('toolSet' in parent ? { toolSet: parent.toolSet } : {}),
  };
  const { ToolExecutionPipeline } = await import('@deepseek-ai/dsh-tools/pipeline');
  const pipeline = new ToolExecutionPipeline(ctx);
  const prepared = await pipeline.prepare(input);
  const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared;
  return pipeline.complete(prepared.exec, outcome);
}
