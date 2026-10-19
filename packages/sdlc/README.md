# @ai-native-sdlc/dsh-sdlc

把 Anthropic《AI 原生 SDLC 实战手册》的方法论落成 **一个 DeepSeek Harness bundle**。

## 一个包，七个组件

DSH 里有两个不同层次的单位，这里刻意让它们各归其位：

| 层次 | 本包的选择 | 为什么 |
|---|---|---|
| **分发单位**（npm 包 / bundle / `dsh.profile.bundles` 条目 / 插件页卡片） | **一个** | 这一套永远同装同升，制品链还是一个跨组件协议；协议必须同版本发布 |
| **执行单位**（Cordis 插件行 / fiber） | **七个** | 每行有自己的 `inject`、`Config`、fiber：故障域、`fiberPhase` 诊断、行级开关、profile 按 id 覆盖都靠它 |

`cordis.patch.yml` 里是一条 `insert`、七行；每行指向本包的一个子路径导出。
**行 id 与合并前完全一致**（`sdlc-task`、`sdlc-verify`……），所以旧 profile 里
`- id: sdlc-task` 这类覆盖继续匹配，插件页也仍能逐行启停。

| 行 id | 子路径 | 机制 |
|---|---|---|
| `sdlc-task` | `@ai-native-sdlc/dsh-sdlc/task` | 任务状态机 + 制品链（`state.yaml` 在 git） |
| `sdlc-artifact` | `@ai-native-sdlc/dsh-sdlc/artifact` | 制品撰写 + 结构检查（只查结构） |
| `sdlc-verify` | `@ai-native-sdlc/dsh-sdlc/verify` | 非 Actor 的独立验证 + 测试冻结 |
| `sdlc-status` | `@ai-native-sdlc/dsh-sdlc/status` | 任务看板（一次盘出全部任务状态/缺失/裁决） |
| `sdlc-workflow` | `@ai-native-sdlc/dsh-sdlc/workflow` | 工作流 Skill：给验证者的判据清单 |
| `sdlc-rsi` | `@ai-native-sdlc/dsh-sdlc/rsi` | 真实验证记录、复盘、指导文字对照实验 |
| `sdlc-ui` | `@ai-native-sdlc/dsh-sdlc`（**包根**，不是子路径） | 客户端制品链面板（`./client` 是浏览器半） |

验证者 preset 内部还挂了一行 `@ai-native-sdlc/dsh-sdlc/verify/preset-filter`
（只在 preset 里生效，不是 bundle 行）。

⚠️ `sdlc-ui` 行的 name 必须是**精确包名**：`@deepseek-ai/dsh-client-modules` 只扫描
精确包名的 loader 行来发现 `dsh.client`；写成 `./ui` 子路径会让浏览器半**静默消失**
（host 端点照常工作、只有面板不出现）。本轮合并实测踩过，`smoke/ui.mjs` 有回归断言。

## 安装

包自带 `dsh.bundle.patch`，安装后自动挂载：

```sh
npm run build --workspace packages/sdlc
npm pack --workspace packages/sdlc
dsh plugin --profile <你的-profile> add <生成的.tgz>
```

宿主提供 `@deepseek-ai/dsh-*` 运行时；**不要**把它们装进本包的 `dependencies`
（会装出第二份 `dsh-tools`，破坏模块内 Symbol 身份，导致每一次工具调用都失败）。

七个组件是同一套方法的七个机制，通常整套启用。只想启用部分时，用 profile 的行级覆盖：

```yaml
- id: sdlc-rsi
  disabled: true
```

## 测试

```sh
npm run build --workspace packages/sdlc   # tsc → lib/（含手写的客户端 bundle 拷贝）
npm run test  --workspace packages/sdlc   # 纯函数层单测 + UI 行为测试
DSH_APP="/Applications/DeepSeek Harness.app" npm run smoke --workspace packages/sdlc
```

冒烟测试用**真实 Cordis 上下文 + 真实 ToolRuntime** 挂载组件并真的 dispatch 工具调用，
七个组件各一个脚本，`smoke/run-all.mjs` 统一驱动。

## 为什么合并（而不是七个包）

合并前是七个独立 bundle。实测代价都落在"分发层"上：

- 七份 `peerDependencies` → DSH 升级时七个包一起静默消失（版本门禁按包判定）；
- 七个 tarball、七条 `dsh.profile.bundles` 条目、七次安装；
- **跨包 import 走不通** → `sessionCwd` 等辅助函数四份逐字相同的副本、
  状态机常量复制一份再拿契约测试盯漂移；
- 插件页七张卡暗示七个可独立选择的东西。

合并消灭了这四类成本，同时**没有**动执行层：七个组件行原样保留。
具体决策与证据记录在仓库的 `AGENTS.md`。

## 边界

Harness 决定「Agent 如何工作」；发布授权、分支保护、密钥属于 Git/CI/RBAC。
本插件不试图在客户端实现合规管控——客户端控制可被绕过，这是实测结论。
