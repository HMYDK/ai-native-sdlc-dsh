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

## 交付形态：插件 bundle，不是仓库脚本

第一版我错误地做成了「git 仓库 + shell 脚本 + md 约定」，
那不是 DSH 插件，只是一个跑在 DSH 里的外部工具集。已废弃。

正确形态：**npm 包 + `dsh.bundle.patch`**，`dsh plugin add` 即自动挂载。

## 拆分原则：按机制，不按阶段

DSH 可挂的扩展点只有四个（工具拦截 / 工具与 Skill 注册 / 提示词组装 / 客户端 UI），
与 SDLC 六个阶段**完全不正交**。按阶段拆会让一个制品链跨六个包、
一个拦截点被六个插件注册。

规划 6 个插件，MVP 2 个。**顺序是「先 verifier」**——它输出结构化 PASS/FAIL，
是唯一能被严格自动验证的插件。

| 插件 | 机制 | 状态 |
|---|---|---|
| `packages/sdlc-verify` | 独立验证 + 测试冻结 | ✅ 已实现并端到端验证 |
| `packages/sdlc-task` | 任务状态机 + 制品链（state.yaml 在 git） | ✅ 已实现并端到端跑通 |
| `packages/sdlc-artifact` | 制品撰写 + 结构检查（只查结构） | ✅ 已实现并端到端跑通 |
| `packages/sdlc-status` | 任务看板（一次盘出所有任务的状态/缺失/裁决） | ✅ 已实现（真实 fs 冒烟） |
| `sdlc-release` | Gate 前的工作（PR 描述、CI 证据汇集） | ⬜ |
| `sdlc-workflow` | 工作流本身，作为一份 **Skill** 交付给验证者 | ✅ 已实现（12 条冒烟） |
| `packages/sdlc-ui` | 客户端制品链面板（侧栏图标 + main 面板） | ✅ 已实现并端到端验证（24 条冒烟） |

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
    （本机版本 `0.1.5-rc.3`，比 npm 上的 `0.2.0-rc.2` 旧，但 `register()` 签名一致）
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
packages/sdlc-verify/     # 独立验证 + 测试冻结
  src/index.ts            #   插件入口：工具 + guard + 提示词段
  src/verdict.ts          #   裁决 schema、persona、提示词构造
  src/test-freeze.ts      #   测试冻结判定（纯函数，可脱离 DSH 单测）
packages/sdlc-task/       # 任务状态机 + 制品链
  src/index.ts            #   三个工具 + 提示词段（文件走 ctx.fs）
  src/state.ts            #   状态机与 state.yaml 形状（纯函数，可脱离 DSH 单测）
packages/sdlc-artifact/   # 制品撰写 + 结构检查（只查结构，不查质量）
packages/sdlc-status/     # 任务看板（只读；坏任务不拖垮全局）
  src/scan.ts             #   跨任务扫描与聚合（纯函数，可脱离 DSH 单测）
docs/                     # DSH 契约与调研（改代码前必查）
handbook/                 # 手册原文，只读
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
`node tools/bench-status-page.mjs`）。这件事**比它看起来重要**，因为
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

⚠️ **这条通路的端到端效果还没有独立读数**：插件模块要**重启 App** 才加载，
所以本轮改完跑不了"同一个 5 条判据实验"。已有证据是单测 43、冒烟 86
（含 6 条重试断言：用桩证明"第一次失败 → 第二次的裁决被采纳"，
以及"两次都失败 → needs_human 而不是猜"）。**重启后应重跑那个实验。**

### 基准至少三维一起测，只测一维会优化出更糟的系统

    抓住率  坏改动被拦        （只优化这一维，会优化出一个再也出不了裁决的验证者）
    误伤率  好改动被误判      （比抓住率更重要——误伤会让人绕开门禁走）
    完成率  验证者是否产出裁决

`verifier_sessions` / `verifier_attempts` 会如实报出"派发了几次"，
**不把"重试过"抹掉**——那正是完成率要看的。

### 三个已实测过的历史 bug（可作基准用例的种子）

同一手法对四条候选全部跑通（2026-10-15）：把修复前后的模块各自编译，
喂同一组输入，**看差异是否只出现在该变的那一组**。

| bug | 可测层 | 修复前 → 修复后 | 守恒组 |
|---|---|---|---|
| `47e5dae` fd 重定向被误拦 | 纯函数 `judgeTestMutation` | `make test 2>&1` **拦截 → 放行** | 真写入 8 条仍拦、只读 5 条仍放行 |
| `ddc4241` 假求助信号 | 纯函数 `classifyStaleness` | REVIEWING+approve：**`waiting` → `active`/`stale`** | reject / needs_human / 无裁决 零溢出 |
| `52212ad` pwsh 白名单 | **接线层**（桩服务调真实 `apply()`，不需要 Electron） | `allow` 含 `pwsh` → **`restrict()` 抛错**；去掉后通过 | — |

⚠️ `52212ad` 的 **win32 侧一次都没跑过**（本机 darwin，没伪造 `process.platform`），
所以「修复没弄坏 Windows」至今无证据——这条与「已知边界」里那条 `pwsh` 是同一件事。

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
6. **`toolFilter` 不过滤别的插件注册的静态提示词**。被过滤的子代理仍会读到
   "用 write 工具…"之类的文字。已在 verifier persona 里加防御说明。
7. **DSH 没有**：网络管控、受保护路径、不可覆盖的管理层、模式化 allow/deny、
   入参改写、审批人归属、规范日志脱敏、连续 OTel 导出。

## 当前状态

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

- **冻结不是防篡改边界**：Actor 自己调一次 `sdlc_fix_end` 即可解冻。
  它是流程摩擦 + 留痕，不是硬约束。
- **测试资产识别是名字模式表**：未覆盖的命名不会被冻结。
- **shell 通道是文本启发式**：不落进模式的等价写法可绕过。
- **`pwsh` 通道**：cmdlet 识别已加、纯函数层已单测，但**未在 Windows 上实测**。
- **`toolFilter` 只过滤继承面**：验证者的工具面里仍有 `subagent`。
  但我用探针（冻结 → 派子代理 → 让它写测试文件）**实测出了答案**：
  调用返回 `Error: subagent depth 2 exceeds maxDepth 1` —— 验证者本身在 depth 1，
  而 `maxDepth` 默认 1，**它派不出任何子代理**。所以 `subagent` 在那里是
  「存在但不可用」，不是逃逸通道。
  ⚠️ 但这是**配置依赖**的：若把 `maxDepth` 调大，这条路就会打开。
  届时应确认工具限制是否沿继承链传递（`restrict()` 只作用于继承面，
  孙代理能否拿到 write/edit 需重新实测）。
- 真正的硬约束应落在工具限制/沙箱层，或服务端分支保护。

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
