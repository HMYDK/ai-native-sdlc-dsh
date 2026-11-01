# RSI 0.4.0 交付证据

本次把真实任务暴露的记录缺陷修好，并把任务证据、改进提案、普通开发任务、两版对照和后续反馈接起来。交付为一个 `@ai-native-sdlc/dsh-sdlc@0.4.0` bundle，原有两条宿主行与 preset 内六个机制组件保持原结构。

这次开发由 Codex 执行。`verification.json` 是实际命令结果和独立代码审查的汇总，`review.json` 保存审查来源；它们不是一次虚构的 DSH `sdlc_verify` 调用。本任务没有伪造 DSH 会话历史、运行 ID 或创建时的代码快照。

## 来源与改动

来源任务为 DEMO-22149。六次验证都有裁决，RSI 却没有保存实际模型配置和工具结果，代码快照也不完整。经过筛选的计数在 [source-facts.json](evidence/source-facts.json)，原因分析在 [source-analysis.md](evidence/source-analysis.md)。业务正文、源码、凭据和原始日志没有进入交付文件。

修复覆盖四件事：

1. 作者与验证者跨 preset 的事件按明确会话身份采集，再用原始会话查询补漏、对账；任务完成和证据完整分开报告。
2. 任务操作先独立保存归属、调用、切换边界和实际执行版本，再写任务索引。重启与写失败不会使旧任务吞入新任务；仅写制品也会记录当时版本。
3. 多仓库代码快照保留范围和缺口，任务记录单独提交不会改变代码指纹；历史起点未知就保留未知。
4. 复盘提案固定引用的当时内容，通过普通任务工具进入插件开发；采用反馈检查同一提案、已完成开发任务和两版实际对照。看板显示记录完整性及待复盘状态。

诊断和对照报告仍注明来自调用方。内容指纹不能代替原因分析，也不能代替独立审查。详细用法见 [RSI.md](../../../packages/sdlc/RSI.md)。

## 实际验证

机器可读结果及本地日志指纹见 [local-validation.json](evidence/local-validation.json)。所有命令均针对最终构建运行；后续只补充本任务记录与项目记忆。

| 检查 | 结果 |
|---|---|
| build + 单测 | lib 213 + UI 9 = 222，通过；失败 0 |
| 看板宿主检查 | 26，通过；失败 0 |
| 九个运行时冒烟脚本 | 437，通过；失败 0 |
| 版本对照 | 四个用例均为旧版违反判据、修复版满足 |
| DSH 兼容性 | 两个 manifest 通过，运行时 0.2.1-rc.2 |
| standard preset 副本 | 22 行与 App 一致，另有六行本套件组件 |
| 独立隔离测试场 | 21 条通过；未改原测试场状态 |
| 安装文件 | 58 个打包文件；32 个发布 JS 与 patch 对账一致 |
| 隔离进程 | 看板 API 200，客户端 bundle 在 boot 中，激活警告 0 |
| 真实浏览器 | 已完成任务仍显示证据不完整；记录缺口可展开，未记录的任务显示尚未确认 |

冒烟细分：artifact 39 / preset 19 / rsi-scopes 39 / rsi 62 / status 69 / task 40 / ui 46 / verify 111 / workflow 12。

核心复跑命令：

```sh
DSH_APP='/Applications/DeepSeek Harness.app' npm run verify --workspace packages/sdlc
node tools/bench/run.mjs
node tools/bench/case-rsi-scope.mjs --json
npm run compat
npm run preset-sync
```

测试场必须在干净隔离副本运行 `make check`，并设置 `DSH_PLUGINS` 指向本仓库的 `packages`。已有 CHK-1 的副本不可复用：检查会拒绝重复创建，不能把夹具残留误判为插件失败。

## 两版对照

[version-comparison.json](evidence/version-comparison.json) 来自真实 Cordis/ToolRuntime/LocalFileSystem 夹具。基线 `7955ddd` 失败四项，候选全部满足：实际配置 0 → 1，工具结果 0 → 1，缺失通知得到补录，证据健康状态可独立判断。

基线 JS 指纹：`5e464b8f27de3eacc221e3ac222f2329c67d0194ea601b57d27e2d1df8859807`。

候选 JS 指纹：`bf8ae47b126177dac01070fc27920dca8a4d287ebecd5e2bbf47fa41984d28ee`。

候选标为 `working-tree build`，是测试当时的真实状态；提交后不倒填成已经测试过的提交号。指纹可关联最终安装包。早期的 `scope-comparison.json` 保留第一阶段对照，最终交付以本节报告为准。

## 独立复核

详细问题和处置见 [review.json](review.json)。第一轮指出任务归属、失败持久化、代码指纹、链接快照和版本来源问题，修复后补了反例。第二轮进一步把失败与重启、仅写制品与跨版本组合起来，发现两处遗漏。

最终复核独立注入旧索引写失败、重建采集器，确认旧任务不再含新任务标记，而写失败仍可见。另用两个独立加载的模块实例验证 0.3.9 创建、0.4.0 写制品，再换旧采集器查询，两版身份均保留。39 条 scope 检查重新通过。最终限定复核范围内没有遗留 Critical/Important；没有把这一结论扩大成新的全项目独立模型验证。

## 安装范围

最终包为 `.verify-home/ai-native-sdlc-dsh-sdlc-0.4.0-351bb4307ae0.tgz`，SHA-256：

`351bb4307ae0a9e63ea726fedeb79c5184ddda4b9ee39844b57648440403b62d`

使用 App 自带 CLI 安装到本仓库 `.verify-home` 下的 `verify-sdlc` profile。文件核对命令：

```sh
DSH_PROFILE_DIR="$PWD/.verify-home/profiles/verify-sdlc" node tools/plugin-activation-check.mjs
```

随后实际启动隔离进程，经本机登录链接换取 cookie 后访问 `/api/sdlc-ui.tasks` 和首页。摘要夹具返回 `evidence_complete=false`、六次验证、七个会话，未被 DONE 状态掩盖。临时访问 token 没有写入交付记录。

真实 Chrome 中打开 SDLC 看板，筛选隔离工作区，展开记录缺口并检查截图。界面显示「执行证据不完整」「7 个会话 · 6 次验证 · 待复盘」及具体缺口；没有摘要的任务显示「尚未确认」。见 [浏览器检查记录](evidence/gui-validation.json) 和 [隔离任务截图](../../../docs/design/sdlc-dashboard-2026-10-28/rsi2-record-health.png)。这是明确标注的夹具，不是新增业务任务的读数。

用户正在使用的 desktop profile 没有升级；没有发布 npm 包，没有自动替换运行中的插件。

## 结论边界

运行时冒烟真实调用 Cordis、工具调度和文件系统，模型响应与会话查询来源由确定性夹具提供；这证明本次机制和异常处理。隔离启动/API 另行验证了真实安装包。它们不能证明更多真实业务任务上的模型质量、完成率或耗时已经普遍改善。

下一步使用新版本处理真实任务时，才会产生可供后续反馈使用的新执行记录。历史任务缺失的完整作者过程和起点快照不能补造；原有共享文件系统下的指导文字实验仍只作探索。

本任务的 `state.yaml` 由 Codex 明确补录为 DONE，表示实现和约定验证完成；`rsi.json` 同时保留执行证据不完整。没有把代码交付完成改写成「DSH 已完整采集了这次开发」。
