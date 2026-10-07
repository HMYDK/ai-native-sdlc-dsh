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
import { humanAge, scanTasks, summarize, type ScanInput, type TaskEntry } from './scan.js';
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
        'state machine\'s time, so hand-editing an artifact does not reset it.',
      parameters: {
        tasks_dir: {
          type: 'string',
          description: 'Override the tasks directory (relative to the repo root). Defaults to the configured value.',
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
            stale: { type: 'number', required: true },
            waiting: { type: 'number', required: true },
          },
        },
        render: (_a, v) => {
          const o = v as { summary?: unknown; tasks?: unknown };
          const lines = Array.isArray(o.tasks) ? (o.tasks as string[]) : [];
          return [
            {
              type: 'text',
              text: [String(o.summary), '', ...lines].join('\n'),
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

        const input = await collectScanInput(ctx, tasksRoot, exec);
        const result = scanTasks({ ...input, staleAfterHours: cfg.staleAfterHours });

        // 上限：任务很多时不要把所有细节都灌进上下文。
        // 截断要**显式说出来**，否则人以为自己看到了全部。
        const LIMIT = 50;
        const shown = result.tasks.slice(0, LIMIT);
        const truncated = result.tasks.length > LIMIT;

        const lines = shown.map((t) => formatEntry(t));
        if (truncated) {
          lines.push(`… 还有 ${result.tasks.length - LIMIT} 个未显示（共 ${result.tasks.length} 个）`);
        }

        return {
          summary: summarize(result),
          total: result.counts.total,
          ok: result.counts.ok,
          incomplete: result.counts.incomplete,
          error: result.counts.error,
          tasks: lines,
          truncated,
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
