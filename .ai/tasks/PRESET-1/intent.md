# Intent：只在选定 Agent Preset 时启用整套 SDLC

## Problem

这套 SDLC 插件目前把七个组件行插在 profile bundle 的宿主 Loader 顶层，因此**装进
desktop profile 后对每个会话全局生效**：任何会话都会自动拿到 `sdlc_*` 工具、
SDLC 提示词段与两条 Skill。日常编码会话并不需要它们，用户希望：

> 只有在**明确指定**这套 SDLC 的时候，它才工作。

检索官方文档后的结论：DSH 没有"会话中按需加载插件 / 点名即启用"的机制；
唯一按会话选择的单位是 **Agent Preset**——preset 决定该 Agent 的工具、提示词和
技能，已有会话保留原组合。官方 `@deepseek-ai/dsh-agent-preset`：
"可同时声明多个 preset，由会话选择"；`@deepseek-ai/dsh-agent-preset-registry`：
"通过声明式 preset 选择 Agent 的工具、提示词和技能"。`dsh-skill` 也明确
preset 插件注册的 Skill 落入该 preset 层，不进入全局层。

## Proposed outcome

采用**方案 A**：

- 新增一个 Agent Preset 声明（`id: sdlc`，展示名「AI 原生 SDLC」），把六个机制组件
  （task / artifact / status / verify / workflow / rsi）作为 preset 内的子插件行；
- **从 bundle 顶层 insert 中移除这六行**，所以标准会话不再加载它们：没有工具、
  没有 SDLC 提示词段、Skill 目录里没有那两条；
- `sdlc-ui` 的**宿主行保留在 bundle 顶层**：`dsh.client` 发现要求宿主 Loader 里
  存在精确包名行，preset 行不在宿主树里，因此浏览器半必须常驻——侧栏面板作为
  只读看板始终可见（方案 A 的既定取舍），但它不参与任何工作流；
- 用户新建会话时在 preset 选择器里选「AI 原生 SDLC」（或把它设为默认）；
  该会话才有整套工具、提示词与 Skill。已有会话不受影响，子代理默认继承父会话的
  preset，也可单独指定；
- 包版本升到 `0.3.0`（行为变化），仍是**一个 npm 包 / 一个 bundle / 一条
  `dsh.profile.bundles` 条目**；安装方式不变。

## Affected users and systems

- 使用 desktop profile 的用户：默认会话不再被 SDLC 工具与提示词占据；需要时在
  新建会话里选择一个模式即可。
- 本仓库的包结构、`cordis.patch.yml`、冒烟/激活检查工具、README/AGENTS/docs。
- 现有会话：保留创建时的组合；本次迁移后当前会话不会自动获得新 preset。
- 验证者：`sdlc_verify` 自身的 `sdlc-verifier` preset 现在由 SDLC 会话内的
  verify 组件注册，只有 SDLC 会话能用；这是符合预期的收敛。

## Constraints

- 只能使用官方机制：Agent Preset 声明由 bundle patch 贡献；不能假设"会话中动态
  挂载"能力。
- `sdlc-ui` 的宿主行必须保留在顶层（精确包名），否则浏览器半静默消失
  （合并时实测过）。
- 六个组件在 preset scope 里必须仍能激活：它们消费宿主服务
  `tools` / `fs` / `sandboxPolicy` / `systemPrompt` / `skills` / `subagents`；
  官方说明"等待 Host 服务的行保持挂载"，且组外普通查找选择 Host realm。
- 不得改变六个组件的工具名、Skill 内容、`state.yaml` / `verification.json`
  契约与验证者隔离策略。
- 已有测试与冒烟语义不变；新增 patch 形状与 preset 装配的校验断言必须能失败。
- 迁移顺序：先改仓库、隔离 profile 验证、独立验证，最后才动 desktop profile。

## Open questions

- 六个组件放进 preset 后，`sdlc-verify` 在 preset scope 内注册
  `sdlc-verifier` preset 是否被激活审计拒绝？（官方："确认泄漏的服务会拒绝挂载"；
  我们只注册数据、不提供服务，预期可行，但需要真实探针。）
- `sdlc-rsi` 与 `sdlc-verify` 在同一个 preset scope 内的事件可见性是否与原先
  （同处宿主全局）一致？
- 是否需要在 preset 声明里显式给 `order` / `description` 以改善选择器展示？
  （倾向给，非必需。）
- `plugin-activation-check` 这类"看宿主行"的工具如何表达"行在 preset 里"？
  （需要更新为同时检查 host 行与 preset 子插件行。）
