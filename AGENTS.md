# AI 原生 SDLC × DeepSeek Harness

本仓库把 Anthropic《AI 原生 SDLC 实战手册》的方法论落成 **DSH 插件**。
手册中文全译在 `handbook/`。本文件是 agent 的项目记忆，每次会话开始时读取。

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
| `packages/sdlc-task` | 任务状态机 + 制品链（state.yaml 在 git） | ✅ 已实现，待装入 desktop |
| `sdlc-artifact` | 制品写作工具 | ⬜ |
| `sdlc-skills` | 方法论 Skill 与提示词段 | ⬜ |
| `sdlc-release` | Gate 前的工作 | ⬜ |
| `sdlc-ui` | 客户端制品链面板 | ⬜ |

## 目录

```
packages/sdlc-verify/     # 独立验证 + 测试冻结
  src/index.ts            #   插件入口：工具 + guard + 提示词段
  src/verdict.ts          #   裁决 schema、persona、提示词构造
  src/test-freeze.ts      #   测试冻结判定（纯函数，可脱离 DSH 单测）
packages/sdlc-task/       # 任务状态机 + 制品链
  src/index.ts            #   三个工具 + 提示词段（文件走 ctx.fs）
  src/state.ts            #   状态机与 state.yaml 形状（纯函数，可脱离 DSH 单测）
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
- [x] 单测 **13/13**（纯函数层）
      · 口径要诚实：`实测过的绕过手法必须被拦` 这条用例里的 10 种写法，
        在上一版实现下**就已经全部被拦住**，所以它是**守恒断言**（防止重构弄丢），
        不是回归证据。
      · 本轮真正的回归是 3 个**当时无人覆盖**的缺口（不是"曾被放行"）：
        `npx jest -u` 不带路径、`dd of=tests/x.py` 的 key= 前缀、以及快照模式里
        `-u` 写错成 `--?-u`（写成 `--?-u` 时既不匹配 `-u` 也不该匹配 `--update`）。
- [x] 运行时冒烟 **47/47**（`smoke.mjs`：真实 Cordis + 真实 ToolRuntime，
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

### sdlc-task 的状态

- [x] 单测 **23/23**（状态机纯函数层）
- [x] 运行时冒烟 **26/26**（真实 Cordis + ToolRuntime + `ctx.fs` 内存桩，
      跑完 create → status → advance 全流程）
- [x] 单测抓出 3 个会在生产里崩的 bug（均已在测试里锁住）：
      ① `yamlScalar` 只按首字符决定加引号 → 含 `: ` 或 ` #` 的标题**写出非法 YAML**；
      ② `created/updated` 缺失时静默填当前时间 → **伪造事实来源**；
      ③ 用 js-yaml 默认 schema 解析 → ISO 时间戳变 `Date` 对象 →
        **读任何正常写出的 state.yaml 都崩**。修法：`JSON_SCHEMA` + 对 Date 容错。
- [x] `sdlc_task_advance` 支持 `artifacts` 参数：迁移与登记**原子完成**。
      没有这个能力时，调用方只能手改 `state.yaml` 才能满足下一状态门槛，
      状态机就守不住自己的规矩。
- [ ] 待装入 desktop profile 做真实端到端验证
- [ ] 回填 `sdlc-verify`：接受 `task_id`、冻结改为按 task 记账

## 待用户决策

- 是否把 `main` 分支保护配上（我测过的所有控制里**只有服务端分支保护不可绕过**）
