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

## 11.1 写文件的正确姿势（漏了就会被沙箱拒绝，而且很难看出原因）

**症状**：`cannot write "<绝对路径>": file access denied under workspace-write mode`。
最迷惑的地方是——**内置 `write` 工具能写同一个路径**，环境策略甚至是
`danger-full-access`。所以看起来不像权限问题，像代码 bug。

**根因**：官方 fs 工具的写入做两件事，自己写插件时很容易只做一半：

```js
// 官方 dsh-tool-fs 的写法
const policy = await sandboxPolicy.resolve({ session });   // ① 解析本次调用的策略
const target = await ctx.fs.resolve(path, {
  cwd: policy?.workspaceRoot ?? sessionCwd(exec),          // ② cwd 必须显式传
  signal: exec.signal,
});
await ctx.fs.writeText(target, content, intent, exec.signal, policy);  // ③ 策略必须传
```

漏掉 ② 或 ③ 的后果：`fs.resolve` 落到**部署的 fallback 根**（`process.cwd()`，
即 App 的工作目录，不是你的仓库），于是"写自己仓库里的文件"被判越界。

**API 细节**（文档里查不到，只能读类型定义）：
- 服务名是 **`ctx.sandboxPolicy`**（策略），不是 `ctx.sandbox`（那是执行器
  `SandboxProvider`）。前者的 `resolve({ session })` 从会话推导出
  `{ mode, workspaceRoot }`——**会话的 cwd 就是它的 workspace-write 边界**。
- 必须**显式 import 这两个包的类型**，否则 declaration merging 不生效，
  tsc 会报 `Property 'sandboxPolicy' does not exist on type 'Context'`。
  纯类型 import 也要真写出来。
- `inject` 里要加 `'sandboxPolicy'`。

⚠️ **这个坑我在两个包里各踩了一次**——修了 `sdlc-task` 却没检查
`sdlc-verify` 有没有同样的调用方式。教训：**修一类问题时，要 grep 全部同类调用点**，
不要只修眼前那个。

⚠️ 还有一层更隐蔽的：**测试桩忽略参数 = 测试对这类问题失明**。
`sdlc-verify` 的 `fs` 桩原本写成 `resolve(p, _o)`、`writeText(target, content)`，
把 cwd 和 policy 直接丢掉，所以这个 bug 在冒烟测试里**不可能被发现**。
现在两个包的桩都记录并断言这两个参数。

## 11.2 陷阱：验证者**无法验证自己这次调用产生的制品**

实测踩到，并且它给出的 `reject` 是**正确**的：

- 验证者被要求确认 `<task>/verification.json` 存在且内容合法
- 它诚实地查了：`ls` + `read` + 全仓库 `find` → 零命中 → 按判据给 `reject`
- **但那个文件确实被写出来了**——只是写在这次调用**结束之后**（晚 8 秒）

这是**固有**的，不是 bug：落盘是调用方的收尾动作，而验证者只存在于调用**期间**。
任何"验证本次调用自身的产物"的验收标准都会必然得到 `reject`。

**推论（写 sdlc_verify 的验收标准时必须遵守）**：
- ❌ 不要让它验证"这次调用会产生的东西"（落盘文件、返回摘要、会话记录）
- ✅ 让它验证**调用之前就已存在**的东西（制品内容、代码、已有测试）
- 想验证产物本身 → **另起一次调用**，那时产物已落地，可正常验证

顺带一提：这次它的 `reject` 反而证明了插件是对的——它**没有**因为
"期望文件存在"就编一个 approve。诚实地报 `missing_evidence` 正是我们要的行为。

## 12.1 补充：`plugin_manager` 的禁用/启用**也**不会重载模块

我在第 12 条里写了"重启 App"，但后来又试了看起来更轻的办法——用
`plugin_manager set_plugin` 先禁用再启用，期望"卸载了自然会重新 import"。**不会。**

实测（2026-10-07）：
- 禁用的**可见效果是有的**：工具从清单消失、我的提示词段从系统提示里消失。
  这很容易让人以为"重新加载成功了"。
- 但重新启用后，修复过的代码**仍未生效**——同一个错误原样复现。
- 机制与第 12 条相同：这条路径走 `entry.update({config})`，
  而 `Entry.update` 在 options 深比较无变化时早退，不重新 `import`。
  **禁用/启用和重新 `dsh plugin add` 是同一条路径。**

⚠️ 这次的教训更隐蔽：**"看到变化"不等于"加载了新代码"。**
禁用时工具消失、启用时工具回来，这个可见变化骗过了我一次。
真正能证明加载了新代码的，只有**修复后的行为**（或运行时可见的新文本）。

**结论：要真正生效，只能重启 App。** 别在这上面再浪费时间。


实测踩到，而且骗过了我一次：

`dsh plugin add` 之后**看起来**像生效（系统提示里出现了新的提示词段、
工具出现在清单里），于是我以为 HMR 会热加载模块变更。**不会。**

机制（验证者查证并给出源码位置）：

- `dsh-app-boot` 的 `reconcileProfilePatches` 对根 include 条目调用
  `entry.update({ config })`
- `cordis-plugin-loader` 的 `Entry.update` 在 options 深比较**无变化**且
  `force=false` 时**直接 return**，不重新 `import` 模块

后果：改了 `lib/*.js` 并重新 `dsh plugin add` 之后，
**运行中的进程仍在执行旧模块**。旧的工具 schema、旧的 persona、旧的判定逻辑
全都还在内存里。

### 怎么分清「制品对了」和「进程加载了」

| 判据 | 能证明什么 |
|---|---|
| `npm pack` 内容 / 文件哈希一致 | 只证明**制品**对了 |
| `plugin_manager list_plugins` 的 `fiberPhase` | 只证明**条目激活**了 |
| **子代理 persona 文本、工具描述、工具清单哈希** | 才证明**加载的是这一版** |

⚠️ 用「磁盘哈希一致」代替「运行时可观测物」是我犯过的错：
哈希一致完全无法证明进程加载了新代码。

**要真正生效，重启 App。** 重启后用运行时可见物验证，不要用文件哈希。
