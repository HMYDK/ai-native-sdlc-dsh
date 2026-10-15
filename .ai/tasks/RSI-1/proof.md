# RSI-1 验证证据

2026-10-15。本记录由实现者整理实际命令与输出；它不是一次独立 sdlc_verify 对本任务的 approve 裁决。

## 本地检查

- sdlc-verify `npm run verify`：build 成功，单测 48/48，真实运行时冒烟 106/106。
- sdlc-rsi `npm run verify`：build 成功，单测 38/38，真实运行时冒烟 62/62；冒烟共 51 次确定性 provider 派发，非真实模型性能实验。
- 全 workspace build/test 成功。其他包单测：artifact 35、status 58、task 48、workflow 7；UI 的 test 是 38 条冒烟。
- 其他包运行时检查：task 35、artifact 39、status 69、UI 38、workflow 12，全部通过。artifact 没有 npm smoke 脚本，改用 App 自带 Electron 直接运行其 smoke.mjs；第一次聚合 npm 命令因这个脚本名不存在而非零退出，没有把它记作全绿。
- `node tools/bench/run.mjs`：STATUS-PAGE-1、FALSE-ALARM-1、PWSH-1 均成立；基线分别违反 4/2/4 条，修复版均为 0。
- 同级 sdlc-playground `make check`：21/21，临时任务已由原脚本清理。

## 独立审查修正

审查实际复现了五种失真：较快失败被算作收益；参考标签可从协议文件读取；调用结束未复查任务制品；异常调用丢运行关联；配置集合去重掩盖单次模型切换。另一次复审发现嵌套调用丢 additionalContexts/concludesTurn。均已修复或如实限制：答案无法隔离时阻止候选推荐；上下文与轮次标记遵循真实 ToolRuntime 契约转交。

回归包括最后一次候选调用才修改制品、错误前插入更晚的无关运行、B→A/A→B 配置顺序、同时运行、运行中取消，以及后置策略将终局成功改为失败的场景。

## 打包与隔离安装

`npm pack`：verify 15 个文件，RSI 12 个文件；包含 bundle patch 和全部运行 JS，不含测试。安装到独立 headless profile，未改 desktop profile；全部 27 个安装文件已逐字节与 tarball 核对一致，检查未发现第二份 dsh-tools。

最终 RSI tarball SHA-1：`cd009c9c7bfd6985f5571119ba9d96c9468d0d7d`。
验证器 tarball SHA-1：`eb911540d82a376f84ac9a64300d349f10f0f34d`。

额外发现：重复安装同路径、同版本 tarball 时，pnpm 报 Already up to date，但已安装 replay.js 仍是旧文件。改用带内容哈希的 tarball 文件名重新安装后，逐字对比 installed replay.js 与最终构建一致。加载通过不能代替检查运行的究竟是哪份代码。

## 真实模型验证

在临时 Git 仓库中使用故意错误的 `double(value) = value * 3` 夹具，要求 `double(3) == 6`。独立 headless 会话调用真正的 sdlc_verify，随后调用 sdlc_rsi_runs 与 sdlc_rsi_analyze。

- 运行 ID：`053e03cd-f8ee-400d-a6fa-38f121706491`
- 验证子会话：`b0ff5bd2-9791-4f27-b27c-29c24f4e447e`
- 结果：reject，verification_complete=true，一次尝试，完整六个生命周期事件，记录 issues=[]。
- 实际观测配置：provider=magpie，model=deepseek/deepseek-flash，maxTokens=393216，来自 request/header，非请求参数推测。
- capture：8 次工具结果、truncated=false、errors=[]；代码快照 complete=true。
- 分析：total=1、completed=1、attempts=1；无失败现象。不从这一次成功算出漏检率或误伤率。

本 headless preset 没有 plugin_manager，无法取得 list_plugins/fiberPhase。这里记录的是实际工具调用与磁盘证据，不伪造激活状态查询。

原始 trace 留在本机临时仓库和 DSH 会话存储，未整份推入 Git。实际工具返回保存在 `evidence/verification-fixture.json`，它验证的是夹具，不是本任务的实现。

## 最终安装包的真实两侧实验

实验 ID：`ca1e498d-7007-4e82-94b2-146b98ce641c`。直接由真实 headless 代理调用 sdlc_rsi_experiment，使用上面的来源运行；只比较空指导与“直接运行判据中的检查，简洁报告观察到的结果。”，一个用例、各一轮。

| 侧 | 运行 ID | 结果 | 尝试次数 | 耗时 |
|---|---|---|---|---|
| baseline | 3122cca2-8d47-4d22-8f7b-53d5e9b8063b | reject，完整 | 1 | 16676 ms |
| candidate | 45f1161e-3bce-42e7-baad-1aa6838693fc | reject，完整 | 1 | 8345 ms |

两次观测的实际模型配置与验证器指纹一致，代码/制品复查 issues=[]。实验状态 completed，recommendation=inconclusive；报告保留小样本、参考答案未隔离、缺少好改动与证据不足两类用例的说明。不能把这一次候选更快解释为已经提升能力。

最终报告原样摘自工具返回，见 `evidence/experiment-fixture.json`。协议先落盘，结果目录有 4 份递增快照（开始、两次观测、结束）；两条 run_id 均能追到完整生命周期与 capture。

## 交付

实现提交 `865ec90` 已推送至 `origin/codex/rsi-real-task-learning`。本任务仍保留 VERIFYING 状态：实现者检查、独立代码审查与模型接线实测均已完成，但没有将夹具裁决冒充本任务的正式独立验证裁决。后续合入或采用仍按正常开发流程处理。
