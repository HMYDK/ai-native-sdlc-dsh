/**
 * 插件入口里那些**可独立单测**的辅助函数。
 *
 * ## 为什么单独成文件
 *
 * 它们原来住在 `index.ts` 里，而 `index.ts` 只导出 `apply()`——于是这些函数
 * **只能穿过整个工具调度去测**。本项目最硬的一条教训就是：那样测会藏 bug。
 * `enforceCriteriaPolicy` 的"findings 被静默丢掉"就是这么藏到最后的，
 * 移到纯函数层直接单测后一次就暴露。
 *
 * ## ⚠️ 这份文件在四个包里是**逐字相同**的
 *
 * `sessionCwd` / `requireSessionCwd` / `resolveOptions` / `writePolicy`
 * 在 sdlc-verify、sdlc-task、sdlc-artifact、sdlc-status 里各有一份副本。
 * 它们至关重要：取错 cwd 会让文件写到沙箱的 **fallback 根**而不是会话仓库，
 * 于是"写自己仓库里的文件"被判越界（实测踩到过，见 docs/dsh-pitfalls.md §11.1）。
 *
 * 为什么不合并成一个共享包：dsh 插件是**独立 bundle**，跨包 import 走不通
 * （pnpm 从 registry 装，解析不到本地工作区包——已在 sdlc-status 上实测）。
 *
 * 所以四份副本保留，但由**契约测试**对照兄弟包检测漂移：
 * 每个包里的 `helpers.test.ts` 都有一节「漂移检测」，会读其它三个包的
 * 这份文件并逐字比对。**改这里就必须四个包一起改**，否则测试会红。
 *
 * ## 单测覆盖什么
 *
 * 主要是 `sessionCwd` 与 `resolveOptions`——它们决定"文件写到哪"，
 * 是踩过坑的地方，而且以前完全没有直接单测。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
// ⚠️ 这一行**必须**在，而且看着像没用——它只为触发 declaration merging：
// `ctx.sandboxPolicy` 由 dsh-sandbox-policy 加到 `Context` 上，
// 不 import 它的类型就看不到那个属性
// （tsc: Property 'sandboxPolicy' does not exist on type 'Context'）。
// 注意提供者是 **sandbox-policy**，不是 sandbox——import 错那个没有用。
import type { SandboxPolicyService as _SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy';

/**
 * 从工具执行上下文里取会话的工作目录。
 *
 * 官方 fs 工具的写法就是 `exec.agent?.session.header.cwd`——`Agent` 本身只暴露
 * `id`，cwd 在 session header 上。逐层可选链，任一环缺失都返回 `undefined`
 * （而不是抛错），由调用方给出可读错误。
 *
 * 尾部的 `/` 会被去掉：`/repo` 与 `/repo/` 必须解析到同一个地方，
 * 否则同一个会话可能因为一个斜杠而写出两份不同的路径。
 */
export function sessionCwd(exec: { agent?: unknown } | undefined): string | undefined {
  // ⚠️ `exec?.` 不是多余的：`exec` 本身也可能是 undefined
  // （直接单测时抓到过 TypeError: Cannot read properties of undefined (reading 'agent')）。
  // 这个函数被工具处理器调用，那里 exec 一定在；但它现在是**可单测的公开函数**，
  // 就不该在"拿不到上下文"时崩——它的契约是"拿不到就返回 undefined"。
  const agent = exec?.agent as
    | { session?: { header?: { cwd?: unknown } } }
    | undefined;
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd.replace(/\/+$/, '') : undefined;
}

/**
 * 与 `sessionCwd` 相同，但拿不到时抛出可读错误。
 *
 * `who` 是工具名（例如 `sdlc_task_create`）——错误信息要能指认是哪个工具失败了。
 * 不用写死包名：同一个工具可能被多个插件注册，指认到**工具**才有用。
 */
export function requireSessionCwd(exec: { agent?: unknown } | undefined, who: string): string {
  const cwd = sessionCwd(exec);
  if (cwd === undefined) {
    throw new Error(
      `${who} 无法确定仓库根：拿不到 session 的 cwd。` +
        '请在有工作目录的会话里调用（子代理或非会话调用可能没有 cwd）。',
    );
  }
  return cwd;
}

/**
 * `ctx.fs.resolve` 的解析选项。
 *
 * ⚠️ **必须带 cwd**，否则解析会落到沙箱的**部署 fallback 根**
 * （App 的工作目录，不是会话仓库），于是"写自己仓库里的文件"被判越界并拒绝。
 * 实测踩到过（pitfalls §11.1）。
 *
 * `policyRoot`（来自沙箱策略的 `workspaceRoot`）**优先于**会话 cwd——
 * 与官方 dsh-tool-fs 的 `sessionResolveOptions` 同一套写法。
 * `signal` 无条件返回（哪怕 `undefined`）：调用方不必区分两种情况。
 */
export function resolveOptions(
  exec: { agent?: unknown; signal?: AbortSignal },
  policyRoot?: string,
): { cwd?: string; signal?: AbortSignal } {
  const cwd = policyRoot ?? sessionCwd(exec);
  return { ...(cwd !== undefined ? { cwd } : {}), signal: exec.signal };
}

/**
 * 解析本次调用的沙箱策略（写操作专用）。
 *
 * 拿不到会话时返回 `undefined`：让 fs 后端自己决定默认行为，
 * 而不是凭空造一个策略。`resolve` 抛错也吞掉——写操作的失败应当由**写本身**
 * 报出来，而不是在这里变成一个语境不明的异常。
 */
export async function writePolicy(
  ctx: Context,
  exec: { agent?: unknown },
): Promise<SandboxExecutionPolicy | undefined> {
  const session = (exec.agent as { session?: unknown } | undefined)?.session;
  if (session === undefined) return undefined;
  try {
    return ctx.sandboxPolicy.resolve({ session: session as never });
  } catch {
    return undefined;
  }
}
