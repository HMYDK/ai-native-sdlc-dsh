# DSH 落地坑清单（实测，非文档推断）

本文件记录在 DSH `0.2.0-rc.2` 上实测踩到的坑。**全部是静默失败**——不报错，
只是"什么都没发生"。写 DSH 插件或配置前请先读。

来源：2026-10-07 一次端到端接线（Claude Code hooks 桥接）的排查过程，
以及插件化落地时的能力核实。原始记录见同名 Agent 会话日志。

---

## 1. `matcher` 必须用 DSH 的小写工具名

| | 工具名 |
|---|---|
| 手册 / Claude Code 文档 | `Bash`、`Write`、`Edit`（首字母大写） |
| **DSH 实际工具名** | **`bash`、`write`、`edit`、`read`**（全小写） |

写成 `"Bash"` **不报任何错**：插件 fiber 照常 `active`，但 matcher 永不匹配，
`hook/*` 事件数恒为 0，**完全静默**。**matcher 大小写敏感。**

实测可用工具名：`bash` `write` `edit` `read` `grep` `glob` `todo_write`
`subagent` `plugin_manager` `cordis_inspect_list` `cordis_inspect_query`
`job_output` `job_list` `job_kill` `list_agents` `send_message`
`interrupt_agent` `skill` `present` 等。

自查当前环境的工具名：

```sh
zstd -dc ~/.dsh/sessions/--<项目>--/<session-id>/session.v4.jsonl.zstd \
  | jq -r 'select(.type=="tool/call") | .data.name' | sort | uniq -c | sort -rn
```

## 2. 插件包通常不带 `dsh.bundle`，需要手工挂载

`dsh plugin add <pkg>` 只把包装进 profile 的 `dependencies`。若包未声明
`dsh.bundle.patch`，会打印 `declares no dsh.bundle — installed as a plain dependency,
not a profile layer`，**必须**在 profile 的 `cordis.patch.yml` 里手工加 `insert` 行才会挂载。

`dsh-base`、`dsh-web-app` 这类 bundle 才带 `dsh.bundle.patch`，会自动启用。

## 3. 注册表 `latest` 标签可能指向过时版本

`@deepseek-ai/dsh-hooks-claude-code` 的 `latest` = `0.0.1-rc.5`（peer `^0.0.1-rc.5`），
而 `next` = `0.2.0-rc.2`（与运行时匹配）。**不带版本号安装会被版本门禁正确拒绝。**

```sh
dsh plugin --profile <p> add <pkg>@<与运行时一致的版本>
```

## 4. 路径含空格会静默打断钩子命令

仓库路径含空格时，`command` 若写裸可执行文件路径，展开后会被 shell 分词拆开：

```
exitCode 126 | bash: <WORKSPACE>/AI: is a directory
```

而按桥接契约，**除 `exit 2` 外的任何失败都是"非阻断失败"**——记录后继续执行，
所以钩子崩了命令照常跑，**又是静默的**。

正确写法（显式解释器 + 引号）：

```json
{ "command": "bash \"${CLAUDE_PLUGIN_ROOT}/gate.sh\"" }
```

## 5. 宿主的 `skill-filesystem` 在 web bundle 里被禁用

`dsh-web-app/cordis.patch.yml` 中：

```yaml
- id: skill-filesystem
  disabled: true
```

注释说明 *"presets own local discovery"* —— 本地发现改由各 agent preset 自己挂。
**后果**：宿主层没有 Skill provider，项目级 `.dsh/skills/` 不会进入任何 agent 的目录，
`/skill <name>` 报 `unknown or no longer available`，**即使目录结构与 frontmatter 全部正确**。

修法：在 profile 层重挂一个宿主级 provider（注册进 registry 全局层，对全部 agent 可见）。
此改动走 HMR，**无需重启**。

## 6. `configPath` 的相对路径从"启动进程的目录"解析

不是从工作区。桌面 App 从它自己的 Resources 目录启动，所以配置里必须用**绝对路径**。

## 7. 插件与宿主同进程、完全受信、无沙箱

- `installed Host code executes in-process outside the workspace sandbox`
- 版本检查 *"is not a sandbox against malicious package code"*
- **游离的 promise 拒绝或同步回调抛错（stream `'data'`、timer）会销毁整个 app 并非零退出**，
  与是哪个插件无关
- 唯一的 `node:vm` 沙箱只用于运行时动态定义的包，且明确"不是安全边界"

→ 插件代码的故障域就是宿主进程。写插件时**不要留未 await 的 promise**。

## 8. 观测插件是否加载，用 `plugin_manager list_plugins`

它返回**实时 Loader 状态**（含 `fiberPhase`）：

```json
{"entryId":"include:x","moduleName":"@scope/x","enabled":true,"fiberPhase":"active"}
```

**不要**用 `cordis_inspect` 查 Service 来判断——很多插件（如 hooks 桥接）**不注册 Service**，
只监听事件，查了必然报 `no catalogued Service`，会误导你以为没装上。

## 9. `hook/*` 事件是判断"钩子是否触发"的可靠探针

会话日志里 `hook/invoked` / `hook/result` 成对出现，带 `decision` / `exitCode` /
`stderrSummary`。**即使 matcher 不匹配也会记录 invoked**，所以"事件数为 0"就是"未加载"。

`configPath` 指向的文件是**进程启动时读一次**——改钩子配置必须重启 App。
profile patch 的改动则走 HMR，无需重启。

## 10. 客户端文本匹配类门禁可以被绕过（固有属性）

对命令文本做模式匹配的控制，任何不产生匹配字面量的等价写法都能通过：

```sh
printf '%s' 'git push origin main' | base64 -D | sh    # 不会被拦
```

**这不是缺陷，是这类控制的上限。** 结论：

> 客户端模式匹配挡的是"心不在焉"，不是"有决心的人"。它不能作为合规证据。

不可绕过的控制只有两处：**服务端分支保护**（GitHub rulesets / GitLab protected branch）
与 **host 层**（文件属主、MDM、独立运行身份）。

**插件化的正确应对**：用 `ctx.tools.guard()` 拿**结构化的 `exec.name` + `exec.arguments`**。

但要分清通道：**文件工具**（`write`/`edit` 的 `file_path`）是结构化的，编码与拼接影响不了它；
**shell 工具**（`bash` 的 `command`）判的仍是文本，等价写法照样能绕。
所以 guard 对 shell 的覆盖是「提高成本」，不是「不可能」——
真正的硬边界在工具限制（`toolFilter`/`restrict`）或沙箱层。

## 11. 引擎侧事实：DSH 的能力边界（影响架构决策）

| 能力 | 事实 |
|---|---|
| 网络出口管控 | **不存在**。`dsh-sandbox` 明确"文件效果是全部策略词汇" |
| 受保护路径 | **不存在**。沙箱按目录范围放行，不识别 `.git/`、密钥 |
| 不可覆盖的管理层 | **不存在**。四层 patch 全在用户可写目录；`--patch` 优先级最高 |
| 模式化 allow/deny 规则 | **不存在**。只有 `{sandbox, approval}` 粗粒度预设 |
| 入参改写 | **不支持**。`tools/pre-execute` 显式不能改写 `exec.arguments`，只能拒绝 |
| 审批人归属 | **缺失**。`approval/decided` 只记 `outcome`，不记谁批的 |
| 规范日志脱敏 | **默认无**。工具参数与结果逐字落盘，且默认 zstd 压缩不可直读 |
| OTel 会话导出 | **不是审计流**。默认 `FEEDBACK_ONLY`，`FULL` 被显式拒绝 |
| 沙箱模式 | 三级：`read-only` / `workspace-write` / `danger-full-access`，OS 级（Seatbelt/bwrap/Landlock/ACL），fail-closed |
| 审批策略 | 仅 `ask` / `never`。且**默认几乎不拦任何东西**——只有两个生产者会产生 `ask` |
| 子代理深度 | `maxDepth` 默认 **1**（只有直接子级）；`maxActiveSubagents` 默认 8，**拒绝而非排队** |
| git worktree | **无原语**。并行隔离需在方法论层用 `git worktree add` 解决 |
| 后台作业 | **非持久**，随进程消亡；跨重启需另做 |
| `dsh-schedule` | 持久 cron **可用**，但**不能挂 headless/SDK-only**，需 Host Web Session controller |
| 结构化输出 | `structured_output` 工具**存在**，带"恰好调用一次"守卫与单调提交 |
| 子代理后端 | 6 种：in-process `spawn` / `fork` / ACP / Codex / Claude Code / SDK |
| 编排 token 计费 | **无**。引擎限制并发与子级数量，但不统计跨子级 token |
