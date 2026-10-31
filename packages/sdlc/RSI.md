# RSI：用真实任务改进 SDLC 插件

0.4.0 把记录单位从单次验证扩展到任务：作者做了什么、验证者查了什么、任务如何变化、当时运行哪一版插件。然后由当前 Agent 阅读证据、提出可验证的改进，在插件源码仓库建立普通开发任务，用旧版和新版对照，记录采用决定和后续真实任务。

它不是自动改代码、自动安装的后台服务。采集和检查由插件执行；诊断与开发由调用工具的 Agent 执行。任务 DONE 后会提示复盘，并把待复盘状态持久化。没有证据支持的问题不强行生成优化。

只在「AI 原生 SDLC」preset 生效，标准会话没有这些工具。只读看板常驻。安装方式见 [README](README.md)。唯一配置 `root` 默认为当前工作区内的 `.ai/rsi`。

## 使用顺序

1. 正常使用 task/artifact/verify 工具。创建任务保存起点，状态变化保存制品和代码；验证按显式 `task_id` 归属。会话 ID、事件序号和代码/插件指纹一并保存。
2. 任务结束后调用 `sdlc_rsi_analyze({task_id})`，按返回路径读作者与验证者证据。区分业务缺陷、插件缺陷、环境故障和未知原因。五次 reject 后 approve 本身不是插件故障。
3. 调用 `sdlc_rsi_propose({task_id,proposal})`，写问题、原因假设、尚未排除的解释、改动、验收、对照方法、证据路径和经过检查的观察摘要。引用必须属于该任务或登记的运行；插件计算实际文件内容指纹。证据不完整时只接受采集问题的假设。
4. 在 **SDLC 插件源码工作区**调用 `sdlc_rsi_improve({task_id,packet})`。packet 是上一步的完整返回值；工具检查包身份并调用普通 task/artifact 工具，创建 INTENT 任务和 `rsi-proposal.json`。它不跳过开发/验证步骤、不覆盖已有任务。摘要指纹只证明传输内容一致，外部原始证据还需复核。
5. 按正常流程开发。对同一用例分别运行基线和候选，保存两版指纹、命令、两侧实际观察、结论边界。完成开发任务后用 `sdlc_rsi_feedback` 记录 adopt/reject/inconclusive；采用提案要求开发任务为 DONE、任务中的提案 ID/内容指纹一致，并有旧版失败、新版满足判据的报告。
6. 后续真实任务再用 feedback 的 `followup_task_id` 关联实际加载插件版本与记录状态，继续检查效果。它必须是当前工作区可查的任务；跨工作区通过 packet/经过检查的报告转交，不偷偷换工作目录。

工具：`sdlc_rsi_tasks`（任务索引/补查）、`sdlc_rsi_runs`（运行历史）、`sdlc_rsi_analyze`（事实汇总与复盘入口）、`sdlc_rsi_propose`（证据提案）、`sdlc_rsi_improve`（普通改进任务）、`sdlc_rsi_feedback`（决定/后续结果）、`sdlc_rsi_experiment`（原有指导文字实验）。配套 Skill 为 `sdlc-evidence-driven-improvement`。

提案结构：

```json
{
  "title": "修复验证者执行记录丢失",
  "problem": "裁决存在，但实际请求配置和工具结果为空",
  "hypothesis": "作者与验证者位于兄弟 preset，普通监听器收不到事件",
  "alternatives": "还需排除查询服务缺失、截断和写盘失败",
  "change": "只采集已登记会话，并与原始日志对账",
  "acceptance": "旧版收不到，新版保存配置与结果；不相关会话仍被排除",
  "comparison": "相同 Cordis 夹具分别加载旧版和候选版",
  "focus": "capture",
  "references": [{"path":"tasks/TASK-1/evidence.json","observation":"经检查的计数摘要"}]
}
```

对照报告格式（报告是调用方提供的检查结果，不是插件自动认定的事实）：

```json
{
  "baseline":{"revision":"旧提交","fingerprint":"旧代码内容指纹"},
  "candidate":{"revision":"候选提交","fingerprint":"新代码内容指纹"},
  "command":"可复跑命令",
  "cases":[{"id":"判据","baseline_pass":false,"candidate_pass":true,"evidence":"两侧实际读数及来源"}],
  "limits":"环境、样本和未覆盖内容"
}
```

本仓库的首个真实闭环来自 DEMO-22149。`node tools/bench/case-rsi-scope.mjs --json --report <报告路径>` 会真实执行旧/新两版并产生上述报告；运行前先 build。来源与结果在 `.ai/tasks/RSI-2/evidence/`。

## 完成不等于证据完整

`verification_complete` 只表示拿到结构化裁决；`evidence_complete` 表示已登记范围的证据通过检查；`replay_ready` 表示运行具备代码与会话起点，仍不代表盲评隔离或完整环境镜像。看板分别显示业务状态、记录缺口、会话/验证次数和待复盘/已提案状态。旧任务没有摘要时显示“尚未确认”。

跨 preset 的事件监听为 global，但仅接收登记的作者、验证者及其子会话。最终通过可选的 DSH `sessionQuery.observeSession` 补漏并核对 cwd、父会话与序号；缺服务、缺事件、内容冲突、截断均明确标为不完整。记录失败进入工具 `recording_errors`，不把真正裁决替换成假失败。

任务归属来自明确携带 task_id 的任务、制品、修复和验证操作，不猜“最近一个任务”；RSI 查询不会把读取者登记成作者。同一作者切换任务会关闭上一段记录范围，重启后先恢复持久化归属再切换。旧数据仅按明确 task_id 补回验证运行/会话和作者工具调用，不能补造任务创建时的代码或缺失的编码过程。因此历史补录始终标明这些缺口。

每次任务操作先独立保存调用 ID、会话序号、任务归属、切换边界和实际执行版本，再更新任务索引。单个任务索引写入失败后，可用操作记录和原始日志里的明确 task_id 调用恢复边界；不会依靠一个仍然打开的旧窗口把后续任务吞进去。

记录失败会保存缺口并更新看板摘要；查询还会重读 state.yaml/history，与已有阶段快照对账。即使失败信息当时也没能落盘，重启后仍能发现状态已前进但阶段记录缺失。手改状态文件不产生任务记录事件，也不能因此自动变成“记录完整”。

## 本地保存

```text
.ai/rsi/
  tasks/<TASK>/task.json             # 会话归属、阶段、run、起点/阶段快照索引
  tasks/<TASK>/checkpoints/*.json    # state、制品正文、代码、实际加载的插件版本
  tasks/<TASK>/sessions/<ID>.json    # 有界作者/验证者记录及其归属范围
  tasks/<TASK>/sessions/<ID>.view.json # 看板用的精简操作摘要，不含消息/配置/命令正文
  tasks/<TASK>/evidence.json         # 证据健康和缺口
  operations/<SESSION>/*.json        # 每次任务操作的归属、切换边界、实际执行版本
  runs/<UUID>/000000.json ...        # 验证生命周期，不覆盖上一轮
  runs/<UUID>/code.json              # Git HEAD、binary diff、新文件及指纹
  runs/<UUID>/capture.json           # 实际模型配置、计数、缺失与截断
  runs/<UUID>/sessions/<ID>.json
  proposals/<UUID>.json              # 经检查的摘要与来源内容指纹
  imports/<TASK>.json
  experiments/<UUID>/protocol.json
  experiments/<UUID>/results/*.json
  feedback/<UUID>.json
.ai/tasks/<TASK>/rsi.json             # 看板读取的小摘要
.ai/tasks/<改进任务>/rsi-proposal.json # 可提交的来源摘要；提交前检查敏感内容
```

作者的原始通知保存在 DSH 日志；任务在阶段变化、turn/end 和查询时保存有界副本。验证会话另外逐事件落盘。进程强制退出导致的无 finished、未关闭范围、日志消失不能当成完整记录。

支持单 Git 根，也支持工作区内最多 32 个仓库（深度 4、最多扫描 1000 项）。各仓库保存 HEAD、dirty diff、未跟踪文件；工作区外部服务、忽略文件和依赖不在快照中。单仓库/仓库外文件各最多 200 个，单文件 1 MiB、各总量 8 MiB；取样后复查是否变化。符号链接、submodule 或超限不能声称完整。

任务制品独立保存（每份 512 KiB）；代码指纹排除 `.ai/tasks` 和 RSI 记录目录，单独提交这些记录不会改变代码指纹。HEAD 仍保留用于定位还原起点。会话副本限单条 512 KiB、每会话 16 MiB / 8192 条，超限保存哈希和截断标记。

加载时保存套件版本、发布 JS 指纹与 patch 指纹；后来改磁盘不会改写运行身份。`recorder_suite` 是本次采集器版本；`loaded_suite` 只来自任务创建快照，历史起点未知时为 null。`execution_suites` 按 operation/checkpoint/run 保留实际版本，跨版本仅续写制品也会留下执行版本。提案和后续反馈会携带这组来源。

记录含原始代码和工具输出，没有通用脱敏。原始 `.ai/rsi` 默认忽略；只提交检查过的摘要。磁盘记录可手改，是工作证据，不是权限或防篡改边界。

## 原有指导文字实验

`sdlc_rsi_experiment` 真实调用模型，比较 baseline_guidance 与 candidate_guidance；必须固定代码、制品、整套插件、模型实际配置，前后复查。参考结果需要外部证据，不能照抄被测验证者裁决。重复、取消、失败都留在分母；更快失败不算改善。

该实验仍与参考答案共享文件系统，只供探索，不推荐采用候选。要判断模型效果，仍需要隔离的盲评环境、多次重复和未参与调优的真实任务。本次确定性版本对照只证明插件机制修复。

## 验证

```sh
DSH_APP='/Applications/DeepSeek Harness.app' npm run verify --workspace packages/sdlc
node tools/bench/run.mjs
npm run compat
npm run preset-sync
```

冒烟使用真实 Cordis、ToolRuntime、LocalFileSystem、作用域和 Git；模型 provider 是确定性夹具。隔离 profile 的 tarball 安装与运行另有交付证据，不修改用户 desktop profile。
