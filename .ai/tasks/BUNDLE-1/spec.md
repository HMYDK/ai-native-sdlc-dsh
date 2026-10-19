# Spec：一个 bundle、七个组件行

## Requirements

- **R1 单一分发单元**：仓库只有一个带 `dsh.bundle.patch` 的包
  `@ai-native-sdlc/dsh-sdlc`；`package.json` 只有一份 peer 范围；
  profile 的 `dsh.profile.bundles` 只增加一条 `@ai-native-sdlc/dsh-sdlc`；
  `dsh.profile.bundles` / dependencies 中不再出现 `@ai-native-sdlc/dsh-sdlc-*`。
- **R2 七个组件行不变形**：`packages/sdlc/cordis.patch.yml` 恰好一条 `insert`、
  七行；行 id 与合并前逐一相同（`sdlc-task` / `sdlc-artifact` / `sdlc-status` /
  `sdlc-verify` / `sdlc-workflow` / `sdlc-rsi` / `sdlc-ui`）；每行模块解析后
  导出 `apply` / `inject` / `Config`（`sdlc-ui` 行允许包根重新导出 ui 定义）。
- **R3 客户端半可被发现**：`sdlc-ui` 行的 name 必须是精确包名
  `@ai-native-sdlc/dsh-sdlc`（不是该包的 `/ui` 子路径）；真实启动后
  `window.__DSH_BOOT__.entries` 含该包条目、`/api/sdlc-ui.tasks` 200。
- **R4 包内单一真相**：`packages/sdlc/src` 不再出现 `@ai-native-sdlc/` 形式的
  跨包 import；`sessionCwd` 等辅助函数只有一份（`src/shared/helpers.ts`）；
  `status/scan.ts` 直接 import `task/state.ts` 的状态机常量。
- **R5 行为不变**：既有工具名、Skill 内容、提示词段、`state.yaml` /
  `verification.json` 契约、验证者 preset 的隔离策略不变；既有单测/冒烟
  语义不变（允许因删除重复测试而减少，且必须逐条说明为什么不再有意义）。
- **R6 安装与运行时证据**：`npm pack` 的 tarball 在**隔离 profile** 中安装后，
  dump-config 七行、无 `entry did not activate`、客户端 entry 存在；
  在 desktop profile 安装后 `plugin_manager list_plugins` 七行 `fiberPhase: active`，
  且当前会话出现 `sdlc_status` / `sdlc_verify` / `sdlc_artifact_*` 工具。
- **R7 门禁与工具跟随**：`npm run compat`、`tools/bench/run.mjs`、
  `tools/plugin-activation-check.mjs`、`tools/time-travel-check.mjs`、
  `tools/mutation-score.mjs --list` 在新布局下可运行且结论如实；
  测试场仓库的 `make check` 同步适配。
- **R8 文档如实**：README / AGENTS / docs 中"当前操作指引"与单包形态一致；
  历史七包读数保留但标注"合并前"；`sdlc-ui` 精确包名的坑记录在案。

## Design

### 分层

| 层次 | 单位 | 保持/变化 |
|---|---|---|
| 分发 | npm 包 / bundle / profile.bundles 条目 / tarball | 7 → 1 |
| 执行 | Cordis 插件行 / fiber | 7 → 7（id、inject、Config 全保留） |
| 代码 | 包内模块 | 机制目录保持；共享层收敛为 `src/shared/` |
| 协议 | state.yaml / verification.json / artifacts 语义 | 不变，且由单版本一起发布 |

### 包结构

```
packages/sdlc/
  package.json          name=@ai-native-sdlc/dsh-sdlc, dsh.bundle.patch, dsh.client
  cordis.patch.yml      一条 insert + 七行（ui 行 = 精确包名）
  src/index.ts          包根：export * from './ui/index.js'（客户端半发现前提）
  src/task/             + artifact / status / verify / workflow / rsi / ui
  src/shared/helpers.ts 四组件共用的 cwd/沙箱辅助函数
  smoke/                七组件真实运行时冒烟（run-all.mjs 驱动；一组件一个 mjs）
  test/                 UI 纯 Node 行为测试
  README.md / TASK.md / RSI.md
```

### 关键约束（为什么不能更"简"）

- **不能七行压一行**：行是失效域/诊断域/开关粒度；压掉后分发粒度不变，纯粹变差。
- **`sdlc-ui` 不能写子路径**：`client-modules` 用 `exactPackageSpecifier` 找
  `dsh.client` 的宿主行；子路径返回 undefined → 浏览器半静默消失。
- **`@deepseek-ai/*` 不能进 dependencies**：第二份 `dsh-tools` 会破坏 Symbol 身份。
- **行 id 不能改**：profile 的按 id 覆盖（如 desktop 的 `- id: sdlc-task`）与
  插件页行级开关都靠它。

## Areas of concern

1. **测试减少的口径**：合并前 251 → 合并后 210。减少 41 = 3 份重复
   `helpers.test.ts` 副本（36）+ 1 条漂移检测 + `status/contract.test.ts` 4 条。
   必须能逐条说明"为什么不再有意义"，不能只说"删掉了"。
2. **mutation 基线只做路径迁移**：没有重新测量；局部 `sdlc-task` 实测
   102/126、24 存活（4 条不在迁移后清单）。这是诚实留下的未完成项。
3. **`sdlc-playground` 是另一个仓库**：它的 `playground-check.mjs` import 旧包
   `lib/index.js`；不更新就等于"组合检查"失去当前形态的绿证。
4. **`.probe` / `.verify-home` 是本地证据**：live 证据必须转化为可提交的
   文字读数（`.ai/tasks/BUNDLE-1/evidence/` 与本任务制品），不能只存在于本机。
5. **desktop profile 迁移顺序**：先隔离 tarball 验证，再装 desktop；新旧包同时
   存在会重复注册工具；旧 tarball 依赖要在删除仓库旧文件前移除。
6. **recency/环境事实**：0.2.1-rc.2 的 `plugin add` 会自动写
   `dsh.profile.bundles`，与旧 AGENTS 断言相反——文档要按"有条件实测"表述。
