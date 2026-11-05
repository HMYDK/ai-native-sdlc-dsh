# 安装与首次使用

[返回项目介绍](../README.md)

以下安装流程已在 **macOS + DeepSeek Harness App** 上验证；其他平台尚未完整验收。
独立验证需要 DSH 已配置可用的模型。从源码构建另需 Node.js 24 或以上版本和 npm。

## 从 npm 安装

可以在 App 的 **Plugin Manager** 中搜索安装 `@ai-native-sdlc-plugin/dsh-sdlc`。
命令行安装推荐使用 **App 自带 CLI**，确保安装命令与实际运行的 DSH 来自同一版本。

下面以 `desktop` profile 为例，其他 profile 请替换名称；App 安装路径不同时也要相应修改。

```sh
export DSH_APP="/Applications/DeepSeek Harness.app"
DSH_CONTENTS="$DSH_APP/Contents"
DSH_BIN="$DSH_CONTENTS/MacOS/DeepSeek Harness"
DSH_CLI="$DSH_CONTENTS/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"

ELECTRON_RUN_AS_NODE=1 "$DSH_BIN" --expose-internals "$DSH_CLI" \
  plugin --profile desktop add @ai-native-sdlc-plugin/dsh-sdlc@0.6.0
```

如果终端已配置与 App 同版的 `dsh` 命令，也可以直接运行：

```sh
dsh plugin --profile desktop add @ai-native-sdlc-plugin/dsh-sdlc@0.6.0
```

## 确认安装并开始任务

包自带 `dsh.bundle.patch`，用于登记看板和工作模式。装完核对对应 profile 的 `package.json`：
`dsh.profile.bundles` 中应包含 `@ai-native-sdlc-plugin/dsh-sdlc`。
默认位置是 `~/.dsh/profiles/desktop/package.json`；设置过 `DSH_HOME` 时以该目录为准。
若未登记，按[安装排查说明](dsh-pitfalls.md)处理。

1. **完全退出并重新打开 DSH**，然后打开要开发的项目目录。
2. **新建会话**，选择 **「AI 原生 SDLC」** 模式。
3. 描述目标和验收要求，让 Agent 创建任务并推进；在侧栏 SDLC 看板查看任务和证据。

工作流只在选择该模式的新会话里启用；已有会话保留创建时的工具组合。
安装成功本身不能证明旧进程已经加载新版。

### 任务记录

记录默认保存在业务工作区，随流程逐步产生：

```text
.ai/tasks/<TASK-ID>/
  state.yaml                 # 当前阶段、交付物索引、流转历史、问题和验证轮次
  intent.md                  # 为什么做、要解决什么问题
  spec.md                    # 预期行为与验收标准
  plan.md                    # 实现计划
  verifications/<run-id>.json # 每轮裁决、逐项结果和被验证的内容版本
  verification.json          # 最新裁决的兼容副本
  review.json                # 评审交付物
  rsi.json                   # 执行记录完整性与复盘状态摘要
```

这些任务材料经检查后可以随代码提交到 Git。原始代码快照、模型配置和工具输出保存在
`.ai/rsi/`，没有通用脱敏；在业务项目的 `.gitignore` 中加入：

```gitignore
.ai/rsi/
```

## 使用 Release 安装包

1. 打开 [Releases](https://github.com/HMYDK/ai-native-sdlc-dsh/releases)，下载所需版本的 `.tgz` 与 `SHA256SUMS.txt`。
2. 在下载目录校验文件：

```sh
shasum -a 256 -c SHA256SUMS.txt
```

校验通过后，先执行上面「从 npm 安装」中的四行路径变量定义，再安装下载的文件：

```sh
SDLC_TGZ="/绝对路径/下载的安装包.tgz"
ELECTRON_RUN_AS_NODE=1 "$DSH_BIN" --expose-internals "$DSH_CLI" \
  plugin --profile desktop add "$SDLC_TGZ"
```

之后按「确认安装并开始任务」检查登记并重启。

## 从源码构建

```sh
git clone https://github.com/HMYDK/ai-native-sdlc-dsh.git
cd ai-native-sdlc-dsh
npm ci

export DSH_APP="/Applications/DeepSeek Harness.app"
npm run compat          # 包声明是否接受本机 DSH 版本
npm run preset-sync     # 内置基础工具列表是否仍与 App 一致
```

`compat` 与 `preset-sync` 任一失败时，先按输出处理再继续。通过后打包：

```sh
SDLC_PACK="$(npm pack --workspace packages/sdlc --silent)"
SDLC_HASH="$(shasum -a 256 "$SDLC_PACK" | cut -c1-12)"
SDLC_TGZ="$PWD/${SDLC_PACK%.tgz}-$SDLC_HASH.tgz"
mv "$SDLC_PACK" "$SDLC_TGZ"
```

`npm pack` 会先构建插件。安装包名加上内容哈希，避免同版本反复打包时安装器复用旧文件。
然后定义 App CLI 路径并安装：

```sh
DSH_CONTENTS="$DSH_APP/Contents"
DSH_BIN="$DSH_CONTENTS/MacOS/DeepSeek Harness"
DSH_CLI="$DSH_CONTENTS/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"

ELECTRON_RUN_AS_NODE=1 "$DSH_BIN" --expose-internals "$DSH_CLI" \
  plugin --profile desktop add "$SDLC_TGZ"
```

之后按「确认安装并开始任务」检查登记并重启。

## 升级与兼容

升级插件时重新执行安装命令，再完全退出 DSH、重新打开并新建会话。

DSH 的工作模式不支持继承，插件保留了一份 `standard` 基础工具列表。App 升级后，在插件源码仓库运行
`npm run compat` 与 `npm run preset-sync`；发现列表漂移时，用 `npm run preset-sync:write` 同步，
检查改动后重新验证、打包和安装。

## 开发与验证

在仓库根目录执行：

```sh
export DSH_APP="/Applications/DeepSeek Harness.app"
npm run verify --workspace packages/sdlc  # 构建 + 单测 + 宿主接口检查 + 运行时冒烟
npm run compat                          # 包声明与本机 DSH 版本
npm run preset-sync                     # 基础工具列表与 App 是否一致
```

冒烟测试使用真实 Cordis 和 ToolRuntime 调用插件工具；涉及模型的集成用例使用预设返回结果。
修改安装、加载或界面接线后，还要把实际 tarball 安装到**隔离 profile**，核对发布文件和运行状态。
`plugin-activation-check.mjs` 可检查安装文件是否与构建一致；进程是否已加载，要继续查看运行时的
`fiberPhase` 和实际行为。检查工具及用法见 [tools/](../tools/README.md)。

开发约定见[贡献指南](../CONTRIBUTING.md)和 [AGENTS.md](../AGENTS.md)，安装与运行中的已知问题见
[DSH 实测问题记录](dsh-pitfalls.md)。
