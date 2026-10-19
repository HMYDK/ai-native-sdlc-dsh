/**
 * 验证者 preset 里的工具过滤行。
 *
 * ## 为什么 preset 之外还需要这一行
 *
 * Agent Preset 只决定「这个子代理**自己**挂哪些插件」。宿主的工具是全局
 * 注册的：实测在真实宿主里，只有 preset 的验证者仍然能看见
 * `sdlc_task_create` / `sdlc_fix_end` / `sdlc_verify` 等宿主工具——因为
 * `ctx.tools` 是宿主服务，preset 没有把它隔离掉。这意味着验证者可以解冻
 * 测试、推进任务状态，甚至递归派验证。
 *
 * 0.2.0 的 `toolFilter` 就是干这件事的；0.2.1 删掉它之后，preset 里需要
 * 一个**显式**的过滤行。这一行在验证者自己的 scope 里调用
 * `ctx.tools.restrict({allow})`：
 *
 * 实测（0.2.1 真实宿主）发现 **allow 清单在这里行不通**：preset 自己的
 * `read` / `grep` / `glob` / `skill` / `bash` 是 **scope 注册**，不在这条
 * scope 的 global 层里，`restrict({allow})` 会报
 * `names unknown global tools`。而 `restrict` 恰好只过滤**继承的 global 层**，
 * 不碰 scope 自己的注册——这正是我们要的语义：
 *
 *   deny 掉当前 global 层的全部工具（`sdlc_*`、`working_directory`……），
 *   preset 自己注册的只读工具原样保留。
 *
 * 用「deny 全部 global」而不是固定 deny 名单：宿主以后新增任何工具，
 * 默认都不会漏进验证者。这一层不是可选的——去掉它，验证者就重新拿到了
 * 解冻测试、推进任务状态的能力。
 */

import type { Context } from '@deepseek-ai/cordis';
// 只为触发 declaration merging：`ctx.tools` 由它提供。
import type {} from '@deepseek-ai/dsh-tools';

export const name = 'sdlc-verifier-tool-filter';

/** 只依赖工具注册表；过滤是 apply 里的第一件事。 */
export const inject = ['tools'];

/**
 * 当前 global 层的全部工具名。
 *
 * `schemas()` 不带 scope = global 视图。这份列表就是「继承面」上要全部
 * 摘掉的东西；preset 自己的 scope 注册不在其中。
 */
export function globalToolNames(tools: { schemas(): readonly { name: string }[] }): string[] {
  return tools.schemas().map((schema) => schema.name);
}

export function apply(ctx: Context): void {
  // deny 全部 global：验证者只保留 preset 自己注册的只读工具。
  ctx.tools.restrict({ deny: globalToolNames(ctx.tools) });
}
