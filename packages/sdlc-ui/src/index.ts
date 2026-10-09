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
      // ⚠️ 仓库根从哪里来 —— 这里曾经有个真实的漂移。
      //
      // 另外四个插件都用 **session 的 cwd**（`exec.agent?.session.header.cwd`），
      // 而我第一版用了 `process.cwd()`。两者在**多工作区**下不同，
      // 后果是：面板会显示**另一个仓库**的任务，而工具看的是当前会话的仓库。
      // 本仓库刚吃过"两份真相漂移"的亏，不该再制造一处。
      //
      // 修法：客户端把当前工作区路径作为 `?cwd=` 传上来（它从 useWorkspaces 拿）。
      // 请求里没有就退回 `process.cwd()`——单工作区下两者相同。
      //
      // ⚠️ **但 `cwd` 是不能无条件信的输入**：它是一个 HTTP 查询参数。
      // 路由虽然在已认证通道上（认证不是我的安全面），但
      // "能读任意目录"仍然是一个我不该给的权限。所以只接受
      // **绝对路径且不是文件系统根**的值；否则退回进程 cwd。
      // 这样最坏情况是"看了错仓库"，而不是"被当成任意文件读取器"。
      // 客户端可能传**多个**候选路径（逗号分隔）：它拿得到工作区列表，
      // 但判断不了哪个是"当前"的。所以这里挑**第一个真有任务目录**的。
      // 这比赌一个"活动工作区"字段稳。
      const rawCwd = new URL(request.url).searchParams.get('cwd') ?? '';
      const candidates = rawCwd
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.startsWith('/') && p !== '/' && !p.includes('\0'))
        .map((p) => p.replace(/\/+$/, ''));
      // 进程 cwd 永远作为兜底候选（单工作区下就是对的那个）。
      const searchRoots = [...new Set([...candidates, process.cwd().replace(/\/+$/, '')])];

      // 逐个候选试，取第一个真的有任务目录的；都没有就用第一个候选
      //（这样 `repoRoot` 与"查过哪里"对得上，空白时能说清是查了哪儿）。
      let repoRoot = searchRoots[0] as string;
      let names: string[] = [];
      const tried: string[] = [];
      for (const root of searchRoots) {
        tried.push(`${root}/${dir}`);
        try {
          const t = await ctx.fs.resolve(`${root}/${dir}`, { cwd: root });
          const entries = await ctx.fs.listDir(t);
          const found = entries.map((e) => e.name).sort();
          if (found.length > 0) {
            repoRoot = root;
            names = found;
            break;
          }
        } catch {
          // 这个候选不行，试下一个
        }
      }


      const tasks: unknown[] = [];
      for (const id of names) {
        let stateText = '';
        try {
          stateText = await ctx.fs.readText(
              await ctx.fs.resolve(`${repoRoot}/${dir}/${id}/state.yaml`, { cwd: repoRoot }),
            );
        } catch {
          // 读不出来就不把这个任务画出来——**不伪造**。看板宁可少一条，
          // 不可编一条。
          continue;
        }
        const st = parseStateYaml(stateText);
        let verdict: { status: string; met: number; notMet: number; cannotTell: number } | undefined;
        try {
          const raw = await ctx.fs.readText(
              await ctx.fs.resolve(`${repoRoot}/${dir}/${id}/verification.json`, { cwd: repoRoot }),
            );
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

      return new Response(
        JSON.stringify({ at: new Date().toISOString(), repoRoot, searched: tried, tasks }), {
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
