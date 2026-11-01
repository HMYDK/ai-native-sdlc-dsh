# AI 原生 SDLC × DeepSeek Harness

本仓库把 Anthropic《AI 原生 SDLC 实战手册》的方法论落成 **DeepSeek Harness（DSH）插件**：把验证、证据和流程状态做成 Harness 里的一等公民。方法论要点与中文导读见 [`docs/playbook-notes.md`](docs/playbook-notes.md)；本仓库不收录全文翻译。

本文件面向任何 clone 仓库的 agent 与贡献者，只保留仍然约束当前实现的结论；详细历史、事故与读数见 [`docs/history/lessons.md`](docs/history/lessons.md)。

当前插件：`@ai-native-sdlc/dsh-sdlc@0.5.0`，源码在 `packages/sdlc/`。

## 项目目标与边界

**目标**：把方法论里本来就该由机器保证的部分（验证、证据、流程状态）做进 Harness。

**不做**：用 Harness 做合规或发布管控。客户端控制可以被绕过：把 `git push origin main` 做 base64 编码再执行，就绕过了文本匹配门禁。

> **Harness 决定「Agent 如何工作」，Git/CI/RBAC 决定「工作对不对、能不能上线」。**

发布授权、分支保护、密钥管理属于后半句，**不要试图在插件里实现它们**。真正的硬约束应落在工具限制/沙箱层，或服务端分支保护；插件只负责让开发过程可检查。

## 交付形态

**一个 npm 包（`packages/sdlc`）、一个 bundle（`dsh.bundle.patch`）、七个执行行。** `dsh plugin add` 安装后由 bundle patch 自动挂载。

- **分发单位是一个**：一个 npm 包、一个 `dsh.profile.bundles` 条目、一个 tarball、插件页一张卡。七个组件永远同装同升；`state.yaml` / `verification.json` / artifacts 语义是跨组件协议，必须同版本发布。
- **执行单位是七个 Cordis 插件行**：每行有自己的 `inject`、`Config`、fiber，故障域、`fiberPhase` 诊断、行级开关和 profile 按 id 覆盖都靠它。不要把七行压成「一个插件行 + `ctx.plugin()` 子插件」——那会压掉唯一真正起作用的隔离边界，分发粒度并不会因此变化。
- **`0.3.0` 起默认不生效**：六个机制组件放进名为「AI 原生 SDLC」的 Agent Preset，只有新建会话选择该模式才挂载。只读看板 UI 常驻宿主层。

| 行 id | 行 name | 机制 |
|---|---|---|
| `sdlc-task` | `@ai-native-sdlc/dsh-sdlc/task` | 任务状态机 + 制品链（`state.yaml` 在 git） |
| `sdlc-artifact` | `@ai-native-sdlc/dsh-sdlc/artifact` | 制品撰写 + 结构检查（只查结构） |
| `sdlc-status` | `@ai-native-sdlc/dsh-sdlc/status` | 任务看板（一次盘出所有任务的状态/缺失/裁决） |
| `sdlc-verify` | `@ai-native-sdlc/dsh-sdlc/verify` | 独立验证 + 测试冻结 |
| `sdlc-workflow` | `@ai-native-sdlc/dsh-sdlc/workflow` | 工作流本身，作为 Skill 交付给验证者 |
| `sdlc-rsi` | `@ai-native-sdlc/dsh-sdlc/rsi` | 执行证据、复盘、改进任务与反馈 |
| `sdlc-ui` | `@ai-native-sdlc/dsh-sdlc`（**精确包名**） | 客户端制品链面板（侧栏图标 + main 面板） |

宿主层还有一条 `preset-sdlc`（`@deepseek-ai/dsh-agent-preset`，id=`sdlc`），它不是机制行，只声明 preset。

⚠️ **`sdlc-ui` 行必须写精确包名**，不能写 `.../ui` 子路径。`@deepseek-ai/dsh-client-modules` 只扫描**精确包名**的 loader 行来发现 `dsh.client`（`exactPackageSpecifier` 对子路径返回 `undefined`）。写成子路径时浏览器半**不会进入 `window.__DSH_BOOT__`**，而 host 端点仍返回 200——面板不出现、日志无错。包根入口必须重新导出 UI 定义；其余六个组件仍走子路径导出。

⚠️ **preset 里必须带 standard 副本**。`preset-sdlc` 的 `config.plugins` = DSH standard preset 的完整副本（22 行）+ 六个机制组件（6 行），共 28 条子行。preset 不继承、不合并；第一版只放六行会让 SDLC 会话没有 `read` / `bash` / `write` / `skill`。副本会随 App 升级漂移，用 `npm run preset-sync` 检查、`npm run preset-sync:write` 同步（见「已知边界」）。

**为什么合并成一个包**：合并前的七包形态实测代价全在分发层——七份 peer 范围会被一次 App 升级一起跳过；七个 tarball、七条 bundles 条目、七次安装；跨包 import 装好后解析不到，`sessionCwd` / `writePolicy` 等 helper 和状态常量出现多份副本；插件页七张卡暗示七个可独立选择的东西，而它们其实是一套。合并后只有一份 peer 范围、`src/shared/helpers.ts` 一份、状态常量直接 import——同一份代码不可能和自己漂移。详细证据见 lessons。

历史上先做 verifier 而不是 plan：verifier 输出结构化 PASS/FAIL，是唯一能被严格自动验证的机制；`plan` 输出给人看的 markdown，很难自动判断好坏。

## 目录结构

```text
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
  src/shared/helpers.ts     #   各组件共用的沙箱/cwd 辅助函数
  smoke/                    #   运行时冒烟（每组件一个脚本 + run-all.mjs / preset.mjs）
  test/                     #   UI 的纯 Node 行为测试
  README.md / TASK.md / RSI.md
docs/                       # DSH 契约与调研；history/lessons.md 为详细历史
tools/                      # bench / mutation / activation / time-travel / compat / preset-sync
```

`packages/sdlc/lib/` 是构建产物，不要手改。

## 写插件必守 0–6

每条都踩过，且多数是「加载正常、警告后继续」的静默失败。

0. 🔴 **绝不要把 `@deepseek-ai/dsh-*` 写进 `dependencies`。** 只写 `peerDependencies` + `devDependencies`。写进 dependencies 会让 profile 装**第二份** `dsh-tools`，而 `dsh-agent-loop` 用一个**模块内 Symbol** 查表（`ctx.tools[TOOL_RUNTIME_SCHEDULER]`）——两份模块 = 两个 Symbol 值 = 查不到 = **每一次工具调用都失败**，会话彻底不可用。加载时完全正常，只在工具调用时爆发，且移除插件也未必能恢复。详见 [`docs/dsh-plugin-contracts.md`](docs/dsh-plugin-contracts.md)。
1. **`inject` 列出每一个访问到的服务。** 少一个就抛 `cannot get property "X" without inject`，插件不激活但 app 照常启动。
2. **`Config` 必须是 Standard Schema 校验器**（schemastery 或 zod），不能是普通对象——Cordis 会调 `Config['~standard'].validate`。
3. **`files` 用 `lib/**/*.js`**，不是 `lib/index.js`（后者只匹配单文件）。打包后**核对文件数**。
4. **不要用 default export**——会隐藏 loader 元数据（有正式 postmortem）。
5. **不要留未 await 的 promise。** 游离的 promise 拒绝或同步回调抛错会**销毁整个 app**，与是哪个插件无关。
6. **Skill 注册返回的 disposer 必须托管。** 用 `ctx.effect(() => ctx.skills.register({ name, description, content, source: 'bundled' }))`；`source` 必填，漏掉会被 tsc 拒。返回值必须交给 `ctx.effect()`，否则卸载后留下指向已卸载插件的悬空注册。卸载入口是 `ctx.fiber.dispose()`，不是 `ctx.dispose()`。

## 兼容性与接入要点

- **peer 范围不要钉死精确版本。** App 会自动升级，仓库不会。DSH 的判定是 `semver.satisfies(runtime, range, { includePrerelease: true })`；精确旧版本不接受新版本。历史上七个包各自钉精确 peer，一次 App 升级让它们被判定 `incompatible-version` 后整体 skip：**App 照常启动，工具和侧栏一起消失，日志只有一行 warning**。现在只有一份 peer 范围；改 peer 或升级 App 后跑 `npm run compat`，它读本机真实 App 的 `dsh/package.json`。
- **0.2.1 子代理 API 已变。** `ctx.subagents.start()` 已删除，改用 `startActivation(spec)`；`SubagentRun` / `run.id` → `SubagentActivation` / `run.childId`；`label` / `signal` 移到 spec 外层，并新增 `delivery: 'caller'`。`persona` / `toolFilter` 已从 `SubagentStartRequest` 删除，迁移为 Agent Preset：`ctx.agentPresets.register({ id, plugins })` + request 带 `agentPreset`。见 `packages/sdlc/src/verify/preset.ts`。
- **preset 不会自动隔离宿主全局工具。** 只挂 preset 时，真实验证者的工具面里仍有 `sdlc_task_create` / `sdlc_fix_end` / `sdlc_verify`——它能解冻测试、推进任务。必须在 preset 里放一行 `ctx.tools.restrict({ deny: <运行时枚举的全部 global> })`。`allow` 清单不行：preset 自己的 `read` / `grep` / `bash` 是 scope 注册，不在 global 层，会被判 `unknown global tool`。
- **`agentPresets` 是可选服务**（web/desktop 有，headless 没有）。不要写进 `inject`（会停 pending），用 `ctx.get('agentPresets')`；缺失时 `sdlc_verify` **fail closed**，不降级成继承全部工具的子代理。
- **验证者 preset 按需注册。** `agentPresets/list` 会把每条声明都列进新会话/设置页的模式选择器，所以 `sdlc-verify` 不在 apply 时注册 `sdlc-verifier`，而是只在 `sdlc_verify` 运行期间临时注册、跑完归还（`withVerifierPreset` 租约；并发调用按 depth 共享一次注册）。空闲时选择器里只有「AI 原生 SDLC」。
- **`dsh plugin add` 是否写 `dsh.profile.bundles` 取决于版本/安装形态。** 不要用绝对句；装完读 profile 的 `package.json` 核对，没出现就手补。`plugin add` 用的是 App 自带 pnpm，不要求 PATH 上有 pnpm。

## 验证纪律

**跑 `npm run verify`（= build + test + smoke），不要只看其中一项。**

**核对单测数字时用 `grep -E "^[#ℹ] (pass|fail)"`，不要写 `^#`。** 这个 Node 版本的 `node --test` 用 `ℹ` 前缀；写 `^#` 会零匹配、退出码 1——看起来像「测试失败」，其实只是 grep 没匹配到。

**独立验证测不了自己这次调用的产物。** 让验证者确认「这次调用会写出的文件」必然得到 reject（它只能在调用期间观察）。要么验证**调用前**已存在的东西，要么另起一次调用验证产物。详见 [`docs/dsh-pitfalls.md`](docs/dsh-pitfalls.md)。

**基准必须两侧对照，至少三维一起测。**

```text
基线版（有缺陷）  应当违反判据      ← 没有这一侧，用例是恒真断言
当前版（已修复）  应当满足判据

抓住率  坏改动被拦
误伤率  好改动被误判
完成率  验证者是否产出裁决
```

只优化抓住率，会得到一个再也出不了裁决的验证者；误伤会让人绕开门禁走。`verifier_sessions` / `verifier_attempts` 如实报告派发次数，不把「重试过」抹掉。用例的真实来源是**修过的 bug**，不是「做过的任务」；判据要从当时的制品搬，不要现编。

**生成期失败：重试是保险，体积才是疗效。** `verifierRetryOnMalformed` 默认开——结构化裁决没拿到时原样重派一次，prompt 追加「把裁决写小」；两次都没拿到 → `needs_human` + `diagnostic`，**绝不解析自由文本去猜**。同时把 `criteria_results[].criterion` 从必填逐字回抄改成可选（省略即按序号对齐）；给了就必须逐字相等，漏报逐条比对。实测同 5 条判据、同样撞 60 步：修复前写不出裁决，修复后以 7864 字符写出 `reject` + 8 条 finding，且**没有走重试**。阈值和复现见 lessons。

**真实接线要单独验证：**

- `smoke.mjs` 用真实 Cordis 上下文 + 真实 `ToolRuntime` 挂载插件并**真的调用工具**；加载成功 ≠ 可用。
- 符号链接安装通过 ≠ 真实分发可用。必须用 `npm pack` 的 tarball 装到**隔离 profile**，检查启动日志有无 `entry did not activate`。
- `plugin_manager list_plugins` 是唯一的运行时真相（含 `fiberPhase`）；`cordis_inspect` 查 Service 对不注册服务的插件必然误报。
- 单测通过 ≠ 端到端可用。涉及接线的改动要真实操作验证；汇报时不要把单测说成功能可用。

## 当前验证读数

最近一次全量记录（**2026-11-01，插件 0.5.0**）：

| 范围 | 读数 |
|---|---|
| 库 + 客户端单测 | 242 + 35 = **277** |
| 看板宿主接口 | **51** |
| 运行时冒烟 | 10 组，**459** 条 |
| 隔离测试场 | **21** 条 |
| `npm run compat` / `npm run preset-sync` | 通过 |

这些是历史读数，不是永久承诺；代码、依赖或 App 版本变化后重跑，引用时带日期和版本。

## 已知边界

- **standard preset 副本会漂移。** App 升级后 `preset-sdlc` 里的基础工具列表可能过期，SDLC 模式会「少新工具」却不报错。必须跑 `npm run preset-sync`；漂移时 `npm run preset-sync:write` 后复跑冒烟。门禁比较整行字段（`id` / `name` / `config` / `disabled` / `group` / `isolate` 及未来新增字段），不能只比 id/name。
- **协议层证据已有，GUI 层未人工验收。** 会话日志 `request/header` 显示 SDLC 会话 44 个工具 = standard 31 个 + 13 个 `sdlc_*`，standard 会话 31 个、0 个 `sdlc_*`；`toolsTokens` 10072 vs 6902 是旁证。仍缺在新建会话选择器里真的点选「AI 原生 SDLC」并看到工具列表/面板渲染；不要把「协议层已证实」写成「GUI 已验收」。
- **已有会话不会切换组合。** 选择只影响之后创建的会话，这是官方语义，不是缺陷。
- **冻结不是防篡改边界。** Actor 自己调一次 `sdlc_fix_end` 即可解冻。它是流程摩擦 + 留痕，不是硬约束。
- **测试资产识别是名字模式表。** 未覆盖的命名不会被冻结。
- **shell 通道是文本启发式。** 不落进模式的等价写法可以绕过。
- **`pwsh` 的 cmdlet 识别未在真实 Windows 上实测。** 验证者工具白名单的平台分支已用伪造的 `process.platform` 跑过 darwin/win32；仍未测的是 `test-freeze.ts` 里判断「某条 pwsh 命令是否在改测试文件」的 cmdlet 识别——它需要真的 pwsh 跑真命令。说「做到哪一步」要按被验证的行为说，不要按「是不是 Windows」说。
- **合并后 mutation 基线只做了路径迁移，没有重新测量。** `tools/mutation-score.mjs sdlc-task --gate` 局部读数：102/126 抓住、24 存活，其中 4 条不在迁移后清单里。全量重测 + 逐条评审仍是未完成工作，不要当成「已通过」。
- **服务端门禁不在插件内。** 没有分支保护时 CI 只是留痕与事后审计，不阻止合并或直接 push；插件侧的客户端检查都可被绕过。这是边界，不是待修的 bug。

## 贡献与提交约定

- **提交信息写「为什么」**，不写「更新了 X」。本项目的提交信息承载踩坑结论，是仓库最有价值的产物之一。
- **不要 `git add -A` 盲推。** 提交前审查 `git ls-files`：实测踩过把冒烟测试造的临时任务提交进历史，也踩过废弃 Skill 一直躺在仓库里没人注意，直到逐个审查跟踪文件才看到。
- **真实任务制品 `.ai/tasks/<TASK-ID>/` 应当提交**——那是制品链的载体。只忽略冒烟测试造的临时任务（`.gitignore` 已有 `.ai/tasks/SMOKE-*/` 规则）。
- **原始 `.ai/rsi/` 默认忽略**：它含完整输入、代码与工具输出，没有通用脱敏。只提交经过检查的任务材料与摘要。
- **不要提交本机 profile、备份目录、安装日志或含个人/环境信息的记录。**
- 改 peer、preset 或 App 版本后跑 `npm run compat` 与 `npm run preset-sync`；提交前跑 `npm run verify`，并在提交/PR 说明里写清验证范围与未覆盖项。
- 引用验证读数时带日期和版本，不要拿旧数字当现状；不要用「单测通过」代替「端到端可用」。

## 历史与踩坑

详细的形态演进、合并证据、0.2.1 事故、方案 A 读数、验证者生成失败样本、基准与 win32 订正、测试场组合缺陷、UI 槽契约、状态机/沙箱 bug、RSI 演进与控制边界，见 [`docs/history/lessons.md`](docs/history/lessons.md)。本文件只保留仍然约束当前实现的结论。

## 关键文档

| 文档 | 内容 |
|---|---|
| [`packages/sdlc/README.md`](packages/sdlc/README.md) | 包总览、分发/执行两层、行表、安装 |
| [`packages/sdlc/TASK.md`](packages/sdlc/TASK.md) | 任务状态机、问题处理、验证版本 |
| [`packages/sdlc/RSI.md`](packages/sdlc/RSI.md) | 执行证据、复盘、改进提案与版本对照 |
| [`docs/dsh-plugin-contracts.md`](docs/dsh-plugin-contracts.md) | DSH 插件契约与依赖约束 |
| [`docs/dsh-pitfalls.md`](docs/dsh-pitfalls.md) | 安装、沙箱、槽位等实测坑 |
| [`tools/bench/README.md`](tools/bench/README.md) | 双侧基准的方法与边界 |
| [`docs/history/lessons.md`](docs/history/lessons.md) | 从本文件移出的详细历史与事故 |
| [`docs/playbook-notes.md`](docs/playbook-notes.md) | 方法论要点与本插件的对应关系（原创导读） |
