# Spec：bundle 顶层只留 UI 宿主行 + 一个「standard + SDLC」Agent Preset

## Requirements

- **R1 全局不再加载机制组件**：`packages/sdlc/cordis.patch.yml` 的宿主行只包含
  两条：`sdlc-ui`（name 为精确包名 `@ai-native-sdlc/dsh-sdlc`）与
  `preset-sdlc`（name 为 `@deepseek-ai/dsh-agent-preset`）。六个机制组件
  **不得**再出现在宿主行中。
- **R2 Preset 声明正确且自身可用**：`preset-sdlc` 的 `config.id` 为 `sdlc`，
  展示名「AI 原生 SDLC」+ 描述；`config.plugins` = **DSH standard preset 的完整
  副本（22 行，含基础工具 read/bash/write/skill/subagent…）** + 追加在末尾的
  六个本套件组件行（id / name 见下）。理由：preset 不继承不合并，没有 standard
  副本的 SDLC 会话连基础工具都没有，流程无法工作。
  - `sdlc-task` → `@ai-native-sdlc/dsh-sdlc/task`
  - `sdlc-artifact` → `.../artifact`、`sdlc-status` → `.../status`、
    `sdlc-verify` → `.../verify`、`sdlc-workflow` → `.../workflow`、
    `sdlc-rsi` → `.../rsi`；每行解析到的模块导出 `apply` / `inject` / `Config`。
- **R3 UI 常驻且可被发现**：`sdlc-ui` 行仍在宿主层、名称为精确包名；真实启动后
  `window.__DSH_BOOT__.entries` 含该包客户端条目，`GET /api/sdlc-ui.tasks` 200。
- **R4 版本与依赖**：包版本 `0.3.0`；`peerDependencies` 增加
  `@deepseek-ai/dsh-agent-preset`（可选 peer，因为 preset 行由 DSH 安装提供）
  且 compat 门禁通过；`dependencies` 仍不含任何 `@deepseek-ai/dsh-*`。
- **R5 副本漂移门禁**：`tools/preset-sync-check.mjs` 读取真实 App 的
  `dsh-web-app/presets/standard.patch.yml`，与仓库 patch 中的副本逐行比对
  （id / name / disabled / config），不一致退出 1；`--write` 可重新同步。
  该门禁必须能在副本被改坏时真的失败（负向实测）。
- **R6 测试与工具跟随**：
  - 新增 `smoke/preset.mjs`：宿主恰好 2 行、preset 含 standard 基础工具锚点、
    六个本套件行按序在末尾、六个模块可装配、六行不在宿主层；
  - 既有单测/七组件冒烟语义不变；
  - `tools/plugin-activation-check.mjs` 同时检查宿主行与 preset 内本套件六行，
    不再误把 standard 副本行当本包导出解析；
  - bench、mutation、time-travel 不受影响。
- **R7 真实运行证据**：隔离 profile 安装 tarball 后：
  - `--dump-config` 只有两条宿主行；启动 0 条 `entry did not activate`；
  - Host `agentPresets/list` 出现 `sdlc`、`broken` 缺失（可组合）；
    `agentPresets/read sdlc` 的末尾是六个本套件行；
  - `session/create` 指定 `agentPreset=sdlc` 与不指定（standard）各建一个会话，
    两者的 `agentPreset` 投影正确；各发一条 prompt 后，`contextBreakdown.toolsTokens`
    在 sdlc 会话显著大于 standard 会话（standard 不得含 sdlc 工具）；
  - `GET /api/sdlc-ui.tasks` 200。
- **R8 迁移安全**：先隔离 profile 验证再迁移 desktop profile；旧全局行移除后
  当前会话失去 `sdlc_*` 工具是预期行为；profile 仍只有一个 SDLC bundle/依赖。
- **R9 文档如实**：包 README 说明"新建会话选择 AI 原生 SDLC 模式才启用"、
  面板常驻的取舍、App 升级后跑 `preset-sync-check`；根 README / contracts /
  pitfalls / AGENTS 更新。

## Design

### patch 形态（摘要）

```yaml
- insert:
    - id: sdlc-ui
      name: '@ai-native-sdlc/dsh-sdlc'
    - id: preset-sdlc
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: sdlc
        name: AI 原生 SDLC
        description: 标准 coding 模式 + 任务状态机、制品链、独立验证与看板。
        order: 20
        plugins:
          # ==== DSH standard preset 副本（由 tools/preset-sync-check.mjs 同步）====
          - { id: persona, name: '@deepseek-ai/dsh-persona', config: { prefix: ... } }
          # …22 行（含 !!js 平台条件）…
          # ==== standard 副本结束；以下是本套件追加的六个机制组件 ====
          - { id: sdlc-task, name: '@ai-native-sdlc/dsh-sdlc/task' }
          # …artifact / status / verify / workflow / rsi
```

### 为什么 UI 不能进 preset

`@deepseek-ai/dsh-client-modules` 只扫描**宿主 Loader** 中精确包名的行来发现
`dsh.client`。preset 的行在注册表拥有的**内存 Loader 树**里，不是宿主 Loader
行，所以客户端半必须留在宿主层。方案 A 接受"只读看板常驻"。

### 为什么 preset 要带 standard 副本

preset 是**完整组合**，不支持继承/合并（官方：覆盖会替换完整子插件列表）。
若只放六个 SDLC 组件，选该模式的会话就没有 read/bash/write/skill 等基础工具，
整个流程不可用（实测：六行-only 时 sdlc 会话 toolsTokens 3265 且没有基础工具）。
因此「AI 原生 SDLC」= standard 的完整副本 + 六个组件；副本由 sync 门禁防漂移。

### 作用域行为（官方语义 + 本仓库实测）

- preset 插件的工具/提示词/Skill 注册落入该 preset 的 scope 层，只有选择该
  preset 的 Agent 可见（`dsh-tools` / `dsh-skill` / registry README）。
- 已有 Agent 保留旧组合；新建 Agent 使用当前定义；子代理默认继承父的 preset，
  也可显式指定。
- preset 插件消费宿主服务没问题（"等待 Host 服务的行保持挂载"）；我们的组件
  不提供服务。
- 隔离 profile 实测：sdlc 会话与会话级 `toolsTokens` 10072，standard 6902
  （差值≈六个组件的工具 schema），且 standard 会话在改动前后都是 6902。

## Areas of concern

1. **standard 副本的维护成本**：App 升级后副本会漂移，SDLC 模式可能缺新工具。
   已加 `preset-sync-check` 门禁 + `--write`，并在 AGENTS/README 写明升级后要跑。
   这是官方不支持 preset 继承带来的、无法消除的接缝。
2. **无法在 agent 内部创建"另一个会话"并直接观测其工具面**：本仓库用 Host RPC
   （`agentPresets/list|read`、`session/create|prompt|projections`）取得真实读数；
   证据与命令写在 `.ai/tasks/PRESET-1/evidence/runtime-verification.md`，可复跑。
3. **eager activation 的副作用**：preset 声明会提前激活，所以 verify 组件注册的
   `sdlc-verifier` preset 会出现在全局约定列表里（与改动前相同，非本次引入）。
4. **面板常驻**是方案 A 明确接受的取舍：它只读 `.ai/tasks`，不提供任何工具。
5. **preset 选择只影响新会话**：已有会话保留原组合，文档必须写清。
