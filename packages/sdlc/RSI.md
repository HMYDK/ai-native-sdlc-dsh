# sdlc-rsi：从跑过的真实验证中改进

这个插件保存每次 `sdlc_verify` 的输入、尝试、结果和失败。先找到重复出现的问题，再把改进假设交给对照实验，最后将经过复核的改动放回普通开发任务。它不会自动修改插件、提示词或用户配置。

首版从**验证环节**开始，尚未覆盖编码代理的全部工作过程，也不承诺模型能力已经提升。


> **使用位置**：本组件只在新建会话选择「AI 原生 SDLC」Agent Preset 时挂载；
> 标准模式会话没有这些工具与提示词。见 [包总览](README.md#安装与使用)。

## 安装

本组件与验证器在**同一个包里、同一版本发布**（合并后不再是两个包各自安装）；旧版验证器不发记录事件，无法补录历史。

```sh
npm run build --workspace packages/sdlc
npm pack --workspace packages/sdlc
dsh plugin --profile <你的-profile> add <生成的.tgz>
```

包自带 `dsh.bundle.patch`，安装后自动挂载七个组件行。宿主提供 `@deepseek-ai/dsh-*`，不要额外安装第二份运行时。开发验证用 App 自带 CLI 和独立 profile，具体命令见仓库的 `docs/dsh-plugin-contracts.md`。

唯一配置是 `root`，默认 `.ai/rsi`，必须是会话工作目录内的相对路径。它不绑定某个仓库绝对路径。只有会话位于 Git 仓库根、文件系统映射到本机时，首版才能保存完整代码起点；否则仍记录验证，但标明快照缺失，拒绝据此比较。

## 使用

正常调用 `sdlc_verify` 就会自动收集，无需增加记录调用。工具返回 `verification_run_id`，以及 `verification_complete`：后者表示**拿到了结构化裁决**，并不表示通过。正确的 `needs_human` 与没有裁决分开统计。

| 工具 | 用途 |
|---|---|
| `sdlc_rsi_runs` | 列出近期运行，或按 `run_id` 读取完整生命周期 |
| `sdlc_rsi_analyze` | 汇总无裁决、错误、中断、重试及记录缺失，并给出可追查的位置 |
| `sdlc_rsi_experiment` | 用真实验证调用比较两段附加指导文字，会消耗模型额度 |
| `sdlc_rsi_feedback` | 保存有来源的人工纠正、采用或放弃决定，关联运行、实验和开发任务 |

插件同时注册 `sdlc-evidence-driven-improvement` Skill，要求假设带证据、一次只改一个因素、保留失败与反例。

实验输入示例（先从运行记录取得真实 ID）：

```json
{
  "hypothesis": "先运行已有复现检查，可能减少漏检",
  "baseline_guidance": "",
  "candidate_guidance": "先复跑制品中明确列出的检查，再核对验收标准。",
  "repetitions": 2,
  "cases": [
    {"id":"bug","source_run_id":"<运行ID>","expected":"reject","evidence":"可复跑检查及其结果位置","holdout":false},
    {"id":"good","source_run_id":"<运行ID>","expected":"approve","evidence":"独立复核的通过证据位置","holdout":true},
    {"id":"unknown","source_run_id":"<运行ID>","expected":"needs_human","evidence":"缺失的外部事实及人工确认位置","holdout":false}
  ]
}
```

`expected` 是调用方提供的参考结果，插件不会证明它正确，也不会把验证器上次的自报裁决当真值。`holdout` 同样是调用方声明，表示未参与调优的用例。基线和候选交替执行，每轮结果立即保存；取消后的未运行项仍留在分母中。

首版只改变 `experimental_guidance`。代码、制品、验收标准、已加载验证器和实际模型配置必须保持一致。来源运行后改了代码，应重新采集来源；插件不会自动 checkout 或还原工作区。每次调用前后都会核对代码及制品，不覆盖原任务的最新裁决。

报告同时列出漏检、误伤、正确求助、结构化完成率、耗时、尝试次数和留出用例结果。耗时收益只比较两边均正确完成的同用例、同轮次；更快报错不算改善。没有 token/费用观测时，不把耗时冒充金额。

**目前实验只能用于探索。** 验证者与协议共享文件系统，虽然提示词不附参考答案，它仍可能通过 read/bash 读到答案或已有复盘。DSH 当前没有可靠的逐路径读取隔离。运行时因此明确记录这个限制，禁止返回 `candidate_promising`；发现的退步仍会报告。将来需要独立的盲评执行环境，才能据此提出采用建议。不要用一条提示词或 shell 文本匹配宣称解决了隔离。

## 保存了什么

```text
.ai/rsi/
  runs/<UUID>/000000.json ...     # started → prepared → attempts → finished
  runs/<UUID>/code.json           # Git HEAD、binary diff、未跟踪文件内容与哈希
  runs/<UUID>/capture.json        # 实际请求配置、工具结果数、截断和写入错误
  runs/<UUID>/sessions/<ID>/events/*.json
  runs/<UUID>/sessions/<ID>.json   # 有界会话摘要
  experiments/<UUID>/protocol.json
  experiments/<UUID>/results/*.json
  feedback/<UUID>.json
```

每次运行使用新目录，事件文件按序号新增，不覆盖上轮结果。进程被强制杀死可能没有 finished，此时查询显示 unknown。记录损坏不拖垮其他运行；写盘失败尽量进入验证返回的 `recording_errors`，不替换真正的裁决。

代码快照不含 `.ai/tasks` 和记录目录，输入制品另存正文与哈希。忽略文件、依赖、外部服务状态不在代码快照内；这不是完整环境镜像。未跟踪文件限 200 个、单个 1 MiB，合计快照限 8 MiB；submodule 不支持完整捕获。会话 trace 单条限 128 KiB、单会话限 2 MiB / 2000 条，超限记录哈希与截断标记，不伪装完整。

记录含制品原文、代码和工具输出，**没有通用脱敏**。本仓库默认忽略 `.ai/rsi/`，经核对的结论和证据摘要进入 `.ai/tasks/<ID>/` 提交。其他仓库或自定义 root 需自行决定保存、清理和 Git 忽略策略。磁盘文件可以被手改，它们是可追查的工作记录，不是防篡改审计。

## 验证

```sh
DSH_APP='/Applications/DeepSeek Harness.app' npm run verify --workspace packages/sdlc
```

包含纯函数单测，以及真实 Cordis、ToolRuntime、LocalFileSystem、Git 和验证器的集成冒烟。冒烟的模型 provider 是确定性夹具，它证明接线和失败处理，不证明真实模型效果。真实分发与模型调用证据另记在 `.ai/tasks/RSI-1/proof.md`。
