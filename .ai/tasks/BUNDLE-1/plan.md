# Plan：把七个包搬进一个包并让证据可复核

## Files that change

迁移/合并（commit `959f3ee`）：
- `packages/sdlc-{task,artifact,verify,status,workflow,rsi,ui}/src` → `packages/sdlc/src/`
- `packages/sdlc-{...}/smoke.mjs` → `packages/sdlc/smoke/`；`sdlc-ui` 的两个
  行为测试 → `packages/sdlc/test/`
- 新增 `packages/sdlc/{package.json,tsconfig.json,cordis.patch.yml,README.md}`
- 共享层：四份 `helpers.ts`/`helpers.test.ts` → `src/shared/` 一份；
  `status/contract.test.ts` 删除；`status/scan.ts` 改 import `task/state.js`；
  `rsi` 对 verify 的 type-only 跨包 import 改相对导入
- 新增 `src/index.ts`（包根重新导出 ui，客户端半发现前提；commit `a6ac82d`）
- `packages/sdlc-{...}/package.json / tsconfig.json / cordis.patch.yml / icon.svg` 删除

工具链（commit `f7e1ade` 及其后）：
- `tools/bench/{lib,case-status-page,case-pwsh-toolfilter}.mjs`：HEAD 侧走
  `packages/sdlc/src/status`，用 git archive 整包编译；基线 rev 保持旧路径
- `tools/mutation-score.mjs`：四组件映射 + 新增 `sdlc-shared` 目标；
  还原自检改为逐字节比对
- `tools/plugin-activation-check.mjs`：七行从 patch 读、经 exports 解析模块、
  整树 sha256、`sdlc-ui` 精确包名断言
- `tools/time-travel-check.mjs`：递归 `lib/**/*.test.js`，零测试直接失败
- `docs/mutation-score-baseline.txt`、`tools/mutation-survivors.json`：仅路径迁移

文档：
- 根 `README.md`、`docs/dsh-plugin-contracts.md`、`docs/dsh-pitfalls.md`、
  `docs/sdlc-ui-redesign.md`、`tools/README.md`、`tools/bench/README.md`
- `AGENTS.md`：交付形态、拆分原则、目录、合并证据、当前读数、已知边界
- `packages/sdlc/README.md`、`TASK.md`、`RSI.md`（随源码迁移）

证据/任务：
- `.ai/tasks/BUNDLE-1/{intent,spec,plan}.md` + `evidence/` + `verification.json`
- `.verify-home/`、`.probe/`：gitignore 的本地证据目录（不提交）

## Order of work

1. 机制探针：第三方 bundle 两个自引用子路径行在真实启动中激活、自动登记、
   行级 disable 可逆（`.probe/repro.sh`，PASS=32）。
2. `git mv` 七个 `src` 与冒烟/测试/文档进 `packages/sdlc`；删重复副本；
   建 package/tsconfig/patch；修 import、preset 子路径、smoke 路径。
3. `npm install --package-lock-only`；`npm run build`；单测；七组件冒烟。
4. 首提交并推送（`959f3ee`）。
5. `npm pack`；在**隔离 profile**（`.verify-home`）安装并真实启动：
   dump-config 七行、无激活警告、端点 200、boot payload 检查。
6. 发现浏览器半缺失 → 修 `sdlc-ui` 行为精确包名 + 包根重导出 + 冒烟回归；
   重打包、重建隔离 profile 复验；提交并推送（`a6ac82d`）。
7. 委派工具链与文档适配；Lead 复跑 bench/mutation-list/activation/compat/
   time-travel；提交（`f7e1ade`）。
8. desktop profile 迁移：备份 → 安装新包（无需重启，HMR 生效）→
   `plugin_manager` 七行 active → live `sdlc_status` → 移除旧七依赖 →
   确认只剩一个 bundle/依赖。
9. 创建本任务制品链；用 `sdlc_verify` 对合并做独立验证（判据见 spec R1–R8）。
10. 按裁决修复（若有）；提交任务制品与 AGENTS 更新并推送；清理本地旧包残留。

## Risks

- **客户端半静默消失**（实际发生）：子路径行不会被 `client-modules` 发现；
  已用精确包名修复并加回归断言。若不真启动，单测/冒烟全绿也看不出。
- **新旧包共存重复注册工具**：迁移时先移除旧七依赖再装新包；desktop 迁移
  前后都用 `plugin_manager list_plugins` 核对。
- **测试跑旧代码**：`lib/` 是构建产物；每次改动后重新 build，并用
  activation-check 的 sha256 比对仓库与 profile。
- **tarball 同路径同版本复用旧内容**：换内容时用不同目录/带内容哈希的路径，
  并逐文件比对而不是以"安装成功"为证据。
- **历史路径与新布局混用**：bench 基线 rev 必须保留旧路径；当前侧必须新路径；
  文档中历史读数加"合并前"限定。
- **mutation 门禁被误当绿灯**：基线只做了路径迁移；报告未重新测量的真实读数。

## Proof

- 机制：`.probe/repro.sh` PASS=32（真实启动 marker 由 boot pid 写出、
  dump-config 两行、自动 bundles、无激活警告、行级 disable 可逆）。
- 构建/单测：`npm run build --workspace packages/sdlc`；`npm test --workspace
  packages/sdlc` → lib 202/202 + UI 8/8。
- 冒烟：`DSH_APP="/Applications/DeepSeek Harness.app" npm run smoke --workspace
  packages/sdlc` → 7 脚本 375 条断言全过（39/62/69/40/44/109/12）。
- 门禁：`npm run compat`；`node tools/bench/run.mjs` 3/3；
  `node tools/time-travel-check.mjs` 5 时点一致；
  `DSH_PROFILE_DIR=.verify-home/profiles/verify-sdlc node
  tools/plugin-activation-check.mjs` 七行 + 26 文件 sha256 一致。
- 隔离运行：tarball 装入隔离 profile；boot payload 含客户端 entry；
  `GET /api/sdlc-ui.tasks` 200 / 81975 字节（3 工作区 / 13 任务）。
- desktop live：无需重启，`plugin_manager` 七行 `fiberPhase: active`；
  `sdlc_status` 返回真实任务（RSI-1，VERIFYING，停滞 4 天）。
- 独立验证：`sdlc_verify` 对 R1–R8 逐条裁决，写入
  `.ai/tasks/BUNDLE-1/verification.json`。
