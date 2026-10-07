# AI 原生 SDLC 落地仓库

本仓库把 Anthropic《AI 原生 SDLC 实战手册》的方法论落地到 **DeepSeek Harness (DSH)**。
手册原文（中文全译）在 `handbook/`。本文件是 agent 的项目记忆，每次会话开始时读取。

## 仓库在做什么

把手册的六个阶段（规划→设计→构建→测试→部署→维护）表达为**受版本控制的制品链**，
并把可自动化的控制点接到 DSH 的扩展点上。

**制品即流程**：每个阶段的产出是一份提交入库的制品，下一阶段读取它。
`intent.md` → `spec.md` → `plan.md` → diff+测试 → 带评审发现的 PR → 事故记录。
提交历史同时就是审计追踪。

## 目录

| 路径 | 作用 |
|---|---|
| `handbook/` | 手册原文，只读参考，不修改 |
| `.dsh/skills/` | 组织沉淀知识（DSH 项目级 Skill 根，rank 100） |
| `.claude/skills/` | 同一批 Skill 的 Claude Code 根，由 `customSkillDirs` 挂载 |
| `.claude/hooks.json` | 门禁钩子，走 `dsh-hooks-claude-code` 桥接 |
| `.claude/hooks/` | 钩子脚本（shell 子进程） |
| `artifacts/` | 制品链，见下 |
| `work/dsh-inspect/docs/` | DSH 能力调研结论（带行号引用，是决策依据） |

## 制品链约定

```
artifacts/
  intent/    意图     — 提出者原话 + 问题/结果/影响/约束/待决问题
  spec/      规格     — 需求与设计合并，标注需关注领域
  plan/      计划     — 改哪些文件、工作顺序、风险、如何证明
  review/    评审发现 — 按严重程度排序
  incidents/ 事故     — 处置记录，回路写回新的 intent
```

**命名**：`intent/YYYY-MM-DD-<kebab-slug>.md`，`spec/` 与 `plan/` 用**同名 slug** 与 intent 配对。
命名由 `.claude/hooks/artifact-guard.sh` 强制。

**最小模板**（每个 intent 至少包含这些小节）：

```markdown
# Intent: <标题>
Author: <谁>. Status: draft | accepted | rejected.

## Problem
## Proposed outcome
## Affected users and systems
## Constraints
## Open questions
```

## 关键约束（本机实测结论，不要凭手册推断）

1. **项目根判定靠 `.git`**。DSH 的 skill 根与 `AGENTS.md` 都取"最近含 `.git` 的祖先"，
   否则退回 cwd。本仓库必须保持是 git 仓库。
2. **`dsh` CLI 与桌面运行时版本不一致**（PATH 上是 `0.1.0-rc.7`，运行时是 `0.2.0-rc.2`）。
   **不要**用 PATH 上的 `dsh` 管理本机 profile，会触发 peer 校验失败。
3. **插件安装需要审批**；本会话的审批策略可能是 `never`，此时安装会被自动拒绝而非询问。
   安装步骤写在 `PLUGIN-SETUP.md`，由人执行。
4. **`.claude/skills/` 不被 DSH 识别**。必须通过 `customSkillDirs` 显式挂载，
   否则只有 `.dsh/skills/` 生效。
5. **hooks 桥接只支持 7 个事件**（`SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse`/
   `Stop`/`SubagentStart`/`SubagentStop`），且 **不支持入参改写**——钩子只能拒绝，不能修正后放行。
6. **`configPath` 的相对路径从启动进程的目录解析**，不是工作区。桌面 App 下必须用绝对路径。
7. **DSH 没有网络出口管控**。沙箱只管文件效果。不要声称本仓库能限制网络。
8. **DSH 没有不可覆盖的管理层**。任何控制都能被能改 `~/.dsh/` 的人关闭，
   合规边界必须落在 host 层（文件属主/MDM/独立进程身份）。

## 改动本仓库时的约定

- **内容层**（`AGENTS.md`、`SKILL.md` 正文、制品模板）写成 harness 无关的形式，
  路径绑定交给配置，**不要复制两份内容**。
- **机制层**（门禁、拦截）优先用 `.claude/hooks/` 的 shell 子进程，而不是 DSH 原生插件——
  插件与宿主同进程且完全受信，**游离 promise 或同步回调抛错会杀死宿主进程**。
- Skill 名必须 kebab-case，frontmatter 必须有 `name` 与 `description`。
- 门禁脚本必须**失败即拒绝**（fail closed），且拒绝理由要能让人看懂怎么拿授权。
- 新增能力前先查 `work/dsh-inspect/docs/`，确认 DSH 是否已有原语；不要假设 Claude Code 的行为。

## 当前状态

- [x] 仓库骨架、制品目录、门禁脚本、技能
- [ ] 插件挂载（见 `PLUGIN-SETUP.md`，待人工执行）
- [ ] 门禁 deny/ask 行为的实测验证
- [ ] 阶段 06 无人闭环（需先决定 Host 常驻还是外部 cron）
