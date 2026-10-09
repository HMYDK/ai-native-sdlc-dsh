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
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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
interface HistoryEntry {
  at: string;
  from: string;
  to: string;
  reason: string;
}

interface ParsedState {
  status?: string;
  title?: string;
  created?: string;
  updated?: string;
  artifacts: Record<string, string>;
  history: HistoryEntry[];
}

/**
 * 解析 `state.yaml` 里面板需要的字段（**含 history**）。
 *
 * ⚠️ 这里刻意**不引入 YAML 库**：`state.yaml` 是本仓库自己写出来的固定形状，
 * 为一屏展示拖进一个解析器不划算。风险是"遇到没见过的形状会错"，
 * 所以：不认识的行**直接跳过**，任何解析失败都**不抛错**（读不出来就不画这个任务，
 * 绝不伪造）。`history` 的每个条目是 `- at/from/to/reason` 四行，理由可能很长。
 */
function parseStateYaml(text: string): ParsedState {
  const out: ParsedState = { artifacts: {}, history: [] };
  let inArtifacts = false;
  let inHistory = false;
  let cur: Partial<HistoryEntry> | null = null;

  const flush = (): void => {
    if (cur && typeof cur.at === 'string') {
      out.history.push({
        at: cur.at,
        from: typeof cur.from === 'string' ? cur.from : '',
        to: typeof cur.to === 'string' ? cur.to : '',
        reason: typeof cur.reason === 'string' ? cur.reason : '',
      });
    }
    cur = null;
  };

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    // 新的 history 条目
    if (inHistory && /^\s{2}-\s/.test(line)) {
      flush();
      cur = {};
      const rest = line.replace(/^\s{2}-\s*/, '');
      const kv = /^(\w+):\s*(.*)$/.exec(rest);
      if (kv) (cur as Record<string, string>)[kv[1] as string] = unquote(kv[2] as string);
      continue;
    }
    if (/^history:\s*$/.test(line)) {
      inHistory = true;
      inArtifacts = false;
      continue;
    }
    if (inHistory && cur && /^\s{4}(\w+):\s*(.*)$/.test(line)) {
      const m = /^\s{4}(\w+):\s*(.*)$/.exec(line);
      if (m) (cur as Record<string, string>)[m[1] as string] = unquote(m[2] as string);
      continue;
    }
    if (/^[a-zA-Z_]/.test(line)) {
      if (inHistory) flush();
      inHistory = false;
    }
    if (/^artifacts:\s*\{\s*\}\s*$/.test(line)) {
      inArtifacts = false;
      continue;
    }
    if (/^artifacts:\s*$/.test(line)) {
      inArtifacts = true;
      inHistory = false;
      continue;
    }
    if (/^[a-zA-Z_]/.test(line)) inArtifacts = false;
    if (inArtifacts) {
      const m = /^\s{2}([a-zA-Z_][\w-]*):\s*"?([^"]*)"?\s*$/.exec(line);
      if (m) out.artifacts[m[1] as string] = m[2] as string;
      continue;
    }
    if (inHistory) continue;
    const kv = /^([a-zA-Z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const value = unquote(kv[2] as string);
    if (key === 'status') out.status = value;
    else if (key === 'title') out.title = value;
    else if (key === 'created') out.created = value;
    else if (key === 'updated') out.updated = value;
  }
  flush();
  return out;
}

/** 去掉 YAML 标量两侧的引号。`state.yaml` 里标题与理由都可能带引号。 */
function unquote(v: string): string {
  const t = v.trim();
  return /^".*"$/.test(t) ? (t.slice(1, -1) as string) : t;
}

/** 抽出一个 markdown 的**章节骨架**（一到三级标题）。 */
function sectionsOf(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split('\n')) {
    const m = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (m) out.push(m[2] as string);
    if (out.length >= 12) break;
  }
  return out;
}

/** 每个阶段**应该**有哪个制品。缺了就是卡在这一门。 */
const STAGE_ARTIFACT: Record<string, string> = {
  INTENT: 'intent',
  SPEC: 'spec',
  PLANNED: 'plan',
  IMPLEMENTING: 'plan',
  VERIFYING: 'verification',
  REVIEWING: 'review',
};

/** 阶段顺序（面板画流程线用）。 */
const STAGES = ['INTENT', 'SPEC', 'PLANNED', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'DONE'] as const;

/**
 * 一个任务**还缺什么才能过这一门**。
 *
 * 这是"卡在哪"的答案。没有它，面板只能告诉你"现在是 VERIFYING"，
 * 而人真正想知道的是"**为什么过不去**"。
 */
function blockedBy(status: string, artifacts: Record<string, string>): string[] {
  const want = STAGE_ARTIFACT[status];
  if (!want || artifacts[want]) return [];
  return [`这一门要求制品 "${want}"，但它不在 artifacts 里`];
}

export function apply(ctx: Context, config: { tasksDir: string }): void {
  const dir = config.tasksDir.replace(/\/+$/, '');

  /**
   * 候选仓库根（按可靠性）：`?cwd=` → DSH 持久化的工作区列表 → 进程 cwd 及其祖先。
   * 桌面 App 的进程 cwd 是 `~/.dsh/profiles/desktop`，**不是任何仓库**，
   * 所以第二条（持久化）是主力。
   */
  const candidateRoots = async (request: Request): Promise<string[]> => {
    const storagesRoot = join(homedir(), '.dsh', 'storages');
    const fromStorage: string[] = [];
    try {
      const raw = await ctx.fs.readText(
        await ctx.fs.resolve(join(storagesRoot, 'workspace.json'), { cwd: storagesRoot }),
      );
      const seen = new Set<string>();
      const walk = (o: unknown, depth: number): void => {
        if (depth > 5 || o === null || typeof o !== 'object') return;
        if (Array.isArray(o)) {
          for (const v of o.slice(0, 50)) walk(v, depth + 1);
          return;
        }
        for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
          if (k === 'path' && typeof v === 'string' && v.startsWith('/')) seen.add(v);
          else walk(v, depth + 1);
        }
      };
      walk(JSON.parse(raw), 0);
      fromStorage.push(...seen);
    } catch {
      // 读不到就没有这一路候选
    }
    const fromClient = (new URL(request.url).searchParams.get('cwd') ?? '').split(',').map((x) => x.trim());
    const fromProcess: string[] = [];
    for (let d = process.cwd(); d !== '/' && d.length > 1; d = dirname(d)) fromProcess.push(d);
    return [
      ...new Set(
        [...fromClient, ...fromStorage, ...fromProcess]
          .filter((x) => x.startsWith('/') && x !== '/' && !x.includes('\0'))
          .map((x) => x.replace(/\/+$/, '')),
      ),
    ];
  };

  const resolveRepoRoot = async (request: Request): Promise<string | null> => {
    for (const root of await candidateRoots(request)) {
      try {
        const t = await ctx.fs.resolve(`${root}/${dir}`, { cwd: root });
        const entries = await ctx.fs.listDir(t);
        if (entries.length > 0) return root;
      } catch {
        // 这个候选不行，试下一个
      }
    }
    return null;
  };

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
      const searchRoots = await candidateRoots(request);
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
        let verdict:
          | { status: string; met: number; notMet: number; cannotTell: number; findings: number; unverified: number; summary: string }
          | undefined;
        try {
          const raw = await ctx.fs.readText(
              await ctx.fs.resolve(`${repoRoot}/${dir}/${id}/verification.json`, { cwd: repoRoot }),
            );
          const doc = JSON.parse(raw) as {
            verdict?: {
              status?: string;
              criteria_results?: { result?: string }[];
              findings?: unknown[];
              unverified?: unknown[];
              summary?: string;
            };
          };
          const results = doc.verdict?.criteria_results ?? [];
          const count = (r: string) => results.filter((x) => x.result === r).length;
          if (typeof doc.verdict?.status === 'string') {
            verdict = {
              status: doc.verdict.status,
              met: count('met'),
              notMet: count('not_met'),
              cannotTell: count('cannot_tell'),
              findings: Array.isArray(doc.verdict.findings) ? doc.verdict.findings.length : 0,
              // ⚠️ unverified 必须单独报出来 —— 它是"验证者说它没复核的东西"，
              // 而"通过"里最容易被人忽略的正是这一块。
              unverified: Array.isArray(doc.verdict.unverified) ? doc.verdict.unverified.length : 0,
              summary: typeof doc.verdict.summary === 'string' ? doc.verdict.summary.slice(0, 400) : '',
            };
          }
        } catch {
          verdict = undefined; // 没验证过就是没验证过
        }
        let review: { decision?: string; rounds?: number; notAccepted?: number; notes: string[] } | undefined;
        try {
          const raw = await ctx.fs.readText(
            await ctx.fs.resolve(`${repoRoot}/${dir}/${id}/review.json`, { cwd: repoRoot }),
          );
          const doc = JSON.parse(raw) as {
            decision?: string;
            rounds?: unknown[];
            not_accepted?: string[];
            honest_notes?: string[];
          };
          review = {
            decision: doc.decision,
            rounds: Array.isArray(doc.rounds) ? doc.rounds.length : 0,
            notAccepted: Array.isArray(doc.not_accepted) ? doc.not_accepted.length : 0,
            notes: Array.isArray(doc.honest_notes) ? doc.honest_notes.slice(0, 3) : [],
          };
        } catch {
          review = undefined;
        }
        // 每个制品的**形状**：章节骨架 + 体量。这是"交付了什么"的直接答案。
        const artifactDetail: { kind: string; file: string; sections: string[]; bytes: number }[] = [];
        for (const [kind, file] of Object.entries(st.artifacts)) {
          try {
            const text = await ctx.fs.readText(
              await ctx.fs.resolve(`${repoRoot}/${dir}/${id}/${file}`, { cwd: repoRoot }),
            );
            artifactDetail.push({
              kind,
              file,
              // JSON 制品没有 markdown 标题，用顶层键当"章节"
              sections: file.endsWith('.json')
                ? Object.keys(JSON.parse(text)).slice(0, 12)
                : sectionsOf(text),
              bytes: text.length,
            });
          } catch {
            // 登记了但读不出来 —— 如实报一个空形状，不假装它有内容
            artifactDetail.push({ kind, file, sections: [], bytes: 0 });
          }
        }

        // 历史轨迹：每次迁移的时间与**理由**。理由是人写给自己看的，价值很高。
        const timeline = st.history.map((h) => ({
          at: h.at,
          from: h.from,
          to: h.to,
          reason: h.reason,
        }));

        // 相邻两次迁移的时间差 —— "这一门花了多久"
        const durations: { stage: string; ms: number }[] = [];
        for (let i = 1; i < timeline.length; i += 1) {
          const a = Date.parse(timeline[i - 1]?.at ?? '');
          const b = Date.parse(timeline[i]?.at ?? '');
          if (Number.isFinite(a) && Number.isFinite(b) && b >= a) {
            durations.push({ stage: timeline[i]?.from ?? '', ms: b - a });
          }
        }

        tasks.push({
          id,
          status: st.status ?? null,
          title: st.title ?? null,
          created: st.created ?? null,
          updated: st.updated ?? null,
          artifacts: artifactDetail,
          timeline,
          durations,
          blocked: blockedBy(st.status ?? '', st.artifacts),
          verdict: verdict ?? null,
          review: review ?? null,
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

  /**
   * 读**一个交付物**的内容。
   *
   * ## ⚠️ 这是一个新的读取面，所以校验必须认真
   *
   * `task` 与 `file` 都来自查询参数。直接拼进路径，这个端点就成了
   * "任意文件读取器" —— 而它挂在已认证通道上，意味着**任何登录的
   * 浏览器会话都能读这台机器的任何文件**。所以三重限制：
   *
   *   ① `task` / `file` 只允许 `[A-Za-z0-9_.-]`，且不得含 `..`
   *   ② **`file` 必须在 `artifacts` 登记表里** —— 白名单来自**事实来源**
   *      （`state.yaml` 的 artifacts），不是来自我临时写的正则。
   *      任务目录里还有别的东西（如 `verification-observations.json`），
   *      它们**不该**被这个端点读到。
   *   ③ 仓库根复用 tasks 端点那一套候选逻辑
   */
  const artifactHandler = async (request: Request): Promise<Response> => {
    const fail = (code: number, message: string): Response =>
      new Response(JSON.stringify({ error: message }), {
        status: code,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    try {
      const q = new URL(request.url).searchParams;
      const task = q.get('task') ?? '';
      const want = q.get('file') ?? '';
      if (!/^[A-Za-z0-9_-]+$/.test(task)) return fail(400, 'task 不合法');
      if (!/^[A-Za-z0-9_.-]+$/.test(want) || want.includes('..')) return fail(400, 'file 不合法');

      const repoRoot = await resolveRepoRoot(request);
      if (!repoRoot) return fail(404, '找不到任务目录');

      const stateText = await ctx.fs.readText(
        await ctx.fs.resolve(`${repoRoot}/${dir}/${task}/state.yaml`, { cwd: repoRoot }),
      );
      const st = parseStateYaml(stateText);

      // ② 白名单来自 artifacts 登记表 —— 不在里面就读不到
      const allowed = Object.values(st.artifacts);
      if (!allowed.includes(want)) {
        return fail(403, `"${want}" 不在该任务的 artifacts 登记表里（可读：${allowed.join(', ') || '无'}）`);
      }

      const text = await ctx.fs.readText(
        await ctx.fs.resolve(`${repoRoot}/${dir}/${task}/${want}`, { cwd: repoRoot }),
      );
      return new Response(
        JSON.stringify({ task, file: want, bytes: text.length, text: text.slice(0, 200_000) }),
        { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
      );
    } catch (err) {
      return fail(500, err instanceof Error ? err.message : String(err));
    }
  };

  const registerArtifact = ctx.connection.fetch.register({
    path: '/api/sdlc-ui.artifact',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: artifactHandler,
  });
  ctx.effect(() => registerArtifact, 'sdlc-ui.artifact route');

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
