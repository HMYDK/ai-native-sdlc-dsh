# 历史与踩坑记录

本文件保存从 [`AGENTS.md`](../../AGENTS.md) 移出的详细历史、事故、验证读数与踩坑结论。`AGENTS.md` 只保留仍然约束当前实现的规则；这里保留“当时到底发生了什么、怎么定位、读数是多少”，方便复查和避免重复踩坑。

读数都带日期或版本。历史快照里的失败不等于当前代码的失败；引用前先确认它属于哪个版本、哪个提交。任务单号已省略，任务统一用“一次任务 / 一轮验证 / 一个演示任务”指代。

## 1. 形态演进：从仓库脚本到单包 bundle

### 1.1 第一版为什么废弃

第一版做成了「git 仓库 + shell 脚本 + md 约定」。它能在 DSH 里跑，但不是 DSH 插件，只是一个外部工具集：没有 bundle patch，没有插件行，没有 `inject` / `Config` / fiber，也没有 `dsh plugin add` 的安装路径。后来整体废弃。

正确形态是 **npm 包 + `dsh.bundle.patch`**：安装后由 bundle patch 自动挂载。2026-10-19 起收敛为**一个**包 `packages/sdlc`，源码版本演进到 0.5.0；0.3.0 起默认不生效，六个机制组件放进「AI 原生 SDLC」Agent Preset，只有新建会话选择该模式才挂载。

### 1.2 七包形态的代价

合并前是七个独立包。实测代价全部在分发层：

1. **七份 `peerDependencies`**。0.2.1 升级时，七个包被版本门禁一起跳过、静默消失。详见 §2.1。
2. **七个 tarball、七条 `dsh.profile.bundles` 条目、七次安装**，还要操心安装顺序。
3. **跨包 import 装好之后解析不到**。`sessionCwd` / `requireSessionCwd` / `resolveOptions` / `writePolicy` 在 verify / task / artifact / status 里是四份逐字相同的副本，靠四份“漂移检测”测试盯着；`sdlc-status` 还复制了一份状态机常量，再用读源码文本的契约测试盯漂移。合并后 `src/shared/helpers.ts` 一份、状态常量直接 import——同一份代码不可能和自己漂移。
4. **插件页七张卡**暗示七个可独立选择的东西，而它们其实是一套。

合并后的收益不是“代码更少”，而是把**分发协议**收敛成一份：一份 peer 范围、一条 compat 检查、一个制品链版本。

### 1.3 合并前的机制探针

在真正合并前，先用 `.probe/repro.sh` 做了第三方 tgz bundle 的机制探针（PASS=32，可复跑）。探针的 patch 两行分别指向**自己包的子路径导出**，在真实 `dsh` 启动中两行都激活：

- marker 由该次启动进程写出；
- `--dump-config` 两行 name 逐字正确；
- `dsh.profile.bundles` 自动追加；
- 无 `entry did not activate`；
- 行级 `disabled: true` 只关对应一行，且可逆。

探针只证明了**行级机制与子路径解析**，没有外推到 peer / 依赖形态。这个边界后来被反复引用：不要拿“行能激活”证明“包依赖形态也没问题”。

### 1.4 真实 tarball 的隔离验证

用 gitignore 的隔离 home（`.verify-home`）验证真实安装，不碰日常使用环境：

- 模板 profile 先建，再 `plugin add`；
- bundles 变成 `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","@ai-native-sdlc/dsh-sdlc"]`；
- `--dump-config` 七行；
- 真实启动无激活警告；
- `__DSH_BOOT__.entries` 含 `{"id":"@ai-native-sdlc/dsh-sdlc","url":"plugins/…/client.js","inject":["…client-ui-sidebar"]}`；
- `GET /api/sdlc-ui.tasks` 返回 200，81975 字节，聚合 3 个工作区 / 13 个任务；最终复验 86730 字节，因为新增了一个任务。

最终 tarball 为 52 文件。换入后重新读过一次 `plugin_manager list_plugins`：七行全部 `fiberPhase: active`，`sdlc-ui` 行 moduleName 是精确包名 `@ai-native-sdlc/dsh-sdlc`。换包只改了 locale/icon 与注释，host 行为不变。

同一轮还清掉了旧 profile 里残留的旧包依赖和 bundles 条目；仓库根 `node_modules` 的七个悬空 workspace 链接随 `npm install` 收敛为只有一个 `dsh-sdlc → packages/sdlc`。

### 1.5 合并后的读数

2026-10-19 全量：

- 单测 **210**（lib 202 + UI 客户端 8）。
- 合并前是 251；减少的 41 = 3 份重复 helpers 测试副本 36 条 + 1 条漂移检测 + status/contract 4 条重复契约。
- 冒烟 7 个脚本共 **377 条**：artifact 39 / rsi 62 / status 69 / task 40 / ui 46 / verify 109 / workflow 12。
- `npm run compat` 2 个 manifest 通过。
- bench 三用例全部成立。
- activation-check 在隔离 profile 上七行一致，26 个发布文件 sha256 全一致。
- time-travel 5 个时点一致。

这些数字后来继续变化，只作为“合并没有削弱覆盖”的证据。

### 1.6 插件页元数据事故：locale / icon 子路径

独立验证连续两轮给了 minor，第三轮直接 reject，原因都在插件页展示元数据。

宿主 `dsh-app-boot` 的 `readPluginMeta` 只读包 specifier 下的 `locale/en.json` 与 `icon` 子路径。合并后必须在**包根**放套件 locale，并给六个子路径行补 `./*/locale/en.json`、`./*/locale/zh.json`、`./*/icon` 的 exports。多星 pattern（`./locale/*/*.json`）不解析。

图标**逐组件保留**在 `icons/`：task/artifact/verify/rsi 恢复各自原图标，status/workflow 与套件共用同一枚（与合并前一致）。

workflow/rsi 原先没有 locale 文件（合并前靠精确包名回退读 `package.json`）。合并后如果不补 `locale/<comp>/{en,zh}.json`，这两行会退化为“只有 icon”——第三轮独立验证正是因此判了 reject。补完后冒烟对**六个**子路径行都校验。

`smoke/ui.mjs` 的回归断言也从“exports 键存在”升级为“target 可解析到真实文件、且 icon target 必须指向本组件自己的 `icons/<comp>.svg`”。第二轮“所有行退化成同一套件图标”的回归因此真会红：负向实测 45/46，断言数保持 46，总冒烟 375 → 377。

## 2. 0.2.1 兼容性事故

### 2.1 精确 peer 让七个插件静默消失

2026-10-17，App 自动从 `0.2.0-rc.2` 升到 `0.2.1-rc.2`。七个插件的 peer 都钉着精确的 `0.2.0-rc.2`，被插件管理器判为 `incompatible-version`，启动时 bundle 被 **skip**。

症状：**App 照常启动，插件全部静默消失**。工具和侧栏一起没了，日志只有一行 warning。

修法：peer 改成 `^0.2.1-rc.2`。DSH 的判定是：

```text
semver.satisfies(runtime, range, { includePrerelease: true })
```

精确旧版本不接受新版本。**不要钉死精确版本**——App 会自动升级，仓库不会。

新门禁：`npm run compat` 读本机真实 App 的 `dsh/package.json`，逐包验证 peer 范围。改 peer 或升级 App 后都要跑。

### 2.2 子代理 API 迁移

0.2.1 的变更：

- `ctx.subagents.start()` 已删除，改用 `startActivation(spec)`；
- `SubagentRun` / `run.id` → `SubagentActivation` / `run.childId`；
- `label` / `signal` 移到 spec 外层；
- 新增 `delivery: 'caller'`；
- `SubagentStartRequest` 删除了 `persona` / `toolFilter`，官方 `dsh-tool-subagent` 传这两个配置会直接抛。

迁移方向是 **Agent Preset**：`ctx.agentPresets.register({ id, plugins })` + request 带 `agentPreset`。实现见 `packages/sdlc/src/verify/preset.ts`。

这次迁移也暴露了一个更一般的教训：**运行时类型变化会让历史基准用例编译失败**。基准里两个旧 revision 是针对 0.2.0 API 写的，合并后第一次跑就报 `toolFilter` / `start` 不存在。处理方式不是在历史源码里改 API，而是给旧 revision 固定它当时的类型环境；否则就是伪造历史。

### 2.3 preset 不会自动隔离宿主全局工具

只挂 preset、不做额外限制时，真实验证者的工具面里仍有：

```text
sdlc_task_create / sdlc_fix_end / sdlc_verify
```

也就是说，验证者能解冻测试、推进任务。必须在 preset 里放一行：

```text
ctx.tools.restrict({ deny: <运行时枚举的全部 global> })
```

`allow` 清单不行：preset 自己的 `read` / `grep` / `bash` 是 scope 注册，不在 global 层，会被判 `unknown global tool`。

### 2.4 `agentPresets` 是可选服务

web/desktop 有，headless 没有。不要写进 `inject`（会停 pending），用 `ctx.get('agentPresets')`。缺失时 `sdlc_verify` **fail closed**，不降级成继承全部工具的子代理。

### 2.5 隔离 profile 的真实读数

- `dsh web` 启动无 `entry did not activate`。
- `__DSH_BOOT__` 里有 `@ai-native-sdlc/dsh-sdlc-ui`。
- `GET /api/sdlc-ui.tasks` 200，聚合 3 个工作区 / 13 个任务。
- 真实验证者工具面：`bash glob grep read read_image skill structured_output`（无 write/edit、无 `sdlc_*`、无 subagent）。
- 无模型凭据时 `sdlc_verify` 仍走完 2 次派发并返回 `needs_human`，未崩。

### 2.6 “插件真的挂上了”的 live 读数

合并前七包形态在真实 profile 中实测：当前会话**无需重启**就出现了 `sdlc_status` / `sdlc_verify` / `sdlc_task_*` 等工具，Skill 目录出现 `sdlc-verification-discipline`；`sdlc_status` 直接返回了一个真实任务（VERIFYING，停滞 4 天）。这是“插件真的挂上了”的最直接读数。合并后的同一读数见 §1.4。

另一次真实调用 `sdlc_verify` 返回了完整结构化 `needs_human`：

- `criteria_results` 1 条 `cannot_tell` + 2 条 finding；
- `verification_complete: true`；
- 运行记录是 `finished` / `outcome: completed`。

验证者那 2 条 finding 说的是“它看不到自己这次调用结束后的返回”——这正是“独立验证测不了自己这次调用的产物”的纪律，不是插件失败。这条比“工具出现在列表里”更强：preset + 派发 + 记录 + 裁决整条链都通了。

### 2.7 0.3.1：验证者 preset 改为按需注册

一次实机截图检查发现：模式选择器里为什么还有一个「SDLC Verifier」？

根因是 `agentPresets/list` 会把每条声明都列进新会话/设置页的模式选择器，而 `sdlc-verify` 在 apply 时注册了 `sdlc-verifier`。0.2.x 就有这个行为，0.3.0 方案 A 后它更显眼。

修法：验证者 preset 不常驻注册，只在 `sdlc_verify` 运行期间临时注册、跑完归还（`withVerifierPreset` 租约；并发调用按 depth 共享一次注册）。隔离 profile 重启后：

```text
agentPresets/list = [standard, ptc, minimal, cordis, sdlc]   # 无 sdlc-verifier
boot rev = c538c0d0075f
API 200 / 91661 字节
0 条激活警告
verify 冒烟 111/111
```

### 2.8 `dsh plugin add` 与 bundles 的不确定性

旧记录说“只装包不写 bundles”；2026-10-19 在 `0.2.1-rc.2` + `npm pack` tgz 上**两次复测都自动追加**了。结论不是“一定会写”或“一定不写”，而是：**不要用绝对句，装完读 profile 的 `package.json` 核对；没出现就手补**。

另：`plugin add` 用的是 App 自带 pnpm，不要求 PATH 上有 pnpm。

## 3. 方案 A：默认不生效，按 Agent Preset 选择

### 3.1 为什么是 Agent Preset

需求是“只有在明确指定这个插件的时候，整套 SDLC 才工作”。先检索官方文档：DSH **没有**“会话中按需加载插件”的机制；唯一按会话选择的单位是 **Agent Preset**。

相关文档结论：

- `@deepseek-ai/dsh-agent-preset`：可同时声明多个 preset，**由会话选择**。
- `@deepseek-ai/dsh-agent-preset-registry`：通过声明式 preset 选择 Agent 的**工具、提示词和技能**；每个声明在启动时创建注册表拥有的 scope 和内存 Loader 树；插件注册继承 preset scope，Agent scope 的父链接决定可见性。
- `dsh-skill`：宿主行落入**全局层**，由 agent preset 常驻组合挂载的插件落入该 **preset 的层**。
- `dsh-client-ui-agent-preset`：新会话选择器/设置页可选自定义 preset；选择变更**只影响之后的任务**，已有插件与提示词保持不变。

### 3.2 形态

```text
宿主行 ① sdlc-ui        name=@ai-native-sdlc/dsh-sdlc（精确包名，常驻只读看板）
宿主行 ② preset-sdlc    name=@deepseek-ai/dsh-agent-preset，id=sdlc
preset 内               standard preset 完整副本（22 行）+ 六个机制组件（6 行）
```

- 六个机制组件不在宿主层：标准模式会话没有 `sdlc_*` 工具、没有 SDLC 提示词段、Skill 目录里也没有那两条 Skill；新建会话选「AI 原生 SDLC」才有。
- 已有会话保留创建时的组合（官方语义），所以迁移后当前会话失去这些工具是**预期行为**。
- UI 必须留在宿主层：`dsh-client-modules` 只扫描宿主 Loader 里精确包名的行；preset 的行在内存 Loader 树里（`Config.listConfigs` 也只遍历 profile Loader 树，官方 README 明说）。把 UI 搬进 preset → 面板静默消失。方案 A 接受“只读面板常驻”。

### 3.3 第一版只放六行是错的

第一版只放六行，选该模式的会话没有 `read` / `bash` / `write` / `skill`，实测 `toolsTokens` 3265（standard 6902）。

修正后 = standard 22 行 + 6 行。代价是复制了一份内置列表，App 升级会漂移。新增 `tools/preset-sync-check.mjs`：读真实 App 的 `dsh-web-app/presets/standard.patch.yml` 逐行对账，`--write` 同步；**升级 App 后必跑**（`npm run preset-sync`）。

### 3.4 真实运行读数

隔离 profile：

```text
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

**模型可见的直接证据**：会话日志（`session.v4.jsonl.zstd`）里的 `request/header` 记录模型实际收到的工具 schema。独立验证与项目记录各自读到：sdlc 会话 44 个工具 = standard 的 31 个 + 恰好 13 个 `sdlc_*`（task_create/status/advance、artifact_write/check、verify/fix_start/fix_end、status、rsi_runs/analyze/experiment/feedback），standard 会话 31 个、`sdlc_*` 为 0；两条 SDLC Skill 也只在 sdlc 会话的 `skills/list`。这比只看 `toolsTokens` 强。

仍未做的是 **GUI 层人工确认**：在新建会话选择器里真的点选「AI 原生 SDLC」并看到工具列表/面板渲染。协议层与日志层的集合证据已经拿到，但不能写成 GUI 已验收。

### 3.5 desktop 迁移的预期现象

0.3.0 迁移后，依赖只剩一个 SDLC file tgz，已安装 patch 的 sha256 前 16 位与仓库一致。`plugin_manager list_plugins` 里：

- `include:sdlc-ui` 与 `include:preset-sdlc` 都是 `fiberPhase: active`；
- `include:sdlc-task/artifact/status/verify/workflow/rsi` 六条宿主行**不再存在**。

迁移前创建的会话（组合已固定）看不到 `sdlc_*`，Skill 目录里也没有两条 SDLC Skill——这正是“已有会话保留原组合 + 全局行卸载”的预期表现，不是故障。新建会话选「AI 原生 SDLC」即可使用整套工具。

### 3.6 preset-sync 门禁的三次修正

1. **第一版只比四个字段**，被独立验证指出漏了 `group` / `isolate`。现在比较整行字段（id/name/config/disabled/group/isolate 及未来新增字段）。
2. **`plugin-activation-check` 第一版把 standard 副本行也拿本包 exports 解析**，全部误报“解析失败”。改为只 import 本套件的行。
3. standard patch 里的 `!!js` 标签会让默认 js-yaml 直接抛，需要自定义处理；这也是第一版 activation-check 误报的原因之一。

负向实测：组件放回宿主行（17/19）、改坏 standard 副本（sync exit 1，含 isolate 字段）、改名 `tool-web`（18/19）都会红。

## 4. 验证者裁决：生成期失败、重试与体积

### 4.1 故障样本

2026-10-15 的一次验证：

```text
72 次工具调用 / 60 步 / 421 秒
turn/end: MALFORMED_RESPONSE
          "DeepSeek Messages stream: tool input is invalid JSON"
structured_output 的调用次数：0
```

验证者当时**已经把活干完了**：它自造混匀夹具、从 `HEAD~1` 编译旧代码做新旧对比、造变异体验证自己的断言不是空的、找到了那条 blocking。它最后一条 reasoning 写着「I have everything. Let me now write the structured output.」——然后那个工具调用的参数流就没能生成出来。

### 4.2 已排除的三个原因

| 嫌疑 | 实测 |
|---|---|
| 上下文被探索撑满 | `contextWindow = 1,000,000` token；整轮累计约 40 万**字符**，远没满 |
| 判据太长把入参撑大 | 5 条判据的 prompt 只有 **1866 字符**；那次 18k 的 user message 是内部提示词注入，与判据无关 |
| 步数预算不够 | 60 步是上限，但它在第 60 步是**有话要说**（要写裁决），不是没查完 |

### 4.3 对照与修复

同一份代码、同一条 lead：判据 5 条 → 无裁决；判据 **2 条** → 完整 `reject` + 6 条 finding。裁决的体积/复杂度有影响，但这不是受控实验，不能推出“判据越少越好”。

处置（已实现）：`verifierRetryOnMalformed`（默认开）——结构化裁决没拿到时**原样重派一次**，prompt 追加“把裁决写小”的指令。理由：一次生成失败不值得扔掉 421 秒的调查；重试不改变任何安全性质（同一个只读、独立上下文的验证者，只是多给一次机会）。两次都没拿到 → `needs_human` + 把 `diagnostic` 带出来，**绝不解析自由文本去猜**。

同时砍掉最容易写崩的部分：`criteria_results[].criterion` 从“必填 + 逐字回抄”改成**可选**（省略即按序号对齐）。防篡改保证没丢——给了就必须逐字相等，否则算漏报；漏报是**逐条比对**出来的，不是只数条数（中间空一格、两条标准报成同一条，都能查出来）。

### 4.4 端到端对照：没有走重试的那次

同一份基线代码、同样 5 条判据、同一个 lead，唯一变量是插件版本：

| | 修复前 | 修复后 |
|---|---|---|
| 步数 | 60（撞顶） | 60（**也撞顶**） |
| 工具调用 | 72（bash 67 / read 5） | 87（bash 84 / read 2） |
| `structured_output` 调用 | **0** | **1（成功）** |
| `turn/end` | `MALFORMED_RESPONSE` | **`completed`** |
| 结果 | needs_human，**无裁决** | **reject + 8 条 finding** |

注意：**没有走重试**。`verifier_attempts` 没出现 = 只派发了一次。所以这一次的成功来自**裁决体积变小**，不是重试兜住的：

```text
修复前：估计约 14k 字符（5 条判据逐字回抄 + 散文式证据）
修复后：实测 7864 字符
```

**重试是保险，体积才是疗效。** 两者都保留：重试在体积仍然写崩时有用，但不能用它掩盖体积问题。

闭环：这个 `reject` 是对的——`tools/bench/run.mjs` 独立证明基线版确实违反 4 条判据。验证者与基准在同一件事上互相印证。

诚实的边界：同时改了两样（`criterion` 变可选 + 提示词要求证据精简），所以“是哪一个起的作用”没有分离。可以说的是：**同样 5 条判据、同样撞 60 步，修复前写不出来、修复后写出来了。**

### 4.5 基准至少三维一起测

```text
抓住率  坏改动被拦        （只优化这一维，会优化出一个再也出不了裁决的验证者）
误伤率  好改动被误判      （比抓住率更重要——误伤会让人绕开门禁走）
完成率  验证者是否产出裁决
```

`verifier_sessions` / `verifier_attempts` 会如实报出“派发了几次”，**不把“重试过”抹掉**——那正是完成率要看的。

### 4.6 三个既有用例

2026-10-15 固化的三个用例：

```text
✅ 成立  看板默认页用例     基线违反 4 条 / 修复版违反 0 条
✅ 成立  误伤回归用例       基线违反 2 条 / 修复版违反 0 条
✅ 成立  平台白名单用例     基线违反 4 条 / 修复版违反 0 条
```

- 看板默认页用例测“丢掉了该动手的任务”；
- 误伤回归用例测“已 `approve` 的 REVIEWING 被报成在等人”，价值在于它测的是**误伤**（多报假求助信号），不是漏检；
- 平台白名单用例测“工具白名单没按平台选”。

判据要从当时的制品搬，不要现编。第一条用例的判据来自 intent 的「不改变默认行为」与 spec R1 的「向后兼容（逐字）」——而基线提交自己就违反了 R1。

**用例的真实来源是“修过的 bug”，不是“做过的任务”。** 历史上只有 3 条任务制品撑不起基准；而每个 bug 天然自带完整的一对：坏的那版在父提交里，好的那版在修复提交里。

### 4.7 读历史快照的陷阱

用例钉在历史提交上，所以冻结代码的失败报告会包含**当时真实的缺陷**。

实测踩到：独立验证者跑冻结的基线提交，报“冒烟 59/60 · 停滞计数应为 1，实际 4”，项目记录把它当成当前待办——其实那条早在后续提交里修了，当前代码是 69/69。

**先问一句“这是历史快照的问题，还是当前的？”，再动手。**

### 4.8 更正：“win32 没测过”这条不成立

先前记录写着“平台白名单用例的 win32 侧一次都没跑过（本机 darwin，没伪造 `process.platform`）”。前半句是真的，后半句暴露了真正的问题——当时把“没测”归因于“没有 Windows 环境”，而实际障碍是**没想到 `process.platform` 可以伪造**：

```text
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
```

实测 `darwin → win32 → darwin` 成功。平台白名单用例因此**两个平台都测了**，而且测出来的比原来记的更糟：

```text
基线（bash + pwsh 都写）
  darwin → [read, grep, glob, bash, pwsh]   不存在的: pwsh   ✗
  win32  → [read, grep, glob, bash, pwsh]   不存在的: bash   ✗
```

**不是“mac 上的 bug”，是“两个平台都坏”**——各被一个不存在的工具名绊倒。这属于「为平台 A 做的修复弄坏了平台 B」那一类。

同一个教训的一般化：**“测不了”这句话要先验证**。项目在这上面栽过不止一次（UI 的“做不出来”结论也是这么错的，见 §6.1）。说“做不到”之前，先确认试过的是**方法**而不是**结论**。

## 5. 测试场与组合缺陷

### 5.1 为什么放在独立仓库

插件的所有路径都相对 **session 的 cwd**，所以想真实使用它们，得把测试场作为**独立的 DSH 会话**打开。混在插件仓库里会互相干扰。

测试场刻意做成真实小项目，而不是空目录——空目录测不出插件真正会遇到的东西：

| 内容 | 用来测什么 |
|---|---|
| `src/cart/discount.py` + `tests/` | 测试冻结：`tests/` 是测试资产识别目标，冻结期间写它应当被拒 |
| 一处刻意留的缺陷 | 修复流程：先复现 → 冻结 → 改产品代码 → 解冻 |
| `Makefile` 的 `test` / `lint` | `test_evidence`：要有真实的命令与输出可贴 |
| 没有 `.ai/tasks/` | 从零走一遍 `sdlc_task_create` |

基线：`make test` → **7 条用例，1 条失败**（正是那个缺陷）；`make lint` → `lint ok`；`make check` → **21/21 通过**。

### 5.2 `make check` 为什么需要

插件自己的 `smoke.mjs` 用**内存 fs 桩**和自造任务树。这一轮的教训是「**两个组件各自都过，组合起来会坏**」：

```text
artifacts 为空 → 序列化器写 `{}` → 登记逻辑插在它后面 → 非法 YAML
```

这个严重缺陷两边单测都没抓到，在真实仓库里跑一遍就露出来了。所以 `make check` 刻意用**真实 git 仓库 + 真实 LocalFileSystem + 真实文件落盘**。

### 5.3 缺陷一：第一个制品登记写坏 `state.yaml`

序列化器给空映射写 `  {}` 占位符，而登记逻辑把 `{}` 当成已有条目、插在它后面 → 非法缩进 → 整个文件解析失败。

后果：**每个新任务的第一次登记**都会写坏事实来源。已修（两层都改）。

### 5.4 缺陷二：冻结期间 `make test 2>&1` 被误拦

重定向检测把 `2>&1` 当成了“往文件里写”。而 `2>&1` 是终端惯用法，不写文件。

后果很严重：**“改代码后跑测试确认变绿”是修复流程的核心步骤，却做不了。**

修法：在检测变更**之前**把 fd 重定向（`[0-9]>&[0-9]`）归一化掉。加了两条回归：`make test 2>&1` 等必须放行；真正的写入（含 `make test > /tmp/out.txt tests/` 这种真重定向 + 测试目标）必须仍被拦。

一般教训：**门禁的误伤和漏检一样是缺陷。** 误伤会让人绕开门禁走。两条缺陷都是**在真实仓库里走一遍**才暴露的——单测覆盖了组件，没覆盖组合。

### 5.5 路径配置与空串坑

测试场根目录从脚本位置推导；插件仓库默认从同级目录找，或用 `DSH_PLUGINS=<插件仓库>/packages` 指定。

⚠️ 用 `||` 而不是 `??`——实测踩到：`DSH_PLUGINS=`（空串）时 `??` 不生效，空串会被当成相对路径。

### 5.6 三次“没运行就声称”

1. 第一版测试场用 pytest，而环境只有标准库 unittest → `make test` 直接 ImportError。一个跑不起来的测试场没有价值。
2. README 写「两条失败」，实测只有一条（另一条没有断言）。
3. 写这一节时用了一个**已被删掉的锚点**，脚本静默地什么都没做。已改为锚点不存在就显式失败。

第一版检查脚本放在临时目录，重启就没了、且不可复跑。现已固化进测试场仓库的 `tools/`——工具不该住在临时目录。

### 5.7 旧任务残留不等于插件缺陷

真实测试场里仍可能有旧 `make check` 残留的任务目录（已 gitignore）。设计上要在干净隔离副本跑；不要把它当成插件缺陷。

另一次：`make check` 前置失败仍会修改旧任务的状态写入。已恢复本次状态并修正脚本立即退出；以后在干净隔离副本跑检查，不能把“报错”当成“已经停止”。

## 6. 客户端 UI：从“做不出来”到槽契约

### 6.1 早先的“做不出来”结论错在方法

早先写过“`sdlc-ui` 做不出来”。错的不是细节，是**方法**：三条理由里只有第 ③ 条（跑不了 tsdown）是实测的，①②③ 全是推断，而项目用“跑不了构建”推断出了“整条路不可行”。

订正后的三条对照：

| 早先的理由 | 实际 |
|---|---|
| ① 需要 tsdown Client preset | ❌ 客户端 bundle 是**普通 CJS 包装**，**手写即可**。`Builtin` 里明确有 `React`——“exposed **without JSX transformation**” |
| ② host→client RPC 是构建期生成的 | ❌ 有公共接口 `ctx.connection.fetch.register(route)`，注册在**已认证的 `/api` 通道**上 |
| ③ 渲染结果验证不了 | ❌ `dsh web` 是现成 profile；`desktop` profile 本身就挂着 `dsh-web-app`，端口 19387 就是它在服务 web UI |

### 6.2 实现与三个真跑才现形的 bug

实现：

```text
host 半   GET /api/sdlc-ui.tasks —— 读 .ai/tasks/*/state.yaml + verification.json
客户端半   手写（零构建），注册两处：
            main                  key='sdlc'      → 面板本体
            sidebar.panellist     id='sdlc'       → 一个 svg 图标
```

验证证据（在独立 web 服务上做，不碰日常 App）：

```text
端点   HTTP 200，841 字节，3 个真实任务（状态 / 裁决 / 制品）
boot   客户端半在 __DSH_BOOT__ 清单里（含 id / url / rev / inject）
bundle 合并 10.4 MB，内含 SdlcIcon / SdlcPanel / 取数路径
```

冒烟全绿、只有真跑才现形的三个 bug：

1. **路由路径少了 `/api` 前缀** → `1 entry did not activate`，**插件没激活但服务照起**。`endpointFromPath('/api', path)` 是硬要求。
2. **`ctx.fs` 要的是解析过的 target，不是字符串** → `listDir` 静默失败 → 端点 200、JSON 合法、repoRoot 正确，**只有任务是 0**。
3. **槽架构是错的**：把面板塞进了 `sidebar.panellist`（那是**图标**位，owner props 是 `{ size, active }`），而契约说 “Each list id **addresses the matching main panel**; the sidebar owns the button”。正确做法是 `main`（keyed）+ `sidebar.panellist`（list）**两处注册、共享同一个 id/key**。

⚠️ **槽契约只能从 live Slot 树查**（`cordis_inspect_query` 的 client/Slots），不要从别处推断——第 3 条就是这么发现的。

### 6.3 0.1.1 界面改版

统一列表 / 详情布局，增加搜索和工作区筛选，完整历史按需展开，适配窄屏和深浅主题。**同名任务必须用 `(repoRoot, id)` 识别**，不能只看任务 ID。

实测宿主测试 24、组件交互 8、冒烟 40；真实浏览器与桌面 App 已操作验证，tarball 已安装且文件逐字节核对。

### 6.4 2026-10-29 循环工作台

保留七阶段、四节点循环和右侧证据，新增独立只读 `/api/sdlc-ui.execution`，按登记的运行 ID 展示轮次，按成功工具结果与 history 展示修复。

语义边界：

- 重试不是新一轮；
- reject 不是修复；
- 缺 `finished` 不是正在运行；
- 历史证据不能打开最新文件冒充；
- 改动说明来自调用方；
- 发现与修复没有明确对应键就说明缺口；
- 原始参数、输出、配置与隐藏推理不返回 UI。

顺手修掉旧的工作区身份问题：显式 root 下无任务时必须 404，不能借用其他工作区的同名任务。读取工作区列表尊重 `DSH_HOME`，隔离 profile 不再读日常 profile 的列表。

最终全量：库 227 + UI 18 = **245** 单测、宿主接口 **32**、九组冒烟 **437**，compat 支持当前 **0.2.1-rc.3**，preset-sync **22 + 6**。真实 Chrome 用同一客户端源码和明确标注的本地夹具检查布局/交互，1421px、1120px 各 18 项通过。

**未完成真实 DSH 页面验收**：初始包已安装到隔离环境且可启动；浏览器认证访问没有重试，改用不连接 DSH 的本地组件预览。最终界面又有视觉修正，不能把初始启动说成最终实机验收。

### 6.5 2026-10-30 阶段交付物恢复

改版后看不到阶段交付物。接口仍返回文件名与章节，客户端却把它们压成底部小链接；阶段详情又只取单个文件。

修复后：

- 阶段条直接展示登记文件，顶部有完整清单，详情与底部卡片显示章节摘要；
- 两处共用阶段关联：验证包含裁决和 proof，实现明确把 plan 标为「实现依据」，完成阶段汇总全部；自定义交付物保留在完整清单中；
- 文件弹窗关闭后返回原阶段，未登记的阶段如实显示空状态；当前文件与历史轮次证据分开。

新增三项交互回归在旧代码全部失败，修复后通过。全量：库 227 + UI 21 = **248**，宿主接口 **32**，冒烟 **437**；compat 与 preset-sync 通过。真实 Chrome 本地夹具在 1421px、390px 各 **29** 项交互通过，含弹窗焦点、刷新后没有重复交付物区；没有脚本错误。该读数仍不替代真实 DSH 页面验收。

### 6.6 2026-10-31 阶段流转成为看板主视图

需求是看清评审或验收退到哪里、为什么退、怎么修改、后来去了哪里。

根因：旧主图固定画验证修复四节点，完整 `history` 却只藏在弹窗里。

现在直接用任务迁移记录画每次真实退回的来源和目标，选中后串起连续的后续路线、每次流转说明及重新提交。例如 `REVIEWING → SPEC` 和 `VERIFYING → PLANNED` 会画出不同路线，不默认退回实现。完整推进/退回记录可筛选；七阶段交付物入口保留；原逐轮验证视图折叠到「验证详情」。

语义边界：

- 重新进入原阶段只代表重新提交，不代表通过；
- 修复和验证提交按连续路线的时间范围展示，注明改动说明来自提交者，没有逐条问题与修改的明确对应键；
- 路线断开、当前状态不符或时间异常时不拼接证据；
- 只有当前裁决的旧任务不伪造历史；
- 刷新保留手动选择，记录消失明确提示。

宿主 API、状态机和依赖均未改变。库 227 + UI 27 = **254** 单测、宿主接口 **32**、九组冒烟 **437** 通过；最后调整修改记录的时间顺序后重建并复跑 UI 27 项。compat 已按自动升级后的 **0.2.1-rc.5** 核对，preset-sync **22 + 6** 一致。真实 Chrome 本地夹具在 1421、1120、390px 各 **40** 项交互通过；深浅主题截图已查看，控制台无错误/警告。仍未访问真实 DSH 页面。

### 6.7 2026-11-01 验证与评审交付物可以直接阅读

问题：`verifications/<run-id>.json` 已由验证器登记，但 UI 打开接口仍只允许顶层文件名，导致点击时报 `file 不合法`。

修复：

- 列表和打开现共用读取：允许任务内子目录，继续核对登记表与解析后的路径范围；
- 旧接口截取前 200,000 字符会截坏完整 JSON，现改为上限内返回全文，超过 16 MiB 明确报错；
- 标准正文按写入方的稳定 ID 对应，不按结果顺序猜。

展示：

- 验证与评审默认显示阅读报告，原始 JSON 按需展开；
- 结论、逐条依据、发现与建议、问题复验、未验证事项和评审风险保留；
- 评审兼容未知字段，没有评审结论不借用验证通过。

全量：库 242 + 客户端 35 = **277**，宿主 **51**，十组冒烟 **459**，隔离测试场 **21**；compat 与 preset-sync 通过。新增检查在旧宿主失败 10 项、旧客户端失败 5 项；新版均通过。真实 Chrome 本地示例在 1421px 深色、390px 浅色共 **39** 项通过，无错误/警告。已安装模块配真实 DSH LocalFileSystem 读取截图对应的两份文件，均 200 且正文一致。

这一轮没有取得独立模型裁决，相关任务保留 `VERIFYING`，没有伪造 `approve`。

## 7. 状态机、制品链与沙箱

### 7.1 端到端演示：四个机制咬合

一条完整走通的制品链：

```text
sdlc_task_create           → 建任务（state.yaml + intent.md 骨架）
sdlc_artifact_write ×3     → intent / spec / plan，结构合格才登记
sdlc_task_advance ×4       → INTENT→SPEC→PLANNED→IMPLEMENTING→VERIFYING
sdlc_verify + criteria(5)  → 第一轮 needs_human（5 条全部 cannot_tell）
```

这条任务后来被正确地打回并重新界定，过程本身是一次有价值的演示。

第一轮验证给 `needs_human` + 2 条 blocking：

1. **算错的数**：spec 映射表枚举 **10** 个内部状态，而 plan 等五处都写“9 个”，其中 plan 还要求单测“断言 == 9 个”——那条单测在 spec 自己的表上必然失败。
2. **事实来源自相矛盾**：`state.yaml` 里先写“不写真实产品代码”，紧接着写“实现完成”。验证者把这个问题原样交还给人：「本任务的交付范围到底是什么？」

处置（2026-10-07）：

1. **回退** `VERIFYING → PLANNED`（第一次在真实会话里跑通回退路径——它要求目标状态的门槛成立，不是随便退）；
2. 标题改为「工作流演示：制品链 + 独立验证」，不再声称实现了理赔功能；
3. 删掉针对**已废弃说法**的旧裁决（可在 git 历史取回；删除一事记在 `state.yaml` 的 history 里，不是毁证据）；
4. **用正确的判据重跑**：判据针对制品链（如实性 / 章节齐备 / Proof 与验收标准对应 / spec 内部自洽），不针对假想的理赔功能 → `approve`，四条全 `met`。

重跑验证者**逐行数出**了表格里的 10 个状态并与文中五处对账，`grep '9 态|9 个|九'` 零命中——修好了。它还独立跑了 `sdlc-artifact` 的结构检查器复核三个制品（`ok=true findings=[]`）。

它另外抓到一件漏了的事，而且是对的：**改完工作区没提交**，而 `AGENTS.md` 仍写着旧状态——“这正是仓库自己反复强调要避免的两份真相漂移”。

这次验证的价值在于**验证者抓到了作者自己算错的数**：制品链的事实来源自相矛盾，导致它给出的验收标准无法实现——这是结构检查查不到、只有独立阅读才能发现的一类缺陷。

它另外指出两条值得记的：

- **`VERIFYING` 的门槛只有 intent/spec/plan**，所以零代码证据也能宣布“实现完成”。这是状态机的结构局限，不是演示场景的问题。
- **“对外只暴露 4 态”的定义面不清**：设计把映射放在门户侧、API 返回内部状态码，于是内部术语仍跨过网络边界。四态保证只由前端承担，API 侧不可强制。

### 7.2 `sdlc-status`：嵌套制品误报

2026-10-19 修（0.1.2）：看板只列任务目录的**顶层**文件，于是 `state.yaml` 里登记的 `evidence/x.json` 被报成“文件不在”，而同一时刻 `sdlc_task_status` 说磁盘上都在——两个读数互相矛盾。

修法：按 `state.yaml` 的 artifacts 路径逐个 `stat`；冒烟夹具加了嵌套制品。隔离 profile 实测：`incomplete` 从 1 变成 0。

状态：

- 单测 **24/24**（跨任务扫描纯函数层）；
- 运行时冒烟 **27/27**（真实 `LocalFileSystem`）。

前三个插件的冒烟都用内存 `ctx.fs` 桩，而“桩忽略参数 = 测试对这类问题失明”（沙箱接线 bug 正是这样漏过去的）。这次在 `mkdtemp` 的临时目录里造真实任务树，同时验证了真实 `listDir`/`stat`/`readText` 与沙箱路径解析。

含**只读性**断言：调用前后比对整个文件树与 mtime，必须完全一致。

关键设计：**坏任务不拖垮全局**。一个任务的 `state.yaml` 被手改坏，看板仍要报出其它任务——出问题的时候最需要能看到东西。

状态机常量**从 `sdlc-task` 导入**（`exports["./state"]`），不复制一份——项目已经吃过一次“两份真相漂移”的亏（`sdlc-verify` 的 schema 漂移）。

### 7.3 `sdlc-task`：三个 YAML 缺陷

单测 **25/25**（状态机纯函数层）；运行时冒烟 **30/30**（真实 Cordis + ToolRuntime + `ctx.fs` 内存桩，跑完 create → status → advance 全流程）。

单测抓出 3 个会在生产里崩的 bug：

1. `yamlScalar` 只按首字符决定加引号 → 含 `: ` 或 ` #` 的标题**写出非法 YAML**；
2. `created` / `updated` 缺失时静默填当前时间 → **伪造事实来源**；
3. 用 js-yaml 默认 schema 解析 → ISO 时间戳变 `Date` 对象 → **读任何正常写出的 `state.yaml` 都崩**。修法：`JSON_SCHEMA` + 对 Date 容错。

`sdlc_task_advance` 支持 `artifacts` 参数：迁移与登记**原子完成**。没有这个能力时，调用方只能手改 `state.yaml` 才能满足下一状态门槛，状态机就守不住自己的规矩。

真实会话端到端跑通：create 建目录 + `state.yaml`、status 报缺失项、缺制品时 advance 被拒并点名缺什么、`artifacts` 参数原子登记后放行。

回填 `sdlc-verify`：接受 `task_id` 自动解析制品、裁决落盘 `verification.json`、冻结绑定 task（拒绝信息带任务归属，错 `task_id` 解冻被拒）。真实 `sdlc_verify` 返回过 `approve`；落盘沙箱策略修复已确认生效。

落盘后**自动把 verification 登记进 `state.yaml` 的 artifacts**——只写文件不够，状态机看的是 artifacts（独立验证者指出的不一致）。

### 7.4 criteria 强制策略与“漏报被静默吞掉”

加 `criteria`（逐条验收标准强制裁决）后：单测 23/23、冒烟 79/79。

强制策略**由代码执行**：

- 没给 criteria 时 `approve` 降级为 `needs_human`；
- 有 `cannot_tell` / `not_met` 时同样降级；
- 漏报标准补 finding。

抓到一个严重 bug：`enforceCriteriaPolicy` 的早退分支丢掉了 findings，使「漏报 N 条标准」这条 finding 永远不出现——即**漏报被静默吞掉**。抓不到的原因是它一直**穿过整个工具调度**被测；移到纯函数层后一次暴露。

整轮独立验证通过：tsc 两包 0 错误、单测 13+23、冒烟 64+29 全部复现；dependencies 无 `@deepseek-ai/*`。该验证者还自行核查了“测试跑的是不是当前代码”（比对 `lib/*.js` 与 `src/*.ts` 的 mtime），排除了项目屡次踩到的“测试跑旧模块”失败模式。

### 7.5 重启加载新模块后才出现的 4 个 bug

这条本身就是教训：**上一轮所有测试跑的都是旧模块**，所以四个 bug 一个都没抓到。

1. **沙箱接线**（`sdlc-task`）：`fs.resolve` 没带 cwd、`writeText` 没带 policy → 落到部署 fallback 根 → “写自己仓库”被判越界。
2. **跨平台白名单**（`sdlc-verify`）：为修 Windows 把 `pwsh` 加进 allow，而 `tools.restrict()` 对不存在的工具名**直接抛错** → macOS 上验证整条通路报错。修法：按 `process.platform` 只放本平台存在的那个。
3. **同一个沙箱坑第二次**（`sdlc-verify` 的落盘路径）：修了 A 包没 grep B 包。这次是**验证者抓到的**——它裁决没问题，但 summary 里如实带出了落盘失败。
4. **假通过的断言**：`dispose` 断言写死“恰好 3 次”、计数器放在会被临时替换的 impl 里 → 新增用例后假失败/漏计。改为比对两个实际计数。

## 8. RSI：从记录到改进

### 8.1 首版（2026-10-15）

- `sdlc-verify/record` 是 awaited 事件，按 `run_id` 记录 `started` / `prepared` / `attempts` / `finished`；异常、取消与无裁决均留下记录。原任务最新裁决与完整运行历史分开。
- `sdlc-rsi` 保存代码与制品快照、实际 request 配置、有界会话 trace，提供 `runs` / `analyze` / `experiment` / `feedback` 四个工具与改进方法 Skill。
- 实验真实调用验证器，首版只改变附加指导。结束时也要核对制品；用 `call_id` 关联异常，不能猜“最近一次”；同次请求配置变化不得靠集合去重掩盖。
- **更快失败不算改善。参考答案不在 prompt 里也不代表隔离。** 同一文件系统可以读到协议答案，当前运行时必须保留限制并禁止推荐候选。只有隔离执行环境解决盲评后才能放开正向建议。
- 本次实测：RSI 单测 38、真实运行时冒烟 62；verify 单测 48、冒烟 106。真实模型已返回 `reject` 并记录完整输入/配置/trace；确定性冒烟不等于模型效果提升。
- 原始 `.ai/rsi/` 默认忽略，因为它含完整输入、代码与工具输出且无通用脱敏。核对后的真实任务结论仍应提交。
- **重复安装同路径同版本 tarball 可能复用旧文件**：安装器报 Already up to date，安装文件却未含最后修复。换带内容哈希的 tarball 路径后才更新；应对比安装文件与构建文件，不以安装成功作版本证明。

### 8.2 RSI 0.4.0（2026-10-22）

目标是用真实任务的执行过程改进插件。

来源问题：一个真实任务的六次验证都有裁决，但旧 RSI 六份记录的实际配置与工具结果均为零，代码快照不完整，分析却没有提示缺口。

根因：

- 作者与验证者分属兄弟 preset，普通监听器看不到验证者；
- 工作目录又是多仓库父目录。

两个必须分开的判断：**任务完成**与**证据完整**。不能用五次 reject 本身推断插件有缺陷。

0.4.0 的做法：

- 只观察明确登记的会话，用 `sessionQuery` 补漏并对账；缺失、截断、失败会影响记录健康状态。
- 任务操作独立记录调用、归属、切换边界和实际执行版本，再写任务索引。重启、旧索引写失败、跨版本仅写制品都要覆盖；不能只测各自成功的情况。阶段快照与 `state/history` 逐项核对。
- 代码按工作区内仓库采样，指纹排除任务/RSI 记录；提交记录不算代码变化。链接、submodule、超限和取样漂移明确报不完整。历史起点未知就保留 `null`，不填当前采集器版本。
- `tasks/analyze/propose/improve/feedback` 连接真实任务、带引用的假设、普通开发任务、两版对照和后续真实任务。引用固定当时内容；采用时核对同一提案和已完成开发任务。诊断与报告注明来自调用方，哈希只检查内容一致，不代表原因已独立成立。
- 看板显示执行记录完整性和待复盘状态；原始 `.ai/rsi` 仍忽略，只提交经过检查的摘要。

全量通过：单测 222（lib 213 + UI 9）、看板宿主 26、九个冒烟脚本 437；四个版本对照均成立，RSI 对照旧版失败 4 项、新版失败 0 项；compat 两包、preset-sync 22 + 6 行、隔离测试场 21 条通过。独立审查提出的问题已修复并复查。最终 tarball 58 文件；安装后 32 个发布 JS 与 patch 对账一致，隔离启动无激活警告，看板 API 200。

本轮验证范围仅限隔离环境。确定性模型夹具证明记录机制，不证明模型质量或真实任务耗时普遍改善。真实 Chrome 已查看新增记录区并展开缺口：DONE 夹具仍显示证据不完整，旧任务显示尚未确认；截图在 `output/playwright/rsi2-record-health.png`。这不替代更广泛的 GUI 验收。

### 8.3 安装成功不等于进程已加载

同一版本重复安装、或安装后不重启，都可能让“安装文件已更新”与“运行进程仍用旧模块”同时成立。

可复用的检查顺序：

1. 安装文件与已验证构建逐个核对（发布 JS + patch）；
2. 隔离 profile 启动，检查有无 `entry did not activate`；
3. 完全退出并重开 DSH，再看 `plugin_manager list_plugins` 的 `fiberPhase` 与实际行为；
4. 新建会话并选择「AI 原生 SDLC」，不要拿已有会话推断新组合。

安装前保留 profile 的 `package.json` 与锁文件副本；只改 SDLC 引用，其他依赖与 bundles 列表保持不变。安装成功本身不能作为版本证明。

### 8.4 0.5.0：问题处理与独立复验成为任务事实

三个真实任务的十轮验证证实了三个缺陷：

1. 问题没有逐项处理与退回关系；
2. 裁决漏项仍保留 `approve`，阶段准入只查文件；
3. 16 MiB 写入与 4 MiB 读取不匹配，造成过程丢失。

另有一个真实任务未发现最终 `reject` 却已完成；这种放行可能由真实工具夹具证明，但项目没有把它冒充成历史事故。

修复后的语义：

- `sdlc_task_issue` 登记审核发现、退回、作者提交和延期；阻断问题不能延期，作者不能自行关闭。退回与问题动作同写。完成后报告新问题会重开审核。旧裁决首次重试时归档并保留问题。
- 验收标准按稳定 ID 对账；每项提交的问题要有独立结果。重复失败保留原问题编号；“已解决”与对应标准未通过相矛盾时不能关闭。缺项、未知/重复 ID 均不能 `approve`。
- 每轮裁决、标准与代码/intent/spec/plan 内容版本持久化；阶段准入重查，单纯 Git 提交不误伤。直接 verify 也检查处理状态。改代码/制品/标准后必须有相应退回；取消后的迟到结果不能覆盖。
- `task` / `artifact` / `verify` 共用状态写锁与 fs 版本检查，避免登记制品时丢掉流程记录。
- 看板按问题显示原因、去向、修改证据与独立复验，每页 20 项。新会话另写小摘要；旧会话有界回读，只恢复有归属证据的轮次与操作，不补造过去没登记的退回。

读数：库 242 + 客户端 30 = **272**，宿主接口 32，10 组冒烟 **455**；测试场 21；5 个双侧基准均成立（旧版违反 9 项、新版 0）；桌面/手机本地夹具各 45 项交互通过。compat 接受当前 App `0.2.1-rc.5`，preset 22 + 6 行一致。最终包 40 个发布 JS 与 patch 均一致。

本轮模型结果为确定性夹具，未取得独立模型裁决，所以任务保留 `VERIFYING`，不伪造 `approve`。

## 9. 控制边界、DSH 约束与 Skill

### 9.1 客户端控制不等于发布边界

最早的门禁是文本匹配：检查命令里有没有 `git push origin main`。用 base64 编码执行同一条命令就绕过了。

这不是实现缺陷，而是边界：**客户端控制总能被绕过**。发布授权、分支保护、密钥属于 Git/CI/RBAC，不要试图在插件里实现它们。

### 9.2 服务端分支保护：先验证，再提议

早期曾四次建议“配一下默认分支保护”，一次都没验证可行性。实测返回 HTTP 403，提示需要升级套餐才能启用：

- 经典分支保护需要付费能力；
- Repository rulesets（较新机制）同样需要；
- 免费的 CI 只有托管平台自带的工作流。

CI 能跑的检查有上限：

| 检查 | CI 能否跑 |
|---|---|
| `tsc` + 单测（约 143 条） | ✅ 纯 node |
| 两套冒烟 + `make check`（约 194 条） | ❌ 依赖本机安装的 DSH App（从 `app.asar` 取 `node_modules`） |

而且 **CI 不构成门禁**：没有分支保护时，工作流失败**不会阻止合并**，甚至不会阻止直接 push 到默认分支。它是“留痕 + 事后审计”，不是“拦住”。

项目记录决定暂不处理（2026-10-08）。所以不要再提议配分支保护——除非同时说清成本或前置条件；现有控制全是客户端的，项目已反复证明它们可被绕过。

### 9.3 DSH 的当前能力缺口

1. **类型定义**：运行时既没有 `.d.ts` 也没有 `src/`。`npm pack @deepseek-ai/dsh-xxx@<version>` 可取 `lib/types/**/*.d.ts`。
   - 订正：这条对 App 的 `app.asar` 里的运行时成立，但**对开发仓库的 `node_modules` 不成立**。开发仓库 `node_modules/@deepseek-ai/` 下 29 个包都有 `lib/types/`，`find … -name '*.d.ts' | wc -l` = 150。所以“类型必须去 npm pack 取”只在离线/分发场景才需要。
   - 这条是一个子代理做基准测量时如实报出来的“题干与实测不符”，已复核。
2. **不要用 PATH 上的 `dsh`**（可能是别的版本）。用 App 自带 CLI（`dsh-desktop-host/lib/cli.js`），配 `ELECTRON_RUN_AS_NODE=1` 和 App 的 MacOS 可执行文件。
3. **Agent preset 没有发现机制**：没有目录扫描、没有环境变量、没有 CLI 参数。只能靠 bundle 补丁的行贡献或覆写。
4. **只有 `spawn` / `fork` 两个 subagent provider**。四个外部后端不在运行时里，npm 上的版本 peer 与 `0.2.0-rc.2` 不兼容 → **异构模型验证当前做不到**。
5. **`outputSchema` 只能由插件代码请求**，模型不能。这是好事：“强制结构化裁决”无法被模型绕过。
6. **工具过滤（`toolFilter` / `tools.restrict()` / preset）不过滤别的插件注册的静态提示词**。被过滤的子代理仍会读到“用 write 工具…”之类的文字。已在 verifier persona 里加防御说明。
7. **DSH 没有**：网络管控、受保护路径、不可覆盖的管理层、模式化 allow/deny、入参改写、审批人归属、规范日志脱敏、连续 OTel 导出。

另：0.2.0 的 `toolFilter` 只过滤继承面。当时验证者工具面里仍有 `subagent`，靠 `maxDepth=1` 使它“存在但不可用”。0.2.1 改用 preset 后，实测工具面是 `bash glob grep read read_image skill structured_output`，`subagent` 与全部 `sdlc_*` 都不在了。这条只适用于 0.2.0，不要再当现状引用。

### 9.4 Skill 注册接口

实测确认的接口：

- `dsh-base` 的 patch 里挂了 `@deepseek-ai/dsh-skill` 与 `dsh-skill-filesystem`。
- 插件侧接口：`ctx.effect(() => ctx.skills.register({ ... }))`。
- `SkillRegistration` 需要 `name` / `description` / `content` / **`source`**（漏 `source` 会被 tsc 拒；用 `'bundled'`）。
- **返回值是 disposer，必须交给 `ctx.effect()` 托管**。丢掉它 = 卸载时 Skill 不归还，留下指向已卸载插件的悬空注册（冒烟的“归还”断言抓到了这一条）。
- 卸载入口是 **`ctx.fiber.dispose()`**，不是 `ctx.dispose()`（后者不存在）。
- 类型解析：`@deepseek-ai/dsh-skill` 要装进仓库根的 `node_modules`。

### 9.5 “验证者能加载 Skill”只能靠外部观测

验证者**自己无法证明**“能加载那份 Skill”。唯一决定性的观测点是**它的会话日志里有没有 `skill` 工具调用、以及返回体是不是完整正文**。

一次实测的会话工具统计：

```text
{ bash: 86, read: 12, skill: 1 }
```

那次调用的返回是完整的 `<skill_content name="sdlc-verification-discipline">` + 七条正文。**这条链通了——`sdlc-workflow` 不是装饰。**

⚠️ 同一次验证**没产出裁决**（`stop_reason=error`，99 次工具调用后）。这是该失败模式的第二次；教训与第一次相同：**判据别贪多，尤其是“核对源码/说明为什么”这类元问题**——它们会显著抬高探索成本。实测跑得完的量级是 **4–6 条**，且不要塞元问题。

### 9.6 内容与机制分离

- 内容（`SKILL.md` 正文、制品模板）写成 harness 无关的形式；
- 路径绑定交给配置，**不要复制两份内容**；
- 一条必须无例外成立的组织知识 → 写成 Skill **并且**加一个 guard，因为 Skill 只是建议性控制（实测确认：只有 guard/deny 才有约束力）。

### 9.7 其他历史订正

- **“类型只在 npm tarball 里”**：见 §9.3 第 1 条的订正。不要再用绝对句。
- **“`sdlc-ui` 做不出来”**：见 §6.1。错的不是细节，是方法。
- **“win32 没测过”**：见 §4.8。平台分支已测；未测的是另一件事（真实 pwsh 的 cmdlet 识别）。
- **“`dsh plugin add` 一定不写 bundles”**：见 §2.8。装完读 profile 的 `package.json`，不要用绝对句。
- **“冻结能防篡改”**：冻结只是流程摩擦 + 留痕；作者自己调一次 `sdlc_fix_end` 即可解冻。测试资产识别是名字模式表，shell 通道是文本启发式，等价写法可以绕过。
- **“单测通过 = 功能可用”**：不成立。加载成功 ≠ 可用；符号链接安装通过 ≠ 真实分发可用；旧模块测试通过 ≠ 新模块可用。涉及接线的改动必须真实操作验证。
