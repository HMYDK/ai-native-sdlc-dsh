/**
 * @ai-native-sdlc-plugin/dsh-sdlc/ui —— **host 半**。
 *
 * 它做两件事：
 *   1. 注册**认证路由** tasks / artifact / execution，提供只读任务、制品和逐轮证据
 *   2. 让客户端半把那份数据画出来（客户端半见 `src/ui/client.js`，手写）
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
import { basename, dirname, join } from 'node:path';

import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
// 显式 import 只为触发 declaration merging —— `ctx.fs` 由 dsh-fs 提供，
// `ctx.connection` 由 dsh-client-connection 提供。不 import 类型就看不到它们。
import type { FsTarget as _FsTarget } from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-client-connection';
import { readExecution } from './execution.js';
import { criterionEntries } from '../verify/verdict.js';
import {JSON_SCHEMA, load as parseYaml} from 'js-yaml';
import {summarizeAcceptance, verificationAcceptance, type AcceptanceSummary} from '../shared/acceptance.js';

export const name = 'sdlc-ui';

export const inject = ['fs', 'connection'];

export const Config = z.object({
  /** 任务目录，相对仓库根。**必须与另外四个插件一致**，否则看板会看别处。 */
  tasksDir: z.string().default('.ai/tasks'),
  /** 与 RSI 组件保持一致，只读任务已登记的运行记录。 */
  rsiDir: z.string().default('.ai/rsi'),
});

/**
 * 解析一个 state.yaml 里我们真正需要的字段。
 *
 * 使用与写入侧一致的 YAML 解码，验收清单交给共享契约模块校验。
 * 坏记录保留诊断，不影响其它任务。
 */
interface HistoryEntry {
  at: string;
  from: string;
  to: string;
  reason: string;
}

interface ParsedState {
  acceptance?: unknown;
  status?: string;
  title?: string;
  created?: string;
  updated?: string;
  artifacts: Record<string, string>;
  history: HistoryEntry[];
}

/** 一个候选仓库根，外加它给人看的名字（工作区标题或目录名）。 */
interface RootInfo {
  root: string;
  label: string;
}

/** YAML decoding is shared with the writer; malformed acceptance data stays visible to the contract checker. */
function parseStateYaml(text: string): ParsedState {
  const out: ParsedState = {artifacts:{},history:[]};
  try {
    const raw = parseYaml(text,{schema:JSON_SCHEMA}) as Record<string,unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const key of ['status','title','created','updated'] as const) if (typeof raw[key] === 'string') out[key] = raw[key];
    if (raw.artifacts && typeof raw.artifacts === 'object' && !Array.isArray(raw.artifacts)) {
      for (const [key,value] of Object.entries(raw.artifacts)) if (typeof value === 'string') out.artifacts[key] = value;
    }
    if (Array.isArray(raw.history)) out.history = raw.history.filter(v=>v && typeof v === 'object').map(v=>({
      at:typeof v.at === 'string' ? v.at : '',from:typeof v.from === 'string' ? v.from : '',
      to:typeof v.to === 'string' ? v.to : '',reason:typeof v.reason === 'string' ? v.reason : '',
    }));
    out.acceptance = raw.acceptance;
  } catch {out.acceptance = {invalid:true};}
  return out;
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

// 制品可以位于任务内的子目录；登记和读取必须遵守同一个相对路径约定。
function artifactPath(file: string): boolean {
  return !!file && file.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..');
}

class ArtifactReadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
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

export function apply(ctx: Context, config: { tasksDir: string; rsiDir?: string }): void {
  const dir = config.tasksDir.replace(/\/+$/, '');

  // 列表与打开共用读取：允许子目录，但解析软链后的目标仍必须在这个任务内。
  const readArtifact = async (repoRoot: string, task: string, file: string, signal?: AbortSignal): Promise<string> => {
    if (!artifactPath(file)) throw new ArtifactReadError(400, 'file 不合法：请使用任务目录内的相对文件路径');
    const workspace = await ctx.fs.resolve(repoRoot, {cwd: repoRoot, signal});
    const taskRoot = await ctx.fs.resolve(`${dir}/${task}`, {cwd: repoRoot, signal});
    const target = await ctx.fs.resolve(`${dir}/${task}/${file}`, {cwd: repoRoot, signal});
    if (!ctx.fs.contains(workspace, taskRoot) || !ctx.fs.contains(taskRoot, target)) {
      throw new ArtifactReadError(403, '交付物路径越出任务目录');
    }
    const info = await ctx.fs.stat(target, signal);
    if (!info) throw new ArtifactReadError(404, '已登记的交付物文件不存在');
    if (info.type !== 'file') throw new ArtifactReadError(400, '交付物不是普通文件');
    const limit = 16 * 1024 * 1024;
    if (info.size !== undefined && info.size > limit) throw new ArtifactReadError(413, '交付物超过 16 MiB，无法在看板完整打开');
    const bytes = await ctx.fs.readBytes(target, signal, limit);
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  };

  /**
   * 候选仓库根（按可靠性）：`?cwd=` → DSH 持久化的工作区列表 → 进程 cwd 及其祖先。
   * 桌面 App 的进程 cwd 是 `~/.dsh/profiles/desktop`，**不是任何仓库**，
   * 所以第二条（持久化）是主力。
   *
   * 每个根带一个**显示名**：持久化列表里工作区行有 `title`，就用它；
   * 没有（`?cwd=` 与进程 cwd 这两路）就退回目录名。
   */
  const candidateRoots = async (request: Request): Promise<RootInfo[]> => {
    const storagesRoot = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages');
    const fromStorage: string[] = [];
    const labels = new Map<string, string>();
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
        const own = o as Record<string, unknown>;
        for (const [k, v] of Object.entries(own)) {
          if (k === 'path' && typeof v === 'string' && v.startsWith('/')) {
            seen.add(v);
            // 工作区行里 `title` 与 `path` 是兄弟键。读不到就退回目录名，
            // 不因为缺一个显示名而丢掉这个工作区。
            const title = own['title'];
            if (typeof title === 'string' && title.trim() !== '' && !labels.has(v)) {
              labels.set(v, title.trim());
            }
          } else walk(v, depth + 1);
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
    const roots = [
      ...new Set(
        [...fromClient, ...fromStorage, ...fromProcess]
          .filter((x) => x.startsWith('/') && x !== '/' && !x.includes('\0'))
          .map((x) => x.replace(/\/+$/, '')),
      ),
    ];
    return roots.map((root) => ({ root, label: labels.get(root) ?? basename(root) }));
  };

  /**
   * **所有**真的有任务目录的候选根 —— 不是"第一个"。
   *
   * ⚠️ 这里曾经是 `break`：找到第一个非空候选就停。多工作区下后果是
   * 面板**永远只显示那一个仓库**，而且切换工作区也不影响它（客户端半
   * 不传 `?cwd=`）。实测：面板只显示 `workspace-a` 的残留任务
   * RSI-1，另外两个工作区里的 8 个真实任务从来没出现过。
   *
   * 看板的职责是"用 SDLC 流程处理过的任务都在场"，所以必须**全扫**。
   * 顺序不在这里决定（见 handler 末尾按 `updated` 排序）。
   *
   * ⚠️ 全扫带来一个新的坑：**去重必须按目录身份，不能按路径字符串**。
   * 同一个工作区可能以两种写法出现在候选里（软链路径 vs 解析后的真实路径；
   * 大小写、尾斜杠同理），字符串不等 → 被当成两个候选 → 同一个任务被扫两遍
   * → 看板上出现两条一模一样的卡片。旧代码"找到第一个就 break"看不到这个问题，
   * 所以它是全扫**引入**的回归，独立验证用软链夹具抓到了。
   * `FsTarget.targetKey` 就是为此存在的：同一个文件必然给出同一个 key
   *（dsh-fs 类型注释原文），本地后端在 resolve 时会 normalize + realpath。
   */
  const taskRoots = async (request: Request): Promise<{ roots: RootInfo[]; tried: string[] }> => {
    const tried: string[] = [];
    const roots: RootInfo[] = [];
    const seen = new Set<string>();
    for (const info of await candidateRoots(request)) {
      tried.push(`${info.root}/${dir}`);
      try {
        const t = await ctx.fs.resolve(`${info.root}/${dir}`, { cwd: info.root });
        // 先看去重集合再决定要不要列目录：同一个目录列两次没有意义。
        const key = String(t.targetKey);
        if (seen.has(key)) continue;
        const entries = await ctx.fs.listDir(t);
        if (entries.length > 0) {
          seen.add(key);
          roots.push(info);
        }
      } catch {
        // 这个候选没有任务目录：跳过，但**不因为已经找到一个就停**
      }
    }
    return { roots, tried };
  };

  /**
   * 读某个任务的制品时该用哪个仓库根。
   *
   * 聚合之后根不止一个，"这个任务在哪个根里"必须**按任务找**，
   * 不能再用"第一个非空根"：否则另一个工作区里的任务会被拿到
   * 错误的仓库去读，症状是"制品打不开"或**读到同名任务的别人的文件**。
   */
  const rootForTask = async (request: Request, task: string): Promise<RootInfo | null> => {
    const wanted = (new URL(request.url).searchParams.get('root') ?? '').trim();
    const { roots } = await taskRoots(request);
    // 指定根就是指定任务身份；缺失时不能从别的工作区借用同名任务。
    const ordered = wanted === ''
      ? roots
      : roots.filter((r) => r.root === wanted);
    for (const info of ordered) {
      try {
        const text = await ctx.fs.readText(
          await ctx.fs.resolve(`${info.root}/${dir}/${task}/state.yaml`, { cwd: info.root }),
        );
        if (text !== undefined) return info;
      } catch {
        // 这个根里没有这个任务（或读不出来）
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
      const { roots, tried } = await taskRoots(request);
      const scanned: { root: string; label: string; taskCount: number }[] = [];


      const tasks: unknown[] = [];
      for (const info of roots) {
        const repoRoot = info.root;
        let names: string[] = [];
        try {
          const t = await ctx.fs.resolve(`${repoRoot}/${dir}`, { cwd: repoRoot });
          names = (await ctx.fs.listDir(t)).map((e) => e.name).sort();
        } catch {
          continue; // 列不出来就跳过这个根，不影响别的根
        }
        const before = tasks.length;
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
          let verificationDoc: unknown;
          let verdict:
            | { status: string; met: number; notMet: number; cannotTell: number; findings: number; unverified: number; summary: string }
            | undefined;
          try {
            const raw = await readArtifact(repoRoot,id,st.artifacts.verification ?? 'verification.json',request.signal);
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
            verificationDoc = doc;
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
          let specText: string | undefined;
          try {if (st.artifacts.spec) specText = await readArtifact(repoRoot,id,st.artifacts.spec,request.signal);} catch { /* reported as unavailable */ }
          const acceptance = summarizeAcceptance(st.acceptance,st.artifacts.spec,specText,verificationDoc);
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
          let rsi: { evidence_complete: boolean; run_count: number; session_count: number; review_status: string; issues: string[]; updated_at: string } | null = null;
          try {
            const raw = await ctx.fs.readText(await ctx.fs.resolve(`${repoRoot}/${dir}/${id}/rsi.json`, { cwd: repoRoot }));
            const doc = JSON.parse(raw);
            if (doc.task_id !== id || typeof doc.evidence_complete !== 'boolean') throw new Error('执行记录摘要格式不正确');
            rsi = { evidence_complete: doc.evidence_complete, run_count: Number(doc.run_count) || 0,
              session_count: Number(doc.session_count) || 0, review_status: String(doc.review_status || 'pending'),
              issues: Array.isArray(doc.issues) ? doc.issues.filter((s: unknown): s is string => typeof s === 'string').slice(0, 8) : [],
              updated_at: typeof doc.updated_at === 'string' ? doc.updated_at : '' };
          } catch { /* Absent, unreadable or legacy records are unconfirmed, never healthy by default. */ }
          // 每个制品的**形状**：章节骨架 + 体量。这是"交付了什么"的直接答案。
          const artifactDetail: { kind: string; file: string; sections: string[]; bytes: number }[] = [];
          for (const [kind, file] of Object.entries(st.artifacts)) {
            try {
              const text = await readArtifact(repoRoot, id, file, request.signal);
              artifactDetail.push({
                kind,
                file,
                // JSON 制品没有 markdown 标题，用顶层键当"章节"
                sections: file.endsWith('.json')
                  ? Object.keys(JSON.parse(text)).slice(0, 12)
                  : sectionsOf(text),
                bytes: new TextEncoder().encode(text).byteLength,
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
            // ⚠️ 聚合之后 `id` 只在**一个工作区内**唯一。不带来源的话，
            // 面板里两个仓库的同名任务分不清，点开制品也会读错仓库。
            repoRoot,
            repoLabel: info.label,
            status: st.status ?? null,
            title: st.title ?? null,
            created: st.created ?? null,
            updated: st.updated ?? null,
            artifacts: artifactDetail,
            timeline,
            durations,
            blocked: blockedBy(st.status ?? '', st.artifacts),
            verdict: verdict ?? null,
            acceptance,
            review: review ?? null,
            rsi,
          });
        }
        // 只报**真的画出来**的条数：目录里可能有不含 state.yaml 的杂物，
        // 报目录数会让"看板少了一条"变成说不清的事。
        scanned.push({ root: repoRoot, label: info.label, taskCount: tasks.length - before });
      }

      // 最新的排前面。
      // 为什么不按根的顺序：候选顺序来自 workspace.json 的创建顺序，与
      // "我现在在做什么"无关 —— 真实项目的 8 个任务因此会被排到最后。
      // 看板的第一眼应当是最近动过的那些。
      tasks.sort((a, b) => {
        const au = (a as { updated?: string | null }).updated;
        const bu = (b as { updated?: string | null }).updated;
        return String(bu ?? '').localeCompare(String(au ?? ''));
      });

      return new Response(
        JSON.stringify({
          at: new Date().toISOString(),
          // `repoRoot` 保留为"第一个有任务的根"，只为兼容；
          // 真正的来源看每个任务自己的 `repoRoot`，全局看 `roots`。
          repoRoot: roots[0]?.root ?? null,
          roots: scanned,
          searched: tried,
          tasks,
        }), {
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
   *   ① `task` 是单段标识，`file` 是规范的相对路径，允许子目录、拒绝 . / .. 段
   *   ② **`file` 必须在 `artifacts` 登记表里** —— 白名单来自**事实来源**
   *      （`state.yaml` 的 artifacts），不是来自我临时写的正则。
   *      任务目录里还有别的东西（如 `verification-observations.json`），
   *      它们**不该**被这个端点读到。
   *   ③ 仓库根复用 tasks 端点那一套候选逻辑，解析后的目标不得越出任务目录
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
      if (!artifactPath(want)) return fail(400, 'file 不合法');

      const hit = await rootForTask(request, task);
      if (!hit) return fail(404, `在任何工作区里都找不到任务 ${task}`);
      const repoRoot = hit.root;

      const stateText = await ctx.fs.readText(
        await ctx.fs.resolve(`${repoRoot}/${dir}/${task}/state.yaml`, { cwd: repoRoot }),
      );
      const st = parseStateYaml(stateText);

      // ② 白名单来自 artifacts 登记表 —— 不在里面就读不到
      const allowed = Object.values(st.artifacts);
      if (!allowed.includes(want)) {
        return fail(403, `"${want}" 不在该任务的 artifacts 登记表里（可读：${allowed.join(', ') || '无'}）`);
      }

      const text = await readArtifact(repoRoot, task, want, request.signal);
      const kind = Object.entries(st.artifacts).find(([, file]) => file === want)?.[0];
      // 验证者可以省略标准正文，也可能重排结果。复用写入方的稳定 ID，不能按位置猜。
      let criteria: {id: string; text: string}[] | undefined;
      let acceptance: AcceptanceSummary | undefined;
      if (kind === 'verification') {
        try {
          const doc = JSON.parse(text);
          let specText: string | undefined;
          try {if (st.artifacts.spec) specText = await readArtifact(repoRoot,task,st.artifacts.spec,request.signal);} catch { /* reported as unavailable */ }
          acceptance = summarizeAcceptance(st.acceptance,st.artifacts.spec,specText,doc);
          if (doc.schema_version === 3) criteria = verificationAcceptance(doc).entries;
          else if (Array.isArray(doc?.criteria) && doc.criteria.every((value: unknown) => typeof value === 'string')) criteria = criterionEntries(doc.criteria);
        } catch { /* 损坏 JSON 仍交给阅读器显示原文和明确错误。 */ }
      }
      return new Response(
        JSON.stringify({ task, file: want, kind, criteria, acceptance, bytes: new TextEncoder().encode(text).byteLength, text }),
        { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
      );
    } catch (err) {
      if (err instanceof ArtifactReadError) return fail(err.status, err.message);
      return fail(500, err instanceof Error ? err.message : String(err));
    }
  };

  const registerExecution = ctx.connection.fetch.register({
    path: '/api/sdlc-ui.execution',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request: Request): Promise<Response> => {
      const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
      try {
        const task = new URL(request.url).searchParams.get('task') ?? '';
        if (!/^[A-Za-z0-9_-]{1,96}$/.test(task)) return respond({error: 'task 不合法'}, 400);
        const hit = await rootForTask(request, task);
        if (!hit) return respond({error: '指定工作区里找不到这个任务'}, 404);
        return respond(await readExecution(ctx.fs, {
          taskId: task, repoRoot: hit.root, tasksDir: dir, rsiDir: config.rsiDir, signal: request.signal,
          findingOffset: Number(new URL(request.url).searchParams.get('findingOffset') ?? 0),
          findingFilter: new URL(request.url).searchParams.get('findingFilter') ?? 'all',
        }));
      } catch {
        // 不将原始记录或解析器错误中的内容带到浏览器。
        return respond({error: '执行记录暂时无法读取，请刷新重试'}, 500);
      }
    },
  });
  ctx.effect(() => registerExecution, 'sdlc-ui.execution route');

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
