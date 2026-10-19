# PRESET-1 运行证据：SDLC 只在选定 Agent Preset 的会话里生效

本文件记录**可复跑**的命令与原始读数。环境：macOS，DSH App `0.2.1-rc.2`，
Node v26.8.2（Electron-as-Node），仓库 HEAD 为实现提交（见 git log）。
隔离 profile 在 `.verify-home/`（gitignored，不碰用户 desktop profile）。

## 0. 制品

- 包：`packages/sdlc`，`@ai-native-sdlc/dsh-sdlc@0.3.0`
- tarball：`packages/sdlc/ai-native-sdlc-dsh-sdlc-0.3.0.tgz`
  （52 文件，sha256 前缀 `6f1d74fd2654c5a7`）
- patch：一条 `insert`、**两条宿主行**（`sdlc-ui` + `preset-sdlc`）；preset
  `config.plugins` = 22 行 standard 副本 + 6 行本套件组件。

## 1. 隔离 profile：安装与启动

```sh
APP="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
CLI="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"
export DSH_HOME="$PWD/.verify-home"; rm -rf "$DSH_HOME"
ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals "$CLI" --profile verify-sdlc \
  --from-default-profile web --dump-config >/dev/null
ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals "$CLI" plugin --profile verify-sdlc \
  add "$PWD/packages/sdlc/ai-native-sdlc-dsh-sdlc-0.3.0.tgz"
ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals "$CLI" --profile verify-sdlc --dump-config \
  > /tmp/dump-030b.yml
```

读数：

```
宿主行: 2（- id: sdlc-ui / - id: preset-sdlc）
preset 子行: 28 个顶层行（22 standard 副本 + 6 本套件）
bundles: ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","@ai-native-sdlc/dsh-sdlc"]
```

真实启动（`--profile verify-sdlc --port 0 --no-open`，取日志里的带 token URL，
先 `curl -L -c cookies` 建立认证 cookie）：

```
启动日志 entry did not activate: 0 条
__DSH_BOOT__ entry:
  {"id":"@ai-native-sdlc/dsh-sdlc",
   "url":"plugins/??@ai-native-sdlc/dsh-sdlc/client.js&rev=ca10afcab19f",
   "inject":["@deepseek-ai/dsh-client-ui-sidebar"]}
GET /api/sdlc-ui.tasks → 200 / 89760 字节
```

## 2. Host RPC：preset 名册、内容、会话绑定

RPC 协议（来自 `@deepseek-ai/dsh-client-connection` 的 `rpc.call` 实现）：
`POST /api/<endpoint>`，body
`{"type":"client-request","rpcId":"<uuid>","method":"<endpoint>","payload":{"args":{...}}}`，
返回 `{"type":"server-response","rpcId":"...","result":{"ok":true,"value":...}}`。
以下请求带启动时拿到的 cookie。

### 2.1 `agentPresets/list`

```json
{"presets":[
 {"id":"standard","isDefault":true},
 {"id":"ptc","isDefault":false},
 {"id":"minimal","isDefault":false},
 {"id":"cordis","isDefault":false},
 {"id":"sdlc","name":"AI 原生 SDLC",
  "description":"标准 coding 模式 + 任务状态机、制品链、独立验证与任务看板。只在选择本模式的会话中生效；侧栏看板常驻但只读。",
  "isDefault":false},
 {"id":"sdlc-verifier","name":"SDLC Verifier","isDefault":false}]}
```

- `sdlc` 存在、名称正确；**`broken` 字段缺失** ⇒ 注册表认为它可以组合会话
  （激活审计通过）。
- `sdlc-verifier` 是 `sdlc-verify` 在 preset scope 内注册的验证者 preset；
  eager activation 的既有副作用（改动前也是全局注册），不影响标准会话工具面。

### 2.2 `agentPresets/read {agentPreset:"sdlc"}`

`content` 渲染出整个子插件列表，**末尾六行**：

```
- id: sdlc-task
- id: sdlc-artifact
- id: sdlc-status
- id: sdlc-verify
- id: sdlc-workflow
- id: sdlc-rsi
```

共 38 行条目（含嵌套组内的行）；前面是 standard 的 persona / tool-fs / tool-bash /
tool-pwsh / skill-filesystem / compaction / delegation 等。

### 2.3 `session/create` + `session/projections`

```
POST session/create {"args":{"request":{"cwd":"<本机临时截图>/","agentPreset":"sdlc"}}}
  → {"sessionId":"session-b7d190e2-…","agentPreset":"sdlc"}
POST session/create {"args":{"request":{"cwd":"<本机临时截图>/"}}}
  → {"sessionId":"session-06bcb0e8-…","agentPreset":"standard"}
session/projections 的 values.agentPreset 分别为 sdlc / standard。
```

### 2.4 工具面差异（经 `session/prompt` 触发请求 envelope 后读投影）

对两个会话各发一条 `session/prompt`（内容 `只回复 ok`，`mode:"queue"`），
等待后读 `session/projections` 的 `contextBreakdown.toolsTokens`
（"最新请求 envelope 的工具 schema 启发式 token 数"）：

```
sdlc 会话    toolsTokens = 10072   agentPreset = sdlc
standard 会话 toolsTokens =  6902   agentPreset = standard
```

- 差值 ≈ 3170 ≈ 六个组件的工具 schema；standard 会话的 6902 与"六行-only 版本"
  时的 standard 读数一致，说明没有 sdlc 工具漏进标准会话。
- ⚠️ **这是间接读数**：它证明两个会话的工具 schema 集合不同；最终的"在新建会话里
  看到工具列表"仍需人工在 GUI 新建会话选择「AI 原生 SDLC」确认（见 §6）。

## 3. 门禁与冒烟（负向实测）

```
node packages/sdlc/smoke/preset.mjs                  → 19/19 通过
node tools/preset-sync-check.mjs                     → 与 App 的 standard 逐行一致（22 行）
node tools/plugin-activation-check.mjs（隔离 profile）→ 宿主 2 行 + 本套件 6 行 +
                                                       26 个发布文件 sha256 全一致
```

负向实测（每条断言都必须真的会失败）：

- 把 `sdlc-task` 放回宿主行 → preset 冒烟 16/18：点名"宿主行应为
  [sdlc-ui, preset-sdlc]"与"机制组件仍在宿主行"。
- 改坏 standard 副本一个值（`maxBytes: 65536 → 65535`）→
  `preset-sync-check` exit 1，点名"第 2 行（agent-instructions）不一致：字段 config"。
- 把 `tool-web` 改名 → preset 冒烟 18/19：点名"preset 缺 standard 基础工具：tool-web"。
- 六行-only 的第一版（保留为历史读数）：sdlc 会话 toolsTokens 3265、无基础工具
  ——说明"preset 不继承"这条必须先解决。

## 4. 既有测试语义未变

实现改动只在 bundle patch / package.json / 冒烟与工具 / 文档：
`src/` 组件代码**未改**。

```
npm test --workspace packages/sdlc
  ℹ tests 202  pass 202  fail 0
  ℹ tests   8  pass   8  fail 0        （lib 202 + UI 8 = 210）

npm run smoke --workspace packages/sdlc
  artifact 39 / rsi 62 / status 69 / task 40 / ui 46 / verify 109 / workflow 12 /
  preset 19 → 8 个脚本共 396 条，全过
```

## 5. 已知边界（不要当成"已验证"）

1. `toolsTokens` 只能证明"工具 schema 集合不同"，不能列出工具名；最终工具列表要用
   GUI 新会话人工确认。
2. standard 副本是静态复制：App 升级后需 `node tools/preset-sync-check.mjs` 对账，
   漂移时 `--write` 同步并复跑冒烟。这是官方不支持 preset 继承的接缝。
3. `sdlc-verifier` preset 因 eager activation 出现在全局名册（与 0.2.x 相同）。
4. 已有会话保留创建时的组合；本次迁移后当前会话失去 `sdlc_*` 工具是预期行为。
5. migration 到 desktop profile 的 live 读数单列在实现提交之后的证据中。
