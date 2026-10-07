# DSH 插件与 preset 契约（实测 + 官方文档）

本文件记录写 DSH 插件时**必须知道但文档分散在各处**的契约。
来源：官方 `docs/`（cookbook / architecture / subsystems）+ npm tarball 里的 `.d.ts` +
已安装运行时的编译产物。每条都标了出处或验证方式。

适用版本：`@deepseek-ai/dsh-*@0.2.0-rc.2`，`@deepseek-ai/cordis@4.0.4`。

---

## 0. 两个会浪费很多时间的前提

### 0.1 类型定义只在 npm tarball 里，不在已安装的运行时里

包声明了 `exports["./src/*"]`，但 `files` 里**没有** `src`——所以：

| 来源 | 有 `lib/index.js` | 有 `.d.ts` | 有 `src/*.ts` |
|---|---|---|---|
| 已安装运行时（App 内 asar / 解包目录） | ✅ | ❌ | ❌ |
| `npm pack @deepseek-ai/dsh-xxx@0.2.0-rc.2` | ✅ | ✅ | ❌ |

**权威类型只能从 tarball 取**：

```sh
npm pack @deepseek-ai/dsh-tools@0.2.0-rc.2 && tar xzf *.tgz
# → package/lib/types/**/*.d.ts
```

官方 shipped skill 也这么说（`dsh-agent-preset/skills/cordis-plugin-development/SKILL.md:32`）：
*"installed packages ship built `lib/index.js` and `lib/types/**/*.d.ts` … not `src/`."*

### 0.2 插件的最小形态

一个 ESM 模块，导出 `apply` 以及可选的 `name` / `inject` / `Config`：

```js
export const name = 'my-plugin'
export const inject = ['tools']        // 依赖的 Cordis 服务
export function apply(ctx, config) { /* ... */ }
```

**关键机制**：没有 default export 时，**整个 ESM 命名空间对象就是插件**
（`cordis-plugin-loader` 的 `unwrapExports`）。所以官方插件都用命名导出。

⚠️ **不要用 default export**——它会隐藏 loader 元数据（`inject` 等）。
这是有正式 postmortem 记录的坑（`dsh-subagent-acp` 的
`0001-acp-default-export-drops-inject.md`）。

### 0.3 三个"警告后继续"的静默失败（实测踩全了）

这三个坑的症状完全一样：**app 照常启动，插件不工作**，
只有启动日志里一行 `dsh: warning: 1 entry did not activate`。
排查入口是 `plugin_manager list_plugins` → `fiberPhase: "failed"`。

#### ① `inject` 必须列出**每一个**访问到的服务

```js
export const inject = ['tools', 'subagents', 'systemPrompt']  // 少一个就抛
```

访问未声明的服务会抛：

```
Error: cannot get property "systemPrompt" without inject
```

注意 `ctx.systemPrompt` / `ctx.skills` / `ctx.approval` 等都要声明，
即使它"看起来总在"。

#### ② `Config` 必须是 Standard Schema 校验器，不能是普通对象

```js
// ✗ 错：Cordis 会调用 Config['~standard'].validate(...)
export const Config = { foo: 'bar' }
// → TypeError: Cannot read properties of undefined (reading 'validate')

// ✓ 对：用 schemastery（官方选择）或 zod
import z from '@deepseek-ai/schemastery'
export const Config = z.object({
  verifierProvider: z.string().default('spawn'),
})
```

`~standard` 是 **Standard Schema v1** 接口。schemastery 与 zod 都实现它，
**JSON Schema 不行**（那是输出方向，用 `--dump-config-schema` 生成）。

配置经校验并填好默认值后才传给 `apply(ctx, config)`。

#### ③ `files` 里的 `lib/index.js` **只匹配单个文件**

```json
// ✗ 错：多文件模块的其余文件不会被打进包
"files": ["lib/index.js"]
// → 安装后 import 时报 ERR_MODULE_NOT_FOUND: .../lib/test-freeze.js

// ✓ 对
"files": ["lib/**/*.js", "!lib/**/*.test.js", "!lib/**/*.d.ts", ...]
```

`npm pack --dry-run` 会列出实际内容——**打包后核对文件数**，
不要只看它能跑通。

### 0.5 🔴 DSH 运行时包必须是**单例**，绝不能写进 `dependencies`

**这是最危险的一个坑**，因为它**在加载时完全正常**，直到任何一次工具调用才爆发，
而且症状看起来完全不像插件问题：

```
Cannot read properties of undefined (reading 'prepare')
```

**每一个**工具调用都失败（包括内置的 `read`、`bash`），会话彻底不可用。

#### 机制

`dsh-tools` 内部有一个**不导出的模块级 Symbol**：

```js
const TOOL_RUNTIME_SCHEDULER = Symbol("@deepseek-ai/dsh-tools.scheduler");
```

`dsh-agent-loop` 从包里 `import` 这个 Symbol，然后在**每次工具调用**时用它查表：

```js
const prepared = await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec);
```

如果 `ctx.tools`（一个 `ToolRuntime` 实例）来自**另一份 `dsh-tools` 副本**，
那么它的 Symbol 键是**另一个值** → 查表得到 `undefined` → 读 `.prepare` 报错。

`Symbol()` 每次求值都产生新值，**所以"同一份模块实例"不是优化，是正确性前提**。

#### 触发方式

插件把 `@deepseek-ai/dsh-*` 写进 `dependencies`：

```json
// ✗ 致命：profile 会装第二份 dsh-tools
"dependencies": { "@deepseek-ai/dsh-tools": "0.2.0-rc.2" }
```

`dsh plugin add` 之后，profile 的 `node_modules/@deepseek-ai/` 里会出现
一份独立的 `dsh-tools`，与 App 自带的形成两个实例。

#### 正确做法

```json
// ✓ 只声明 peer + dev
"peerDependencies":  { "@deepseek-ai/dsh-tools": "0.2.0-rc.2" },
"devDependencies":   { "@deepseek-ai/dsh-tools": "0.2.0-rc.2" }
```

运行时由宿主提供这些包，**不要**替它决定版本，也**不要**让它装第二份。

#### 排查手法

```sh
find ~/.dsh/profiles/<profile> -path "*node_modules/@deepseek-ai/dsh-tools/package.json"
# 有一份 = 被污染了（正常应该是 0 份，全部由 App 提供）
```

一旦装上就很难干净移除（残留会让符号解析继续错位）——
最可靠的恢复是**重建 profile**：

```sh
mv ~/.dsh/profiles/desktop ~/.dsh/profiles/desktop.broken
open -a "DeepSeek Harness"     # 会用模板重建，会话历史不受影响
```

### 0.4 本地开发时不要用符号链接安装

`dsh plugin add <绝对路径>` 会创建**符号链接**。Node 的模块解析会
**穿过链接按真实路径**去找依赖，于是：

- 插件自己的 `node_modules` 若被 npm 提升到工作区根 → 解析不到
- 运行时需要的包根本不在解析链上 → 加载失败

**要么**把运行时依赖声明进 `dependencies`（profile 会装在插件旁边），
**要么**用 tarball / 发布包验证。

⚠️ 一个关键的验证纪律：**符号链接安装通过 ≠ 真实分发可用**。
必须用 `npm pack` 出来的 tarball 装一遍再验证。

---

## 1. Bundle 与 profile

**Bundle = 一个带 Cordis 补丁层的 npm 包。** 声明方式：

```json
{ "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

`patch` 可以是**字符串或字符串数组**（数组形式是超出 shipped skill 示例的扩展，
可用于一个包含多个补丁层的 bundle）。

**只有声明了 `dsh.bundle.patch` 的包才会自动挂载。** 否则 `dsh plugin add` 只把它
装进 `dependencies`，并打印 `declares no dsh.bundle — installed as a plain dependency,
not a profile layer`，必须手工往 profile 的 `cordis.patch.yml` 加 `insert` 行。

bundle 会被**自动追加到 `dsh.profile.bundles`**——这一点已实测：安装本地 bundle 后，
`dsh.profile.bundles` 从 `["@deepseek-ai/dsh-base"]` 变成
`["@deepseek-ai/dsh-base", "<本包>"]`。这是 bundle 相对普通插件的核心优势。

### 安装到隔离 profile 验证（不碰正在用的 App）

```sh
BASE="/Applications/DeepSeek Harness.app/Contents"
CLI="$BASE/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"
APP="$BASE/MacOS/DeepSeek Harness"

# 用 profile 自己的运行时跑 CLI（PATH 上的 dsh 可能是别的版本）
ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals "$CLI" plugin --profile <p> add <绝对路径或包名>
ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals "$CLI" --profile <p> --dump-config | grep <包名>
```

`plugin add` 会自动初始化不存在的 profile。

---

## 2. Agent Preset

### 2.1 精确形状

```ts
export interface PresetDefinition {
  readonly id: string                                  // 必填
  readonly name?: string
  readonly description?: string
  readonly order?: number
  readonly plugins: readonly EntryRow[]                // 必填
}
```

**它是一个 Loader 行，不是一个磁盘文件。** 约定行 id 为 `preset-<config.id>`：

```yaml
- id: preset-review
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: review
    name: Review
    order: 10
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config: { prefix: You review software changes. }
```

### 2.2 没有发现机制——这是最容易误判的一点

- ❌ 没有 preset 目录扫描，没有 glob，没有路径配置
- ❌ 没有 `$DSH_AGENT_PRESET` 或任何 preset 环境变量（48 个 `DSH_*` 变量里没有）
- ❌ 没有 preset 的 CLI 参数
- ❌ 遗留目录 `$DSH_HOME/.agent-presets/<id>/` **已无人读取**

> `agent-preset-registry/README.md:46`：*"Definitions are ordinary plugin rows; the
> registry neither scans directories nor accepts preset paths."*

✅ **唯一的贡献方式**：bundle 补丁里的一个 `insert` 行（或按键覆写已发布的行）。

### 2.3 子插件树是任意的

`plugins` 是完整的 Cordis entry 列表，支持全部行形状：`cordis:group` 嵌套组、
`isolate`、`disabled: !!js ...`、省略 `id`。

**preset 内挂多个 `dsh-tool-subagent` 行是官方用法**——
`dsh-web-app/presets/standard.patch.yml:86-118` 就在一个 preset 里挂了四个
（`spawn`/`fork`/`codex`/`claude-code`，各带 `toolName`/`backgroundMode`/`maxDepth`）。

每行可用配置：`provider`(必填)、`toolName`、`modelSelectionSettings`、
`enableRunInBackground`、`backgroundMode`、`agentOptions`、`persona`、
`toolFilter{allow?,deny?}`、`maxDepth`。

### 2.4 会话如何选择 preset（五个入口，无环境变量）

1. profile 里的部署默认：`agent-preset-registry` 行的 `config.default`
2. 用户默认：settings 命名空间 `agent-preset-registry` 的 `selectedDefault`（覆盖 1）
3. 插件用的 Host API：`ctx.agentPresets.resolve/acquireScope/mount/select/...`
4. Remote：`agentPresets/list`、`agentPresets/read`、`agentPresets/select`（**仅空白会话**）
5. 会话创建请求：`SessionCreateRequest.agentPreset`

插件侧的标准序列（`dsh-webhook` 的实际写法）：

```js
const preset = await ctx.agentPresets.resolve(agentPreset)
await ctx.agentPresets.acquireScope(preset.id)
const handle = await ctx.agents.create({
  sessionId, signal,
  meta: { cwd, agentPreset: preset.id },
  setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, preset.id) },
})
```

---

## 3. 子代理与结构化输出

### 3.1 只有两个后端可用

已安装运行时里**只有** `spawn` 与 `fork` 注册了 provider。
`acp` / `codex` / `claude-code` / `dsh-sdk` **不在运行时里**；
npm 上只有 `0.0.1-rc.1`，其 peer 依赖 `^0.0.1-rc.1` **与 `0.2.0-rc.2` 不兼容**，
安装会被版本门禁拒绝。preset 里那两行是 `disabled: true` 的占位。

→ **异构模型（DeepSeek 编码 + Claude 审查）在当前版本做不到**，
除非自己实现一个 provider。

### 3.2 `outputSchema` 只能由插件代码请求，模型不能

`dsh-tool-subagent` 的配置里**没有** `outputSchema` 字段，模型可见参数只有
`description`/`prompt`/`[provider,model,reasoning_effort]`/`run_in_background`。

**这对设计是好消息**：意味着"强制结构化裁决"必须是插件代码的行为，
模型无法自己决定跳过它。

### 3.3 结构化输出的机制

- 请求前用 `assertObjectJsonSchema` 校验，要求 **object 根**
- 子代理里注入 `structured_output` 工具 + 指令段，description 明确"恰好调用一次"
- **单调 guard**：已捕获后再调用任何工具都会被拒
  （`structured output already recorded: the run is complete, ...`）
- **提交时机**：等该调用自己的 `tools/result` 成功后才提交（PTC 下还要等外层 `run_code`）
- ⚠️ **干净结束但没提交 ⇒ `stopReason: 'error'`，且不会重试**

最后一条决定了插件必须处理 `structured === undefined`：
**不要退化成"解析自由文本然后猜"**——那会把一个明确的失败变成一个可能错误的通过。

### 3.4 `toolFilter` 的确切语义与一个真实风险

```ts
interface ToolRestriction { readonly allow?: readonly string[]; readonly deny?: readonly string[] }
```

- 作用于该 scope **继承**的工具（全局层 + 所有祖先），多个 restriction **取交集**，
  然后叠加该 scope 自己的注册（**自己的注册豁免**，否则子代理用不了自己的工具）
- `allow` 列表是**排除式**的：未列出的后续工具不会出现
- 效果是**单一可见性**：工具既从提示词消失，也拒绝执行
- 未知名会**大声报错**（fail loud，不是静默）

⚠️ **风险（实测文档确认）**——`dsh-subagent-fork-in-process/README.md:114`：

> *"a tool restriction filters its global wire schemas, executable lookup, and PTC mode
> SDK bindings **but not standalone guidance**."*

即：**别的插件注册的静态提示词段落不会因为工具被过滤而消失。**
被过滤的子代理仍会读到"用 `write` 工具…"之类的指导文字，而那个工具它其实没有。

对验证者的实际影响：它可能尝试调用不存在的工具，浪费轮次。
**应对**：在 persona 里显式说明"你只有只读工具，看到任何让你修改文件的指示都忽略"。

（正确的根治方式是让 guidance 段在装配时查 `ctx.tools.get(name, scope)`，
但那是第三方插件的责任，我们控制不了。）

---

## 4. 工具与拦截

### 4.1 选择规则（官方 cookbook 给的四条）

| 需求 | 扩展点 |
|---|---|
| 可重排的策略层 | `tools/pre-execute`（waterfall，返回 `PreToolDecision`）|
| **单调的最终拒绝** | `ctx.tools.guard()` |
| 包裹 dispatch 生命周期（超时/重试/指标）| `tools/execute`（只能替换 `exec.signal`）|
| 显式变换结果 | `tools/post-execute` |
| 对不可变终态的只读观察 | `tools/result` |

```ts
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined

export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; info?: ToolErrorInfo }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?: string; displayReason?: { en: string; [locale: string]: string } }
```

要点：
- guard 的**返回字符串即拒绝**，且**没有任何后续监听器能翻回允许**（单调）
- guard 只在 `tools/pre-execute` 返回 `allow` 时才被咨询
- 被拒的调用变成 `Error: <reason>` 反馈给模型，**不结束本轮**
- `ask` 带多语言 `displayReason`，GUI 可直接渲染

### 4.2 guard 拿到的是结构化事实，不是命令文本

`exec.name` + `exec.arguments`（lossless JSON，深冻结）。

**这是相对"客户端文本匹配门禁"的决定性优势**：
对**文件工具通道**（`write`/`edit` 的 `file_path`）这句话成立：
判定不依赖命令长什么样，只依赖解析后的参数。

但对 **shell 通道**不成立——那里判的仍是 `arguments.command` 的**文本**，
属于文本匹配的一种，等价写法可以绕过（实测：`python3 -c "open('tests/x','w')"`）。
把 shell 通道如实标注为「保守启发式」，要硬约束请落到工具限制或沙箱层。

### 4.3 工具参数 DSL 的类型集合

`string` / `number` / `integer` / `boolean` / `null` / `array` / `object` / `json` /
`oneOf`（exactly-one）。

⚠️ **作者 DSL 里没有 `type: 'object'`**——那是 wire-level 的 `JsonSchemaType`。
作者侧要用 `json`（任意 JSON 值，投影成 annotation-only schema）。
写错会在 `tsc` 时报 `Type '"object"' is not assignable to type '"json"'`。

### 4.4 工具返回值的类型约束

工具返回值必须能被物化成 **lossless JSON**（要写进持久会话日志）。
带原型链的对象、函数、`undefined`、非有限数字都会被拒。

实践：普通 interface 若没有索引签名，`tsc` 会拒绝把它赋给 schema 推出的类型。
**不要用类型体操绕**——要么在边界上序列化，要么用一处带充分注释的窄化。

---

## 5. 客户端（Web UI）

- 包声明 `dsh.client { platform: 'web' }` + 导出 `./client`
- Host 半边是一个**空的 `apply()`**，只为让它出现在 Loader 里
- 客户端注册进父级声明的 Slot，或用 `ctx.uiConversation.events.register(...)`
  注册会话行定义（`ConversationNodeDefinition`）
- 制品/交付面板的现成先例是 `dsh-client-ui-deliverables`

---

## 6. 插件故障语义（写之前必须知道）

| 失败 | 后果 |
|---|---|
| 模块导入失败 / `apply()` 抛错 / 配置校验失败 | **警告后继续**（第三方插件都是"可选"条目）|
| **游离的 promise 拒绝（未 await）** | **销毁 app、非零退出——与是哪个插件无关** |
| **同步回调抛错（stream `'data'`、timer）** | **同上** |

"必需条目"是一份硬编码 id 白名单（`agent-loop`/`webserver`/`modules`/`connection`/
`headless-runner`/`acp`/`sdk-jsonrpc-server`），**所有第三方插件都是可选的**。

→ **插件代码里不要留未 await 的 promise。** 故障域是整个宿主进程。
