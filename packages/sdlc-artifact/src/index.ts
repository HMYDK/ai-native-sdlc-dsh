/**
 * @ai-native-sdlc/dsh-sdlc-artifact
 *
 * AI 原生 SDLC 的**制品撰写与结构检查**。
 *
 * ## 这个插件解决什么
 *
 * 手册给 intent / spec / plan 各规定了一组必需章节，而这些章节**都是下游的输入**：
 *   · intent 的 `Open questions` → spec 阶段必须逐条回答或延续
 *   · spec 的 `Areas of concern` → 产品负责人转交策略负责人的清单
 *   · plan 的 `Proof`            → 验证阶段对账"计划里承诺的证据"
 * 章节缺失会让下游**静默地少掉一个输入**——这正是要防的。
 *
 * ## 这个插件**不**解决什么（写在工具描述里，也写在拒绝信息里）
 *
 * **它只查结构，不查质量。结构合规的废话照样能通过。**
 * 一段把 `## Problem` 填成"我们要做得更好"的 intent.md 在结构上完全合法。
 * 夸大一个检查的能力比不做更危险——本项目已经因为宣称"绕不过去"
 * 被独立验证者实测推翻过一次（见 docs/dsh-pitfalls.md）。
 */

import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { FsTarget as _FsTarget } from '@deepseek-ai/dsh-fs';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type { SandboxPolicyService as _SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy';
import {
  ARTIFACT_FILENAMES,
  ARTIFACT_KINDS,
  checkArtifact,
  isArtifactKind,
  REQUIRED_SECTIONS,
  skeletonFor,
  type ArtifactKind,
} from './artifact.js';

export const name = 'sdlc-artifact';

export const inject = ['tools', 'fs', 'systemPrompt', 'sandboxPolicy'];

export const Config = z.object({
  /** 任务目录位置，相对仓库根。必须与 sdlc-task 一致，否则两个插件会看不同的地方。 */
  tasksDir: z.string().default('.ai/tasks'),
});

interface SdlcArtifactConfig {
  tasksDir: string;
}

// ── 路径与文件系统（与 sdlc-task / sdlc-verify 同一套写法）────────────

/**
 * 解析选项：`fs.resolve` 必须带 cwd，否则会落到沙箱的**部署 fallback 根**
 * （`process.cwd()`，即 App 的工作目录），于是"写自己仓库里的文件"被判越界。
 * 详见 docs/dsh-pitfalls.md §11.1——这个坑在两个包里各踩过一次。
 */
function resolveOptions(
  exec: { agent?: unknown; signal?: AbortSignal },
  policyRoot?: string,
): { cwd?: string; signal?: AbortSignal } {
  const agent = exec.agent as { session?: { header?: { cwd?: unknown } } } | undefined;
  const raw = agent?.session?.header?.cwd;
  const sessionCwd = typeof raw === 'string' && raw !== '' ? raw.replace(/\/+$/, '') : undefined;
  const cwd = policyRoot ?? sessionCwd;
  return { ...(cwd !== undefined ? { cwd } : {}), signal: exec.signal };
}

function requireSessionCwd(exec: { agent?: unknown }): string {
  const agent = exec.agent as { session?: { header?: { cwd?: unknown } } } | undefined;
  const raw = agent?.session?.header?.cwd;
  if (typeof raw !== 'string' || raw === '') {
    throw new Error(
      'sdlc-artifact 无法确定仓库根：拿不到 session 的 cwd。请在有工作目录的会话里调用。',
    );
  }
  return raw.replace(/\/+$/, '');
}

async function writePolicy(
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

interface TaskPaths {
  repoRoot: string;
  taskDir: string;
  stateFile: string;
}

function pathsFor(cfg: SdlcArtifactConfig, exec: { agent?: unknown }, taskId: unknown): TaskPaths {
  const repoRoot = requireSessionCwd(exec);
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    throw new Error('task_id 必须是非空字符串，例如 "PROJ-1024"');
  }
  const id = taskId.trim().toUpperCase();
  const taskDir = `${repoRoot}/${cfg.tasksDir.replace(/\/+$/, '')}/${id}`;
  return { repoRoot, taskDir, stateFile: `${taskDir}/state.yaml` };
}

async function readFileIfExists(
  ctx: Context,
  path: string,
  exec: { agent?: unknown; signal?: AbortSignal },
): Promise<string | undefined> {
  const target = await ctx.fs.resolve(path, resolveOptions(exec));
  const info = await ctx.fs.stat(target, exec.signal);
  if (info === undefined || info.type !== 'file') return undefined;
  return ctx.fs.readText(target, exec.signal);
}

async function writeFile(
  ctx: Context,
  path: string,
  content: string,
  exec: { agent?: unknown; signal?: AbortSignal },
): Promise<void> {
  const policy = await writePolicy(ctx, exec);
  const target = await ctx.fs.resolve(path, resolveOptions(exec, policy?.workspaceRoot));
  await ctx.fs.writeText(target, content, undefined, exec.signal, policy);
}

/**
 * 把制品登记进任务 `state.yaml` 的 `artifacts`。
 *
 * 与 sdlc-verify 里的同名逻辑同一套做法，理由也一样：**只写文件不够**，
 * `sdlc_task_advance` 的准入门槛看的是 `state.yaml` 的 `artifacts`，
 * 不是"磁盘上碰巧有这个文件"。
 *
 * 返回值是**给人看的一句话**，会出现在工具返回值里。为什么必须报出来：
 * 这个函数有多条"静默放弃"的路径，而静默成功与静默失败在制品上无法区分
 * （独立验证者指出过这一点）。最小编辑：只在 artifacts 段插一行——
 * state.yaml 是人也会手改的文件，整份重写风险太大。
 */
async function registerArtifact(
  ctx: Context,
  paths: TaskPaths,
  kind: ArtifactKind,
  filename: string,
  exec: { agent?: unknown; signal?: AbortSignal },
): Promise<string> {
  const text = await readFileIfExists(ctx, paths.stateFile, exec);
  if (text === undefined) {
    return `⚠ 制品未登记：任务没有 state.yaml（${paths.stateFile}）。文件已写好，但状态机看不到它。`;
  }
  // 必须比对**值**而不只是键：只写 `^\s*${kind}:` 会把
  // `verification: "verification.json"` 误判成"已登记 intent"——
  // 那样真正的文件名永远不会被写进去。冒烟测试抓到了这一点。
  if (new RegExp(`^\\s*${kind}:\\s*"${escapeRe(filename)}"\\s*$`, 'm').test(text)) {
    return `制品登记：${kind} → ${filename} 已在 state.yaml 中`;
  }

  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^artifacts:\s*$/.test(l));
  if (start < 0) {
    return (
      `⚠ 制品未登记：state.yaml 里找不到 \`artifacts:\` 段（可能被手改过）。` +
      `文件已写好，请手动登记 ${kind}: "${filename}"`
    );
  }
  let insertAt = start + 1;
  while (insertAt < lines.length && /^\s{2}\S/.test(lines[insertAt] ?? '')) insertAt += 1;

  // 同一个 kind 已存在但值不同 → 就地替换，不要插入重复键
  //（重复键在 YAML 里是错的，而且后一个会静默覆盖前一个）
  const existingAt = lines.findIndex(
    (l, i) => i > start && i < insertAt && new RegExp(`^\\s{2}${escapeRe(kind)}:\\s`).test(l),
  );
  const line = `  ${kind}: "${filename}"`;
  if (existingAt >= 0) {
    lines[existingAt] = line;
    await writeFile(ctx, paths.stateFile, lines.join('\n'), exec);
    return `制品登记：${kind} → ${filename}（更新了原有登记）`;
  }

  lines.splice(insertAt, 0, line);
  await writeFile(ctx, paths.stateFile, lines.join('\n'), exec);
  return `制品登记：${kind} → ${filename} → state.yaml 的 artifacts`;
}

/** 转义成可用于 RegExp 的字面量（制品名是我们自己定的，但不该依赖这一点）。 */
function escapeRe(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function apply(ctx: Context, config: SdlcArtifactConfig): void {
  const cfg = config;

  // ─────────────────────────────────────────────────── 结构检查（只读）
  ctx.tools.register(
    defineTool({
      name: 'sdlc_artifact_check',
      description:
        'Check a draft artifact against the sections the handbook requires, WITHOUT writing anything. ' +
        'This checks STRUCTURE ONLY, NOT QUALITY: an artifact whose sections are all present but full of ' +
        'vacuous prose passes. Use it to catch the failure that matters most — a section heading that exists ' +
        'but has no content, which looks written but silently starves the next stage of an input.',
      parameters: {
        kind: {
          type: 'string',
          required: true,
          description: `Artifact kind: ${ARTIFACT_KINDS.join(' / ')}.`,
        },
        content: {
          type: 'string',
          description: 'The draft markdown to check. Omit if you pass task_id instead.',
        },
        task_id: {
          type: 'string',
          description: 'Check the artifact already on disk in this task, e.g. "PROJ-1024".',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true },
            ok: { type: 'boolean', required: true },
            found: { type: 'array', required: true, items: { type: 'string' } },
            missing: { type: 'array', required: true, items: { type: 'string' } },
            empty: { type: 'array', required: true, items: { type: 'string' } },
            placeholder: { type: 'array', required: true, items: { type: 'string' } },
            details: { type: 'array', required: true, items: { type: 'string' } },
            required_sections: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_a, v) => {
          const o = v as Record<string, unknown>;
          const list = (x: unknown) =>
            Array.isArray(x) && x.length > 0 ? (x as string[]).join(', ') : '（无）';
          return [
            {
              type: 'text',
              text: [
                `${String(o.kind)} 结构检查：${o.ok === true ? '通过' : '**不通过**'}`,
                `已找到章节：${list(o.found)}`,
                `缺失：${list(o.missing)}`,
                `有标题但无正文：${list(o.empty)}`,
                `未填占位符：${list(o.placeholder)}`,
              ].join('\n'),
            },
          ];
        },
      },
      async execute(args, exec) {
        const { kind, markdown } = await resolveCheckInput(ctx, cfg, args, exec);
        const r = checkArtifact(kind, markdown);
        const pick = (k: string) => r.findings.filter((f) => f.kind === k).map((f) => f.section);
        return {
          kind,
          ok: r.ok,
          found: r.found,
          missing: pick('missing'),
          empty: pick('empty'),
          placeholder: pick('placeholder'),
          details: r.findings.map((f) => `[${f.kind}] ${f.detail}`),
          required_sections: REQUIRED_SECTIONS[kind].map((s) => s.name),
        };
      },
    }),
  );

  // ─────────────────────────────────────────── 撰写制品（写文件 + 登记）
  ctx.tools.register(
    defineTool({
      name: 'sdlc_artifact_write',
      description:
        'Write an intent.md, spec.md or plan.md into a task directory, checking required sections first and ' +
        'registering the artifact in state.yaml so the task state machine can see it. Refuses to overwrite an ' +
        'existing artifact unless overwrite is true — a silently replaced intent is how "what was asked for" ' +
        'gets lost. NOTE: this gate checks STRUCTURE ONLY. Vacuous prose passes; passing it does not mean the ' +
        'artifact is good.',
      parameters: {
        task_id: {
          type: 'string',
          required: true,
          description: 'Task identity, e.g. "PROJ-1024". The artifact goes into that task directory.',
        },
        kind: {
          type: 'string',
          required: true,
          description: `Artifact kind: ${ARTIFACT_KINDS.join(' / ')}. Determines the required sections.`,
        },
        title: {
          type: 'string',
          description:
            'Used only when creating a skeleton (no content given). Ignored when content is provided.',
        },
        content: {
          type: 'string',
          description:
            'Full markdown. If omitted, a skeleton with the required section headings is written instead — ' +
            'the skeleton deliberately fails the structure check so it cannot be mistaken for a finished artifact.',
        },
        overwrite: {
          type: 'boolean',
          description: 'Allow replacing an existing artifact. Default false.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true },
            path: { type: 'string', required: true },
            created: { type: 'boolean', required: true },
            structure_ok: { type: 'boolean', required: true },
            findings: { type: 'array', required: true, items: { type: 'string' } },
            registration: { type: 'string', required: true },
            quality_checked: { type: 'boolean', required: true },
          },
        },
        render: (_a, v) => {
          const o = v as Record<string, unknown>;
          const fs = Array.isArray(o.findings) ? (o.findings as string[]) : [];
          return [
            {
              type: 'text',
              text: [
                `${String(o.kind)} 已${o.created === true ? '创建' : '更新'}：${String(o.path)}`,
                `结构检查：${o.structure_ok === true ? '通过' : `**不通过**（${fs.length} 项）`}`,
                ...fs.map((f) => `  · ${f}`),
                String(o.registration),
                o.quality_checked === false
                  ? '⚠ 只检查了结构，**没有检查内容质量**——结构合规的废话照样能通过。'
                  : '',
              ]
                .filter((l) => l !== '')
                .join('\n'),
            },
          ];
        },
      },
      async execute(args, exec) {
        if (!isArtifactKind(args.kind)) {
          throw new Error(
            `非法制品类型：${JSON.stringify(args.kind)}。允许值：${ARTIFACT_KINDS.join(' / ')}`,
          );
        }
        const kind = args.kind;
        const paths = pathsFor(cfg, exec, args.task_id);
        const filename = ARTIFACT_FILENAMES[kind];
        const path = `${paths.taskDir}/${filename}`;

        const existing = await readFileIfExists(ctx, path, exec);
        if (existing !== undefined && args.overwrite !== true) {
          const check = checkArtifact(kind, existing);
          throw new Error(
            `${filename} 已存在（${existing.length} 字符，结构检查${check.ok ? '通过' : '不通过'}）。` +
              '要用 overwrite: true 明确覆盖——静默替换会让"当初要求的是什么"丢失。' +
              '想先看它的结构问题，用 sdlc_artifact_check。',
          );
        }

        const content =
          typeof args.content === 'string' && args.content.trim() !== ''
            ? args.content
            : skeletonFor(kind, typeof args.title === 'string' && args.title !== '' ? args.title : '（待填标题）');

        await writeFile(ctx, path, content, exec);

        // 结构检查在写之后跑：文件已经在磁盘上，报告的结论与磁盘一致。
        // （先检查再写会让"检查通过"与"实际写下的内容"可能不一致。）
        const r = checkArtifact(kind, content);

        const registration = r.ok
          ? await registerArtifact(ctx, paths, kind, filename, exec)
          : '未登记：结构检查未通过。补全缺失章节后用 overwrite: true 重写，届时会自动登记。';

        return {
          kind,
          path,
          created: existing === undefined,
          structure_ok: r.ok,
          findings: r.findings.map((f) => `[${f.kind}] ${f.detail}`),
          registration,
          quality_checked: false,
        };
      },
    }),
  );

  // ────────────────────────────────────────────────────────── 方法论引导
  ctx.systemPrompt.section({
    name: 'sdlc:artifact-policy',
    order: 680,
    text: [
      '## 制品撰写（AI 原生 SDLC）',
      '',
      '手册给每种制品规定了必需章节，而这些章节**都是下游的输入**——缺一节，下游就少一个输入：',
      '',
      '- `intent.md`：Problem / Proposed outcome / Affected users and systems / Constraints / **Open questions**',
      '  （Open questions 是规格阶段的输入：spec 必须逐条回答或延续）',
      '- `spec.md`：Requirements / Design / **Areas of concern**',
      '  （关注点是产品负责人转交策略负责人的清单）',
      '- `plan.md`：Files that change / Order of work / Risks / **Proof**',
      '  （Proof 是验证阶段对账的依据——"计划里承诺的证据"要能对得上）',
      '',
      '用 `sdlc_artifact_write` 写、`sdlc_artifact_check` 先查草稿（不写盘）。',
      '',
      '⚠️ 这两个工具**只查结构，不查质量**。结构合规的废话照样通过。',
      '把这个检查当成"少写了没有"，不是"写得好不好"。',
    ].join('\n'),
  });
}

/** 解析 check 的输入：要么给 content，要么从磁盘上的任务制品读。 */
async function resolveCheckInput(
  ctx: Context,
  cfg: SdlcArtifactConfig,
  args: { kind?: unknown; content?: unknown; task_id?: unknown },
  exec: { agent?: unknown; signal?: AbortSignal },
): Promise<{ kind: ArtifactKind; markdown: string; source?: string }> {
  if (!isArtifactKind(args.kind)) {
    throw new Error(
      `非法制品类型：${JSON.stringify(args.kind)}。允许值：${ARTIFACT_KINDS.join(' / ')}`,
    );
  }
  const kind = args.kind;

  if (typeof args.content === 'string' && args.content.trim() !== '') {
    return { kind, markdown: args.content };
  }

  if (typeof args.task_id === 'string' && args.task_id.trim() !== '') {
    const paths = pathsFor(cfg, exec, args.task_id);
    const path = `${paths.taskDir}/${ARTIFACT_FILENAMES[kind]}`;
    const text = await readFileIfExists(ctx, path, exec);
    if (text === undefined) {
      throw new Error(`任务里没有 ${ARTIFACT_FILENAMES[kind]}（${path}）。用 content 传草稿，或先写制品。`);
    }
    return { kind, markdown: text, source: path };
  }

  throw new Error('必须给出 content（草稿）或 task_id（检查磁盘上已有的制品）之一。');
}

// 刻意**不**做跨制品一致性检查（例如"intent 的 open questions 是否都被 spec 回答"）：
// 那需要语义判断，而本插件的边界就是"只查结构"。做半个语义检查
// 比不做更危险——它会给人"内容也被检查过了"的错觉。
