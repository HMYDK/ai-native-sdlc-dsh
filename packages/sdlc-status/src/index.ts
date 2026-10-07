/**
 * @ai-native-sdlc/dsh-sdlc-status
 *
 * AI 原生 SDLC 的**任务看板**。
 *
 * ## 为什么需要它
 *
 * 前三个插件让每个任务自己管自己：`sdlc-task` 管状态机、`sdlc-artifact` 管制品、
 * `sdlc-verify` 管独立验证。但**没有任何地方能一眼看到全部任务**——
 * "有哪几个任务卡住了""谁的裁决是 reject 还没处理""哪个任务制品不全"，
 * 这些只能挨个去问。
 *
 * 一次调用把这个盘出来。
 *
 * ## 为什么它是 host 侧工具而不是 GUI 面板
 *
 * 原本的计划是客户端 UI 面板。实测调研后放弃（见 docs/dsh-pitfalls.md §13）：
 * 本机**没有构建客户端 bundle 的 tsdown Client preset**，
 * host 半给客户端用的 RPC 也是构建期生成的，而客户端代码**我验证不了**
 * （"加载 ≠ 可用"，客户端连"加载"都做不到）。
 *
 * 交付一个验证不了的渲染器**违背本项目的验证纪律**。所以改成 host 侧工具：
 * 同样的信息，而且能被完整验证。
 *
 * ## 刻意不做的事
 *
 * 不缓存、不写文件、不改任何状态。它只读。
 */

import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { FsTarget as _FsTarget } from '@deepseek-ai/dsh-fs';
import {
  humanAge,
  MAX_PAGE_LIMIT,
  scanTasks,
  selectTasks,
  summarize,
  type ScanInput,
  type TaskEntry,
} from './scan.js';
import { requireSessionCwd, resolveOptions } from './helpers.js';

export const name = 'sdlc-status';

export const inject = ['tools', 'fs', 'systemPrompt'];

export const Config = z.object({
  /** 任务目录位置，相对仓库根。必须与 sdlc-task / sdlc-artifact 一致。 */
  tasksDir: z.string().default('.ai/tasks'),
  /**
   * 超过这个小时数没动就算"停滞"。
   *
   * ⚠️ 口径：用 `state.yaml` 的 `updated`，即**状态机的时间**，
   * 不是"最后一次有人干活的时间"——手改制品内容不会动它。
   * 所以"很新"不代表在推进，但"很久没动"仍然有意义：状态机没动 = 流程没往前走。
   */
  staleAfterHours: z.number().default(24),
});

interface SdlcStatusConfig {
  tasksDir: string;
  staleAfterHours: number;
}



/**
 * 读取任务目录，组装成 `scanTasks` 需要的纯输入。
 *
 * 只有目录本身与 `state.yaml` 等少数文件会被读；`readFile` 是惰性的，
 * 扫描逻辑按需调用——不会为了统计去读每个制品的正文。
 */
async function collectScanInput(
  ctx: Context,
  tasksRoot: string,
  exec: { agent?: unknown; signal?: AbortSignal },
): Promise<ScanInput> {
  const rootTarget = await ctx.fs.resolve(tasksRoot, resolveOptions(exec));
  const rootInfo = await ctx.fs.stat(rootTarget, exec.signal);
  if (rootInfo === undefined || rootInfo.type !== 'directory') {
    // 没有任务目录不是错误——可能还没开始用。
    return { dirs: [], readFile: () => undefined };
  }

  const dirents = await ctx.fs.listDir(rootTarget, exec.signal);
  const dirNames = dirents
    .filter((d) => d.type === 'directory')
    .map((d) => d.name)
    .sort();

  const dirs: ScanInput['dirs'] = [];
  const cache = new Map<string, string | undefined>();

  for (const task of dirNames) {
    const dirPath = `${tasksRoot}/${task}`;
    let files: string[] = [];
    try {
      const t = await ctx.fs.resolve(dirPath, resolveOptions(exec));
      const entries = await ctx.fs.listDir(t, exec.signal);
      files = entries.filter((e) => e.type === 'file').map((e) => e.name);
    } catch {
      files = [];
    }
    dirs.push({ task, files });
  }

  const readFile = (task: string, relativePath: string): string | undefined => {
    const key = `${task}\u0000${relativePath}`;
    // 同步接口 + 异步 IO：先在收集阶段把需要的文件读好。
    // 这里返回的是预算好的缓存；未预算的返回 undefined（调用方只问已列出的文件）。
    return cache.get(key);
  };

  // 预先读扫描需要的文件：state.yaml、verification.json，以及
  // state.yaml 里登记过的制品（用于判定"登记了但文件不在"）。
  for (const { task, files } of dirs) {
    for (const name of ['state.yaml', 'verification.json']) {
      if (!files.includes(name)) continue;
      try {
        const t = await ctx.fs.resolve(`${tasksRoot}/${task}/${name}`, resolveOptions(exec));
        cache.set(`${task}\u0000${name}`, await ctx.fs.readText(t, exec.signal));
      } catch {
        cache.set(`${task}\u0000${name}`, undefined);
      }
    }
    // 制品正文不读——只需知道存在与否，而存在性由上面列出的 files 判定。
    // 但 scan 对含 `/` 的路径会回调 readFile 探测，所以对每个已列出的文件
    // 登记一个哨兵值，使 `!== undefined` 成立而不必读内容。
    for (const name of files) {
      const key = `${task}\u0000${name}`;
      if (!cache.has(key)) cache.set(key, '');
    }
  }

  return { dirs, readFile };
}

export function apply(ctx: Context, config: SdlcStatusConfig): void {
  const cfg = config;

  ctx.tools.register(
    defineTool({
      name: 'sdlc_status',
      description:
        'List every task in the workspace with its status, artifact completeness, what is missing, and the latest ' +
        'verification verdict. Use it to answer "what is stuck", "which task has an unresolved reject", or "what ' +
        'should I work on next" in ONE call instead of asking task by task. ' +
        'Read-only: it never writes or changes any state. A task whose state.yaml is broken is reported as an ' +
        'error entry rather than aborting the scan — the dashboard must still work when something is wrong. ' +
        'It also reports how long each task has been idle and separates "stale" (idle past the threshold while ' +
        'work is expected) from "waiting" (a needs_human verdict — idle because it is waiting for a person, which ' +
        'is normal). Configure the threshold with staleAfterHours; the clock is state.yaml\'s `updated`, i.e. the ' +
        'state machine\'s time, so hand-editing an artifact does not reset it. ' +
          // ⚠️ 这一句是本次变更最容易埋雷的地方：`tasks` 的语义从"全部任务"
          // 变成了"**本次显示**的任务"。在不超过一页（50 个）的仓库里两者
          // 看起来完全一样，所以这个区别在开发者的本地仓库里天然测不到——
          // 必须在描述里说清楚，否则调用方会把 `tasks` 的长度当成任务总数。
          'IMPORTANT: the returned `tasks` are the ones SHOWN, not all of them — compare with `total`, or check ' +
          '`complete`. When there are more, pass `offset` to continue (the `note` tells you the next offset to ' +
          'use). Pass `task_id` to see one task in detail. Non-integer or negative `offset`/`limit` are errors, ' +
          'not silently coerced.',
      parameters: {
        tasks_dir: {
          type: 'string',
          description: 'Override the tasks directory (relative to the repo root). Defaults to the configured value.',
        },
        task_id: {
          type: 'string',
          description:
            'Show ONLY this task in detail (one entry). Takes precedence over offset/limit; the ignored ' +
            'parameters are reported in `note`. Errors if no such task exists — an empty list could not be ' +
            'told apart from a broken scan.',
        },
        offset: {
          type: 'integer',
          description:
            'Skip the first N tasks (pagination). Use the offset suggested in `note` to continue. ' +
            'A non-integer or negative value is an error, not silently treated as 0.',
        },
        limit: {
          type: 'integer',
          description:
            'Show at most M tasks (default 50). Values above 200 are clamped to 200 and the requested value ' +
            'is reported in `note` — clamp is never silent.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string', required: true },
            total: { type: 'number', required: true },
            ok: { type: 'number', required: true },
            incomplete: { type: 'number', required: true },
            error: { type: 'number', required: true },
            tasks: { type: 'array', required: true, items: { type: 'string' } },
            truncated: { type: 'boolean', required: true },
            note: { type: 'string' },
            window_start: { type: 'number', required: true },
            window_end: { type: 'number', required: true },
            complete: { type: 'boolean', required: true },
            stale: { type: 'number', required: true },
            waiting: { type: 'number', required: true },
          },
        },
        render: (_a, v) => {
          const o = v as { summary?: unknown; tasks?: unknown; note?: unknown };
          const lines = Array.isArray(o.tasks) ? (o.tasks as string[]) : [];
          // `note` 必须渲染出来——字段存在但人看不到，等于没有。
          // 它承载"还有多少、怎么继续、哪些参数被忽略"这类必须被看见的信息。
          const note = typeof o.note === 'string' && o.note !== '' ? o.note : undefined;
          return [
            {
              type: 'text',
              text: [String(o.summary), ...(note !== undefined ? [note] : []), '', ...lines].join('\n'),
            },
          ];
        },
      },
      async execute(args, exec) {
        const repoRoot = requireSessionCwd(exec, 'sdlc-status');
        const dir = (typeof args.tasks_dir === 'string' && args.tasks_dir.trim() !== ''
          ? args.tasks_dir.trim()
          : cfg.tasksDir
        ).replace(/\/+$/, '');
        const tasksRoot = `${repoRoot}/${dir}`;

        // 参数校验：**不做静默纠正**。
        // 把 offset=-1 当成 0、把 limit=1.5 当成 1，会让调用方以为自己传的参数生效了。
        const offset = intArg(args.offset, 'offset', { min: 0 });
        const limit = intArg(args.limit, 'limit', { min: 1 });
        const taskId =
          typeof args.task_id === 'string' && args.task_id.trim() !== ''
            ? args.task_id.trim()
            : undefined;

        const input = await collectScanInput(ctx, tasksRoot, exec);
        const result = scanTasks({ ...input, staleAfterHours: cfg.staleAfterHours });

        // 选择窗口（纯函数，见 scan.ts 的 selectTasks）。
        // task_id 未命中时它会抛错——那是**有意的**：返回空数组会让调用方
        // 分不清"该任务不存在"与"扫描坏了"。
        const sel = selectTasks(result.tasks, { taskId, offset, limit });

        const lines = sel.entries.map((t) => formatEntry(t));

        // `note` 只在调用方**显式用了新参数**时产出。
        //
        // ⚠️ 一开始我在默认路径也产出它，结果空仓库会渲染出
        // 「没有更多了：offset=0 已越过总数 0」——**没有任务却报"已越过总数"**，
        // 而默认路径本应逐字不变。独立验证者用 HEAD 的旧代码逐字对比抓到了这一条。
        //
        // 所以：默认路径回到旧行为（只有那行旧的截断提示）；
        // 文案只在"调用方问了什么"的语境里才成立。
        const explicit = taskId !== undefined || offset !== undefined || limit !== undefined;
        const bits: string[] = [];
        if (explicit) {
          if (sel.singleIndex >= 0) {
            bits.push(`单任务详情（第 ${sel.singleIndex + 1} / ${result.counts.total} 个）`);
            const ignored: string[] = [];
            if (offset !== undefined) ignored.push('offset');
            if (limit !== undefined) ignored.push('limit');
            if (ignored.length > 0) bits.push(`已忽略 ${ignored.join(' 与 ')}（单任务详情不受分页影响）`);
          } else if (sel.entries.length === 0) {
            bits.push(`没有更多了：offset=${String(offset)} 已越过总数 ${result.counts.total}`);
          } else if (!sel.complete) {
            bits.push(
              `显示第 ${sel.start + 1}-${sel.start + sel.entries.length} 个，共 ${result.counts.total} 个` +
                `（还有 ${sel.remaining} 个，用 offset=${sel.start + sel.entries.length} 继续）`,
            );
          }
          if (sel.clampedFrom !== undefined) {
            bits.push(
              `limit 请求 ${sel.clampedFrom}，超过上限 ${MAX_PAGE_LIMIT}，已按 ${MAX_PAGE_LIMIT} 处理`,
            );
          }
        }

        // 旧的截断提示**原样保留**（spec R1 的向后兼容要求）。
        // 它现在只表示"默认分页没全显示"，而不是"看不见那些任务"——
        // 用 offset 就能看到，`note` 会说下一步怎么走。
        // ⚠️ 这两件事必须**分开**（我自己在这里踩过一次，见下）：
        //
        //   ① `truncated` 字段：语义修正为"有任务没显示"（独立验证者的 finding）。
        //      旧写法 `!explicit && !complete` 在显式分页时恒为 false，
        //      调用方会以为看全了。新的式子 `!complete` 在默认路径下
        //      与旧实现逐字等价（默认 limit=50，total<=50 → false；total>50 → true）。
        //
        //   ② 那条旧的截断提示**行**：它属于**默认路径的向后兼容**，
        //      必须继续只在 `!explicit` 时追加。
        //
        // 我第一版把 ① 的式子直接用在 ② 上，于是显式分页时也追加了那行——
        // 会把一个真实任务挤出窗口（冒烟立刻抓到：limit=1000 在 250 个任务的
        // 仓库里显示 201 条，多出的那行是"… 还有 50 个未显示"，而它已经
        // 说了分页信息，重复且有害）。
        const truncated = !sel.complete;
        if (!explicit && truncated) {
          lines.push(`… 还有 ${result.counts.total - sel.entries.length} 个未显示（共 ${result.counts.total} 个）`);
        }

        const windowStart = sel.entries.length > 0 ? sel.start + 1 : 0;
        const windowEnd = sel.entries.length > 0 ? sel.start + sel.entries.length : 0;
        const note = bits.length > 0 ? bits.join('；') : undefined;

        return {
          summary: summarize(result),
          total: result.counts.total,
          ok: result.counts.ok,
          incomplete: result.counts.incomplete,
          error: result.counts.error,
          tasks: lines,
          truncated,
          ...(note !== undefined ? { note } : {}),
          window_start: windowStart,
          window_end: windowEnd,
          complete: sel.complete,
          stale: result.counts.staleness.stale,
          waiting: result.counts.staleness.waiting,
        };
      },
    }),
  );

  ctx.systemPrompt.section({
    name: 'sdlc:status-policy',
    order: 670,
    text: [
      '## 任务看板（AI 原生 SDLC）',
      '',
      '问题"哪些任务卡住了""谁的裁决还是 reject 没处理""下一步该做什么"——',
      '用 `sdlc_status` 一次问清，不要挨个去问任务。',
      '',
      '它对每个任务报出：状态、制品完整性、缺什么、最新验证裁决。',
      '它是**只读**的，不会改任何状态。',
    ].join('\n'),
  });
}

/**
 * 解析一个整数参数。**非法值抛错，不静默纠正。**
 *
 * 为什么不做宽容处理：把 `offset=-1` 当成 0、把 `limit=1.5` 当成 1，
 * 会让调用方**以为自己的参数生效了**，而它没有。参数错就要说出来。
 *
 * 空串与 `undefined` 都当作"没给"（模型常把可选参数传成空串）。
 */
function intArg(
  raw: unknown,
  name: string,
  opts: { min: number },
): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new Error(`${name} 必须是整数，收到 ${JSON.stringify(raw)}`);
  }
  if (raw < opts.min) {
    throw new Error(`${name} 必须 ≥ ${opts.min}，收到 ${raw}`);
  }
  return raw;
}

function formatEntry(t: TaskEntry): string {
  const bits: string[] = [];

  if (t.health === 'error') {
    return `✗ ${t.task} — **读不出来**：${t.error ?? '未知原因'}`;
  }

  // 停滞标记放最前
  const st = t.staleness;
  let mark = t.health === 'ok' ? '·' : '!';
  if (st?.class === 'stale') mark = '⏳';
  else if (st?.class === 'waiting') mark = '⏸';
  else if (st?.class === 'closed') mark = '✓';

  bits.push(`${mark} ${t.task}`);
  if (t.status !== undefined) bits.push(`[${t.status}]`);
  if (t.title !== undefined) bits.push(t.title);

  if (st !== undefined && st.ageMs !== undefined) {
    if (st.class === 'stale') {
      bits.push(`**停滞 ${humanAge(st.ageMs)}**（阈值 ${st.thresholdHours} 小时）`);
    } else if (st.class === 'waiting') {
      bits.push(`等人 ${humanAge(st.ageMs)}`);
    } else if (st.class !== 'closed') {
      bits.push(`${humanAge(st.ageMs)}前`);
    }
  }

  if (t.verdict !== undefined) {
    const v = t.verdict;
    const detail =
      v.criteria > 0
        ? ` (met ${v.met} / not_met ${v.notMet} / cannot_tell ${v.cannotTell})`
        : ' (未给验收标准)';
    bits.push(`裁决: ${v.status}${detail}`);
  } else {
    bits.push('裁决: 未验证');
  }

  if (t.missingForStatus.length > 0) bits.push(`缺: ${t.missingForStatus.join(', ')}`);
  if (t.missingOnDisk.length > 0) bits.push(`文件不在: ${t.missingOnDisk.join(', ')}`);
  if (t.nextRequired.length > 0) bits.push(`下一步需: ${t.nextRequired.join(', ')}`);

  return bits.join('  ');
}
