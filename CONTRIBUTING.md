# 贡献指南

本仓库把《AI 原生 SDLC 实战手册》的方法论落成一个 DeepSeek Harness（DSH）插件，
只有一个包：`packages/sdlc`（`@ai-native-sdlc-plugin/dsh-sdlc`）。开始之前请先读：

- [README.md](README.md)：插件能做什么、怎样开始使用；[安装指南](docs/installation.md)包含详细安装与验证步骤；
- [packages/sdlc/README.md](packages/sdlc/README.md)：一个包与七个组件的关系、宿主行与 Agent Preset 的划分；
- [AGENTS.md](AGENTS.md) 和 [docs/dsh-plugin-contracts.md](docs/dsh-plugin-contracts.md)：改代码前必读的工程约定与 DSH 契约。

## 开发环境

| 项 | 要求 |
|---|---|
| 操作系统 | macOS。本项目的安装、冒烟和界面验收都在 macOS 上完成，其他平台尚未验收 |
| DSH | 已安装的 DeepSeek Harness App，默认路径 `/Applications/DeepSeek Harness.app` |
| 运行时 | Node.js 与 npm。根目录 `engines` 要求 Node >= 24（`.nvmrc` 指定 24）；CI 使用 Node 24 |

插件运行时由 DSH App 提供。`@deepseek-ai/dsh-*` 只能出现在 `peerDependencies` /
`devDependencies` 中，**不要**写进 `dependencies`——那会装出第二份 `dsh-tools`，
破坏模块内的 Symbol 身份，让每一次工具调用都失败。

## 安装

在仓库根目录执行。`package-lock.json` 已提交，用 `npm ci` 安装整棵 workspace：

```sh
npm ci
```

## 构建

```sh
npm run build --workspace packages/sdlc
```

`tsc` 把 `packages/sdlc/src` 编译到 `packages/sdlc/lib`（已被 `.gitignore` 忽略），
并把手写的 `src/ui/client.js` 拷进产物。**单测跑的是 `lib/` 下的编译结果，所以先构建再测试。**

仓库根还有一组遍历 workspace 的脚本，CI 用的就是它们：

```sh
npm run build       # 等价于 npm run build --workspaces --if-present
npm run typecheck
npm test
```

## 单测

```sh
npm test --workspace packages/sdlc
```

包含库的 Node 单测、看板行为测试和 UI 客户端测试，不需要 DSH App。

## 完整验证

```sh
DSH_APP="/Applications/DeepSeek Harness.app" npm run verify --workspace packages/sdlc
```

`verify` = 构建 + 单测 + 运行时冒烟。冒烟测试用 App 自带的 Electron-as-Node 启动
真实 Cordis 上下文和真实 `ToolRuntime`，真的派发工具调用，所以**必须有可用的 DSH App**。

## 依赖本机 App 的检查（不进 CI）

| 命令 | 检查什么 |
|---|---|
| `npm run smoke --workspace packages/sdlc` | 运行时冒烟；需要 `DSH_APP` 指向真实 App |
| `npm run compat` | 读本机 App 里的 `dsh/package.json`，确认 peer 范围接受当前 DSH 版本 |
| `npm run preset-sync` | 读本机 App 的 `standard.patch.yml`，与 preset 内嵌的基础工具副本逐行对账 |

`compat` 与 `preset-sync` 都读本机安装的 App，**没有 App 就无法运行**，因此不放进
GitHub Actions。CI 只跑 `build` / `typecheck` / `test`（见
[.github/workflows/ci.yml](.github/workflows/ci.yml)）。改动 peer 范围或 preset 副本后，
请在本机跑这两条，并在 PR 里贴出结果。

`preset-sync` 报漂移时，用 `npm run preset-sync:write` 按当前 App 重新生成副本，
**检查 diff** 后再提交；升级 DSH App 后也要重跑。

其它仓库级检查（基准对照、变异得分、安装核对等）见 [tools/README.md](tools/README.md)。

## 提交信息

提交信息写**为什么**，不写“更新了 X”。这个仓库的提交历史保存了大量踩坑结论，
它们和代码一样是项目产物。建议包含三部分：

```text
<范围>: <一句话结论>

为什么需要改：原行为的问题、风险或触发条件（尽量给实测读数）
怎么验证：跑过的命令和实际结果（没跑的项写明原因）
遗留：未覆盖的部分或后续任务
```

一个提交只做一件事，不要把格式化或无关重构混进行为改动里。

## 提交前审查

**不要用 `git add -A` 盲推。** 逐个确认被跟踪的文件：

```sh
git status
git diff --cached --stat
git ls-files
```

这个仓库踩过两次：把冒烟测试生成的 `.ai/tasks/SMOKE-*/` 提交进了历史；以及
`.dsh/skills/` 下三个引用已删除脚本的废弃 Skill 一直躺在跟踪列表里，直到逐个
审查跟踪文件时才被发现。

提交前确认没有混入：

- 凭据、`.env`、密钥，以及模型输入/输出原文；
- `.ai/rsi/` 下的原始执行记录（含完整输入、代码快照和工具输出，没有通用脱敏）；
- 冒烟测试的临时任务 `.ai/tasks/SMOKE-*/`（`.gitignore` 已忽略，仍要确认）；
- `*.tgz` 安装包、`node_modules/`、`packages/*/lib/` 构建产物；
- `.idea/`、`output/` 截图，以及不在公开范围内的 `handbook/` 全文。

真实任务制品 `.ai/tasks/<TASK-ID>/` **应当提交**——它们是制品链的载体，
脱敏后可以随代码一起公开。

## 公开范围

本仓库公开的是插件源码（`packages/sdlc`）、自研文档（`docs/`）和脱敏后的
`.ai/tasks/` 证据。`handbook/` 全文翻译、`output/` 截图和 `.idea/` 不公开。
新增文件前先判断它属于哪一类，不确定时先问维护者。

## PR 流程

1. 从 `master` 开分支，一个 PR 解决一件事。
2. 按上面的顺序在本地验证。冒烟、`compat`、`preset-sync` 跑了就贴读数，没跑就写“未跑”和原因。
3. 用 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md) 说明：为什么改、改了什么、怎么验证、有什么影响。
4. 等待 CI 通过（`build` / `typecheck` / `test`，ubuntu-latest + Node 24）。
5. 涉及插件加载、安装或界面接线的改动，还要按[安装指南的「开发与验证」](docs/installation.md#开发与验证)把真实 tarball
   装进**隔离 profile** 核对，不能只靠单测。
6. 维护者 review 后合并，合并后可以删除分支。

不要提交尚未验证的结论。把“实测通过”和“推测”分开写，是评审时最省时间的一件事。

## 文档贡献

文档和代码同等重要：

- `docs/` 记录 DSH 契约、插件约定和实测踩坑。新增结论要标明**验证时间与版本**，并给出可复跑的命令。
- `packages/sdlc/README.md`、`TASK.md`、`RSI.md` 是插件行为说明，改行为要同步改文档。
- 改路径或命令时，顺手检查 [README.md](README.md) 与 [AGENTS.md](AGENTS.md) 里的引用是否还成立。
- 不要为了好看而夸大范围：单测通过不等于端到端可用，协议层证据不等于 GUI 已验收。
- Markdown 允许行尾空格（见 [.editorconfig](.editorconfig)），标题层级保持一层一级。

## 许可证

本项目以 [MIT 许可证](LICENSE) 发布，版权人 **HMYDK**，年份 **2026**
（`packages/sdlc/package.json` 中同样声明 `"license": "MIT"`）。

提交贡献即表示你同意自己的贡献以同一 MIT 许可证发布，并确认你有权提交这些内容。
引入第三方代码或资源时，请把许可证与出处写进
[packages/sdlc/THIRD_PARTY_NOTICES.md](packages/sdlc/THIRD_PARTY_NOTICES.md)。
