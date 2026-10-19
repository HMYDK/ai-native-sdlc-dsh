# DSH 落地坑清单（实测，非文档推断）

本文件记录在 DSH `0.2.0-rc.2` / `0.2.1-rc.2` 上实测踩到的坑。**全部是静默失败**——
不报错，只是"什么都没发生"。写 DSH 插件或配置前请先读。
（0.2.1 的破坏性变更与版本门禁见 `docs/dsh-plugin-contracts.md` §0.0。）

> **路径口径**：2026-10-19 起本仓库只有一个包 `packages/sdlc`：组件源码在
> `packages/sdlc/src/<组件>/`、冒烟在 `packages/sdlc/smoke/<组件>.mjs`。
> 下文出现 `packages/sdlc-verify/` 等七个旧包名的地方都是**合并前**的历史记录，
> 已就地标注；照抄旧路径会找不到文件。

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
带 patch 的包还会被自动登记进 `dsh.profile.bundles`——见 §2.1。

### 2.1 带 `dsh.bundle.patch` 的包：`plugin add` **会自动写** `dsh.profile.bundles`（0.2.1-rc.2 实测）

**与仓库早先的一句断言不同**：AGENTS.md 曾记「`dsh plugin add` 只装包，不写
`dsh.profile.bundles`，必须手补」。2026-10-19 在 DSH `0.2.1-rc.2` 上用 `npm pack`
的 tgz 在隔离 profile 上**两次实测**，CLI 都自动追加了：

- 冷启动 profile：`["@deepseek-ai/dsh-base"]` → `["@deepseek-ai/dsh-base", "@probe/two-rows"]`
- web 模板 profile：`["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]` → `+ "@probe/two-rows"`

两次都是装完直接读 profile `package.json` 看到的，没有手改。完整证据（含
`--dump-config` 行、真实启动 marker）见本轮探针记录 `.probe/EVIDENCE.md` §6.1
（本地证据目录，不进 git）。

怎么记这条才不误导：

- 它**不是永恒契约**。可能受版本（`0.2.0-rc.2` vs `0.2.1-rc.2`）、安装形态
  （tgz vs 绝对路径符号链接）、bundle 自身 peer 与运行时兼容性影响。
- 旧断言也不必当作"当时写错了"删掉——它当时的读数可能仍然对，错在把它写成了绝对句。
- **可操作的结论**：装完读 profile 的 `package.json` 核对 `dsh.profile.bundles`；
  没出现就手补（GUI 插件管理器也会做这一步）。不要用「安装成功」推断「bundle 已登记」。

### 2.2 不需要 PATH 上有 pnpm（desktop CLI 自带）

`dsh plugin add` 会调用 pnpm，但**不是 PATH 上的那个**：desktop CLI 在
`runDesktopCli()` 里把 packageManager 固定为 `process.execPath` +
`ELECTRON_RUN_AS_NODE=1` + App 运行时的 `pnpm.mjs`（2026-10-19 读 `cli.js` 实现 +
实测确认；App 运行时是 pnpm `11.28.5`）。本机 `command -v pnpm` 退出码 1，
两次 `plugin add` 都成功。

这条对「干净机器上复现」有用：**没有 pnpm 也能装 bundle**；反过来，PATH 上有 pnpm
也不代表它会被采用。证据见 `.probe/EVIDENCE.md` §1 / §6.3。

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

⚠️ **这个坑我在两个独立的包（合并前）里各踩了一次**——修了 `sdlc-task`
（现 `packages/sdlc/src/task/`）却没检查 `sdlc-verify`
（现 `packages/sdlc/src/verify/`）有没有同样的调用方式。
教训：**修一类问题时，要 grep 全部同类调用点**，不要只修眼前那个。

⚠️ 还有一层更隐蔽的：**测试桩忽略参数 = 测试对这类问题失明**。
`sdlc-verify` 的 `fs` 桩（现在是 `packages/sdlc/smoke/verify.mjs`）原本写成
`resolve(p, _o)`、`writeText(target, content)`，把 cwd 和 policy 直接丢掉，
所以这个 bug 在冒烟测试里**不可能被发现**。合并后两个组件的桩都在同一个包里，
现在都记录并断言这两个参数。

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

### 12.2 订正：**重启本身不会加载你的新代码**——要看 profile 里装的是什么

上面那条"重启就生效"**有一个前提，我当时没写出来**：
`dsh plugin add` 建的是**符号链接**时，重启才会重新读仓库的 `lib/`。

**本机 desktop profile 不是这种情况。** 它的 `package.json` 里是（合并前的读数）：

    "@ai-native-sdlc/dsh-sdlc-verify": "file:.../packages/sdlc-verify/<pkg>.tgz"

合并后同一个包叫 `@ai-native-sdlc/dsh-sdlc`，安装形态不变：

    "@ai-native-sdlc/dsh-sdlc": "file:.../ai-native-sdlc-dsh-sdlc-0.2.0.tgz"

`file:` 指向 **tgz**，装的是**解压出来的副本**。所以：

- 改仓库的 `lib/*.js` → **重启也没用**，跑的还是 tgz 里那份
- 实测代价：2026-10-15 我在"重启了但没生效"上**白重启两轮**，
  一度以为是代码问题，实际是装的位置不对

**怎么查**（这一步必须做，不能靠"我重启了"）：

    node tools/plugin-activation-check.mjs

它比对 profile 里装的那份与仓库刚构建的那份**是否逐字节一致**，
不一致就点名是哪个包、哪个文件。退出码 1 = App 跑的不是你这一版。
它同时检查下面 §12.3 那条。

**同步方式**：合并后只有一个包——把 `packages/sdlc/lib/**/*.js` 拷进 profile 的
`node_modules/@ai-native-sdlc/dsh-sdlc/lib/`（保留子目录结构），再重启。
（合并前是按组件拷进 `node_modules/@ai-native-sdlc/dsh-sdlc-<组件>/lib/`。）

⚠️ 顺带一个同类的坑：环境里的 `DSH_PROFILE` 值是 **`desktop`（名字，不是路径）**，
绝对路径在 `DSH_PROFILE_DIR`。拿 `DSH_PROFILE` 当路径用会得到一个**相对路径**，
于是"文件明明在却说没装"。

### 12.3 `inject` 里**多**写一个服务 → 插件静默挂起，工具全部消失

已知的是"**少**写一个抛 `cannot get property "X" without inject`"——
**那个至少会报错**。实测更隐蔽的是反过来：

    往 inject 加了 'logger'
    → plugin_manager 显示： enabled: true, fiberPhase: "pending"
    → 调用工具：Error: unknown tool "sdlc_verify"
    → App 照常启动，其它插件全部 active，**没有报错、没有日志**

机制（已实测证明）：Cordis 会**等** `inject` 里的每个服务，缺一个就不调 `apply()`。
patch 里没有插件提供那个服务 → 永远在等。

    ctx.plugin({inject:[a,b,c,d,e], apply})   五个都在 → apply 运行
                                              缺一个   → apply 不运行

⚠️ **`ctx.logger` 这类是 Context 上的内置属性，不是可注入的服务**，
所以"读 `ctx[name]` 看有没有值"判不出来——要用 `ctx.get(name)`。

⚠️ **`smoke.mjs` 抓不到这个**：它直接调 `apply()`，绕过了 Cordis 的服务等待，
所以"缺服务"在冒烟里完全不体现（那次 86/86 全绿，而插件在 App 里根本没激活）。
`packages/sdlc/smoke/verify.mjs`（合并前是 `packages/sdlc-verify/smoke.mjs`）
已补一条断言（"inject 的每个名字都能被 Cordis 解析到"），并**做过反向验证**：
把 `logger` 装回去 → 冒烟红 1 条。

**教训**：`fiberPhase` 的失败有两种，`failed` 会报错，**`pending` 是沉默的**——
插件"工具不见了"时先查 `fiberPhase`。

## 13. 客户端（Web UI）插件：~~做不出来~~ **订正：做得到**（2026-10-08 重查）

> ⚠️ **本节的原始结论是错的，已保留原文在下方以便对照。**
> 下面的「三条实测事实」里有两条是**推断**，而且是错的。

### 订正后的三条对照

| 原始理由 | 实际（用 `cordis_inspect_query` 查活的客户端） |
|---|---|
| ① 需要 tsdown Client preset，本机没有构建工具链 | ❌ **错。** 格式是普通 CJS 包装，**手写即可**；`Builtin` 里明确有 `React`——"React runtime exposed **without JSX transformation**"，本来就是给手写用的 |
| ② host→client 的 RPC 是构建期生成的 | ❌ **错。** `Builtin` 里有 `host`：`host.call(method, args)` = "JSON RPC from Client to **this Package's Host half**"。**不需要路由、不需要认证** |
| ③ **决定性的：渲染结果验证不了** | ❌ **错。** `dsh web` 是现成 profile，Web GUI 就在本机 `127.0.0.1:19387` 跑着，**能看到渲染** |

### 现在知道的事实（都是查活的运行时得到的，不是读文档）

```js
// 手写的客户端 bundle 格式（取自 dsh-client-ui-brand-official，仅 1863 字节）
window.__ModuleLoader__.load({
  id: "<包名>",
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");                 // 宿主提供
    let jsx = require("react/jsx-runtime");       // 所以不需要 JSX 变换
    const inject = ["slots"];
    function apply(ctx) {
      ctx.slots.inject("<slot>", function* () {
        yield ctx.slots.register({ name: "<slot>" }, MyComponent);
      });
    }
    exports.apply = apply; exports.inject = inject;
    return module.exports;
  }
});
```

- `package.json`：`exports["./client"]` → `./lib/client.js`；
  `dsh.client = { platform: 'web', inject: [...] }`
- **`cordis_inspect_query` 客户端 side 有五个 provider**：`Service` / `Event` /
  `Builtin` / `Slots` / `Theme`——这就是写客户端插件时的"类型定义"和"live 树"
- 挂载点（从 live Slot 树里查到的）：`sidebar.panellist`（全局面板图标）、
  `main`（keyed 中央面板，已占 `conversation`）、`sidebar.footer.action`、
  `shell.overlay`
- 数据来源：`host.call(...)` 找本包自己的 host 半——**我们已经有四个 host 插件**

### ✅ 已端到端验证（2026-10-09，探针跑通）

**`dsh web` 确实会加载 `exports["./client"]`。** 做法与观察到的证据：

```
1. 写一个探针包（合并前叫 `packages/sdlc-ui`；合并后组件在
   `packages/sdlc/src/ui/`）：host 半 + 手写客户端半，
   往 sidebar.panellist 挂一个带文字 "SDLC-ui ✓" 的项
2. dsh plugin --profile web add <tgz>
3. dsh --profile web --port 19403 --no-open   （后台任务）
   → 服务打印带 token 的 URL
4. 带 token 拉页面（curl -sL -b/-c cookie）
```

**拿到的四层证据**（每一层都是硬的）：

| 层 | 证据 |
|---|---|
| 进了 boot 清单 | 页面里 `{"id":"@ai-native-sdlc/dsh-sdlc-ui","url":"plugins/??…/client.js&rev=aeccbffea1ef","inject":["…dsh-client-ui-sidebar"]}` |
| 被 preload | `<link rel="preload" as="script" href="plugins/??…,@ai-native-sdlc/dsh-sdlc-ui/client.js&rev=…">` |
| 服务端真的服务了它 | 合并 bundle 10.4 MB（`plugins/??<60 个插件>`），HTTP 200 |
| **我的代码在合并 bundle 里** | `SdlcPanelButton` ×2、样式色值 `e879f9` ×2、渲染文字 `AI 原生 SDLC：探针项` ×1 |

**所以：发现 → 组合 → 服务 → 带上代码，四环全通。**

⚠️ 两个操作要点（都实测过）：
- `/` 会 **401**，随后 **303 重定向**——必须 `curl -sL` 且带 cookie jar
- 插件 bundle 的 URL 里有 `??`（多个插件合并成一个响应）。
  **必须从页面里取完整 URL**（含 `&rev=`）；自己拼 `plugins/??<包名>/client.js` 会 **404**

> 上表两个 id 都是**合并前**的客户端包名（当时 `sdlc-ui` 是独立包，行名就是包名）。
> 现在 `packages/sdlc/src/ui/client.js` 的 loader id 是 `@ai-native-sdlc/dsh-sdlc`；
> 保留旧读数只为对照。

### ⚠️ 合并后新坑（2026-10-19）：`dsh.client` 只按**精确包名**的 loader 行发现

`sdlc-ui` 合并进 `packages/sdlc` 后，`cordis.patch.yml` 里这一行**仍然必须写包名本身**
`@ai-native-sdlc/dsh-sdlc`，不能写 `@ai-native-sdlc/dsh-sdlc/ui` 子路径：

- `@deepseek-ai/dsh-client-modules` 用 `exactPackageSpecifier` 找"哪个已加载的
  loader 行属于声明了 `dsh.client` 的包"，子路径让它返回 `undefined`；
- 写成子路径的后果是**浏览器半不进 `window.__DSH_BOOT__`**，而 host 半的
  `/api/sdlc-ui.tasks` 照常 200——**面板不出现，启动日志无错**；
- 本轮真实启动抓到过一次（boot payload 里没有那个 entry）；修法是把 `sdlc-ui` 行
  改回精确包名、包根入口重新导出 ui 定义。`smoke/ui.mjs` 加了 4 条回归断言，
  ui 冒烟从 40 变 44。

一般化：**"进了 Loader"不等于"客户端半被发现"**——`dsh.client` 的发现条件是
**精确包名**（`@scope/name` 两段），不是"任意指向该包的加载行"。其余六个组件
仍走子路径导出，不受影响。

### ⚠️ 数据通道：查清了，而且**有真实的坑**

`Builtin` 里写着 `host.call(method, args)` = "Package-private JSON RPC from Client
to **this Package's Host half**"，看着正是我要的。**但它在静态插件包里拿不到。**

逐条查证（都是读已装产物）：

| 候选 | 实际 |
|---|---|
| `host.call` | 只在**动态包运行器**（`cordis_run`）里成立——那里 host 半用 `harness.handle(method, fn)` 配对。注释原文：`harness.* belongs to the HOST half`。**静态插件包没有这个 harness** |
| `ctx.remote.<ns>.<method>` | 由 host 侧的 `@Remote('methodName')` 标注、**构建期生成**。`dsh-api-workspace-files` 里的 `ClientRemote['workspaceFiles']` 就是产物。**手写拿不到** |
| 认证 HTTP 路由（`/api/*`） | 官方有先例（`dsh-client-ui-deliverables` 用 `/api/present.host`、`/api/present.open`），但它的 host 半**自己也没注册路由**——那些路径同样是 typert/remote 协议按元数据生成的 |

**所以：手写的静态客户端插件，没有现成的 host→client 数据通道。**
可行的三条路，各有代价：

1. **客户端自己读**：`ctx.uiWorkspace.listDirectory(path)` 确实存在（live Service 目录里查到）。
   但要读 `state.yaml` 正文还需要"读文件内容"的接口 —— **未查证是否存在**
2. **认证 HTTP 路由**：`ctx.connection` 有 authenticated URL 机制。可行但要自己处理认证，
   而且**有真实的安全面**（自己开的端点得自己守住）
3. **把要展示的数据变成宿主静态资源**：host 半把 `.ai/tasks/` 的摘要写成一个
   JSON 文件，客户端按 URL 取。最土，但**没有认证面**

⚠️ **这一节的结论我没有端到端验证过任何一条** —— 它们是读产物得出的。
不要当成"能用"，要当成"候选"。

### 客户端插件的可手写格式（官方最小范例，1863 字节）

`@deepseek-ai/dsh-client-ui-brand-official/lib/client.js` 是范本。
包装是普通 CJS；`Builtin` 的 `React` 明确写着
"exposed **without JSX transformation**"，所以 `require("react/jsx-runtime")`
直接调 `jsx(type, props, key)` 即可，**不需要任何构建步骤**。

---

### 原始结论（保留对照，已被上面的订正取代）

## 13-old. 客户端（Web UI）插件：本机做不出来，也验证不了

> ⛔ **以下全部是错的历史结论，保留只为对照。**
> **不要照着它做决定。** 正确版本见上面的 §13。
>
> 已实测反驳：`sdlc-ui` **已经做出来并端到端验证通过**（2026-10-09）。
> 这一节里的三条理由，只有第 ③ 条是**实测**的（跑不了 tsdown），
> 而①②是**推断**——我却用第 ③ 条推断了整条路不可行。

计划里有个 `sdlc-ui`（任务看板的面板）。调研后**放弃**，理由是三条实测事实。

### 13.1 构建客户端 bundle 的工具链不在本机

客户端 bundle 不是普通 ESM，而是运行时自定义格式：

```js
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-ui-goal",
  factory: (require) => { var module = { exports: {} }; /* ... */ }
})
```

这个包装器**可以手写**（React 由宿主提供，只需 `require("react")`），但生成它的
工具是 monorepo 的共享 **tsdown Client preset**，而：

- `app.asar/dsh/package.json` 的 `scripts` 是 **`{}`**（打包后的发行版）
- 没有 `tsdown.config.ts`、没有 `pnpm-workspace.yaml`、没有 `packages/`/`apps/`
- 官方包**只分发预构建产物，不带 `src/`**

我自己早先的调研记录已经写明这一点：*"构建工具是 monorepo 的共享 tsdown Client
preset —— 不在这个 extract 里，所以我无法引用它。"*

### 13.2 host 半给客户端用的 RPC 是构建期生成的

官方客户端用 `ctx.remote.<namespace>.<method>`，来自 host 侧的 `@Remote()` 装饰器。
查客户端服务目录：**没有 `remote`**（`no catalogued Service named "remote"`）。
这是构建期生成的 RPC 层，手工产不出来。

官方先例 `dsh-client-ui-deliverables` 走的是另一条路——host 半注册
`/api/changes.summary` 这类**认证路由** + `ctx.connection.authenticatedUrl`。
可行，但要自己处理认证，而且多一层易错的东西。

### 13.3 决定性的一条：渲染结果**验证不了**

> 每处**其他**改动 —— apps/web 外壳和普通包 —— 需要重建受影响的 Web 制品，
> 并在**页面刷新后**验证这个现有 URL。

`apps/web` 不在这里，所以我写不出、也验证不了渲染结果。

### 结论：换成 host 侧工具

> **按本项目最硬的纪律（"加载 ≠ 可用"），不该交付一个连"加载"都做不到的东西。**

改成 `sdlc-status`：同样的信息（所有任务的状态、制品完整性、缺失项、最新裁决），
host 侧工具，**能被完整验证**。这次的冒烟甚至用**真实 `LocalFileSystem`** 而不是
内存桩——见 §11.1 的教训（"桩忽略参数 = 测试对这类问题失明"）。

### 如果将来要做客户端 UI，缺的是

1. 能产出 `window.__ModuleLoader__.load` 格式的构建（或确认手写包装器可行并验证）
2. host→client 的数据通道：要么走认证 HTTP 路由（官方先例），要么拿到构建期 RPC
3. 一个能刷新页面并看到渲染结果的验证手段（否则违背验证纪律）
