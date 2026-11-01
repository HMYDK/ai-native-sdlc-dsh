# AI 原生 SDLC × DeepSeek Harness

本仓库把 Anthropic《AI 原生 SDLC 实战手册》的方法论落成 **DSH 插件**。
手册中文全译在 `handbook/`。本文件是 agent 的项目记忆，每次会话开始时读取。

## 仓库与提交纪律

- **远端**：`https://github.com/HMYDK/ai-native-sdlc-dsh`（私有，默认分支 `master`）
- **每个有意义的改动都要提交并推送**，不要攒着。工作区应保持干净。
- 提交信息写**为什么**，不写"更新了 X"。本项目的提交信息承载了大量
  踩坑结论，它们是这个仓库最有价值的产物之一。
- ⚠️ **推送前先审查 `git ls-files`**，别用 `git add -A` 盲推。
  实测踩过两次：
  ① 把冒烟测试造的 `.ai/tasks/SMOKE-*/` 提交进了历史（后来用 filter-branch 清理）；
  ② `.dsh/skills/` 下三个废弃 Skill 一直躺在仓库里没被注意，直到准备推送、
     逐个审查 42 个跟踪文件时才看到——它们引用的是早已删除的脚本。
  已加 `.gitignore` 规则忽略 `.ai/tasks/SMOKE-*/`。
- 真实任务制品（`.ai/tasks/<TASK-ID>/`）**应当提交**——那是制品链的载体。
  只忽略冒烟测试造的临时任务。

## 目标与边界（最重要，先读）

**目标**：把方法论里*本来就该机器保证*的部分（验证、证据、流程状态）
做成 Harness 里的一等公民。

**不做**：用 Harness 做合规管控。实测已证明客户端控制可被绕过——
用 base64 编码执行 `git push origin main` 就绕过了我写的文本匹配门禁。

> **Harness 决定「Agent 如何工作」，Git/CI/RBAC 决定「工作对不对、能不能上线」。**

发布授权、分支保护、密钥属于后者，**不要试图在插件里实现它们**。

## 交付形态：一个插件 bundle，不是仓库脚本

第一版我错误地做成了「git 仓库 + shell 脚本 + md 约定」，
那不是 DSH 插件，只是一个跑在 DSH 里的外部工具集。已废弃。

正确形态：**npm 包 + `dsh.bundle.patch`**，`dsh plugin add` 即自动挂载。
2026-10-19 起是**一个**包（`packages/sdlc`，源码现为 `@ai-native-sdlc/dsh-sdlc@0.5.0`），
不再是七个包——原因见下一节与 `packages/sdlc/README.md`。
`0.3.0` 起它默认**不生效**：六个机制组件放进一个名为「AI 原生 SDLC」的 Agent
Preset，只有新建会话选择该模式才挂载；只有只读看板 UI 常驻（见「方案 A」一节）。

## 拆分原则：分发按套件合一，执行按机制拆行

DSH 可挂的扩展点只有四个（工具拦截 / 工具与 Skill 注册 / 提示词组装 / 客户端 UI），
与 SDLC 六个阶段**完全不正交**。按阶段拆会让一个制品链跨多个包、
一个拦截点被多个插件注册。

「按机制拆」决定的是**执行单位**；**分发单位**是另一个层次，刻意收敛成一个。
判据是：**边界只能放在真实差异存在的地方。**

| 层次 | 选择 | 为什么 |
|---|---|---|
| 分发单位：npm 包 / bundle / `dsh.profile.bundles` 条目 / tarball / 插件页卡片 | **一个** | 七个组件永远同装同升；制品链（`state.yaml` / `verification.json` / artifacts 语义）是跨组件协议，必须同版本发布 |
| 执行单位：Cordis 插件行 / fiber | **七个** | 每行独立 `inject` / `Config` / fiber：故障域、`fiberPhase` 诊断、行级开关、profile 按 id 覆盖都靠它 |

`packages/sdlc/cordis.patch.yml` 现在是**一条 `insert`、两条宿主行**：
`sdlc-ui`（精确包名，常驻只读看板）+ `preset-sdlc`（`@deepseek-ai/dsh-agent-preset`
声明）。preset 的 `config.plugins` = **DSH standard preset 的完整副本 + 六个机制组
件行**（行 id 仍是 `sdlc-task`、`sdlc-verify`……）。preset 不支持继承/合并，
所以副本必须与 App 同步；见「方案 A」一节。

| 行 id | 行 name | 机制 | 状态 |
|---|---|---|---|
| `sdlc-task` | `@ai-native-sdlc/dsh-sdlc/task` | 任务状态机 + 制品链（state.yaml 在 git） | ✅ 已实现并端到端跑通 |
| `sdlc-artifact` | `@ai-native-sdlc/dsh-sdlc/artifact` | 制品撰写 + 结构检查（只查结构） | ✅ 已实现并端到端跑通 |
| `sdlc-status` | `@ai-native-sdlc/dsh-sdlc/status` | 任务看板（一次盘出所有任务的状态/缺失/裁决） | ✅ 已实现（真实 fs 冒烟） |
| `sdlc-verify` | `@ai-native-sdlc/dsh-sdlc/verify` | 独立验证 + 测试冻结 | ✅ 已实现并端到端验证 |
| `sdlc-workflow` | `@ai-native-sdlc/dsh-sdlc/workflow` | 工作流本身，作为 **Skill** 交付给验证者 | ✅ 已实现（12 条冒烟） |
| `sdlc-rsi` | `@ai-native-sdlc/dsh-sdlc/rsi` | 整个任务的执行证据、提案、改进任务与反馈 | ✅ 0.4.0 已实现；模型指导实验仍为探索用途 |
| `sdlc-ui` | `@ai-native-sdlc/dsh-sdlc`（**精确包名**） | 客户端制品链面板（侧栏图标 + main 面板） | ✅ 已实现并端到端验证（46 条冒烟） |

⚠️ **`sdlc-ui` 行必须写精确包名**，不能写 `.../ui` 子路径：
`@deepseek-ai/dsh-client-modules` 只扫描**精确包名**的 loader 行来发现 `dsh.client`
（`exactPackageSpecifier` 对子路径返回 `undefined`）。写成子路径的后果是浏览器半
**不进 `window.__DSH_BOOT__`**，而 host 端点照常 200——面板不出现、日志无错。
本轮合并真实启动抓到过一次，修法是包根入口重新导出 ui 定义；`smoke/ui.mjs` 加了
4 条回归断言。其余六个组件仍走子路径导出。

**不要**把七行压成「一个插件行 + `ctx.plugin()` 子插件」：那会把唯一真正在
起作用的隔离边界（fiber）压掉，而分发粒度并不因此变化，是纯粹变差。

**顺序上先做 verifier，不是先做 plan**（历史决策，仍然成立）：verifier 输出结构化
PASS/FAIL，是唯一能被严格自动验证的机制；`plan` 输出给人看的 markdown，
很难自动判断好坏。而且手册自己说"Verification 是最值得优先建设的部分"。

### 2026-10-19 合并：为什么是正确的事（证据）

一个包、一个 bundle、一条 `dsh.profile.bundles` 条目、一个 tarball；
七个组件行原样保留。合并前的七包形态实测代价全在分发层：

1. **七份 `peerDependencies`**：0.2.1 升级时七个包被版本门禁一起跳过、静默消失
   （见下面 §0.2.1）。合并后只有一份 peer 范围、一条 compat 检查。
2. **七个 tarball、七条 bundles 条目、七次安装**，还要操心安装顺序。
3. **跨包 import 走不通**（装好之后解析不到）：`sessionCwd` / `requireSessionCwd` /
   `resolveOptions` / `writePolicy` 在 verify/task/artifact/status 里是**四份逐字相同**
   的副本，靠四份"漂移检测"测试盯着；`sdlc-status` 还复制了一份状态机常量，
   再用读源码文本的契约测试盯漂移。合并后 `src/shared/helpers.ts` 一份、
   状态常量直接 import——**同一份代码不可能和自己漂移**。
4. 插件页七张卡暗示七个可独立选择的东西，而它们其实是一套。

**机制成立性先做了探针**（`.probe/repro.sh`，PASS=32，可复跑）：第三方 tgz bundle
的 patch 两行分别指向**自己包的子路径导出**时，真实 `dsh` 启动中两行都激活
（marker 由该次启动进程写出、dump-config 两行 name 逐字正确、
`dsh.profile.bundles` 自动追加、无 `entry did not activate`、行级
`disabled: true` 只关对应一行且可逆）。探针只证明了行级机制与子路径解析，
未外推到 peer/依赖形态。

**真实 tarball 的隔离验证**（`.verify-home`，gitignore，不碰用户 profile）：
模板 profile 先建、再 `plugin add`；bundles 变成
`["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","@ai-native-sdlc/dsh-sdlc"]`；
dump-config 七行；真实启动无激活警告；`__DSH_BOOT__.entries` 含
`{"id":"@ai-native-sdlc/dsh-sdlc","url":"plugins/??…/client.js","inject":["…client-ui-sidebar"]}`；
`GET /api/sdlc-ui.tasks` 200 / 81975 字节（3 个工作区 / 13 个任务；最终复验
86730 字节，因为新增了 BUNDLE-1）。

**desktop profile live 验证**：`dsh plugin --profile desktop add <tgz>` 后
**无需重启**，`plugin_manager list_plugins` 里七行全部 `fiberPhase: active`
（`sdlc-ui` 行 moduleName 是 `@ai-native-sdlc/dsh-sdlc`）；当前会话直接出现了
`sdlc_status` / `sdlc_verify` / `sdlc_artifact_*` 等工具与
`sdlc-verification-discipline` Skill；`sdlc_status` 返回真实任务
（RSI-1，VERIFYING，停滞 4 天）。随后已把旧七个依赖从 profile 移除，
现在 profile 里只有一个 SDLC bundle、一个依赖。

**最终 tarball（52 文件）换入后重新读过一次**：`plugin_manager list_plugins`（19:53:39）里
`include:sdlc-task/artifact/status/verify/workflow/rsi/ui` 七行仍全部
`fiberPhase: active`，`sdlc-ui` 行 moduleName 是精确包名 `@ai-native-sdlc/dsh-sdlc`；
换包只改了 locale/icon 与注释，host 行为不变。另两个旧 profile（headless、
verifytest）里残留的旧包依赖/ bundles 条目也已清掉；仓库根 `node_modules` 的
七个悬空 workspace 链接已随 `npm install` 收敛为只有一个 `dsh-sdlc → packages/sdlc`。

**读数（2026-10-19 全量）**：单测 **210**（lib 202 + UI 客户端 8；合并前 251，
减少的 41 = 3 份重复 helpers.test 副本 36 条 + 1 条漂移检测 + status/contract.test
4 条重复契约）；冒烟 7 个脚本共 **377 条**（artifact 39 / rsi 62 / status 69 /
task 40 / ui 46 / verify 109 / workflow 12）；`npm run compat` 2 个 manifest 通过；
bench 三用例全部成立；activation-check 在隔离 profile 上七行一致 + 26 个发布文件
sha256 全一致；time-travel 5 个时点一致。

**插件页展示元数据要单独修**（独立验证两轮的 minor，已修）：宿主
`dsh-app-boot` 的 `readPluginMeta` 只读包 specifier 下的 `locale/en.json` 与
`icon` 子路径，所以合并后必须在**包根**放套件 locale，并给六个子路径行补
`./*/locale/en.json`、`./*/locale/zh.json`、`./*/icon` 的 exports；多星 pattern
（`./locale/*/*.json`）不解析。图标**逐组件保留**在 `icons/`：task/artifact/
verify/rsi 恢复各自原图标，status/workflow 与套件共用同一枚（与合并前一致）。
workflow/rsi 原先没有 locale 文件（合并前靠精确包名回退读 package.json），
合并后必须补 `locale/<comp>/{en,zh}.json` 才不会让这两行退化为"只有 icon"——
第三轮独立验证正是因此判了 reject，已补并让冒烟对**六个**子路径行都校验。
`smoke/ui.mjs` 的回归断言从"exports 键存在"升级为"target 可解析到真实文件、
且 icon target 必须指向本组件自己的 `icons/<comp>.svg`"——第二轮"所有行退化成
同一套件图标"的回归因此真会红（负向实测 45/46），断言数保持 46；总冒烟 375 → 377。


### 2026-10-19 方案 A：默认不生效，按 Agent Preset 选择（0.3.0）

用户要求："只有在明确指定这个插件的时候，整套 SDLC 才工作。"先检索了官方文档：
DSH **没有**"会话中按需加载插件"的机制；唯一按会话选择的单位是 **Agent Preset**。

- `@deepseek-ai/dsh-agent-preset`：「可同时声明多个 preset，**由会话选择**」
- `@deepseek-ai/dsh-agent-preset-registry`：「通过声明式 preset 选择 Agent 的
  **工具、提示词和技能**」；「每个声明在启动时创建注册表拥有的 scope 和内存
  Loader 树」；「插件注册继承 preset scope，Agent scope 的父链接决定可见性」
- `dsh-skill`：「宿主行…落入全局层，由 agent preset 常驻组合挂载的插件落入该
  **preset 的层**」
- `dsh-client-ui-agent-preset`：新会话选择器/设置页可选自定义 preset；「选择变更
  **只影响之后的任务**，已有插件与提示词保持不变」

**方案 A 的形态**（`packages/sdlc/cordis.patch.yml`）：

```
宿主行 ① sdlc-ui        name=@ai-native-sdlc/dsh-sdlc（精确包名，常驻只读看板）
宿主行 ② preset-sdlc    name=@deepseek-ai/dsh-agent-preset，id=sdlc
preset 内               standard preset 完整副本（22 行）+ 六个机制组件
```

- **六个机制组件不在宿主层**：标准模式会话没有 `sdlc_*` 工具、没有 SDLC 提示词段、
  Skill 目录里也没有那两条 Skill；新建会话选「AI 原生 SDLC」才有。已有会话保留
  创建时的组合（官方语义），所以当前会话在迁移后失去这些工具是**预期行为**。
- **UI 必须留在宿主层**：`dsh-client-modules` 只扫描宿主 Loader 里精确包名的行；
  preset 的行在内存 Loader 树里（`Config.listConfigs` 也只遍历 profile Loader 树，
  官方 README 明说）。把 UI 搬进 preset → 面板静默消失。方案 A 接受"只读面板常驻"。
- **preset 里必须带 standard 副本**：preset 不继承、不合并（官方：覆盖替换完整
  子插件列表）。第一版只放六行 → 选该模式的会话没有 read/bash/write/skill，
  实测 `toolsTokens` 3265（standard 6902）。修正后 = standard 22 行 + 6 行。
  代价是复制了一份内置列表，App 升级会漂移：新增
  `tools/preset-sync-check.mjs`（读真实 App 的 `dsh-web-app/presets/standard.patch.yml`
  逐行对账，`--write` 同步）；**升级 App 后必跑**（`npm run preset-sync`）。

**真实运行读数**（隔离 profile；可复跑命令见
`.ai/tasks/PRESET-1/evidence/runtime-verification.md`）：

```
--dump-config           宿主 2 行；preset 子行 28（22 standard + 6 本套件）
启动                    0 条 entry did not activate；boot entry rev=ca10afcab19f
GET /api/sdlc-ui.tasks  200（字节数随 .ai/tasks 数据变化：写入时 89760，复验时 90350）
agentPresets/list       sdlc 存在、broken 缺失（可组合）
agentPresets/read sdlc  末尾六行 = 本套件组件
session/create          指定 sdlc → agentPreset=sdlc；默认 → standard
session/projections     sdlc 会话 toolsTokens 10072 > standard 6902
会话日志 request/header sdlc 会话 44 个工具（31 standard + 13 个 sdlc_*）；
                        standard 会话 31 个工具、0 个 sdlc_*
```

**直接的模型可见读数**：会话日志（`session.v4.jsonl.zstd`）里的 `request/header`
记录模型实际收到的工具 schema。独立验证者与我各自读到：sdlc 会话 44 个工具 =
standard 的 31 个 + 恰好 13 个 `sdlc_*`（task_create/status/advance、artifact_write/
check、verify/fix_start/fix_end、status、rsi_runs/analyze/experiment/feedback），
standard 会话 31 个、`sdlc_*` 为 0；两条 SDLC Skill 也只在 sdlc 会话的 `skills/list`。
这比 `toolsTokens` 强，已不依赖"只看 token 数"的间接推断。

⚠️ 仍未做的只有 **GUI 层人工确认**（在新建会话选择器里真的点选「AI 原生 SDLC」并
看到工具列表/面板渲染）；协议层与日志层的集合证据已拿到。

**desktop profile 已迁移（2026-10-19 21:49:24 到 0.3.0；22:04:54 更新到 0.3.1）**：
依赖只剩 `@ai-native-sdlc/dsh-sdlc@0.3.1`（file tgz），已安装 patch sha256 前 16 位
`85f7410f1f855681` 与仓库一致；`plugin_manager list_plugins` 里
`include:sdlc-ui` 与 `include:preset-sdlc` 都是 `fiberPhase: active`，而
`include:sdlc-task/artifact/status/verify/workflow/rsi` 六条宿主行**不再存在**。
当前会话（迁移前创建、组合固定）的 Host `Tool` provider 已看不到 `sdlc_*`，
Skill 目录里也没有两条 SDLC Skill——这正是"已有会话保留原组合 + 全局行卸载"的
预期表现，不是故障。**新建会话选「AI 原生 SDLC」模式即可使用整套工具。**

0.3.1 修复了用户实测截图发现的「为什么还有一个 SDLC Verifier」：验证者 preset
不再常驻注册，只在 `sdlc_verify` 运行期间临时存在。隔离 profile 重启后
`agentPresets/list` = `[standard, ptc, minimal, cordis, sdlc]`（无 `sdlc-verifier`），
boot rev `c538c0d0075f`、API 200/91661、0 条激活警告；verify 冒烟 111/111。

**工具与读数**：单测 210 不变（`src/` 组件代码未改）；冒烟新增
`smoke/preset.mjs` 19 条、verify 冒烟 +2 条（验证者 preset 懒注册/归还）
→ **8 个脚本共 398 条**；负向实测：组件放回宿主行（17/19）、
改坏 standard 副本（sync exit 1，含 isolate 字段）、改名 `tool-web`（18/19）都会红。
`plugin-activation-check` 改为只 import 本套件的行（第一版把 standard 副本行也拿
本包 exports 解析，全部误报"解析失败"——`!!js` 标签也让默认 js-yaml 直接抛，
两处都要自定义处理）。

### 2026-10-29 循环工作台：验证与修复按真实记录展示

用户选中第二张深色循环工作台。实现保留七阶段、四节点循环和右侧证据，新增独立只读
`/api/sdlc-ui.execution`，按登记的运行 ID 展示轮次，按成功工具结果与 history 展示修复。
重试不是新一轮，reject 不是修复，缺 finished 不是正在运行；历史证据不能打开最新文件冒充。
改动说明来自调用方，发现与修复无明确对应键就说明缺口。原始参数、输出、配置与隐藏推理不返回 UI。

顺手修掉了旧的工作区身份问题：显式 root 下无任务时必须 404，不能借用其他工作区的同名任务。
读取工作区列表尊重 `DSH_HOME`，隔离 profile 不再读日常 profile 的列表。

最终全量：库 227 + UI 18 = **245** 单测、宿主接口 **32**、九组冒烟 **437**，compat
支持当前 **0.2.1-rc.3**，preset-sync **22 + 6**。真实 Chrome 用同一客户端源码和明确
标注的本地夹具检查布局/交互，1421px、1120px 各 18 项通过。设计对照见根目录
`design-qa.md`，复跑与限制见 `docs/design/sdlc-dashboard-2026-10-28/implementation.md`。

**未完成真实 DSH 页面验收**：初始包已安装隔离 profile 且可启动；用户拒绝浏览器认证
访问后没有重试，改用不连接 DSH 的本地组件预览。最终界面又有视觉修正，不能把初始
启动说成最终实机验收。日常 desktop profile 未升级。远端推送此前也被拒绝，只保留本地提交。

### 2026-10-30 阶段交付物恢复，desktop 已安装修正版

用户反馈改版后看不到阶段交付物。接口仍返回文件名与章节，客户端却把它们压成底部
小链接；阶段详情又只取单个文件。现在阶段条直接展示登记文件，顶部有完整清单，
详情与底部卡片显示章节摘要。两处共用阶段关联：验证包含裁决和 proof，实现明确把
plan 标为「实现依据」，完成阶段汇总全部；自定义交付物保留在完整清单中。
文件弹窗关闭后返回原阶段，未登记的阶段如实显示空状态；当前文件与历史轮次证据分开。

新增三项交互回归在旧代码全部失败，修复后通过。全量：库 227 + UI 21 = **248**，
宿主接口 **32**，冒烟 **437**；compat 与 preset-sync 通过。真实 Chrome 本地夹具
在 1421px、390px 各 **29** 项交互通过，含弹窗焦点、刷新后没有重复交付物区；
没有脚本错误。该读数仍不替代真实 DSH 页面验收。

修正版包 `ai-native-sdlc-dsh-sdlc-0.4.0-deliverables-dae2636cbe51.tgz` 先装隔离
profile，再装日常 desktop；33 个发布 JS 与 patch 核对一致。安装前备份位于
`~/.dsh/backups/sdlc-deliverables-2026-10-30T02-49-04-049Z/`，仅 SDLC 引用变化。
**未替用户退出 DSH；需完全退出再打开加载新模块，当前进程是否已加载尚未确认。**
沿用此前拒绝远端推送的要求，只保存本地提交。

### 2026-10-31 阶段流转成为看板主视图

用户需要看清评审或验收退到哪里、为什么退、怎么修改、后来去了哪里。根因是旧主图
固定画验证修复四节点，完整 `history` 却只藏在弹窗里。现在直接用任务迁移记录画
每次真实退回的来源和目标，选中后串起连续的后续路线、每次流转说明及重新提交。
例如 `REVIEWING → SPEC` 和 `VERIFYING → PLANNED` 会画出不同路线，不默认退回实现。
完整推进/退回记录可筛选；七阶段交付物入口保留；原逐轮验证视图折叠到「验证详情」。

重新进入原阶段只代表重新提交，不代表通过。修复和验证提交按连续路线的时间范围展示，
注明改动说明来自提交者、没有逐条问题与修改的明确对应键。路线断开、当前状态不符或
时间异常时不拼接证据；只有当前裁决的旧任务不伪造历史。刷新保留手动选择，记录消失
明确提示。宿主 API、状态机和依赖均未改变。

库 227 + UI 27 = **254** 单测、宿主接口 **32**、九组冒烟 **437** 通过；最后调整
修改记录的时间顺序后重建并复跑 UI 27 项。compat 已按自动升级后的 **0.2.1-rc.5**
核对，preset-sync **22 + 6** 一致。真实 Chrome 本地夹具在 1421、1120、390px 各
**40** 项交互通过；深浅主题截图已查看，控制台无错误/警告。仍未访问真实 DSH 页面。

包 `ai-native-sdlc-dsh-sdlc-0.4.0-flow-46e802f88e84.tgz`（60 文件）已先装隔离 profile，
再装日常 desktop；33 个发布 JS 与 patch 对账一致。其他依赖、bundles、profile patch
和非 SDLC 锁文件条目不变。备份在 `~/.dsh/backups/sdlc-stage-flow-2026-10-31T01-56-42-126Z/`。
没有替用户退出 DSH，当前进程是否加载新版仍待重启确认；沿用此前拒绝远端推送的要求，
只做本地提交。复跑与范围见 `docs/design/sdlc-dashboard-2026-10-28/implementation.md`。

### 2026-10-31 问题处理与独立复验成为任务事实（0.5.0）

历史 DEMO-22149 / 23846 / 23882 共 10 轮证实三个缺陷：问题没有逐项处理与退回关系；
裁决漏项仍保留 approve、阶段准入只查文件；16 MiB 写入与 4 MiB 读取不匹配造成过程丢失。
真实任务未发现最终 reject 却已完成；这种放行可能由真实工具夹具证明，不冒充历史事故。

- `sdlc_task_issue` 登记审核发现、退回、作者提交和延期；阻断问题不能延期，作者不能自行关闭。
  退回与问题动作同写。完成后报告新问题会重开审核。旧裁决首次重试时归档并保留问题。
- 验收标准按稳定 ID 对账；每项提交的问题要有独立结果。重复失败保留原问题编号，
  “已解决”与对应标准未通过相矛盾时不能关闭。缺项、未知/重复 ID 均不能 approve。
- 每轮裁决、标准与代码/intent/spec/plan 内容版本持久化；阶段准入重查，单纯 Git 提交不误伤。
  直接 verify 也检查处理状态。改代码/制品/标准后必须有相应退回；取消后的迟到结果不能覆盖。
  task/artifact/verify 共用状态写锁与 fs 版本检查，避免登记制品时丢掉流程记录。
- 看板按问题显示原因、去向、修改证据与独立复验，每页 20 项。新会话另写小摘要；旧会话
  有界回读，只恢复有归属证据的轮次与操作，不补造过去没登记的退回。

证据在 `.ai/tasks/FLOW-1/`。全量：库 242 + 客户端 30 = 272，宿主接口 32，10 组冒烟
455；测试场 21；5 个双侧基准均成立（FLOW-1 旧版违反 9 项、新版 0）；桌面/手机本地夹具
各 45 项交互通过。compat 接受当前 App 0.2.1-rc.5，preset 22 + 6 行一致。

最终包 `ai-native-sdlc-dsh-sdlc-0.5.0-flow-a5aaac074538.tgz` 已装隔离和 desktop；40 个发布
JS 与 patch 均一致。未退出用户 DSH，需完全退出再打开，新建 SDLC 会话；当前进程加载版本
未确认。未重试用户拒绝的 DSH 浏览器认证。本轮模型结果为确定性夹具，未取得 FLOW-1 的
独立模型裁决，所以任务保留 VERIFYING，不伪造 approve。

### 2026-11-01 验证与评审交付物可以直接阅读

DEMO-23998 的 `verifications/<run-id>.json` 已由验证器登记，但 UI 打开接口仍只允许
顶层文件名，导致点击时报 `file 不合法`。列表和打开现共用读取：允许任务内子目录，
继续核对登记表与解析后的路径范围。旧接口截取前 200,000 字符会截坏完整 JSON，现改为
上限内返回全文，超过 16 MiB 明确报错。标准正文按写入方的稳定 ID 对应，不按结果顺序猜。

验证与评审默认显示阅读报告，原始 JSON 按需展开。结论、逐条依据、发现与建议、问题复验、
未验证事项和评审风险保留；评审兼容未知字段，没有评审结论不借用验证通过。

库 242 + 客户端 35 = **277**，宿主 **51**，十组冒烟 **459**，隔离测试场 **21**；
compat 与 preset-sync 通过。新增检查在旧宿主失败 10 项、旧客户端失败 5 项；新版均通过。
真实 Chrome 本地示例在 1421px 深色、390px 浅色共 **39** 项通过，无错误/警告。
已安装模块配真实 DSH LocalFileSystem 读取截图对应的两份文件，均 200 且正文一致。

包 `ai-native-sdlc-dsh-sdlc-0.5.0-reports-f47c1e3a16f3.tgz` 已装隔离与 desktop；
40 个发布 JS 与 patch 对账一致。其他 profile 配置、依赖与非 SDLC 锁文件条目未变。
备份在 `~/.dsh/backups/sdlc-readable-reports-2026-11-01T11-46-12+0800/`。
没有退出用户 DSH，运行进程版本未确认；未重试 DSH 浏览器认证，未推送远端。
证据见 `.ai/tasks/ARTIFACT-READ-1/`，无独立模型裁决，任务保留 VERIFYING。

### 2026-10-22 RSI 0.4.0：从真实任务记录到插件改进

目标是用真实任务的执行过程改进本插件。来源 `DEMO-22149` 六次验证都有裁决，
但旧 RSI 六份记录的实际配置与工具结果均为零，代码快照不完整，分析却没有提示缺口。
根因是作者与验证者分属兄弟 preset，普通监听器看不到验证者；工作目录又是多仓库父目录。
任务完成与证据完整必须分别判断，不能用五次 reject 本身推断插件有缺陷。

- 只观察明确登记的会话，用 `sessionQuery` 补漏并对账；缺失、截断、失败会影响记录健康状态。
- 任务操作独立记录调用、归属、切换边界和实际执行版本，再写任务索引。重启、旧索引写失败、
  跨版本仅写制品都要覆盖；不能只测各自成功的情况。阶段快照与 state/history 逐项核对。
- 代码按工作区内仓库采样，指纹排除任务/RSI 记录；提交记录不算代码变化。链接、submodule、
  超限和取样漂移明确报不完整。历史起点未知就保留 null，不填当前采集器版本。
- `tasks/analyze/propose/improve/feedback` 连接真实任务、带引用的假设、普通开发任务、
  两版对照和后续真实任务。引用固定当时内容；采用时核对同一提案和已完成开发任务。
  诊断与报告注明来自调用方，哈希只检查内容一致，不代表原因已独立成立。
- 看板显示执行记录完整性和待复盘状态；原始 `.ai/rsi` 仍忽略，只提交经过检查的摘要。

证据在 `.ai/tasks/RSI-2/`，用法见 `packages/sdlc/RSI.md`。全量通过：单测 222
（lib 213 + UI 9）、看板宿主 26、九个冒烟脚本 437；四个版本对照均成立，RSI 对照
旧版失败 4 项、新版失败 0 项；compat 两包、preset-sync 22 + 6 行、隔离测试场 21 条通过。
独立审查提出的问题已修复并复查。最终 tarball 58 文件；安装后 32 个发布 JS 与 patch
对账一致，隔离启动无激活警告，看板 API 200。**本轮只安装隔离 profile，没有升级用户
desktop profile**。确定性模型夹具证明记录机制，不证明模型质量或真实任务耗时普遍改善。
真实 Chrome 已查看新增记录区并展开缺口：DONE 夹具仍显示证据不完整，旧任务显示尚未确认；
截图在 `output/playwright/rsi2-record-health.png`。这不替代更广泛的 GUI 验收。

### 2026-10-23 desktop 已安装 0.4.0，待重启后的运行确认

用户要求现在在日常 DSH 中使用 RSI，已把上节验证过的同一份 tarball 安装进
`~/.dsh/profiles/desktop`。安装前备份 package.json 和 pnpm-lock.yaml；只升级
SDLC，其他依赖与 bundles 列表不变。安装文件为
`packages/sdlc/ai-native-sdlc-dsh-sdlc-0.4.0-351bb4307ae0.tgz`（gitignore），
避免日常 profile 引用可随时清理的隔离环境目录。

compat 两包与 preset-sync 22 + 6 行通过；安装后 32 个发布 JS 与 patch 均与
已验证构建一致。证据在 `.ai/tasks/RSI-2/evidence/desktop-installation.json`。
**没有替用户退出 DSH，尚未确认当前进程已加载新版**。使用前完全退出再打开，
在业务工作区新建会话并选「AI 原生 SDLC」。正常创建和执行任务会自动记录；
DONE 后仍须让 Agent 继续调用 `sdlc_rsi_analyze` 复盘，不能把提醒当成后台自动改进。

### RSI 首版（2026-10-15，历史记录）

实现与实测证据见 `.ai/tasks/RSI-1/`，用法见 `packages/sdlc/RSI.md`。

- `sdlc-verify/record` 是 awaited 事件，按 run_id 记录 started/prepared/attempts/finished；异常、取消与无裁决均留下记录。原任务最新裁决与完整运行历史分开。
- `sdlc-rsi` 保存代码与制品快照、实际 request 配置、有界会话 trace，提供 runs/analyze/experiment/feedback 四个工具与改进方法 Skill。
- 实验真实调用验证器，首版只改变附加指导。结束时也要核对制品；用 call_id 关联异常，不能猜“最近一次”；同次请求配置变化不得靠集合去重掩盖。
- **更快失败不算改善。参考答案不在 prompt 里也不代表隔离。** 同一文件系统可读协议答案，当前运行时必须保留限制并禁止推荐候选。只有隔离执行环境解决盲评后才能放开正向建议。
- 本次实测：RSI 单测 38、真实运行时冒烟 62；verify 单测 48、冒烟 106。真实模型已返回 reject 并记录完整输入/配置/trace，详见 proof；确定性冒烟不等于模型效果提升。
- 原始 `.ai/rsi/` 默认忽略，因其含完整输入、代码与工具输出且无通用脱敏。核对后的真实任务结论仍应提交。
- **重复安装同路径同版本 tarball 可能复用旧文件**：本次 pnpm 报 Already up to date，安装文件却未含最后修复。换带内容哈希的 tarball 路径后才更新；应对比安装文件与构建文件，不以安装成功作版本证明。

### `sdlc-workflow`：为什么它算机制，而不只是一份规范

另外四个插件管住了「东西**在不在**」（`sdlc_task_advance` 缺制品就拒绝），
管不住「东西**有用没用**」。实测的代价：作者写的判据**看着专业、其实无法证伪**
（夹具小到让断言恒真），而四处结构检查全绿。

根因是**没有地方写"什么叫写得好"**。补上的做法不是写一份给作者看的规范
——本项目实测过：**建议性控制没有约束力**。而是把它写成**给验证者的判据清单**，
由验证者拿去质问作者。**作者忽略不了，因为质问发生在验证环节。**

清单里七条全部是实测踩出来的（每条都注明出处），不是手册复述。

**Skill 的注册接口（实测确认，别再怀疑它不存在）**：

  · `dsh-base` 的 patch 里挂了 `@deepseek-ai/dsh-skill` 与 `dsh-skill-filesystem`
    （本机 App 现为 `0.2.1-rc.2`；曾观察到 `0.1.5-rc.3` 的旧 runtime，但 `register()` 签名一致）
  · 插件侧接口：**`ctx.effect(() => ctx.skills.register({...}))`**
    · `SkillRegistration` 需要 `name` / `description` / `content` / **`source`**
      （漏 `source` 会被 tsc 拒；我用 `'bundled'`）
    · **返回值是 disposer，必须交给 `ctx.effect()` 托管**——
      丢掉它 = 卸载时 Skill 不归还，留下指向已卸载插件的悬空注册
      （冒烟的"归还"断言抓到了这一条）
  · 卸载入口是 **`ctx.fiber.dispose()`**，不是 `ctx.dispose()`（后者不存在）
  · 类型解析：`@deepseek-ai/dsh-skill` 要装进**仓库根的 node_modules**
    （其他四个包的类型都从那里来，packages 下没有各自的 node_modules）

**「验证者能加载它」只能靠外部观测证明**（实测拿到过证据）：

验证者**自己无法证明**"我能加载那份 Skill"。唯一决定性的观测点是
**它的会话日志里有没有 `skill` 工具调用、以及返回体是不是完整正文**。

实测（`dd7bc77e`）：`{ bash: 86, read: 12, skill: 1 }`，那次调用的返回是完整的
`<skill_content name="sdlc-verification-discipline">` + 七条正文。
**这条链通了——`sdlc-workflow` 不是装饰。**

⚠️ 另外记：那次验证**没产出裁决**（`stop_reason=error`，99 次工具调用后）。
这是该失败模式的**第二次**（第一次是 STATUS-PAGE 第 1 轮）。
教训与第一次相同：**判据别贪多，尤其是"核对源码/说明为什么"这类元问题**——
它们会显著抬高探索成本。实测跑得完的量级是 **4-6 条**，且不要塞元问题。

## 目录

```
packages/sdlc/              # 唯一的插件包（一个 bundle：两条宿主行 + preset 声明）
  package.json              #   dsh.bundle.patch + dsh.client + exports 子路径
  cordis.patch.yml          #   一条 insert、两条宿主行 + preset（standard 副本 + 六组件）
  src/index.ts              #   包根：重新导出 ui 组件（客户端半被发现的前提）
  src/task/                 #   任务状态机 + 制品链（state.ts 纯函数可脱离 DSH 单测）
  src/artifact/             #   制品撰写 + 结构检查（只查结构，不查质量）
  src/status/               #   任务看板（scan.ts 纯函数；坏任务不拖垮全局）
  src/verify/               #   独立验证 + 测试冻结（verdict / test-freeze / preset）
  src/workflow/             #   工作流 Skill
  src/rsi/                  #   真实验证记录、复盘、指导文字对照实验
  src/ui/                   #   客户端面板（index.ts host 半 + 手写 client.js）
  src/shared/helpers.ts     #   四个组件共用的沙箱/cwd 辅助函数（合并前是四份副本）
  smoke/<组件>.mjs          #   每个组件一个运行时冒烟 + preset.mjs（patch 形状）
  test/                     #   UI 的纯 Node 行为测试
packages/sdlc/README.md     #   包总览（分发/执行两层、行表、安装）
packages/sdlc/TASK.md       #   任务状态机文档（原 sdlc-task/README.md）
packages/sdlc/RSI.md        #   RSI 文档（原 sdlc-rsi/README.md）
docs/                       # DSH 契约与调研（改代码前必查）
tools/                      # bench / mutation / activation / time-travel / compat / preset-sync
handbook/                   # 手册原文，只读
```

## 工程约定

### 写插件必守（每条都踩过，全是"警告后继续"的静默失败）

0. 🔴 **绝不要把 `@deepseek-ai/dsh-*` 写进 `dependencies`。**
   只写 `peerDependencies` + `devDependencies`。写进 dependencies 会让 profile
   装**第二份** `dsh-tools`，而 `dsh-agent-loop` 用一个**模块内 Symbol** 查表
   （`ctx.tools[TOOL_RUNTIME_SCHEDULER]`）——两份模块 = 两个 Symbol 值 = 查不到
   = **每一次工具调用都失败**，会话彻底不可用。
   加载时完全正常，只在工具调用时爆发，且移除插件也未必能恢复。
   详见 `docs/dsh-plugin-contracts.md` §0.5。
1. **`inject` 列出每一个访问到的服务**。少一个就抛
   `cannot get property "X" without inject`，插件不激活但 app 照常启动。
2. **`Config` 必须是 Standard Schema 校验器**（schemastery 或 zod），
   不能是普通对象——Cordis 会调 `Config['~standard'].validate`。
3. **`files` 用 `lib/**/*.js`**，不是 `lib/index.js`（后者只匹配单文件）。
   打包后**核对文件数**。
4. **不要用 default export**——会隐藏 loader 元数据（有正式 postmortem）。
5. **不要留未 await 的 promise**。游离的 promise 拒绝或同步回调抛错会
   **销毁整个 app**，与是哪个插件无关。

### 0.2.1 兼容性（2026-10-19 实测，别再踩）

> 下面几条是**合并前**七包形态的读数（保留因为它是合并理由之一）：
> 当时七个独立包各自钉 peer，一次 App 升级让七个一起静默消失。
> 合并后只有一份 peer 范围（见上文「2026-10-19 合并」）。

- App 在 2026-10-17 自动从 `0.2.0-rc.2` 升到 `0.2.1-rc.2`。七个插件的
  peer 都钉着精确的 `0.2.0-rc.2`，被插件管理器判为 `incompatible-version`，
  启动时 bundle 被 **skip**——**App 照常启动，插件全部静默消失**。
  症状是工具和侧栏一起没了，日志只有一行 warning。
- 修法：peer 改成 `^0.2.1-rc.2`。DSH 的判定是
  `semver.satisfies(runtime, range, { includePrerelease: true })`；
  精确旧版本不接受新版本。**不要钉死精确版本**——App 自动升级，仓库不会。
- 新门禁：`npm run compat` 读**本机真实 App** 的 `dsh/package.json`，
  逐包验证 peer 范围。改 peer 或升级 App 后都要跑。
- 0.2.1 子代理 API：`ctx.subagents.start()` **已删除**，改用
  `startActivation(spec)`；`SubagentRun`/`run.id` → `SubagentActivation`/`run.childId`；
  `label`/`signal` 移到 spec 外层，并新增 `delivery: 'caller'`。
- 0.2.1 从 `SubagentStartRequest` 删除了 `persona` / `toolFilter`；官方
  `dsh-tool-subagent` 传这两个配置会直接抛。迁移为 **Agent Preset**：
  `ctx.agentPresets.register({id, plugins})` + request 带 `agentPreset`。
  见 `packages/sdlc/src/verify/preset.ts`。
- ⚠️ **preset 不会自动隔离宿主全局工具。** 只挂 preset 时，真实验证者的
  工具面里仍有 `sdlc_task_create` / `sdlc_fix_end` / `sdlc_verify`——它能解冻
  测试、推进任务。必须在 preset 里放一行
  `ctx.tools.restrict({ deny: <运行时枚举的全部 global> })`。
  `allow` 清单不行：preset 自己的 `read`/`grep`/`bash` 是 scope 注册，
  不在 global 层，会被判 `unknown global tool`。
- `agentPresets` 是**可选服务**（web/desktop 有，headless 没有）。不要写进
  `inject`（会停 pending），用 `ctx.get('agentPresets')`；缺失时
  `sdlc_verify` **fail closed**，不降级成继承全部工具的子代理。
- 真实读数（隔离 profile，不碰用户 App）：
  · `dsh web` 启动无 `entry did not activate`；
  · `__DSH_BOOT__` 里有 `@ai-native-sdlc/dsh-sdlc-ui`；
  · `GET /api/sdlc-ui.tasks` 200，聚合 3 个工作区 / 13 个任务；
  · 真实验证者工具面：`bash glob grep read read_image skill structured_output`
    （无 write/edit、无 `sdlc_*`、无 subagent）；
  · 无模型凭据时 `sdlc_verify` 仍走完 2 次派发并返回 `needs_human`，未崩。
- （合并前七包形态的 live 读数）**装进 desktop profile 后实测**：当前会话
  **无需重启**就出现了
  `sdlc_status` / `sdlc_verify` / `sdlc_task_*` 等工具，Skill 目录出现
  `sdlc-verification-discipline`；`sdlc_status` 直接返回了真实任务
  （RSI-1，VERIFYING，停滞 4 天）。这是“插件真的挂上了”的最直接读数。
  合并后的同一读数见上文「2026-10-19 合并」。
- ⚠️ **`dsh plugin add` 会不会写 `dsh.profile.bundles`，取决于版本/安装形态**：
  旧记录说"只装包不写 bundles"；2026-10-19 在 `0.2.1-rc.2` + `npm pack` tgz 上
  **两次复测都自动追加**了（详见 `docs/dsh-pitfalls.md` §2.1）。**不要再用绝对句**，
  装完读 profile 的 `package.json` 核对；没出现就手补。
  另：`plugin add` 用的是 App 自带 pnpm，**不要求 PATH 上有 pnpm**（同节 §2.2）。
- **（合并前的历史 live 读数，2026-10-19 17:31）**：
  · `sdlc_status` 不再把 RSI-1 的 `evidence/*.json` 报成“文件不在”
    （status 0.1.2 生效），只报停滞与缺 verification；
  · **真实调用 `sdlc_verify` 成功**：返回完整结构化 `needs_human`
    （`criteria_results` 1 条 `cannot_tell` + 2 条 finding，
    `verification_complete: true`）；运行记录
    `.ai/rsi/runs/3d764861-…/000005.json` 是 `finished`/`outcome: completed`。
    验证者那 2 条 finding 说的是“它看不到自己这次调用结束后的返回”——
    这正是本项目“独立验证测不了自己这次调用的产物”的纪律，不是插件失败。
    这条比“工具出现在列表里”更强：preset + 派发 + 记录 + 裁决整条链都通了。

### 验证纪律

**跑 `npm run verify`（= build + test + smoke），不要只看其中一项。**

**核对单测数字时用 `grep -E "^[#ℹ] (pass|fail)"`，不要写 `^#`。**
这个 Node 版本的 `node --test` 用 `ℹ` 前缀，写 `^#` 会零匹配、退出码 1——
看起来像"测试失败"，其实只是 grep 没匹配到（实测：我写错过一次，
被独立验证者纠正）。

**独立验证测不了自己这次调用的产物。** 让验证者确认"这次调用会写出的文件"
必然得到 reject（它只能在调用期间观察）。要么验证**调用前**已存在的东西，
要么另起一次调用验证产物。详见 pitfalls §11.2。

**「优化之后效果如何」现在有了第一个能证伪的读数**（2026-10-15 起，
`node tools/bench/run.mjs`）。这件事**比它看起来重要**，因为
不这么做的默认结局是"为修复写的断言向修复方案归一化、变成恒真"——
本项目实测发生过一次（STATUS-PAGE 第三轮，验证者发现新加的冒烟夹具只有
10 个任务，而 ≤50 时两种实现返回完全一样，**那条断言在被修好的代码和被
reject 的代码上都是绿的**）。

基准的形态是**两侧对照**，缺任何一侧都不算用例：

    基线版（有缺陷）  应当违反判据      ← 没有这一侧，用例是恒真断言
    当前版（已修复）  应当满足判据

判据**要从当时的制品搬**，不要现编。第一条用例的判据来自 intent 的
「不改变默认行为」与 spec R1 的「向后兼容（逐字）」——而 `60825a2` 自己就违反了 R1。
详见 `tools/bench/README.md`。

⚠️ **用例的真实来源是"修过的 bug"，不是"做过的任务"。** 历史上只有 3 条任务制品
（E2E-1 / STATUS-PAGE / WF-1，在 `f412a67` 被删，git 历史里可取回），撑不起基准。
而每个 bug 天然自带完整的一对：坏的那版在父提交里，好的那版在修复提交里。

### ⚠️ 验证者产出不了裁决：**生成期失败**，重试是有效处置

不是步数耗尽（那是"够用"的 60 步里正好用满的），也不是判据难。
实测（`4ef6fa76`，2026-10-15）：

    72 次工具调用 / 60 步 / 421 秒
    turn/end: MALFORMED_RESPONSE "DeepSeek Messages stream: tool input is invalid JSON"
    structured_output 的调用次数：**0**

验证者当时**已经把活干完了**——它自造混匀夹具、从 `HEAD~1` 编译旧代码做新旧
对比、造变异体验证自己的断言不是空的、找到了那条 blocking。它最后一条 reasoning
写着「I have everything. Let me now write the structured output.」——
**然后那个工具调用的参数流就没能生成出来。**

**已排除的三个原因**（都实测过，别再拿它们当解释）：

| 嫌疑 | 实测 |
|---|---|
| 上下文被探索撑满 | ❌ `contextWindow = 1,000,000` token；整轮累计约 40 万**字符**，远没满 |
| 判据太长把入参撑大 | ❌ 量过：5 条判据的 prompt 只有 **1866 字符**。那次 18k 的 user message 是**内部提示词注入**，与判据无关 |
| 步数预算不够 | ❌ 60 步是上限，但它在第 60 步是**有话要说**（要写裁决），不是没查完 |

**对照实验**（同一份代码、同一条 lead）：判据 5 条 → 无裁决；判据 **2 条** →
完整 `reject` + 6 条 finding。所以**裁决的体积/复杂度有影响**，但它不是唯一变量——
这只是一次对照，不是受控实验。

**处置（已实现）**：`verifierRetryOnMalformed`（默认开）——
结构化裁决没拿到时**原样重派一次**，prompt 追加"把裁决写小"的指令。
理由：一次生成失败不值得扔掉 421 秒的调查；重试不改变任何安全性质
（同一个只读、独立上下文的验证者，只是多给一次机会）。
两次都没拿到 → `needs_human` + 把 `diagnostic` 带出来，**绝不解析自由文本去猜**。

同时砍掉**最容易写崩的那部分**：`criteria_results[].criterion` 从"必填 +
逐字回抄"改成**可选**（省略即按序号对齐）。防篡改保证没丢——给了就必须
逐字相等，否则算漏报；漏报是**逐条比对**出来的，不是只数条数
（中间空一格、两条标准报成同一条，都能查出来）。

### ✅ 端到端读数（2026-10-15，两个会话对照）

同一份基线代码、**同样 5 条判据**、同一个 lead，唯一变量是插件版本：

| | 修复前 `4ef6fa76` | 修复后 `f9d427dc` |
|---|---|---|
| 步数 | 60（撞顶） | 60（**也撞顶**） |
| 工具调用 | 72（bash 67 / read 5） | 87（bash 84 / read 2） |
| `structured_output` 调用 | **0** | **1（成功）** |
| `turn/end` | `MALFORMED_RESPONSE` | **`completed`** |
| 结果 | needs_human，**无裁决** | **reject + 8 条 finding** |

⚠️ **注意：没有走重试。** `verifier_attempts` 没出现 = 只派发了一次。
所以这一次的成功来自**裁决体积变小**，不是重试兜住的：

    修复前：估计约 14k 字符（5 条判据逐字回抄 + 散文式证据）
    修复后：实测 **7864 字符**

**重试是保险，体积才是疗效。** 两者都留着——重试在体积仍然写崩时有用。

**闭环**：这个 `reject` 是对的——`tools/bench/run.mjs` 独立证明
基线版确实违反 4 条判据。验证者与基准在同一件事上互相印证。

⚠️ **两个变量的区分是诚实的推断，不是受控实验**：同时改了两样
（`criterion` 变可选 + 提示词要求证据精简），所以"是哪一个起的作用"没有分离。
可以说的是：**同样 5 条判据、同样撞 60 步，修复前写不出来、修复后写出来了。**


### 基准至少三维一起测，只测一维会优化出更糟的系统

    抓住率  坏改动被拦        （只优化这一维，会优化出一个再也出不了裁决的验证者）
    误伤率  好改动被误判      （比抓住率更重要——误伤会让人绕开门禁走）
    完成率  验证者是否产出裁决

`verifier_sessions` / `verifier_attempts` 会如实报出"派发了几次"，
**不把"重试过"抹掉**——那正是完成率要看的。

### 基准：三个用例，已固化成一套（2026-10-15）

    node tools/bench/run.mjs
    ✅ 成立  STATUS-PAGE-1    基线违反 4 条 / 修复版违反 0 条
    ✅ 成立  FALSE-ALARM-1    基线违反 2 条 / 修复版违反 0 条
    ✅ 成立  PWSH-1           基线违反 4 条 / 修复版违反 0 条

| 用例 | 基线 → 修复 | 在测什么 |
|---|---|---|
| `STATUS-PAGE-1` | `60825a2` → `HEAD` | 看板默认页丢了"该动手的"任务 |
| `FALSE-ALARM-1` | `671a683` → `ddc4241` | 已 `approve` 的 REVIEWING 被报成"在等人" |
| `PWSH-1` | `896d569` → `52212ad` | 工具白名单没按平台选 |

`FALSE-ALARM-1` 的价值在于它测的是**误伤**（多报假求助信号），不是漏检。
本项目反复记过"门禁的误伤和漏检一样是缺陷——误伤会让人绕开门禁走"。

### ⚠️ 更正：「win32 没测过」这条**不成立**，而且障碍不是我原来以为的那个

先前这里写着"`52212ad` 的 win32 侧一次都没跑过（本机 darwin，没伪造
`process.platform`）"。**前半句是真的，后半句暴露了真正的问题**——
我当时把"没测"归因于"没有 Windows 环境"，而实际障碍是
**没想到 `process.platform` 可以伪造**：

    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

实测 `darwin → win32 → darwin` 成功。`PWSH-1` 因此**两个平台都测了**，
而且测出来的比原来记的更糟：

    基线 896d569（bash + pwsh 都写）
      darwin → [read, grep, glob, bash, pwsh]   不存在的: pwsh   ✗
      win32  → [read, grep, glob, bash, pwsh]   不存在的: bash   ✗

**不是"mac 上的 bug"，是"两个平台都坏"**——各被一个不存在的工具名绊倒。
这属于「为平台 A 做的修复弄坏了平台 B」那一类（STATUS-PAGE 第二轮同形态）。

⚠️ 同一个教训的一般化：**"我测不了"这句话要先验证**。
本项目在这上面栽过不止一次（`sdlc-ui` 的"做不出来"结论也是这么错的，
见 pitfalls §13 的订正）。说"做不到"之前，先确认试过的是**方法**而不是**结论**。

- **`smoke.mjs` 是关键的那一层**：它用真实 Cordis 上下文 + 真实 `ToolRuntime`
  挂载插件并**真的调用工具**。加载成功 ≠ 可用——这个脚本就是为了防这件事。
  它不需要重启 App，也不碰用户 profile。
- **符号链接安装通过 ≠ 真实分发可用。** 必须用 `npm pack` 的 tarball 装一遍。
- **隔离 profile 验证，不碰正在用的 App**：
  `dsh plugin --profile verifytest add <tgz>`，看启动日志有无
  `entry did not activate`。
- **`plugin_manager list_plugins` 是唯一的运行时真相**（含 `fiberPhase`）。
  不要靠推断；`cordis_inspect` 查 Service 对不注册服务的插件必然误报。
- **单元测试通过 ≠ 端到端可用。** 任何涉及"接线"的改动都要真实操作验证，
  且汇报时不要把单测说成功能可用。

### 内容与机制分离

- 内容（`SKILL.md` 正文、制品模板）写成 harness 无关的形式
- 路径绑定交给配置，**不要复制两份内容**
- 一条必须无例外成立的组织知识 → 写成 Skill **并且**加一个 guard，
  因为 Skill 只是建议性控制（实测确认：只有 guard/deny 才有约束力）

## 关键约束（本机实测，不要从文档推断）

1. **类型定义只在 npm tarball 里**。运行时既没有 `.d.ts` 也没有 `src/`。
   `npm pack @deepseek-ai/dsh-xxx@0.2.0-rc.2` 取 `lib/types/**/*.d.ts`。
   ⚠️ **订正（2026-10-15 实测）**：这条对 App 的 `app.asar` 里的运行时成立，
   但**对开发仓库的 `node_modules` 不成立**——本仓库 `node_modules/@deepseek-ai/`
   下 29 个包**都有** `lib/types/`，`find … -name '*.d.ts' | wc -l` = **150**。
   所以「类型必须去 npm pack 取」只在离线/分发场景才需要，开发时直接解析得到。
   （这条是一个子代理做基准测量时如实报出来的"题干与实测不符"，已复核。）
2. **不要用 PATH 上的 `dsh`**（可能是别的版本）。用 App 自带 CLI：
   `$BASE/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`
   配 `ELECTRON_RUN_AS_NODE=1` 和 App 的 MacOS 可执行文件。
3. **Agent preset 没有发现机制**：没有目录扫描、没有环境变量、没有 CLI 参数。
   只能靠 bundle 补丁的行贡献或覆写。
4. **只有 `spawn` / `fork` 两个 subagent provider**。四个外部后端不在运行时里，
   npm 上的版本 peer 与 `0.2.0-rc.2` 不兼容 → **异构模型验证当前做不到**。
5. **`outputSchema` 只能由插件代码请求**，模型不能。这是好事：
   "强制结构化裁决"无法被模型绕过。
6. **工具过滤（`toolFilter` / `tools.restrict()` / preset）不过滤别的插件注册的
   静态提示词**。被过滤的子代理仍会读到"用 write 工具…"之类的文字。
   已在 verifier persona 里加防御说明。
7. **DSH 没有**：网络管控、受保护路径、不可覆盖的管理层、模式化 allow/deny、
   入参改写、审批人归属、规范日志脱敏、连续 OTel 导出。

## 当前状态

> 下面各条保留为历史。**当前全量读数**（2026-10-22，源码 0.4.0，DSH
> `0.2.1-rc.2`）：单测 **222**（lib 213 + UI 9）、看板宿主 **26**；冒烟
> **9 个脚本共 437 条**（artifact 39 / preset 19 / rsi-scopes 39 / rsi 62 /
> status 69 / task 40 / ui 46 / verify 111 / workflow 12）；compat 两包、
> preset-sync、bench 4/4、隔离测试场 21 条通过。实际安装范围与限制见上文
> 「RSI 0.4.0」及 `.ai/tasks/RSI-2/proof.md`。

- [x] `sdlc-verify` 插件：TypeScript 严格模式零错误
- [x] 单测 **23/23**（纯函数层，含 criteria 强制策略 10 条）
      · 口径要诚实：`实测过的绕过手法必须被拦` 这条用例里的 10 种写法，
        在上一版实现下**就已经全部被拦住**，所以它是**守恒断言**（防止重构弄丢），
        不是回归证据。
      · 本轮真正的回归是 3 个**当时无人覆盖**的缺口（不是"曾被放行"）：
        `npx jest -u` 不带路径、`dd of=tests/x.py` 的 key= 前缀、以及快照模式里
        `-u` 写错成 `--?-u`（写成 `--?-u` 时既不匹配 `-u` 也不该匹配 `--update`）。
- [x] 运行时冒烟 **79/79**（`smoke.mjs`：真实 Cordis + 真实 ToolRuntime，
      真的 dispatch 工具调用；断言数由脚本输出，不手写。
      含进程级冻结、被拦命令必须证明未执行、persona 的正负向断言）
- [x] 根因已修复：`dependencies` 里的 `@deepseek-ai/*` 会让 profile 装第二份
      `dsh-tools`，破坏模块内 Symbol 身份，使**所有**工具调用失败
- [x] **已在真实会话端到端跑通**：`sdlc_verify` 返回结构化裁决，四次验证者会话
      （`0569f81b` / `b6f19027` / `45de6b01` / `086c1405`）；工具面实测为
      `bash glob grep read structured_output subagent`——`write`/`edit` 确认被摘除
- [x] `needs_human` + `unverified` 通路已验证（`45de6b01` 返回 3 条未决问题）——
      这条通路在修复前是坏的
- [x] 已按**三轮**验证裁决修复（2 条 blocking + 若干 important；详见 git log）
      · 第三轮抓到的关键一条：我声称修好的「快照批量更新」其实没关上
        （`npx jest -u` 不带路径仍放行），而写进冒烟的那条恰好带了 `tests/`，
        把洞遮住了——**不要挑好走的用例**。
      · 同轮还抓到 AGENTS.md 里我新写的一句假数字，已按实测更正。

### 已知边界（不要当成"已完成"）

- **standard preset 副本是静态复制**：App 升级后 `preset-sdlc` 里的基础工具列表
  可能过期，SDLC 模式会"少新工具"却不报错。必须跑 `npm run preset-sync`；
  漂移时 `npm run preset-sync:write` 后复跑冒烟。这是官方不支持 preset 继承的接缝，
  不能靠"记得升级"消除，只能靠门禁。
- **"只有选定会话才有工具"已有协议层直接证据**：会话日志 `request/header` 显示
  sdlc 会话 44 工具（31 + 13 个 `sdlc_*`）、standard 会话 31 工具 0 个 `sdlc_*`；
  `toolsTokens` 10072 vs 6902 是旁证。仍缺 GUI 层人工确认（选择器点选/面板渲染），
  不要把"协议层已证实"写成"GUI 已人工验收"。
- **preset-sync 门禁比较整行字段**（id/name/config/disabled/group/isolate 及未来
  新增字段）；第一版只比四个字段，被独立验证指出漏了 `group`/`isolate`。
- **内部验证者 preset 不常驻注册（0.3.1 修正）**：`agentPresets/list` 会把每条
  声明都列进新会话/设置页的模式选择器，所以 `sdlc-verify` 不再在 apply 时注册
  `sdlc-verifier`，而是**只在 `sdlc_verify` 运行期间临时注册、跑完归还**
  （`withVerifierPreset` 租约；并发调用按 depth 共享一次注册）。空闲时选择器里
  只有「AI 原生 SDLC」。这是用户实测截图发现「为什么还有一个 SDLC Verifier」后
  的修复：常驻注册是 0.2.x 就有的行为，0.3.0 方案 A 后它更显眼。
- **已有会话不会切换组合**：选择只影响之后创建的会话，这是官方语义，不是缺陷。
- **冻结不是防篡改边界**：Actor 自己调一次 `sdlc_fix_end` 即可解冻。
  它是流程摩擦 + 留痕，不是硬约束。
- **测试资产识别是名字模式表**：未覆盖的命名不会被冻结。
- **shell 通道是文本启发式**：不落进模式的等价写法可绕过。
- **`pwsh` 通道**：cmdlet 识别已加、纯函数层已单测，但**未在 Windows 上实测**。
  ⚠️ **这条要分开看**（2026-10-15 订正）：
  · **验证者工具白名单**的平台分支**已经测了**——`PWSH-1` 用伪造的
    `process.platform` 跑了 win32 侧，见上面那节。
  · 仍然没测的是**另一件事**：`test-freeze.ts` 里 `pwsh` 的 **cmdlet 识别**
    （判断某条 pwsh 命令是否在改测试文件）。那需要**真的 pwsh 跑真命令**，
    伪造 `process.platform` 不够——它只改 `verifierToolAllow()` 的分支，
    不改 cmdlet 匹配逻辑。
  所以「做到哪一步」要按**被验证的行为**说，不要按"是不是 Windows"说。
- **（0.2.0 历史）`toolFilter` 只过滤继承面**：当时验证者的工具面里仍有
  `subagent`，靠 `maxDepth=1` 使它"存在但不可用"。0.2.1 改用 preset 后，
  实测工具面是 `bash glob grep read read_image skill structured_output`，
  `subagent` 与全部 `sdlc_*` 都不在了。这条只适用于 0.2.0，不要再当现状引用。
- 真正的硬约束应落在工具限制/沙箱层，或服务端分支保护。
- **合并后 mutation 基线只做了路径迁移，没有重新测量**（2026-10-19，
  见 `docs/mutation-score-baseline.txt` 文件头）。`tools/mutation-score.mjs
  sdlc-task --gate` 局部实测：102/126 抓住、24 存活，其中 4 条不在迁移后清单里
  ——属代码演化 + helpers 归并后的真实读数。**没有**用 `--update-allowlist`
  掩盖。全量重测 + 逐条评审是**未完成**工作，不要当成"已通过"。
- **测试场仓库已跟随单包布局并推送**：`sdlc-playground` 的
  `tools/playground-check.mjs` 改为 import `packages/sdlc/lib/<comp>/index.js`，
  并加了单包布局前置检查（缺失 exit 2，不写 `.ai`）；commit `348bff2` 已推
  `main`，从远端 clone 复跑 `make check` **21/21 通过**（断言数未削弱）。
  ⚠️ 真实测试场里仍有旧 `make check` 残留的 `.ai/tasks/CHK-1`（gitignore），
  设计上要在干净隔离副本跑；不要把它当成插件缺陷。

### 本轮真实会话暴露的 4 个 bug（都只在重启加载新模块后才出现）

这条本身就是教训：**上一轮所有测试跑的都是旧模块**，所以四个 bug 一个都没抓到。

1. **沙箱接线**（`sdlc-task`）：`fs.resolve` 没带 cwd、`writeText` 没带 policy
   → 落到部署 fallback 根 → "写自己仓库"被判越界。见 pitfalls §11.1。
2. **跨平台白名单**（`sdlc-verify`）：为修 Windows 把 `pwsh` 加进 allow，
   而 `tools.restrict()` 对不存在的工具名**直接抛错** → macOS 上验证整条通路报错。
   修法：按 `process.platform` 只放本平台存在的那个。
3. **同一个沙箱坑第二次**（`sdlc-verify` 的落盘路径）：修了 A 包没 grep B 包。
   这次是**验证者替我抓到的**——它裁决没问题，但 summary 里如实带出了落盘失败。
4. **假通过的断言**：`dispose` 断言写死"恰好 3 次"、计数器放在会被临时替换的
   impl 里 → 新增用例后假失败/漏计。改为比对两个实际计数。

### 四个机制已咬合（E2E-1 演示，2026-10-07）

`.ai/tasks/E2E-1/` 是一条**完整走通**的制品链，可作为手册工作流的参考实现：
任务状态机 + 制品撰写 + 独立验证 + 逐条判据，四个机制真的接上了。

```
sdlc_task_create           → 建任务（state.yaml + intent.md 骨架）
sdlc_artifact_write ×3     → intent / spec / plan，结构合格才登记
sdlc_task_advance ×4       → INTENT→SPEC→PLANNED→IMPLEMENTING→VERIFYING
sdlc_verify + criteria(5)  → 第一轮 needs_human（5 条全部 cannot_tell）
```

**这条任务后来被正确地打回并重新界定**，过程本身是一次有价值的演示：

第一轮验证给 `needs_human` + 2 条 blocking，其中一条是**我自己算错的数**
（spec 映射表枚举 10 个内部状态，我五处都写 9 个），另一条是根子上的：
`state.yaml` 里先写"不写真实产品代码"、紧接着写"实现完成"——**同一文件自相矛盾**。
验证者把这个问题原样交还给人：「本任务的交付范围到底是什么？」

处置（2026-10-07）：
1. **回退** `VERIFYING → PLANNED`（第一次在真实会话里跑通回退路径——
   它要求目标状态的门槛成立，不是随便退）
2. 标题改为「工作流演示：制品链 + 独立验证」，不再声称实现了理赔功能
3. 删掉针对**已废弃说法**的旧裁决（可在 git 历史取回；
   删除一事记在 state.yaml 的 history 里，不是毁证据）
4. **用正确的判据重跑**：判据针对制品链（如实性 / 章节齐备 /
   Proof 与验收标准对应 / spec 内部自洽），不针对假想的理赔功能
   → `approve`，四条全 `met`

⚠️ 这次重跑验证者**逐行数出**了表格里的 10 个状态并与文中五处对账，
`grep '9 态|9 个|九'` 零命中——**修好了**。它还独立跑了
`sdlc-artifact` 的结构检查器复核三个制品（`ok=true findings=[]`）。

它另外抓到一件我漏了的事，而且是对的：**改完工作区没提交**，
而 AGENTS.md 仍写着旧状态——「这正是仓库自己反复强调要避免的两份真相漂移」。

**这次验证的价值在于验证者抓到了我自己算错的数**：
spec.md 的映射表枚举了 **10** 个内部状态，而我和 plan.md 五处都写"9 个"——
其中 plan.md 还要求单测"断言 == 9 个"，那条单测在 spec 自己的表上**必然失败**。
验证者逐行解析表格数出了 10。**制品链的事实来源自相矛盾，导致它给出的
验收标准无法实现**——这是结构检查查不到、只有独立阅读才能发现的一类缺陷。
已修正为 10。

它另外指出两条值得记的：
- **`VERIFYING` 的门槛只有 intent/spec/plan**，所以零代码证据也能宣布"实现完成"。
  状态机的结构局限，不是演示场景的问题。
- **"对外只暴露 4 态"的定义面不清**：设计把映射放在门户侧、API 返回内部状态码，
  于是内部术语仍跨过网络边界。四态保证只由前端承担，API 侧不可强制。

### sdlc-status 的状态

- [x] **2026-10-19 修嵌套制品误报**（0.1.2）：看板只列任务目录的**顶层**文件，
  于是 `state.yaml` 里登记的 `evidence/x.json` 被报成"文件不在"，
  而同一时刻 `sdlc_task_status` 说磁盘上都在——两个读数互相矛盾。
  修法：按 `state.yaml` 的 artifacts 路径逐个 `stat`；冒烟夹具加了嵌套制品。
  隔离 profile 实测：`incomplete` 从 1 变成 0。
- [x] 单测 **24/24**（跨任务扫描纯函数层）
- [x] 运行时冒烟 **27/27**（真实 `LocalFileSystem`）
      · 前三个插件的冒烟都用内存 `ctx.fs` 桩，而"桩忽略参数 = 测试对这类问题失明"
        （沙箱接线 bug 正是这样漏过去的）。这次在 `mkdtemp` 的临时目录里
        造真实任务树，同时验证了真实 `listDir`/`stat`/`readText` 与沙箱路径解析。
      · 含**只读性**断言：调用前后比对整个文件树与 mtime，必须完全一致。
- [x] 关键设计：**坏任务不拖垮全局**。一个任务的 `state.yaml` 被手改坏，
      看板仍要报出其它任务——出问题的时候最需要能看到东西。
- [x] 状态机常量**从 sdlc-task 导入**（`exports["./state"]`），不复制一份——
      本项目已经吃过一次"两份真相漂移"的亏（sdlc-verify 的 schema 漂移）。
- [x] 已装入 desktop profile（`make check` 21/21 通过）

### ✅ sdlc-ui：**订正**——做出来了（2026-10-09）

**2026-10-17，0.1.1 界面改版**：统一列表 / 详情布局，增加搜索和工作区筛选，
完整历史按需展开，适配窄屏和深浅主题。同名任务必须用 `(repoRoot,id)` 识别。
实测宿主测试 24、组件交互 8、冒烟 40；真实浏览器与桌面 App 已操作验证，
tarball 已安装且文件逐字节核对。见 `docs/sdlc-ui-redesign.md`。
另发现 playground 的 make check 前置失败仍会修改旧 CHK-1，已恢复本次状态写入并修正
脚本立即退出；以后在干净隔离副本跑检查，不能把“报错”当成“已经停止”。

我早先写在这里的"做不出来"结论**是错的**，而且错的不是细节，是**方法**：
三条理由里只有第 ③ 条（跑不了 tsdown）是实测的，①②③ 全是**推断**，
而我用"跑不了构建"推断出了"整条路不可行"。详见 pitfalls §13（原文保留对照）。

**订正后的三条对照：**

| 早先的理由 | 实际 |
|---|---|
| ① 需要 tsdown Client preset | ❌ 客户端 bundle 是**普通 CJS 包装**，**手写即可**。`Builtin` 里明确有 `React`——"exposed **without JSX transformation**" |
| ② host→client RPC 是构建期生成的 | ❌ 有公共接口 `ctx.connection.fetch.register(route)`，注册在**已认证的 `/api` 通道**上 |
| ③ 渲染结果验证不了 | ❌ `dsh web` 是现成 profile；`desktop` profile 本身就挂着 `dsh-web-app`，**19387 就是它在服务 web UI** |

**已实现并端到端验证：**

```
host 半   GET /api/sdlc-ui.tasks —— 读 .ai/tasks/*/state.yaml + verification.json
客户端半   手写（零构建），注册两处：
            main                  key='sdlc'      → 面板本体
            sidebar.panellist     id='sdlc'       → 一个 svg 图标
```

**验证证据**（在独立的 web 服务上做，不碰用户的 App）：

    端点   HTTP 200，841 字节，3 个真实任务（状态 / 裁决 / 制品）
    boot   客户端半在 `__DSH_BOOT__` 清单里（含 id / url / rev / inject）
    bundle 合并 10.4 MB，内含 SdlcIcon / SdlcPanel / 取数路径

**过程中真跑才抓到的三个 bug**（冒烟全绿，只有真跑才现形）：

1. **路由路径少了 `/api` 前缀** → `1 entry did not activate`，
   **插件没激活但服务照起**。`endpointFromPath('/api', path)` 是硬要求
2. **`ctx.fs` 要的是解析过的 target，不是字符串** → `listDir` 静默失败 →
   端点 200、JSON 合法、repoRoot 正确，**只有任务是 0**
3. **我原来的槽架构是错的**：把面板塞进了 `sidebar.panellist`（那是**图标**位，
   owner props 是 `{size, active}`），而契约说 "Each list id **addresses the
   matching main panel**; the sidebar owns the button"。正确做法是
   `main`(keyed) + `sidebar.panellist`(list) **两处注册、共享同一个 id/key**

⚠️ **槽契约只能从 live Slot 树查**（`cordis_inspect_query` 的 client/Slots），
不要从别处推断——第 3 条就是这么发现的。

### sdlc-task 的状态

- [x] 单测 **25/25**（状态机纯函数层）
- [x] 运行时冒烟 **30/30**（真实 Cordis + ToolRuntime + `ctx.fs` 内存桩，
      跑完 create → status → advance 全流程）
- [x] 单测抓出 3 个会在生产里崩的 bug（均已在测试里锁住）：
      ① `yamlScalar` 只按首字符决定加引号 → 含 `: ` 或 ` #` 的标题**写出非法 YAML**；
      ② `created/updated` 缺失时静默填当前时间 → **伪造事实来源**；
      ③ 用 js-yaml 默认 schema 解析 → ISO 时间戳变 `Date` 对象 →
        **读任何正常写出的 state.yaml 都崩**。修法：`JSON_SCHEMA` + 对 Date 容错。
- [x] `sdlc_task_advance` 支持 `artifacts` 参数：迁移与登记**原子完成**。
      没有这个能力时，调用方只能手改 `state.yaml` 才能满足下一状态门槛，
      状态机就守不住自己的规矩。
- [x] **已在真实会话端到端跑通**：create 建目录 + state.yaml、status 报缺失项、
      缺制品时 advance 被拒并点名缺什么、`artifacts` 参数原子登记后放行
      （任务 `.ai/tasks/SMOKE-1`，状态已到 SPEC）
- [x] 回填 `sdlc-verify`：接受 `task_id` 自动解析制品、裁决落盘 verification.json、
      冻结绑定 task（拒绝信息带任务归属，错 task_id 解冻被拒）
- [x] 真实 `sdlc_verify` 返回过 `approve`；落盘沙箱策略修复**已确认生效**
      （`.ai/tasks/SMOKE-1/verification.json` 写出，含 task/at/artifacts/verdict）
- [x] 落盘后**自动把 verification 登记进 state.yaml** 的 artifacts——
      只写文件不够，状态机看的是 artifacts（独立验证者指出的不一致）
- [x] 加 `criteria`（逐条验收标准强制裁决）：单测 23/23、冒烟 79/79
      · 强制策略**由代码执行**：没给 criteria 时 approve 降级为 needs_human；
        有 cannot_tell / not_met 时同样降级；漏报标准补 finding
      · 抓到一个严重 bug：`enforceCriteriaPolicy` 的早退分支丢掉了 findings，
        使「漏报 N 条标准」这条 finding 永远不出现——即**漏报被静默吞掉**。
        抓不到的原因是它一直**穿过整个工具调度**被测；移到纯函数层后一次暴露。
- [x] **整轮独立验证通过**（verifier_session 754030b9）：tsc 两包 0 错误、
      单测 13+23、冒烟 64+29 全部复现；dependencies 无 @deepseek-ai/*
      · 该验证者还自行核查了"测试跑的是不是当前代码"（比对 lib/*.js 与
        src/*.ts 的 mtime），排除了本项目屡次踩到的"测试跑旧模块"失败模式

## 测试场：`sdlc-playground`（另一个仓库）

**不在本仓库里**，而是同级目录，并推到了独立的远端：

```
本地: <WORKSPACE>/sdlc-playground
远端: https://github.com/HMYDK/sdlc-playground  (private, main)
```

**为什么放在外面**：插件的所有路径都相对 **session 的 cwd**，
所以想真实使用它们，得把 `sdlc-playground` 作为**独立的 DSH 会话**打开。
混在本仓库里会互相干扰。

**它刻意做成真实小项目，而不是空目录**——空目录测不出插件真正会遇到的东西：

| 内容 | 用来测什么 |
|---|---|
| `src/cart/discount.py` + `tests/` | **测试冻结**：`tests/` 是测试资产识别目标，冻结期间写它应当被拒 |
| **一处刻意留的缺陷** | **修复流程**：先复现 → 冻结 → 改产品代码 → 解冻 |
| `Makefile` 的 `test` / `lint` | **`test_evidence`**：要有真实的命令与输出可贴 |
| 没有 `.ai/tasks/` | 从零走一遍 `sdlc_task_create` |

当前基线（实测）：`make test` → **7 条用例，1 条失败**（正是那个缺陷）；
`make lint` → `lint ok`；`make check` → **21/21 通过**。

### `make check` 是四个插件的端到端检查（已固化进测试场仓库）

```
tools/playground-check.mjs   ← 在测试场仓库里，进 git、可复跑
```

**为什么需要它**：插件自己的 `smoke.mjs` 用**内存 fs 桩**和自造任务树，
而这一轮的教训是「**两个组件各自都过，组合起来会坏**」——
「artifacts 为空 → 序列化器写 `{}` → 登记逻辑插在它后面 → 非法 YAML」
这个严重缺陷两边单测都没抓到，在这里跑一遍就露出来了。

所以它刻意用**真实 git 仓库 + 真实 LocalFileSystem + 真实文件落盘**。

**路径可配**（不硬编码）：测试场根目录从脚本位置推导；插件仓库默认从同级
目录找，或用 `DSH_PLUGINS=<插件仓库>/packages` 指定。
⚠️ 用 `||` 而不是 `??`——实测踩到：`DSH_PLUGINS=`（空串）时 `??` 不生效，
空串会被当成相对路径。

**改动插件后跑它**，这是唯一能同时覆盖四个插件接线的检查。

缺陷的性质：会员分支 `base = total * (1 - MEMBER_RATE)` **把满减整个替换掉了**
而不是叠加，所以满 300 的会员单只减 15，比非会员（减 50）还少。

⚠️ 建这个测试场时我又犯了**两次「没运行就声称」**：
① 第一版用 pytest，而本机只有标准库 unittest —— `make test` 直接 ImportError，
   一个跑不起来的测试场没有价值；
② README 写「两条失败」，实测只有一条（另一条没有断言）。
两次都已按实测改正，并把第 ② 个错误本身写进测试场的 README 当示例。

（还有第三次差点发生：写这一节时我用了一个**已被删掉的锚点**，
脚本静默地什么都没做。已改为锚点不存在就显式失败。）

⚠️ 第一版检查脚本我放在 `/tmp`，**重启就没了**、且不可复跑。
现已固化进测试场仓库的 `tools/`——工具不该住在临时目录。

## 测试场抓到的两个真缺陷（都不是自查能发现的）

### ① `artifacts` 为空时，第一个制品的登记会写坏 `state.yaml`

两个组件**组合**才出的问题（各自单测都过）：序列化器给空映射写 `  {}` 占位符，
而登记逻辑把 `{}` 当成已有条目、插在它后面 → 非法缩进 → 整个文件解析失败。
后果：**每个新任务的第一次登记**都会写坏事实来源。已修（两层都改）。

### ② 冻结期间跑不了测试：`make test 2>&1` 被误拦

重定向检测把 `2>&1` 当成了"往文件里写"。而 `2>&1` 是终端惯用法，不写文件。
后果很严重：**"改代码后跑测试确认变绿"是修复流程的核心步骤，却做不了**。

修法：在检测变更**之前**把 fd 重定向（`[0-9]>&[0-9]`）归一化掉。
加了两条回归：`make test 2>&1` 等必须放行、而真正的写入
（含 `make test > /tmp/out.txt tests/` 这种真重定向 + 测试目标）必须仍被拦。

⚠️ 这条也说明一个更一般的教训：**门禁的误伤和漏检一样是缺陷**。
误伤会让人绕开门禁走（本项目早先就记过"误伤降低门禁效力"）。
两条缺陷都是**在真实仓库里走一遍**才暴露的——单测覆盖了组件，没覆盖组合。

## 已查清：服务器端强制在这个仓库上做不到（不要重复提议）

我先前**四次**建议"配一下 `main` 分支保护"，**一次都没验证过可行性**。实测结论：

```
HTTP 403  Upgrade to GitHub Pro or make this repository public to enable this feature.
```

- **经典分支保护**：私有仓库要 Pro
- **Repository rulesets**（较新机制）：**同样要 Pro**
- 账号是个人 User，免费套餐

**免费可用的只有 GitHub Actions**，而且它能跑的检查有上限：

| 检查 | CI 能否跑 |
|---|---|
| `tsc` + 单测（约 143 条） | ✅ 纯 node |
| 两套冒烟 + `make check`（约 194 条） | ❌ 依赖本机装的 DSH App（从 `app.asar` 取 node_modules） |

⚠️ 而且 **CI 不构成门禁**：没有分支保护时，工作流失败**不会阻止合并**，
甚至不会阻止直接 push 到 `master`。它是"留痕 + 事后审计"，不是"拦住"。

用户决定**暂不处理**（2026-10-08）。所以：

- **不要**再提议配分支保护——除非同时说清它要 $4/月或转公开（而**转公开也不解锁**，
  公开仓库的分支保护同样要 Pro）
- 现有控制全是**客户端**的，本项目已反复证明它们可被绕过
  （最早就是用 base64 绕过了自己写的门禁）
- 这条边界的正确定位写在文首：**Harness 决定「Agent 如何工作」，
  Git/CI/RBAC 决定「工作对不对、能不能上线」**。后半句在当前套餐下没有实现，
  这是已知缺口，不是疏忽。
