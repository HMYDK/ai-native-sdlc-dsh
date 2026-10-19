# AI 原生 SDLC × DeepSeek Harness

把 Anthropic《[AI 原生 SDLC 实战手册](https://claude.com/resources/articles/the-ai-native-sdlc-playbook)》
的方法论落成 **一个 DeepSeek Harness 插件套件**（`packages/sdlc`，
`@ai-native-sdlc/dsh-sdlc`）。手册中文全译在 [handbook/](handbook/)。

## 定位（先读这段，它决定后面所有取舍）

**Harness 决定「Agent 如何工作」，Git/CI/RBAC 决定「工作对不对、能不能上线」。**

这句话不是口号，是实测结论：客户端的一切控制都能被绕过。
我对自己的门禁做过一次实验——`printf '%s' 'git push origin main' | base64 -D | sh`
就绕过去了，因为门禁在匹配命令文本。

所以本仓库的目标**不是**「用 Harness 做合规管控」，而是：

> 把方法论里**本来就该机器保证**的部分（验证、证据、流程状态）
> 做成 Harness 里的一等公民；把**不能**由客户端保证的部分
> （发布授权、分支保护、密钥）明确留给 Git/CI/K8s。

## 架构：分发按套件合一，执行按机制拆行

文档原方案按 SDLC 阶段拆 7 个插件。我改成按**扩展点 / 机制**拆，理由：

- DSH 可挂的扩展点只有四个：工具拦截、工具 / Skill 注册、提示词组装、客户端 UI
- 这四个点与 SDLC 六个阶段**完全不正交**
- 按阶段拆会让**一个制品链跨六个包**，且**一个拦截点被六个插件注册**

拆完之后，"按机制"只决定**执行单位**；**分发单位**是另一个层次，刻意收敛成一个。
两者各归其位：

| 层次 | 本仓库的选择 | 为什么 |
|---|---|---|
| **分发单位**：npm 包 / bundle / `dsh.profile.bundles` 条目 / tarball / 插件页卡片 | **一个** | 七个组件永远同装同升；制品链（`state.yaml` / `verification.json` / artifacts 语义）是跨组件协议，必须同版本发布 |
| **执行单位**：Cordis 插件行 / fiber | **七个** | 每行有自己的 `inject` / `Config` / fiber：故障域、`fiberPhase` 诊断、行级开关、profile 按 id 覆盖都靠它 |

所以最终形态是：**一个 npm 包、一个 bundle、一条 `dsh.profile.bundles` 条目、
一个 tarball，`cordis.patch.yml` 里一条 `insert` 加七行。**

七个**行 id 与合并前完全一致**（`sdlc-task`、`sdlc-verify`……），所以旧 profile 里
`- id: sdlc-task` 这类覆盖继续匹配，插件页也仍能逐行启停。

| 行 id | 行 name | 机制 | 文档 |
|---|---|---|---|
| `sdlc-task` | `@ai-native-sdlc/dsh-sdlc/task` | 任务状态机 + 制品链（`state.yaml` 在 git） | [TASK.md](packages/sdlc/TASK.md) |
| `sdlc-artifact` | `@ai-native-sdlc/dsh-sdlc/artifact` | 制品撰写 + 结构检查（只查结构，不查质量） | [包总览](packages/sdlc/README.md) |
| `sdlc-status` | `@ai-native-sdlc/dsh-sdlc/status` | 任务看板（一次盘出全部任务的状态 / 缺失 / 裁决） | [包总览](packages/sdlc/README.md) |
| `sdlc-verify` | `@ai-native-sdlc/dsh-sdlc/verify` | 非 Actor 的独立验证 + 测试冻结 | [包总览](packages/sdlc/README.md) |
| `sdlc-workflow` | `@ai-native-sdlc/dsh-sdlc/workflow` | 工作流本身，作为一份给验证者的判据清单 Skill 交付 | [包总览](packages/sdlc/README.md) |
| `sdlc-rsi` | `@ai-native-sdlc/dsh-sdlc/rsi` | 真实验证记录、复盘、指导文字对照实验 | [RSI.md](packages/sdlc/RSI.md) |
| `sdlc-ui` | `@ai-native-sdlc/dsh-sdlc`（**包根**，不是子路径） | 客户端制品链面板（侧栏图标 + main 面板） | [改版记录](docs/sdlc-ui-redesign.md) |

⚠️ `sdlc-ui` 是唯一指向**包名本身**的行。`@deepseek-ai/dsh-client-modules` 只按
**精确包名**的 loader 行发现 `dsh.client`；写成 `.../ui` 子路径会让浏览器半
**静默消失**（host 端点照常 200，只有面板不出现，日志无错）。本轮真实启动抓到过一次，
现在 `smoke/ui.mjs` 有回归断言。其余六个组件仍走子路径导出。

验证者 preset 内部还挂一行 `@ai-native-sdlc/dsh-sdlc/verify/preset-filter`
（只在 preset 里生效，不是 bundle 行）。

**为什么合并（而不是继续七个包）**：合并前是七个独立 bundle，实测代价都落在分发层——

- 七份 `peerDependencies` 让 DSH 升级时七个包一起静默消失（版本门禁按包判定）；
- 七个 tarball、七条 `dsh.profile.bundles` 条目、七次安装；
- **跨包 import 走不通**：`sessionCwd` 等辅助函数在四个包里是逐字相同的副本，
  靠四份"漂移检测"测试盯着；`sdlc-status` 还复制了一份状态机常量；
- 插件页七张卡暗示这是七个可独立选择的东西。

合并只动分发层，**没有**动执行层：七个组件行、工具名、Skill 内容、`state.yaml`
契约、验证者 preset 的隔离策略全部原样保留。

> ⚠️ 不要把它做成"一个插件行套子插件"：那会把唯一真正在起作用的隔离边界（fiber）
> 压掉，而分发粒度并不因此变化，是纯粹变差。

**顺序上先做 verifier，不是先做 plan**：verifier 输出结构化 PASS/FAIL，
是唯一能被严格自动验证的机制；plan 输出给人看的 markdown，很难自动判断好坏。

## 核心机制（一）：Actor ≠ Verifier

实现在 [`packages/sdlc/src/verify/`](packages/sdlc/src/verify/)。
启动一个验证子代理，五个机制共同保证它不是实现者：

| 机制 | 作用 |
|---|---|
| **新会话** | 验证者看不到 Actor 的推理过程，只看制品 |
| **独立 Agent Preset** | preset 里只挂只读工具：`tool-fs` 关掉 write/edit，不放委派 / 联网 |
| **preset 内 deny 全部宿主 global 工具** | 宿主工具是全局注册的，不挡的话验证者能解冻测试、推进任务 |
| **独立 `persona`** | 明确"你没写这段代码，也别相信关于它的说法" |
| **`outputSchema` 强制结构化** | 必须提交机器可读裁决，不能只给一段自然语言 |

> **关于"只读"的如实说明**：真实运行时测到的工具面是
> `bash glob grep read read_image skill structured_output`。
> 保留 `bash` 是因为验证者必须能**跑测试**来复核作者的证据，而 `bash` 是通用 shell、
> 技术上能写文件。persona 里如实写了这一点（约束来自职责，不是来自虚假的能力声明）。
> 0.2.1 删除了请求上的 `toolFilter` / `persona`，改由 Agent Preset 承担；
> preset 也不会自动隔离宿主全局工具，所以 preset 里还有一行
> `ctx.tools.restrict({ deny: <全部 global> })`。见 `docs/dsh-plugin-contracts.md` §0.0。

裁决有**三态**：`approve` / `reject` / `needs_human`。
第三条是刻意的——只给 PASS/FAIL 会逼验证者在**证据不足**时猜成 PASS。

结构化捕获失败时返回 `needs_human`，**绝不退化成"解析自由文本然后猜"**：
那会把一个明确的失败变成一个可能错误的通过。

## 核心机制（二）：测试冻结——单调 guard，不是提示词请求

实现在 [`packages/sdlc/src/verify/test-freeze.ts`](packages/sdlc/src/verify/test-freeze.ts)。

```
Bug → 写失败的测试 → 确认复现 → sdlc_fix_start（冻结）→ 改产品代码 → sdlc_fix_end
```

用的是 `ctx.tools.guard()`：**返回字符串即拒绝，且没有任何后续监听器能翻回允许。**
冻结是**进程级 / 仓库级**的——不按 agent 记账，所以派子代理绕过这条路被堵死了。

能拦住的形式（都有回归测试）：`write` / `edit` 改测试文件；
经 shell 的 `>tests/x`（含不带空格）、`rm` / `mv` / `cp` / `install` / `truncate` / `shred`、
`sed -i`、`perl -pi`、`find -delete`、`python -c` / `node -e` 内写入、
`git checkout|restore|reset|clean`（含 `git -C`）。

> ⚠️ **两层都只是「提高成本」，不是硬边界。**
> 文件工具通道（`write` / `edit` 的 `file_path`）参数是**结构化**的，编码绕不过去；
> 但**是否算测试资产**仍靠上面的名字模式表——未覆盖的命名不会被冻结
> （验证者实测过 `jest.config.js`、`testdata/`、`*.snap`，已补入）。
> shell 通道判的是命令**文本**，不落进模式的等价写法仍可绕过
> （自造二进制、heredoc、动态拼出的命令名）。
> 而且**解冻只需 Actor 自己调一次 `sdlc_fix_end`**，所以它不是防篡改边界。
> **真正的硬约束应落在工具限制或沙箱层**：冻结期直接 restrict 掉写能力。

## 从真实任务中改进：`sdlc-rsi`

使用说明见 [packages/sdlc/RSI.md](packages/sdlc/RSI.md)。安装后自动记录每次验证，
包括无裁决、失败、中断与重试；可按运行查询、复盘、执行真实对照并保存人工反馈。
首版实验只改变附加指导文字，不自动修改系统。

参考答案目前与验证者共享文件系统，因此实验明确作为探索，不能据此推荐采用。
原始输入、代码快照与工具输出默认留在本机 `.ai/rsi/`，核对后的结论写入真实任务制品。
[本次实现与验证证据](.ai/tasks/RSI-1/proof.md) 分开记录单测、确定性冒烟和真实模型调用。

## 安装与打包

```sh
npm install
npm run build --workspace packages/sdlc
npm pack --workspace packages/sdlc        # → ai-native-sdlc-dsh-sdlc-0.2.0.tgz
dsh plugin --profile <你的-profile> add <生成的.tgz>
```

一个 tarball 装七个组件行。包自带 `dsh.bundle.patch`，安装后自动挂载。

⚠️ 用 **App 自带 CLI**，不要用 PATH 上的 `dsh`（可能是别的版本）：

```sh
BASE="/Applications/DeepSeek Harness.app/Contents"
CLI="$BASE/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"
APP="$BASE/MacOS/DeepSeek Harness"
ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals "$CLI" plugin --profile <profile> add <tgz 绝对路径>
```

装完**核对 profile 的 `package.json`**：`dsh.profile.bundles` 里应有
`@ai-native-sdlc/dsh-sdlc`。实测（DSH `0.2.1-rc.2`、tgz 安装）`plugin add` 会自动追加；
更早版本 / 符号链接安装曾观察到**不追加**——所以以 profile manifest 为准，
没出现就手补（GUI 插件管理器也会做这一步）。不要用"安装成功"推断"bundle 已登记"。

七个组件通常整套启用。只想启用部分时，用 profile 的行级覆盖（行 id 与合并前一致）：

```yaml
- id: sdlc-rsi
  disabled: true
```

更多细节与"为什么合并"见 [packages/sdlc/README.md](packages/sdlc/README.md)。

## 开发与验证

```sh
npm run build --workspace packages/sdlc     # tsc → lib/（含手写的客户端 bundle 拷贝）
npm run test  --workspace packages/sdlc     # 单测（先 build）
DSH_APP="/Applications/DeepSeek Harness.app" npm run smoke --workspace packages/sdlc
npm run verify --workspace packages/sdlc    # = build + test + smoke
npm run compat                              # 按本机真实 App 的版本校验 peer 范围
```

冒烟测试用**真实 Cordis 上下文 + 真实 ToolRuntime** 挂载组件并真的 dispatch 工具调用；
七个组件各一个脚本，在 `packages/sdlc/smoke/`，`run-all.mjs` 统一驱动。

验证插件真的能加载（**用隔离 profile，不碰正在用的 App**）：

```sh
npm pack --workspace packages/sdlc
# APP / CLI 同「安装与打包」
ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals "$CLI" plugin --profile verifytest add "$PWD"/ai-native-sdlc-dsh-sdlc-0.2.0.tgz
ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals "$CLI" --profile verifytest --port 19999
# 看启动输出：出现 "entry did not activate" 就是失败
# 再查 plugin_manager list_plugins 的 fiberPhase；它才是运行时真相
```

### 验证纪律

- **跑 `npm run verify`（build + test + smoke），不要只看其中一项。**
- **加载成功 ≠ 可用，单测通过 ≠ 端到端可用。** 任何涉及"接线"的改动都要真实操作验证；
  汇报时不要把单测说成功能可用。
- **符号链接安装通过 ≠ 真实分发可用。** 必须用 `npm pack` 出来的 tarball 装一遍。
- **隔离 profile 验证，不碰正在用的 App**；装的是 tgz 副本时，改仓库的 `lib/`
  重启也不会生效——必须重装 / 同步进 profile。
- **`plugin_manager list_plugins` 是唯一的运行时真相**（含 `fiberPhase`），
  不要靠推断；`cordis_inspect` 查 Service 对不注册服务的插件必然误报。
- 核对 `node --test` 数字用 `grep -E "^[#ℹ] (pass|fail)"`，不要写 `^#`：
  这个 Node 版本用 `ℹ` 前缀，写 `^#` 会零匹配、退出码 1，看起来像"测试失败"。

### 当前实测读数（2026-10-19，DSH `0.2.1-rc.2`，合并后）

| 检查 | 读数 |
|---|---|
| `npm run test --workspace packages/sdlc` | 单测 **210**（lib 202 + UI 客户端交互 8；看板宿主测试 24 另计） |
| `npm run smoke --workspace packages/sdlc` | 七脚本全过：artifact 39 / rsi 62 / status 69 / task 40 / ui 44 / verify 109 / workflow 12（共 375 条断言） |
| `npm run compat` | 根工作区 + `@ai-native-sdlc/dsh-sdlc`（8 条 peer）全部接受 `0.2.1-rc.2` |
| `npm pack --dry-run --workspace packages/sdlc` | `ai-native-sdlc-dsh-sdlc-0.2.0.tgz`，40 个文件 |

单测从合并前 **251** 降到 **210**，减少的 41 条**全是重复覆盖**：
3 份逐字相同的 `helpers.test` 副本（36 条）+ 1 条跨包漂移检测
+ `status/contract.test` 的 4 条重复契约测试。没有删掉任何独有用例。

## 文档

| 文件 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 项目记忆与工程约定（改代码前先读）|
| [packages/sdlc/README.md](packages/sdlc/README.md) | **包总览**：一个包七个组件的边界、安装、测试、为什么合并 |
| [packages/sdlc/TASK.md](packages/sdlc/TASK.md) | `sdlc-task`：状态机与 `state.yaml` 契约 |
| [packages/sdlc/RSI.md](packages/sdlc/RSI.md) | `sdlc-rsi`：真实验证记录、复盘与对照实验 |
| [docs/dsh-plugin-contracts.md](docs/dsh-plugin-contracts.md) | **插件 / preset 权威契约**，含三个静默失败的坑 |
| [docs/dsh-pitfalls.md](docs/dsh-pitfalls.md) | DSH 实测坑清单 + 能力边界 |
| [docs/dsh-plugin-authoring.md](docs/dsh-plugin-authoring.md) | 插件编写与分发的详细调研 |
| [docs/sdlc-ui-redesign.md](docs/sdlc-ui-redesign.md) | 客户端看板的改版记录与验证读数 |
| [docs/dsh-*.md](docs/) | 其余 DSH 子系统调研（带行号引用）|

## 边界（不要高估这套东西）

| 缺口 | 事实 |
|---|---|
| 网络出口管控 | **不存在**。DSH 沙箱明确"文件效果是全部策略词汇" |
| 受保护路径 | **不存在**。沙箱按目录范围放行 |
| 不可覆盖的管理层 | **不存在**。能改 `~/.dsh/` 的人可以摘掉任何插件 |
| 客户端控制 | 上限是"提高成本"，**不能作为合规证据** |
| 异构模型验证 | 当前版本做不到（外部 subagent 后端不在运行时里）|

→ 真正不可绕过的只有两处：**服务端分支保护**（GitHub rulesets / GitLab
protected branch）与 **host 层**（文件属主、MDM、独立运行身份）。
