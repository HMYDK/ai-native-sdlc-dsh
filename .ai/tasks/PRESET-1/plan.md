# Plan：把六个机制组件搬进「standard + SDLC」Agent Preset

## Files that change

- `packages/sdlc/cordis.patch.yml`：宿主行收敛为 `sdlc-ui` + `preset-sdlc`；
  preset 的 `config.plugins` = standard preset 完整副本（22 行）+ 六个组件行。
- `packages/sdlc/package.json`：版本 `0.3.0`；`peerDependencies` 增加
  `@deepseek-ai/dsh-agent-preset`（optional）；描述更新。
- `packages/sdlc/smoke/preset.mjs`：新增冒烟（宿主 2 行、standard 锚点、
  六个本套件行在末尾、模块可装配、六行不在宿主层）。
- `packages/sdlc/smoke/run-all.mjs`：输出改为"全部冒烟"（不再写死七个）。
- `packages/sdlc/README.md`：安装后如何新建会话选择「AI 原生 SDLC」；面板常驻
  的取舍；App 升级后跑 preset-sync-check。
- `packages/sdlc/TASK.md` / `RSI.md`：使用段落补"在 AI 原生 SDLC preset 会话中"。
- `tools/plugin-activation-check.mjs`：检查宿主行 + preset 内本套件六行；
  profile 发布文件 sha256。
- `tools/preset-sync-check.mjs`（新增）：与 App 的 standard preset 逐行对账；
  `--write` 重新同步副本。
- `tools/README.md`：五工具说明。
- 根 `README.md`、`docs/dsh-plugin-contracts.md`、`docs/dsh-pitfalls.md`、
  `AGENTS.md`：新形态、官方机制引用、方案 A 取舍、真实会话 RPC 读数、
  升级后的副本同步流程。
- `.ai/tasks/PRESET-1/`：本任务制品链 + 证据。

## Order of work

1. 制品链（intent/spec/plan）写就并登记——此时旧全局插件仍可用。
2. 从 App 的 `dsh-web-app/presets/standard.patch.yml` 生成副本；改 patch 与
   package.json；新增 smoke/preset.mjs；更新 run-all。
3. 更新 activation-check（区分宿主行 / 本套件 preset 行 / standard 副本）与
   新增 preset-sync-check；负向实测两个门禁都能红。
4. `npm run build` + 单测 + 八组件冒烟；`npm pack`。
5. 隔离 profile 重装并做**真实运行验证**：dump-config、启动、客户端点、
   `agentPresets/list|read`、`session/create|prompt|projections` 的
   toolsTokens 对比（sdlc 会话 > standard 会话）。
6. 更新文档与证据；提交并推送。
7. `sdlc_verify` 独立验证（判据 R1–R9；证据文件给出可复跑命令）。
8. 按裁决修复；迁移 desktop profile 到 0.3.0（此步后当前会话失去
   `sdlc_*` 工具，预期），记录 live 读数并提交推送。
9. 请用户在新建会话中选择「AI 原生 SDLC」做最终人工确认。

## Risks

- **standard 副本漂移**：官方 preset 不支持继承，副本必须手动同步；已加门禁与
  `--write`；文档写明 App 升级后要跑。这是本方案的主要长期成本。
- **preset 装配失败**：可能因 `!!js`、group、服务缺失等激活审计失败而 `broken`。
  用真实隔离 profile 的 `agentPresets/list` 的 `broken` 字段与真实会话读数判定。
- **误把 standard 副本行当本包导出**：activation-check 第一版就踩了（拿
  exports 解析 `@deepseek-ai/dsh-persona` 报解析失败）；已限定只 import 本套件行。
- **无法在 agent 内自动观测别的会话工具面**：用 Host RPC 的会话投影
  `contextBreakdown.toolsTokens` 对比，证据落盘；这是间接但可复跑的读数。
- **迁移后当前会话失去工具**：先完成独立验证再迁移，避免"验证工具自己先没了"。
- **重装坑**：同路径同版本可能复用旧文件；隔离 profile 每次重建，正式迁移
  从 0.2.0→0.3.0 且用新 tarball，安装后以 activation-check 的 sha256 为准。

## Proof

- 静态：`node packages/sdlc/smoke/preset.mjs`（19 条）；负向：把组件搬回宿主行
  或删掉 standard 副本锚点，断言必须红。
- 副本：`node tools/preset-sync-check.mjs` 与 App 的 standard 逐行一致；负向：
  改坏一行后退出 1（记录在证据里）。
- 构建与既有行为：`npm run build`、单测 202+8、全部冒烟（8 脚本，数量由脚本
  输出）；bench 3/3；compat 通过；mutation `--list` 干净；time-travel 5 时点。
- 隔离运行（可复跑命令见 evidence）：
  - `--dump-config` 两条宿主行；
  - 启动 0 条 `entry did not activate`，boot entry 含 `@ai-native-sdlc/dsh-sdlc`；
  - `GET /api/sdlc-ui.tasks` 200；
  - `agentPresets/list` 含 `sdlc`（broken 缺失），`agentPresets/read` 末尾六行；
  - `session/create`（sdlc / 默认）两会话 `agentPreset` 正确；
    各发 prompt 后 `toolsTokens`：sdlc 10072 > standard 6902。
- desktop 迁移后：`plugin_manager list_plugins` 有 `preset-sdlc` / `sdlc-ui`
  active，且**没有** `include:sdlc-task` 等六个宿主行；依赖只剩一个。
- 独立验证：`sdlc_verify` 对 R1–R9 逐条裁决并写入 `verification.json`；
  "新建会话选到该 preset" 的最终人工确认如实列为后续项。
