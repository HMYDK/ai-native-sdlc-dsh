# AI 原生 SDLC × DeepSeek Harness

把 Anthropic《[AI 原生 SDLC 实战手册](https://claude.com/resources/articles/the-ai-native-sdlc-playbook)》
的方法论落成 **DeepSeek Harness 插件**。手册中文全译在 [handbook/](handbook/)。

## 定位（先读这段，它决定后面所有取舍）

**Harness 决定「Agent 如何工作」，Git/CI/RBAC 决定「工作对不对、能不能上线」。**

这句话不是口号，是实测结论：客户端的一切控制都能被绕过。
我对自己的门禁做过一次实验——`printf '%s' 'git push origin main' | base64 -D | sh`
就绕过去了，因为门禁在匹配命令文本。

所以本仓库的目标**不是**「用 Harness 做合规管控」，而是：

> 把方法论里**本来就该机器保证**的部分（验证、证据、流程状态）
> 做成 Harness 里的一等公民；把**不能**由客户端保证的部分
> （发布授权、分支保护、密钥）明确留给 Git/CI/K8s。

## 架构：按机制拆插件，不按阶段拆

文档原方案按 SDLC 阶段拆 7 个插件。我改成按**扩展点/机制**拆，理由：

- DSH 可挂的扩展点只有四个：工具拦截、工具/Skill 注册、提示词组装、客户端 UI
- 这四个点与六个阶段**完全不正交**
- 按阶段拆会让**一个制品链跨六个包**，且**一个拦截点被六个插件注册**

规划中的插件（**全量 6 个，MVP 2 个**）：

| 插件 | 拥有的机制 | 状态 |
|---|---|---|
| `sdlc-verify` | 非 Actor 的独立验证 + 测试冻结 | ✅ **已实现** |
| `sdlc-artifact` | 制品写作工具（intent/spec/plan 合并）| ⬜ |
| `sdlc-task` | 任务状态与制品链（`.ai/tasks/<ID>/state.yaml`）| ⬜ |
| `sdlc-skills` | 方法论 Skill 与提示词段 | ⬜ |
| `sdlc-release` | Gate **之前**的工作（MR / CI / staging 报告）| ⬜ |
| `sdlc-ui` | 客户端：制品链面板 | ⬜ |
| `sdlc-rsi` | 真实验证记录、复盘、指导文字对照实验 | ✅ 首版已实现 |

**MVP 先做 verifier，不是先做 plan。** 原因：verifier 输出结构化 PASS/FAIL，
是唯一能被严格自动验证的插件；`plan` 输出给人看的 markdown，很难自动判断好坏。
而且手册自己说"Verification 是最值得优先建设的部分"。

## 已完成：`sdlc-verify`

见 [packages/sdlc-verify/](packages/sdlc-verify/)。

### 两条机制

**1. `sdlc_verify` —— Actor ≠ Verifier**

启动一个验证子代理，四个机制共同保证它不是实现者：

| 机制 | 作用 |
|---|---|
| **新会话** | 验证者看不到 Actor 的推理过程，只看制品 |
| **独立 Agent Preset** | preset 里只挂只读工具：`tool-fs` 关掉 write/edit，不放委派/联网 |
| **preset 内 deny 全部宿主 global 工具** | 宿主工具是全局注册的，不挡的话验证者能解冻测试、推进任务 |
| **独立 `persona`** | 明确"你没写这段代码，也别相信关于它的说法" |
| **`outputSchema` 强制结构化** | 必须提交机器可读裁决，不能只给一段自然语言 |

> **关于"只读"的如实说明**：真实运行时测到的工具面是
> `bash glob grep read read_image skill structured_output`。
> 保留 `bash` 是因为验证者必须能**跑测试**来复核作者的证据，而 `bash` 是通用 shell、
> 技术上能写文件。persona 里如实写了这一点（约束来自职责，不是来自虚假的能力声明）。
> 0.2.1 删除了请求上的 `toolFilter`/`persona`，改由 Agent Preset 承担；
> preset 也不会自动隔离宿主全局工具，所以 preset 里还有一行
> `ctx.tools.restrict({ deny: <全部 global> })`。见 `docs/dsh-plugin-contracts.md` §0.0。

裁决有**三态**：`approve` / `reject` / `needs_human`。
第三条是刻意的——只给 PASS/FAIL 会逼验证者在**证据不足**时猜成 PASS。

结构化捕获失败时返回 `needs_human`，**绝不退化成"解析自由文本然后猜"**：
那会把一个明确的失败变成一个可能错误的通过。

**2. 测试冻结 —— 单调 guard，不是提示词请求**

```
Bug → 写失败的测试 → 确认复现 → sdlc_fix_start（冻结）→ 改产品代码 → sdlc_fix_end
```

用的是 `ctx.tools.guard()`：**返回字符串即拒绝，且没有任何后续监听器能翻回允许。**
冻结是**进程级/仓库级**的——不按 agent 记账，所以派子代理绕过这条路被堵死了。

能拦住的形式（都有回归测试）：`write`/`edit` 改测试文件；
经 shell 的 `>tests/x`（含不带空格）、`rm`/`mv`/`cp`/`install`/`truncate`/`shred`、
`sed -i`、`perl -pi`、`find -delete`、`python -c`/`node -e` 内写入、
`git checkout|restore|reset|clean`（含 `git -C`）。

> ⚠️ **两层都只是「提高成本」，不是硬边界。**
> 文件工具通道（`write`/`edit` 的 `file_path`）参数是**结构化**的，编码绕不过去；
> 但**是否算测试资产**仍靠上面的名字模式表——未覆盖的命名不会被冻结
> （验证者实测过 `jest.config.js`、`testdata/`、`*.snap`，已补入）。
> shell 通道判的是命令**文本**，不落进模式的等价写法仍可绕过
> （自造二进制、heredoc、动态拼出的命令名）。
> 而且**解冻只需 Actor 自己调一次 `sdlc_fix_end`**，所以它不是防篡改边界。
> **真正的硬约束应落在工具限制或沙箱层**：冻结期直接 restrict 掉写能力。


## 从真实任务中改进：`sdlc-rsi`

[sdlc-rsi 使用说明](packages/sdlc-rsi/README.md)。安装后自动记录每次验证，包括无裁决、失败、中断与重试；可按运行查询、复盘、执行真实对照并保存人工反馈。首版实验只改变附加指导文字，不自动修改系统。

参考答案目前与验证者共享文件系统，因此实验明确作为探索，不能据此推荐采用。原始输入、代码快照与工具输出默认留在本机 `.ai/rsi/`，核对后的结论写入真实任务制品。[本次实现与验证证据](.ai/tasks/RSI-1/proof.md) 分开记录单测、确定性冒烟和真实模型调用。

## 开发

```sh
npm install          # 装类型依赖（.d.ts 只在 npm tarball 里）
npm run build        # tsc
npm run test         # 单测（纯函数部分，不需要 DSH）
```

验证插件真的能加载（**用隔离 profile，不碰正在用的 App**）：

```sh
BASE="/Applications/DeepSeek Harness.app/Contents"
CLI="$BASE/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"
APP="$BASE/MacOS/DeepSeek Harness"

cd packages/sdlc-verify && npm pack
ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals "$CLI" plugin --profile verifytest add "$PWD"/*.tgz
ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals "$CLI" --profile verifytest --port 19999
# 看启动输出：出现 "entry did not activate" 就是失败
```

## 文档

| 文件 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 项目记忆与工程约定（改代码前先读）|
| [docs/dsh-plugin-contracts.md](docs/dsh-plugin-contracts.md) | **插件/preset 权威契约**，含三个静默失败的坑 |
| [docs/dsh-pitfalls.md](docs/dsh-pitfalls.md) | DSH 实测坑清单 + 能力边界 |
| [docs/dsh-plugin-authoring.md](docs/dsh-plugin-authoring.md) | 插件编写与分发的详细调研 |
| [docs/dsh-*.md](docs/) | 其余 DSH 子系统调研（带行号引用）|

## 边界（不要高估这套东西）

| 缺口 | 事实 |
|---|---|
| 网络出口管控 | **不存在**。DSH 沙箱明确"文件效果是全部策略词汇" |
| 受保护路径 | **不存在**。沙箱按目录范围放行 |
| 不可覆盖的管理层 | **不存在**。能改 `~/.dsh/` 的人可以摘掉任何插件 |
| 客户端控制 | 上限是"提高成本"，**不能作为合规证据** |
| 异构模型验证 | 当前版本做不到（外部 subagent 后端不在运行时里）|

→ 真正不可绕过的只有两处：**服务端分支保护**（GitHub rulesets / GitLab
protected branch）与 **host 层**（文件属主、MDM、独立运行身份）。
