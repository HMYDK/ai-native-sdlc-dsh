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
4. **`.claude/skills/` 不被 DSH 识别**；而且 **宿主的 `skill-filesystem` 行在
   `dsh-web-app/cordis.patch.yml` 里是 `disabled: true`**（注释："presets own local
   discovery"），本地发现改由各 agent preset 自己挂。后果：**宿主层没有 Skill provider，
   项目级 `.dsh/skills/` 不会进入任何 agent 的目录**——`/skill <name>` 报
   `unknown or no longer available`，即使目录结构与 frontmatter 全部正确。
   修法：在 profile 层重挂宿主级 provider（注册进 registry 全局层，对全部 agent 可见）：
   ```yaml
   - insert:
       - id: skill-filesystem-host
         name: "@deepseek-ai/dsh-skill-filesystem"
         config:
           customSkillDirs: ["<repo>/.claude/skills"]
   ```
   **诊断教训：验证「路径解析正确」不等于验证「provider 已挂载」。**
   真正的判据是 `/skill <name>` 能否加载。此改动**支持 HMR 热加载，无需重启**。
5. **hooks 桥接只支持 7 个事件**（`SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse`/
   `Stop`/`SubagentStart`/`SubagentStop`），且 **不支持入参改写**——钩子只能拒绝，不能修正后放行。
5b. **`matcher` 必须用 DSH 的小写工具名——移植 Claude Code 钩子最大的坑。**
   DSH 实际工具名是 `bash` / `write` / `edit` / `read`，**不是** `Bash`
   （手册与 Claude Code 文档里都是大写 B）。写了 `"Bash"` **不报任何错**：
   桥接 fiber 照常 `active`，但 matcher 永不匹配，`hook/*` 事件数恒为 0，**完全静默**。
   实测：改小写前本会话 854 个事件中 `hook/*` = 0。**matcher 大小写敏感。**
   可用工具名：`bash write edit read grep glob todo_write subagent plugin_manager
   cordis_inspect_list cordis_inspect_query job_output job_list job_kill
   list_agents send_message interrupt_agent skill present` 等。
   排查手法：解压会话日志统计 `tool/call` 的 `name` 字段。
6. **`configPath` 的相对路径从启动进程的目录解析**，不是工作区。桌面 App 下必须用绝对路径。
7. **DSH 没有网络出口管控**。沙箱只管文件效果。不要声称本仓库能限制网络。
8. **DSH 没有不可覆盖的管理层**。任何控制都能被能改 `~/.dsh/` 的人关闭，
   合规边界必须落在 host 层（文件属主/MDM/独立进程身份）。
9. **新增 Skill 后立即可用**（挂载正确时）：`skill-filesystem` 的 watcher 会监听既存根的
   直接子项，profile 层的 provider 改动也走 HMR，**无需重启**。
   注：本仓库建成当天 `skill "…" is unknown` 的真实原因是第 4 条（宿主无 provider），
   不是会话快照——不要沿用那个错误结论。

## 改动本仓库时的约定

- **内容层**（`AGENTS.md`、`SKILL.md` 正文、制品模板）写成 harness 无关的形式，
  路径绑定交给配置，**不要复制两份内容**。
- **机制层**（门禁、拦截）优先用 `.claude/hooks/` 的 shell 子进程，而不是 DSH 原生插件——
  插件与宿主同进程且完全受信，**游离 promise 或同步回调抛错会杀死宿主进程**。
- Skill 名必须 kebab-case，frontmatter 必须有 `name` 与 `description`。
- 门禁脚本必须**失败即拒绝**（fail closed），且拒绝理由要能让人看懂怎么拿授权。
- 新增能力前先查 `work/dsh-inspect/docs/`，确认 DSH 是否已有原语；不要假设 Claude Code 的行为。

## 当前状态

**核心链路已全部打通并通过端到端实测（2026-10-07）。**

- [x] 仓库骨架、制品目录、门禁脚本、技能
- [x] 门禁脚本逻辑自测（`.claude/hooks/verify-gates.sh`，26 项全通过）
- [x] 插件安装 + 挂载（App 自带 CLI + profile `insert` 行，fiber `active`）
- [x] **三个 Skill 可加载**（`/skill <name>` 实测成功）
- [x] **门禁端到端实测通过**，三条路径均有会话日志 `hook/*` 事件为证：
      `git push origin main` → `block`/2（未执行）；
      普通命令 → `pass`/0；
      无配对 intent 写 `artifacts/spec/` → `block`/2（未写入）
- [ ] 确认桌面 App 是否把 shell 环境传给钩子进程（决定 `RELEASE_APPROVAL` 怎么注入）
- [ ] 阶段 06 无人闭环（需先决定 Host 常驻还是外部 cron）

### 四个根因（都是静默失败，排查耗时很长，务必先读）

按发现顺序，每一个的症状都是「什么都没发生」，没有一个会报错：

1. **插件未安装** → 桥接不存在，`hooks.json` 无人读取
2. **`matcher` 大小写**：写 `"Bash"` 而非 `bash` → fiber 仍 `active`，但永不匹配
3. **路径空格**：`command` 用裸可执行文件路径 → 仓库路径含空格 → `exit 126`，
   且按契约属「非阻断失败」，命令照常执行
4. **宿主层无 Skill provider**：`dsh-web-app` 把 `skill-filesystem` 设为 `disabled`
   → 项目级 Skill 目录从未被扫描

### 三条给未来的自己的教训

1. **`verify-gates.sh` 直接 `bash 脚本`，绕过了桥接。单元测试通过 ≠ 端到端可用。**
   任何涉及「接线」的改动都必须用真实操作验证，且汇报时不要把单元测试说成功能可用。
2. **诊断 DSH 插件问题，第一步永远是 `plugin_manager list_plugins`**——它返回实时
   Loader 状态（含 `fiberPhase`）。我查了四轮才想到用它，此前一直用不可靠的间接推断
   （`cordis_inspect` 查 Service——但该桥接根本不注册 Service）。
3. **「配置写对了」和「运行时加载了」是两件事。** 我先后验证了路径解析、YAML 语法、
   Schema 校验、dump-config——全部通过，但功能仍然不工作，因为**没有验证运行时状态**。
   会话日志的 `hook/*` 事件与 `list_plugins` 的 `fiberPhase` 才是运行时真相。
