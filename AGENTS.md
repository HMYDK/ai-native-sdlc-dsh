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
| `packages/sdlc-verify` | 独立验证 + 测试冻结 | ✅ 已实现并实测加载 |
| `sdlc-artifact` | 制品写作工具 | ⬜ |
| `sdlc-task` | 任务状态与制品链 | ⬜ |
| `sdlc-skills` | 方法论 Skill 与提示词段 | ⬜ |
| `sdlc-release` | Gate 前的工作 | ⬜ |
| `sdlc-ui` | 客户端制品链面板 | ⬜ |

## 目录

```
packages/sdlc-verify/     # 已实现的插件（TypeScript → lib/）
  src/index.ts            #   插件入口：工具 + guard + 提示词段
  src/verdict.ts          #   裁决 schema、persona、提示词构造
  src/test-freeze.ts      #   测试冻结判定（纯函数，可脱离 DSH 单测）
docs/                     # DSH 契约与调研（改代码前必查）
handbook/                 # 手册原文，只读
```

## 工程约定

### 写插件必守（每条都踩过，全是"警告后继续"的静默失败）

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

- [x] `sdlc-verify` 插件：类型检查零错误、单测 9/9、打包内容核对、
      隔离 profile 启动实测**全部条目激活成功**
- [x] desktop profile 已安装 tarball 版本（待重启生效）
- [ ] 端到端实测：真实跑一次 `sdlc_verify`，确认结构化裁决能拿到
- [ ] 端到端实测：测试冻结 guard 在真实会话里拦得住
- [ ] 其余 5 个插件

## 待用户决策

- 是否把 `main` 分支保护配上（我测过的所有控制里**只有服务端分支保护不可绕过**）
- MVP 第二个插件选哪个：`sdlc-task`（状态与制品链）还是 `sdlc-artifact`（制品工具）
