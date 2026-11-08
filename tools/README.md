# tools/ — 仓库级检查工具

这些工具**不是插件**（不在 `packages/` 里），它们验证的是仓库自身的验证纪律：
基准对照、变异得分、插件激活/安装漂移、单测的时间稳定性、peer 兼容性。

| 工具 | 一句话 | 典型命令 |
|---|---|---|
| `bench/run.mjs` | 两侧对照基准：同一条判据在**坏版本**上必须违反、在**修复版**上必须满足 | `node tools/bench/run.mjs` |
| `mutation-score.mjs` | 变异测试：往 `lib/` 注入明确的缺陷，看测试会不会红 | `node tools/mutation-score.mjs` / `--list` / `--gate sdlc` |
| `plugin-activation-check.mjs` | App 会加载的到底是不是我这一版：宿主行 + preset 内本套件六行 → 模块、inject 可解析、profile 副本逐文件 sha256 | `node tools/plugin-activation-check.mjs` |
| `profile-runtime-check.mjs` | 对已装 tarball 的隔离 profile 启动真实 App 运行时，检查模式、实际工具调用、验证者范围和看板接口 | `DSH_HOME=/tmp/sdlc-check node tools/profile-runtime-check.mjs /tmp/sdlc-check/profiles/web` |
| `time-travel-check.mjs` | 用假时钟把单测推到未来若干时点，抓"写下的当天对、之后必坏"的断言 | `node tools/time-travel-check.mjs` |
| `compat-check.mjs` | peer 范围是否接受本机**真实 App** 的 DSH 运行时（普通 Node 读不了 app.asar，会自己重入） | `npm run compat` |
| `preset-sync-check.mjs` | `preset-sdlc` 内嵌的 DSH **standard preset 副本**是否与当前 App 一致；`--write` 重新同步 | `npm run preset-sync` / `npm run preset-sync:write` |

每个工具文件头都有"为什么需要它"的来历，改之前先读——里面记的坑都是实测踩出来的。

## DSH 升级后的检查顺序

先跑 `npm run compat` 和 `npm run preset-sync`。前者只检查版本范围，不保证组件入口或 API 没变；副本漂移时用 `npm run preset-sync:write` 同步，再跑 `npm run verify`。`smoke/preset.mjs` 会递归解析当前 App 导出的 DSH 组件，避免漏掉组内已删除的入口。

接着用 App 自带 CLI 将 `npm pack` 的 tarball 装进隔离 `DSH_HOME` 下的 `web` profile，再按表中命令跑 `profile-runtime-check.mjs`。该脚本不会替你安装包；必须显式传隔离目录，不能用日常 desktop profile。它会启动本地服务并实际调用 `sdlc_status`，检查 standard/SDLC 模式隔离、验证者工具范围与注册归还，以及带认证的看板接口；不会调用模型。当前只在 macOS 的 DSH 0.2.2-rc.1 上实测。

裸 `ToolRuntime` 冒烟通过 `smoke/helpers/executor.mjs` 安装 App 的真实执行器，所有 DSH 导入也统一指向 App，避免混入开发依赖旧版本。`smoke/invoke-tool.mjs` 可用 `DSH_SMOKE_MODULES` 指向 App 外的一份同代依赖，复核内部调用的父子关系、策略和取消。

## 2026-10-19 单包合并后的适配

背景（commit `83d86b0` + `7f2be0a`）：七个插件合并为**一个包**
`packages/sdlc`（`@ai-native-sdlc-plugin/dsh-sdlc@0.2.0`）。

- 源码 `packages/sdlc/src/<comp>/`，产物 `packages/sdlc/lib/<comp>/`；
- 一个 bundle：`packages/sdlc/cordis.patch.yml` 里**一条 insert + 七行**，
  行 id 仍是 `sdlc-task` / `sdlc-artifact` / `sdlc-status` / `sdlc-verify` /
  `sdlc-workflow` / `sdlc-rsi` / `sdlc-ui`；
- ⚠️ **`sdlc-ui` 行的 name 是精确包名** `@ai-native-sdlc-plugin/dsh-sdlc`（包根
  `lib/index.js`），其余六行是子路径。原因：`@deepseek-ai/dsh-client-modules`
  只扫描精确包名的 loader 行来发现 `dsh.client`，写成 `./ui` 子路径会让
  浏览器半**静默消失**（host 端点照常 200，只有面板不出现）。所以
  **不要假设 "name 去掉包名前缀 = `lib/<comp>/index.js`"**，映射要走
  package.json 的 `exports`；
- 旧七个 `packages/sdlc-*` 目录已无 package.json/tsconfig（只剩被 gitignore 的
  `lib/`、`node_modules/`、tgz 残留）。**它们的 `src/` 已不在工作区，但 git
  历史里旧路径仍然真实存在**——bench 的基线 revision 必须继续用旧路径。

四个工具都改成**按 revision / 按文件系统判形**，不硬编码某一种布局：

### `bench/`
- `lib.mjs` 新增 `mergedAt(rev)` / `compileMerged(rev, work)` / `loadMerged()`：
  合并布局的 revision 用 `git archive` 取**整包 `packages/sdlc`**（组件间有真实
  相对 import：`status/scan.ts` → `../task/state.js`），在临时目录用包自己的
  `package.json`（`type: module`）与 `tsconfig.json` 编译，再 `import()` 加载；
  旧布局的 revision 保持原来的 `git show` 单文件 + `require` 加载。两种形态在
  同一个 work 目录里共存（嵌套 package.json 优先）。
- `case-status-page.mjs`：基线 `80d8edc` 仍取 `packages/sdlc-status/src/scan.ts`；
  修复版 `HEAD` 走合并布局 `packages/sdlc/src/status`。
- `case-pwsh-toolfilter.mjs`：两个 revision 都是历史提交，旧路径不动。但
  **tsc 失败是类型漂移，不是用例失败**：ccb880e/6bed6ea 针对 0.2.0 API 写的
  （`ctx.subagents.start` / `SubagentStartRequest.toolFilter`），拿 App 升级后的
  0.2.1 类型检查必然报 TS2353/TS2339。修法是用 `compileFiles(..., { noCheck: true })`
  只转译——本用例测的是**运行时行为**，不是历史源码对新类型的兼容性。顺便删掉了
  从不存在的 `helpers.ts` 文件名（`compileFiles` 会静默跳过缺失文件）。
- `case-false-alarm.mjs` 两侧都是历史提交，未改。

### `mutation-score.mjs`
- 测量目标从"四个包目录"改成单包里的组件目录：
  `sdlc-verify/task/artifact/status` → `packages/sdlc/{src,lib}/<comp>`，
  冒烟是 `packages/sdlc/smoke/<comp>.mjs`；
- 新增第五个目标 **`sdlc-shared`**：合并前 `sessionCwd` / `resolveOptions` 等
  辅助函数在四个包里各有一份**逐字相同**的 `helpers.js`，合并后只剩
  `src/shared/helpers.ts` 一份，测量单元也应只剩一份（否则同一份代码被四个
  组件各测一遍、存活点重复登记）。原 `sdlc-status/lib/helpers.js` 的存活点
  归到 `sdlc-shared`；
- `--gate` 语义更新：`package.json` 的 `mutation-gate` 现在是 `--gate sdlc`。
  `sdlc` / `dsh-sdlc` / `@ai-native-sdlc-plugin/dsh-sdlc` 是"全部目标"的别名；
  组件名照旧可单独选；**未知名字显式失败**，不静默空跑；
- 还原自检补强：`lib/` 不进 git（`.gitignore`），旧版只查 `git status` 在单包
  布局下**看不见 lib 残留**。现在收尾把每个被改文件与改动前原文**逐字节比对**
  （权威判据），`git status` 只用于证明没误动 `src/`；
- `srcLineOf` 按 `lib/<comp>/x.js ↔ src/<comp>/x.ts` 的相对路径定位；旧实现用
  `dirname(dirname(libFile))` 在单包里会指到 `packages/sdlc/src/*.ts`（对不上）。

### `plugin-activation-check.mjs`
- 检查对象从"七个包"变成"一个包 + 七行"：从 `cordis.patch.yml` 读七行 →
  用 package.json `exports` 解析出仓库模块文件 → 逐个 `import` 校验
  `apply` / `inject` / `Config`（Standard Schema）/ `name`，并断言
  `name === patch 行 id`、七行 id 不多不少；
- 七行 `inject` **并集**逐个对 `HOST_SERVICES` 校验；
- `sdlc-ui` 行单独钉一条断言：name 必须是精确包名（来历见上）；
- profile 漂移：`<profile>/node_modules/@ai-native-sdlc-plugin/dsh-sdlc` 与仓库
  `packages/sdlc` 的**整棵 lib 树**逐文件 sha256（只比会发布的 `.js`，排除
  `*.test.js`；`.d.ts` 不发布），额外比 `cordis.patch.yml`（App 按装进去的
  那份 patch 挂行）与版本号；缺文件/旧代码/多余旧文件都点名；
- profile 解析顺序保持：`DSH_PROFILE_DIR` > `DSH_PROFILE_NAME`/`DSH_PROFILE`
  +`DSH_HOME` > `~/.dsh/profiles/desktop`。**未安装时如实报错、exit 1，不崩**。

### `time-travel-check.mjs`
- 单包递归发现 `lib/**/*.test.js`，**按目录分组**（artifact/rsi/shared/status/
  task/verify/workflow）逐组跑；对单包递归跑就是包自己的
  `node --test "lib/**/*.test.js"`，分组只是为了报告能点名是哪个组件漂了；
- 假时钟机制不变（`NODE_OPTIONS=--import` shim 推 `Date.now()` / 无参
  `new Date()`）；**冒烟仍然不能时间旅行**（Electron 拒绝 `NODE_OPTIONS`，
  实测），静态检查写死日期的逻辑改成扫 `smoke/*.mjs` + `src/**/*.test.ts`；
- 组数/测试文件数会打印出来；**一个测试都没发现时直接失败**（否则"所有时点
  一致"是一条恒真断言）；
- `--smoke` 只把合并包的冒烟套件**跑一次**作为可用性检查，并明确标注
  "这次运行没有经过假时钟"——不假装做了时间旅行。

## 实测记录（2026-10-19，HEAD `7f2be0a`，Node v26.8.2，macOS）

### `node tools/bench/run.mjs`（约 4 秒）

```
汇总：
  ✅ 成立  STATUS-PAGE-1       基线违反 4 条 / 修复版违反 0 条
  ✅ 成立  FALSE-ALARM-1       基线违反 2 条 / 修复版违反 0 条
  ✅ 成立  PWSH-1              基线违反 4 条 / 修复版违反 0 条

✅ 全部用例成立：每个都在基线版上被证伪、在修复版上满足。
```

### `node tools/mutation-score.mjs --list`（0 秒，不跑测试）

```
  目标            变异点   抓住   存活   得分
  sdlc-verify       172      0      0       —
  sdlc-task         126      0      0       —
  sdlc-artifact      85      0      0       —
  sdlc-status       145      0      0       —
  sdlc-shared         4      0      0       —

  ✓ 收尾检查：未注入任何变异（--list），没有需要还原的文件；packages/ 的 git 状态干净（未动 src/）
```

### 注入/还原/计数/门禁通路（实跑，不是只看 `--list`）

```
$ node tools/mutation-score.mjs sdlc-shared --kinds=boundary
  ⚠ 存活  cmp-eq  packages/sdlc/lib/shared/helpers.js:58 (src:103)  `===` → `!==`
  → sdlc-shared：2/3 被抓住，**变异得分 66.7%**
  ✓ 收尾检查：1 个被改文件已逐字节还原；packages/ 的 git 状态干净（未动 src/）

$ node tools/mutation-score.mjs sdlc-shared --gate --kinds=boundary
  门禁：1 个存活，0 个**不在清单里**，清单里 44 条未处置
  ✓ 门禁通过：没有未登记的存活变异
```

第二条同时验证了**迁移后的清单键能对上**：那个存活点
（`if (session === undefined)`）从旧 `sdlc-status/lib/helpers.js` 迁移成
`sdlc-shared` + `packages/sdlc/lib/shared/helpers.js`，门禁按
`pkg|op|file|site` 匹配成功（行号不在键里，所以行号漂移不影响）。

### 一次全量目标的局部实跑（`sdlc-task --gate`，约 28 秒）

```
  → sdlc-task：102/126 被抓住，**变异得分 81.0%**
  门禁：24 个存活，4 个**不在清单里**，清单里 44 条未处置
  …（4 条新存活被点名：task/index.js:430 bool-or；task/state.js:310/313/323 const-false）
  ✓ 收尾检查：2 个被改文件已逐字节还原；packages/ 的 git 状态干净（未动 src/）
```

⚠️ 这是**代码演化 + 布局变化后的真实读数**，不是旧基线复现：旧的
`docs/mutation-score-baseline.txt` 是 2026-10-08 的四个独立包读数（task 108/109），
之后代码变过（例如 `unchecked` 字段是后加的），且 helpers 单测现在归
`sdlc-shared` 目标。**不要**为了让它回到旧数字去 `--update-allowlist` 了事；
这 4 条要逐条人工评审。门禁因清单里还有 44 条"未处置"而只报告不阻断——那是
工具设计（见 `mutation-score.mjs` 门禁段注释），不是失败。

### `DSH_PROFILE_DIR=.verify-home/profiles/verify-sdlc node tools/plugin-activation-check.mjs`

```
bundle 行: 7 行（期望 7）
✓ sdlc-task … ✓ sdlc-verify … ✓ sdlc-ui → …/packages/sdlc/lib/index.js
inject 并集: [tools, fs, systemPrompt, sandboxPolicy, subagents, skills, connection]
  ✓ 并集里每个服务都在 HOST_SERVICES 名单里

profile 副本: 已安装 @0.2.0，逐文件 sha256 比对 26 个发布文件 ✓ 完全一致
✅ 全部就绪：七行可解析、inject 可解析、制品与 profile 一致。
```

负向分支已实测**真的会失败**（每条断言都要能失败）：

- 未安装：`DSH_PROFILE_DIR=/tmp/definitely-no-such-profile` → 点名"没装"，
  exit 1；
- 漂移：`.probe/fake-profile` 里删一个文件、改一个文件、加一个旧文件 →
  三条分别点名（缺文件 / sha256 不一致 / 多余旧文件），exit 1；
- 行级：在临时 git worktree 里把 `sdlc-ui` 行改回 `./ui` 子路径、给 task 的
  inject 加 `logger` → 分别点名"必须是精确包名"与"宿主没有的服务 logger"，
  exit 1。

### `node tools/time-travel-check.mjs`（约 10 秒）

```
时间旅行检查：偏移 +0天, +1天, +30天, +365天, +3650天（packages/sdlc：7 组 / 13 个测试文件）
对象                      今天         +1天        +30天       +365天      +3650天
  artifact           23/23       23/23       23/23       23/23       23/23
  rsi                38/38       38/38       38/38       38/38       38/38
  shared             11/11       11/11       11/11       11/11       11/11
  status             42/42       42/42       42/42       42/42       42/42
  task               36/36       36/36       36/36       36/36       36/36
  verify             45/45       45/45       45/45       45/45       45/45
  workflow             7/7         7/7         7/7         7/7         7/7

✅ 所有时点的结果一致——没有"随日期改变"的断言。
```

（合计 202 条单测，与 `npm test` 的口径一致。静态检查报的 17 处写死日期是
**测试自己钉住时刻**的夹具——5 个时点结果完全一致就是证据；不是定时炸弹。）

### `node tools/compat-check.mjs`

```
DSH runtime (from /Applications/DeepSeek Harness.app): 0.2.1-rc.2
  ai-native-sdlc-harness@0.1.0  peers=0
  @ai-native-sdlc-plugin/dsh-sdlc@0.2.0  peers=8

✓ 全部 2 个包与 DSH 0.2.1-rc.2 兼容
```

⚠️ 合并后 compat 只覆盖 **2 个 manifest**（仓库根 + 合并包）。AGENTS.md 里
"8 个包全部接受当前运行时"是合并前的历史读数，不要再引用。

## 已知边界

- **mutation 没有做全量重跑**：`tools/mutation-survivors.json` 与
  `docs/mutation-score-baseline.txt` 只做了**路径迁移**（文件头已注明），
  分数/行号仍是 2026-10-08 旧布局的读数。重跑后应整体替换，而不是在旧表上打补丁。
- **`--gate sdlc` 全量一次要数分钟**（历史四包全量 139 秒；单包全量预计同量级），
  目前只验证了通路与局部目标。全量是否通过取决于那 4 条新存活点的评审结论。
- **bench 的用例钉在历史提交上**：失败报告可能说的是**那个时代**的缺陷，
  先分辨再动手（`tools/bench/README.md` 有专门一节）。基线侧必须继续用旧路径。
- **`time-travel` 是假时钟**：只覆盖 `Date.now()` / 无参 `new Date()`；
  `performance.now()` 或外部命令取时间的路径它看不见。
- **`plugin-activation-check` 不证明"进程已经加载了"**，只证明"制品对、能激活"；
  后者要看运行时可见物（`plugin_manager` 的 `fiberPhase` 或新行为）。

## 2026-10-19 方案 A：改成「选定 preset 才生效」后的适配

背景（`0.3.0`）：用户要求"只有明确指定这套 SDLC 时才工作"。官方唯一按会话选择的
单位是 Agent Preset，所以：

- `packages/sdlc/cordis.patch.yml` 变成**两条宿主行**：
  `sdlc-ui`（精确包名，常驻只读看板）+ `preset-sdlc`（`@deepseek-ai/dsh-agent-preset`
  声明，id=`sdlc`，`config.plugins` = **DSH standard preset 的完整副本** +
  本套件六个组件行）；
- 六个机制组件不再出现在宿主层，标准会话不会加载它们；
- **`preset` 不继承、不合并**，所以副本必须手动同步：`preset-sync-check.mjs`
  读 App 的 `dsh-web-app/presets/standard.patch.yml` 与仓库 patch 逐行比对
  （**整行**：id/name/config/disabled/group/isolate 及未来新增字段），
  `--write` 用 App 当前 standard 重写副本区域；
  App 升级后必须跑；
- `plugin-activation-check.mjs` 相应改为：只 import **本套件的行**（`sdlc-ui` 宿主行
  + preset 内六行），**不**拿本包的 `exports` 去解析 standard 副本里的
  `@deepseek-ai/*` 行（第一版这么写，全部误报"解析失败"）。
- 新增 `packages/sdlc/smoke/preset.mjs`：patch 形状（宿主 2 行、preset 含
  standard 基础工具锚点 + 六行在末尾、模块可装配、六行不在宿主层）。

### 可复跑的真实运行读数（隔离 profile，`.verify-home`）

```
--dump-config           宿主 2 行；preset 子行 28（22 standard 副本 + 6 本套件）
启动                    0 条 entry did not activate；boot entry rev=ca10afcab19f
GET /api/sdlc-ui.tasks  200（字节数随 .ai/tasks 数据变化，写入时 89760）
agentPresets/list       standard / ptc / minimal / cordis / sdlc / sdlc-verifier；
                        sdlc 的 broken 字段缺失（可组合）
agentPresets/read sdlc  末尾六个本套件行
session/create          指定 agentPreset=sdlc → 返回 agentPreset=sdlc；默认 → standard
会话投影 toolsTokens    sdlc 会话 10072 > standard 会话 6902（standard 没有多出来的工具）
```

⚠️ `toolsTokens` 是"最新请求 envelope 的工具 schema 启发式 token 数"（间接）；
**更直接**的读数是会话日志里的 `request/header`：sdlc 会话 44 工具（31 standard +
13 个 `sdlc_*`）、standard 会话 31 工具 0 个 `sdlc_*`。两者都只是协议层证据，
GUI 选择器/面板的人工验收仍单列。
