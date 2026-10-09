/**
 * @ai-native-sdlc/dsh-sdlc-ui —— **host 半**。
 *
 * 它做两件事：
 *   1. 注册一条**认证路由** `GET /api/sdlc-ui.tasks`，返回当前仓库的任务看板数据
 *   2. 让客户端半把那份数据画出来（客户端半见 `src/client.js`，手写）
 *
 * ## 数据通道为什么是"认证路由"
 *
 * 查证过三条候选（详见 `docs/dsh-pitfalls.md` §13）：
 *   · `host.call()` 只在**动态包运行器**里成立，静态插件包拿不到
 *   · `ctx.remote.*` 由 `@Remote` 标注、**构建期生成**，手写拿不到
 *   · **`ctx.connection.fetch.register(route)`** —— 公共接口，✅ 用它
 *
 * 关键好处：路由注册在**已认证的 `/api` 通道**上。类型定义原文：
 * "Handle one request after the physical carrier has applied its trust and
 * authentication policy." 所以**认证不是我自己的安全面**——
 * 这正是选它而不是"自己开一个端点"的理由。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
// 显式 import 只为触发 declaration merging —— `ctx.fs` 由 dsh-fs 提供，
// `ctx.connection` 由 dsh-client-connection 提供。不 import 类型就看不到它们。
import type { FsTarget as _FsTarget } from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-client-connection';

export const name = 'sdlc-ui';

export const inject = ['fs', 'connection'];

export const Config = z.object({
  /** 任务目录，相对仓库根。**必须与另外四个插件一致**，否则看板会看别处。 */
  tasksDir: z.string().default('.ai/tasks'),
});

/**
 * 解析一个 state.yaml 里我们真正需要的字段。
 *
 * ⚠️ 这里**刻意不引入 YAML 库**：面板只要 status / title / artifacts / updated，
 * 而 `state.yaml` 是本仓库自己写出来的**固定形状**。为一屏展示拖进一个解析器
 * 不划算，而手写解析的风险是"遇到没见过的形状会错"——
 * 所以它对不认识的行**直接跳过**，且**任何解析失败都不抛错**（见下）。
 */
function parseStateYaml(text: string): {
  status?: string;
  title?: string;
  artifacts: Record<string, string>;
  updated?: string;
} {
  const out: { status?: string; title?: string; artifacts: Record<string, string>; updated?: string } = {
    artifacts: {},
  };
  let inArtifacts = false;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (/^artifacts:\s*\{\s*\}\s*$/.test(line)) {
      inArtifacts = false;
      continue;
    }
    if (/^artifacts:\s*$/.test(line)) {
      inArtifacts = true;
      continue;
    }
    if (/^[a-zA-Z_]/.test(line)) inArtifacts = false; // 顶层键，退出 artifacts 段
    if (inArtifacts) {
      const m = /^\s{2}([a-zA-Z_][\w-]*):\s*"?([^"]*)"?\s*$/.exec(line);
      if (m) out.artifacts[m[1] as string] = m[2] as string;
      continue;
    }
    const kv = /^([a-zA-Z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const value = (kv[2] ?? '').trim().replace(/^"(.*)"$/, '$1');
    if (key === 'status') out.status = value;
    else if (key === 'title') out.title = value;
    else if (key === 'updated') out.updated = value;
  }
  return out;
}

export function apply(ctx: Context, config: { tasksDir: string }): void {
  const dir = config.tasksDir.replace(/\/+$/, '');

  const handler = async (request: Request): Promise<Response> => {
    try {
      // 仓库根从请求里拿不到会话，用进程 cwd —— 与 dsh web 从工作区启动的语义一致。
      const repoRoot = process.cwd();
      const tasksRoot = `${repoRoot}/${dir}`;

      // ⚠️ `ctx.fs` 的方法要的是**解析过的 target**，不是字符串。
      // 我第一版直接传了路径字符串，于是 listDir 静默失败 → tasks 恒为空
      //（端点 200、JSON 合法、repoRoot 正确，**只有任务是 0**——这种
      // "看起来正常但是空的"失败正是本仓库一直在防的）。
      //
      // ⚠️ 而且**不要造一个假 session 去问沙箱策略**。
      // 我试过 `ctx.sandboxPolicy.resolve({ session: {…} })`，它要的是真 session
      // 对象（报 `session.snapshotEvents is not a function`）。
      // 本 host 半跑在**主机进程**里（不是工具调用），`process.cwd()` 就是启动
      // 服务时所在的仓库根——把 cwd 直接显式传给 `resolve` 即可，
      // 这既绕开了假 session，也满足了 `resolve` 必须带 cwd 的要求（pitfalls §11.1）。
      const opts = { cwd: repoRoot };

      let names: string[] = [];
      try {
        const rootTarget = await ctx.fs.resolve(tasksRoot, opts);
        const entries = await ctx.fs.listDir(rootTarget);
        names = entries.map((e) => e.name).sort();
      } catch {
        names = [];
      }

      const tasks: unknown[] = [];
      for (const id of names) {
        let stateText = '';
        try {
          stateText = await ctx.fs.readText(await ctx.fs.resolve(`${tasksRoot}/${id}/state.yaml`, opts));
        } catch {
          // 读不出来就不把这个任务画出来——**不伪造**。看板宁可少一条，
          // 不可编一条。
          continue;
        }
        const st = parseStateYaml(stateText);
        let verdict: { status: string; met: number; notMet: number; cannotTell: number } | undefined;
        try {
          const raw = await ctx.fs.readText(await ctx.fs.resolve(`${tasksRoot}/${id}/verification.json`, opts));
          const doc = JSON.parse(raw) as {
            verdict?: { status?: string; criteria_results?: { result?: string }[] };
          };
          const results = doc.verdict?.criteria_results ?? [];
          const count = (r: string) => results.filter((x) => x.result === r).length;
          if (typeof doc.verdict?.status === 'string') {
            verdict = {
              status: doc.verdict.status,
              met: count('met'),
              notMet: count('not_met'),
              cannotTell: count('cannot_tell'),
            };
          }
        } catch {
          verdict = undefined; // 没验证过就是没验证过
        }
        tasks.push({
          id,
          status: st.status ?? null,
          title: st.title ?? null,
          artifacts: Object.keys(st.artifacts),
          updated: st.updated ?? null,
          verdict: verdict ?? null,
        });
      }

      return new Response(JSON.stringify({ at: new Date().toISOString(), repoRoot, tasks }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    } catch (err) {
      // 失败要说出来，不要给一个看起来正常的空看板。
      return new Response(
        JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } },
      );
    }
  };

  const register = ctx.connection.fetch.register({
    // ⚠️ 路径**必须**以 `/api/` 开头。
    // 校验逻辑是 `endpointFromPath('/api', route.path)`，它会先要求
    // `pathname.startsWith('/api/')`——不满足就直接判非法并**抛错**，
    // 而失败的样子是"1 entry did not activate"（插件没激活，但服务照起）。
    // 我第一版写的是 `/sdlc-ui.tasks`（少了前缀），真跑才抓到。
    path: '/api/sdlc-ui.tasks',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: handler,
  });
  // disposer 必须交给 ctx.effect 托管 —— 否则卸载时留下悬空路由
  //（本仓库在 sdlc-workflow 上踩过同一类坑：Skill 注册的 disposer 被丢掉）。
  ctx.effect(() => register, 'sdlc-ui.tasks route');
}
