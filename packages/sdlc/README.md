# @ai-native-sdlc-plugin/dsh-sdlc

把 Anthropic《AI 原生 SDLC 实战手册》的方法论落成 **一个 DeepSeek Harness bundle**。方法论要点与本插件的对应关系见[中文导读](../../docs/playbook-notes.md)。

## 一个包：常驻的只读看板 + 一个可选的工作模式

从 `0.3.0` 起，这套东西**只在会话明确选择「AI 原生 SDLC」模式时才工作**：

| 部分 | 形态 | 什么时候生效 |
|---|---|---|
| 侧栏看板（`sdlc-ui`） | bundle 顶层的一条**宿主行** | 常驻可见，只读，不提供任何工具 |
| 整套工作流（六组件） | 一个 **Agent Preset**（`id: sdlc`，展示名「AI 原生 SDLC」） | 只有在新建会话时选择这个模式才挂载 |

标准会话不会加载六个机制组件：没有 `sdlc_*` 工具、没有 SDLC 提示词段、Skill
目录里也没有那两条 Skill。已有会话保留创建时的组合；选择只影响之后创建的任务。

### 为什么 UI 常驻、其余进 preset

- **UI 必须留在宿主层**：`@deepseek-ai/dsh-client-modules` 只扫描宿主 Loader 里
  **精确包名**的行来发现 `dsh.client`。preset 的行在注册表自己的内存 Loader 树里，
  不是宿主 Loader 行；把 UI 搬进 preset 会让浏览器半**静默消失**（host 端点照常
  200，面板不出现，日志无错）。方案 A 接受这个取舍：面板常驻、只读。
- **六个机制组件进 preset**：DSH 唯一按会话选择的单位就是 Agent Preset
  （官方：「由会话选择」「通过声明式 preset 选择 Agent 的工具、提示词和技能」）。
  工具 / 提示词 / Skill 的注册都落入该 preset 的 scope 层，只有选择它的 Agent 可见。

### 为什么 preset 里要带一份 standard 副本

preset **不继承、不合并**（官方：覆盖会替换完整子插件列表）。如果只放六个 SDLC
组件，选了这个模式的会话连 `read` / `bash` / `write` / `skill` 这些基础工具都没有，
整个流程无法工作（实测：只有六行时该会话的 `toolsTokens` 是 3265，且没有基础工具）。
所以「AI 原生 SDLC」模式 = **DSH 内置 `standard` preset 的完整副本 + 六个组件**。

⚠️ 这意味着我们复制了一份 DSH 内置列表。App 升级后 standard 可能变化，
**升级 App 后要跑**：

```sh
node tools/preset-sync-check.mjs          # 与这台机器真实 App 的 standard 逐行对账
node tools/preset-sync-check.mjs --write  # 漂移时用 App 当前 standard 重新同步副本
```

preset 内的六行仍是各自独立的 Cordis 行（各有 `inject` / `Config` / fiber），
行 id 与合并前完全一致（`sdlc-task`、`sdlc-verify`……），便于诊断。

| preset 内的行 id | 子路径 | 机制 |
|---|---|---|
| `sdlc-task` | `@ai-native-sdlc-plugin/dsh-sdlc/task` | 任务状态机 + 制品链（`state.yaml` 在 git） |
| `sdlc-artifact` | `@ai-native-sdlc-plugin/dsh-sdlc/artifact` | 制品撰写 + 结构检查（只查结构） |
| `sdlc-verify` | `@ai-native-sdlc-plugin/dsh-sdlc/verify` | 非 Actor 的独立验证 + 测试冻结 |
| `sdlc-status` | `@ai-native-sdlc-plugin/dsh-sdlc/status` | 任务看板（一次盘出全部任务状态/缺失/裁决） |
| `sdlc-workflow` | `@ai-native-sdlc-plugin/dsh-sdlc/workflow` | 工作流 Skill：给验证者的判据清单 |
| `sdlc-rsi` | `@ai-native-sdlc-plugin/dsh-sdlc/rsi` | 任务全过程证据、插件改进任务、版本对照与后续反馈 |

验证者 preset（`sdlc-verifier`）是内部实现细节：它只在 `sdlc_verify` 运行期间
临时注册、跑完归还，**不会**作为可选模式出现在新会话/设置页的选择器里。
该 preset 内部还挂了一行 `@ai-native-sdlc-plugin/dsh-sdlc/verify/preset-filter`。

⚠️ `sdlc-ui` 行的 name 必须是**精确包名**：写成 `./ui` 子路径会让浏览器半
**静默消失**（host 端点照常工作、只有面板不出现）。`smoke/ui.mjs` 有回归断言。

## 安装与使用

### 循环工作台

看板把七个任务阶段与“发现问题 → 修复实现 → 执行检查 → 独立验证”的往返分开显示。
选择一个验证轮次，问题、判据、测试证据和改动说明一起切换到该轮；查看历史时会显示
历史标识，刷新也不会把它切回最新轮次。阶段、交付物、修复记录、完整迁移记录和复盘
入口都可打开，支持任务搜索、工作区筛选、深浅主题和窄屏任务切换。

0.6.0 起任务的完整验收清单在 Spec 中登记。跳阶段不能绕过登记，第一次验证前的 Spec 修改也会被发现；看板显示应验项数、已答项数和缺失编号。旧记录保留原始编号并明确提示范围未核对，迁移规则见 [TASK.md](TASK.md#060完整验收范围从-spec-登记)。

0.5.0 起轮次直接登记在任务中，RSI 补充执行过程；一次验证内部的重试只算尝试次数。阶段回退与成功的
`sdlc_fix_start` / `sdlc_fix_end` 分别呈现，不能从 reject 次数推算修复次数。
旧任务按任务编号与制品路径恢复可核对的轮次；确实只有 `verification.json` 时标为“当前裁决 · 历史未记录”；记录缺少结束事件时
标为“记录未结束”，不假装 Agent 仍在运行。任务累计修复与所选轮次的证据明确区分。

任务列表仍使用 `/api/sdlc-ui.tasks`；选中任务后按需读取
`/api/sdlc-ui.execution?task=...&root=...`。显式工作区没有该任务时返回 404，
不会改读另一个工作区的同名任务。读取工作区列表尊重 `DSH_HOME`。
UI 的 `tasksDir` / `rsiDir` 配置应与任务、RSI 组件保持一致。

执行接口只读取该任务登记的 runs/sessions，展示有界摘要：最近 50 个运行、最多
64 个登记会话、每轮 12 条工具摘要；单次读取总量最多 24 MiB。超过范围或记录损坏
会明确说明。参数、原始工具输出、模型配置和隐藏推理不会返回浏览器。
改动说明来自验证调用方；没有明确关联时，不把它宣称为某个问题已修复的证明。

本地预览与验收方式见 [循环工作台验证记录](../../docs/design/sdlc-dashboard-2026-10-28/implementation.md)。

包自带 `dsh.bundle.patch`，安装后自动挂载：

```sh
npm run build --workspace packages/sdlc
npm pack --workspace packages/sdlc
dsh plugin --profile <你的-profile> add <生成的.tgz>
```

使用：

1. **新建会话**，在模式/预设选择器里选「AI 原生 SDLC」
   （或在设置页把它设为新任务默认值）；
2. 这个会话里才会出现 `sdlc_task_create` / `sdlc_artifact_*` / `sdlc_verify` 等工具
   与 SDLC 提示词；
3. 标准模式的会话不受影响；已打开的旧会话也不会变（DSH 的既定语义）。

宿主提供 `@deepseek-ai/dsh-*` 运行时；**不要**把它们装进本包的 `dependencies`
（会装出第二份 `dsh-tools`，破坏模块内 Symbol 身份，导致每一次工具调用都失败）。

只想启用部分组件时，按行 id 覆写该 preset 的 `config.plugins`——注意覆盖会
**替换完整列表**，需带上 standard 副本与其余组件的完整内容（或者直接用 sync
工具生成后再删行）。

## 测试与门禁

```sh
npm run build --workspace packages/sdlc   # tsc → lib/（含手写的客户端 bundle 拷贝）
npm run test  --workspace packages/sdlc   # 纯函数层单测 + UI 行为测试
DSH_APP="/Applications/DeepSeek Harness.app" npm run smoke --workspace packages/sdlc
node tools/preset-sync-check.mjs          # App 的 standard preset 副本是否仍一致
node tools/plugin-activation-check.mjs    # 宿主行 + preset 内六行 + profile 发布文件
```

冒烟测试用**真实 Cordis 上下文 + 真实 ToolRuntime** 挂载组件并真的 dispatch 工具调用；
`smoke/preset.mjs` 另外校验 bundle patch 的形状（宿主恰好两行、preset 含 standard
基础工具锚点与六个本组件行、模块可装配、六行不在宿主层）。

## 为什么合并（而不是七个包）

合并前是七个独立 bundle。实测代价都落在"分发层"上：

- 七份 `peerDependencies` → DSH 升级时七个包一起静默消失（版本门禁按包判定）；
- 七个 tarball、七条 `dsh.profile.bundles` 条目、七次安装；
- **跨包 import 走不通** → `sessionCwd` 等辅助函数四份逐字相同的副本、
  状态机常量复制一份再拿契约测试盯漂移；
- 插件页七张卡暗示七个可独立选择的东西。

合并消灭了这四类成本，同时**没有**动执行层：组件行原样保留。
具体决策与证据记录在仓库的 `AGENTS.md`。

## 边界

Harness 决定「Agent 如何工作」；发布授权、分支保护、密钥属于 Git/CI/RBAC。
本插件不试图在客户端实现合规管控——客户端控制可被绕过，这是实测结论。


0.5.0 的“问题如何处理”逐项显示来源、退回目标、修改说明、作者证据、独立复验和延期原因，
每页 20 项。作者提交与独立关闭分开显示。新执行记录读取不含原始消息/配置/命令的摘要；
旧会话记录有界回读，超过限额明确显示缺口。操作存在但没有问题关联时，只展示历史操作，
不能认定已解决。工具用法见 [任务与返工流程](TASK.md#050发现问题后如何流转)。
