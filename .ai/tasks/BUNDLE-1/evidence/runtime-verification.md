# BUNDLE-1 运行时证据（2026-10-19，DSH 0.2.1-rc.2）

本文件把**本机执行过的**安装/启动证据固化成文字，供独立验证者复核。
可丢弃的本地目录（`.probe/`、`.verify-home/`）不进 git；命令可照抄复跑。

## A. 机制探针：第三方 bundle 自引用子路径行（`probe-*.md` / `probe-repro.sh`）

- fixture：`@probe/two-rows`（npm pack 的 tgz），`cordis.patch.yml` 两行分别指向
  `@probe/two-rows/a`、`@probe/two-rows/b`；两个组件在 `apply()` 时写 marker。
- 结果：`PASS=32 FAIL=0`（`.probe/repro-console.txt`）。关键读数：
  - `--dump-config` 两行、name 逐字为子路径；
  - `dsh.profile.bundles` 由 CLI 自动追加 `@probe/two-rows`；
  - 真实 `dsh web` 启动后两个 marker 都由**该次启动进程**（pid 相同）写出，
    日志 `dsh web: http://127.0.0.1:50252/...`；
  - 三次启动日志里 `entry did not activate` 零命中；
  - profile patch `- id: probe-b / disabled: true` 后只有 `a.txt`，恢复后两个 marker 都回来。
- 边界：fixture 无 peerDependencies、不 import `@deepseek-ai/*`；只证明行级机制 +
  子路径解析 + 真实激活，未覆盖发行包的 peer/依赖形态。

## B. 真实 tarball 的隔离 profile 验证（`.verify-home`，不碰用户 profile）

环境：`DSH_HOME=<repo>/.verify-home`；先用 `--from-default-profile web` 建模板，
再 `dsh plugin --profile verify-sdlc add <tgz>`（顺序不能反：`--from-default-profile`
是整目录替换，会清空刚装的依赖与 bundles）。

- 安装结果：`dependencies: + @ai-native-sdlc/dsh-sdlc 0.2.0`；
  `dsh.profile.bundles` = `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app",
  "@ai-native-sdlc/dsh-sdlc"]`。
- `--dump-config`：`grep -c "name: '@ai-native-sdlc/dsh-sdlc"` = **7**；
  七行分别为 `.../task`、`/artifact`、`/status`、`/verify`、`/workflow`、`/rsi`
  与**精确包名** `@ai-native-sdlc/dsh-sdlc`（ui 行）。
- 真实启动：`dsh --profile verify-sdlc --port 0 --no-open`，日志出现
  `dsh web: http://127.0.0.1:<port>/?token=...`，**无** `entry did not activate` /
  client compose 错误。
- `GET /`（带 token cookie）返回 200 / 37718 字节；其中
  `__DSH_BOOT__.entries` 含：
  `{"id":"@ai-native-sdlc/dsh-sdlc","url":"plugins/??@ai-native-sdlc/dsh-sdlc/client.js&rev=22268bf8eaf1","rev":"22268bf8eaf1","inject":["@deepseek-ai/dsh-client-ui-sidebar"]}`
- `GET /api/sdlc-ui.tasks`（认证 cookie）返回 **200 / 81975 字节**：
  `repoRoot=<WORKSPACE>/AI Native SDLC`，`roots` 三个工作区、
  `taskCount` 分别 1 / 2 / 10。
- `DSH_PROFILE_DIR=<repo>/.verify-home/profiles/verify-sdlc
  node tools/plugin-activation-check.mjs` → 七行可解析、inject 并集全在
  HOST_SERVICES 名单、profile 副本逐文件 sha256 一致（26 个发布文件）。

## C. desktop profile live 迁移（真实 App，不重启）

- 迁移前备份：`.verify-home/backup/desktop-{package.json,cordis.patch.yml,pnpm-lock.yaml}`。
- `ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals "$CLI" plugin --profile desktop add
  <tgz>` → `+ @ai-native-sdlc/dsh-sdlc 0.2.0`；`dsh.profile.bundles` 末尾自动追加
  该包（与旧 AGENTS 断言相反，见 `docs/dsh-pitfalls.md` §2.1）。
- **无需重启**：`plugin_manager list_plugins` 里七行 `fiberPhase: active`：
  `include:sdlc-task`(=@ai-native-sdlc/dsh-sdlc/task)、artifact、status、verify、
  workflow、rsi、`include:sdlc-ui`(moduleName=@ai-native-sdlc/dsh-sdlc)，全部
  `enabled: true, fiberPhase: active`；无 pending。
- 当前会话直接获得工具 `sdlc_status` / `sdlc_verify` / `sdlc_artifact_*` /
  `sdlc_task_*` 与 Skill `sdlc-verification-discipline`；`sdlc_status` 返回真实任务
  `RSI-1 [VERIFYING] ... 停滞 4 天 裁决: 未验证`。
- 清理：`dsh plugin --profile desktop remove @ai-native-sdlc/dsh-sdlc-{artifact,rsi,
  status,task,ui,verify,workflow}` 逐个移除；最终 profile `dependencies` 只剩
  `@ai-native-sdlc/dsh-sdlc`，`dsh.profile.bundles` 只有一条 SDLC 条目。
- 旧七包目录在 profile 中已不存在（`ls node_modules/@ai-native-sdlc` 只有 `dsh-sdlc`）。

## D. 测试与门禁读数（本地实测，命令可复跑）

| 命令 | 读数 |
|---|---|
| `npm test --workspace packages/sdlc` | lib `ℹ tests 202 / pass 202 / fail 0`；UI `8/8`（合计 210） |
| `DSH_APP=... npm run smoke --workspace packages/sdlc` | 7 脚本全过：artifact 39 / rsi 62 / status 69 / task 40 / ui 46 / verify 109 / workflow 12（共 377 条断言） |
| `node tools/bench/run.mjs` | STATUS-PAGE-1 基线违反 4/修复 0；FALSE-ALARM-1 2/0；PWSH-1 4/0 → 3/3 成立 |
| `node tools/compat-check.mjs` | 2 个 manifest 与 DSH 0.2.1-rc.2 兼容 |
| `node tools/time-travel-check.mjs` | 7 组 / 13 个测试文件，5 个时点结果一致 |
| `node tools/mutation-score.mjs --list` | 532 个变异点；收尾 git status 干净 |
| `DSH_PROFILE_DIR=.verify-home/profiles/verify-sdlc node tools/plugin-activation-check.mjs` | 见 B |

## E. 合并前后测试数对比（减少的 41 条逐项说明）

- 合并前 251（含 UI 8）：artifact 35 / rsi 38 / status 58 / task 48 / ui 8 /
  verify 57 / workflow 7。
- 合并后 210：lib 202 + UI 8。
- 减少 41：
  - 3 份重复的 `helpers.test.ts` 副本 × 12 = **36**：同一份代码不再有副本，
    "漂移检测"失去对象；保留的 `src/shared/helpers.test.ts` 仍在测行为。
  - `helpers.test.ts` 里的 1 条**漂移检测**用例：同上。
  - `status/contract.test.ts` **4** 条：它读 `packages/sdlc-task/src/state.ts`
    源码文本比对常量副本；合并后 `status/scan.ts` 直接 import 常量，副本不存在。

## F. 独立验证裁决后的 minor 修复（2026-10-19）

第一次 `sdlc_verify`（verifier_session `2b1a89aa-…`）返回 **approve**（5/5 met），
同时给了 3 条 minor。全部已处置：

1. **插件页展示元数据丢失**（功能性 minor）：
   - 旧包在包根有 `locale/en.json` + `zh.json`（`meta.title/description`），
     宿主 `dsh-app-boot` 的 `readPluginMeta` 只读 `<specifier>/locale/en.json`；
     合并后把 locale 放进 `locale/<组件>/`，且 exports 是 `./locale/*/*.json`
     （多星 pattern 不解析）→ 卡片与子路径行退化为裸 specifier。
   - 修法：包根新增 `locale/en.json` + `locale/zh.json`（套件级标题/描述）；
     exports 增加 `./locale/en.json`、`./locale/zh.json`、
     `./*/locale/en.json`、`./*/locale/zh.json`、`./*/icon`；`files` 改
     `locale/**/*.json`。子路径行（task/artifact/status/verify 有 locale；
     workflow/rsi 原本就没有 locale）与组件 icon 均恢复可达。
   - 实测（从 desktop profile 已安装副本用 `createRequire` 解析）：
     7 个 locale/icon 资源全部解析成功，标题为 "AI-native SDLC" /
     "AI 原生 SDLC" 与各组件标题；`lib/index.js`、`lib/task/index.js` 等
     模块解析正常。
   - 回归：`smoke/ui.mjs` 新增 2 条断言（包根 locale meta + exports 覆盖），
     ui 冒烟 44 → **46**，总冒烟 375 → **377**。
2. **旧包磁盘残留**：已 `rm -rf packages/sdlc-{task,artifact,status,verify,
   workflow,rsi,ui}`。`packages/` 现在只有 `sdlc/`；`find packages -name '*.tgz'`
   只剩 `packages/sdlc/ai-native-sdlc-dsh-sdlc-0.2.0.tgz`（gitignore）。
   旧脚本"静默假绿"的前置条件消失。
3. **六处源码头注释旧包名**：`src/{task,artifact,status,verify,workflow,ui}/index.ts`
   头注释改为 `@ai-native-sdlc/dsh-sdlc/<component>`；ui 注释里 `src/client.js`
   改为 `src/ui/client.js`。

最终 tarball：`packages/sdlc/ai-native-sdlc-dsh-sdlc-0.2.0.tgz`（48 文件，含 locale/ 与 icons/），
已替换 desktop 依赖（`file:…/packages/sdlc/ai-native-sdlc-dsh-sdlc-0.2.0.tgz`）
并重建隔离 profile；`plugin-activation-check` 七行 + 26 文件 sha256 一致。
隔离 profile 最终启动：`__DSH_BOOT__.entries` 含客户端 entry（rev=b2c042a69eb1），
`GET /api/sdlc-ui.tasks` 200 / 86773 字节（含新增的 BUNDLE-1，故比首轮 81975 大），
0 条 `entry did not activate`。

## G. 测试场仓库（另一个 git 仓库）适配

`sdlc-playground` commit `348bff2`（已推送 `main`）：
`tools/playground-check.mjs` 的 import 改为 `${PLUGINS}/sdlc/lib/<comp>/index.js`，
并新增"单包布局"前置检查（缺了就 exit 2、不写 `.ai`，避免旧脚本在干净检出上
ERR_MODULE_NOT_FOUND、在本机残留旧 lib 上静默假绿）。实测（隔离副本 + 远端
clone 复跑）：`make check` **21/21 通过**，断言数未削弱。

## H. 第二轮独立验证（approve，4 条 minor）后的修复与复验

第二轮 `sdlc_verify`（verifier_session `9de467f5-…`）5/5 met、approve，
给出 4 条 minor，全部处置：

1. **逐组件 icon 丢失**：`./*/icon` 全部指向同一个套件 icon。已把旧四枚不同
   icon 从 git 历史取出（`git show 959f3ee^:packages/sdlc-<comp>/icon.svg`），
   放到 `packages/sdlc/icons/`，exports 改为 `./*/icon: ./icons/*.svg`；
   `files` 加 `icons/*.svg`。实测从已安装 desktop 副本解析：
   task `375536c3f2de`、artifact `7411d5be50ee`、verify `c703362363d5`、
   rsi `69294c2bf0c3`，status/workflow 与套件共用 `78170def2c91`
   ——与合并前逐一相同。
2. **UI 冒烟 exports 断言只查键存在**：已改为对每个 key 把 target 里的 `*`
   替换成代表性组件、检查真实文件存在，并逐组件校验 icon；同时做负向实测
   （把 `./locale/en.json` 的 target 改坏 → 该断言红、46/46 变 45/46）。
   断言总数仍 46，未用"加断言"换数字。
3. **plan.md 的 Proof 数字过期**：已用 `sdlc_artifact_write` 覆写 plan，改为
   377/46 与"字节数/根数随工作区任务变化"的表述；与 D/F 节对齐。
4. **desktop 七行 fiberPhase 未在最终 tarball 上复读**：已重装最终 tarball
   （先 remove + 删除安装目录，避免同路径同版本复用旧文件）后重新调用
   `plugin_manager list_plugins`（19:34）：七行全部 active；当前会话
   `sdlc_status`/`sdlc_verify` 可真实调用。

其余清理：headless / verifytest profile 里旧的 `@ai-native-sdlc/dsh-sdlc-*`
依赖与 bundles 条目已移除；仓库根 `node_modules/@ai-native-sdlc` 的七个悬空
workspace 链接已随 `npm install` 收敛为唯一 `dsh-sdlc → packages/sdlc`。

最终 tarball：`packages/sdlc/ai-native-sdlc-dsh-sdlc-0.2.0.tgz`
（**48 文件**；sha256 见打包记录）。隔离 profile 重装后：
bundles=[base,web-app,dsh-sdlc]、dump-config 7 行、启动日志 0 条
`entry did not activate`、boot entry rev=`25dbcb5b2aed`、
`GET /api/sdlc-ui.tasks` 200 / 86730 字节。
