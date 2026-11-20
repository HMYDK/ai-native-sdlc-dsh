# SPEC review 单次真实模型探针

`run.mjs` 在已安装插件 tarball 的隔离 web profile 中创建真实父代理，通过 ToolRuntime 调用一次 `sdlc_spec_review`。父代理不发送模型消息；新工具自行派发真实审查者。它不是无人值守批量 benchmark，也不生成语义正确性标签。

运行前准备独立工作区，放置处于 SPEC 的任务 state.yaml，登记 intent、spec 与 source。多份资料用 spec_sources 登记。标签、修订预案、调用参数和输出放工作区外。按使用说明编写 args.json，首次使用 task_id（显式 sources 须与登记内容一致），复审使用当前已登记 review_id 与逐项 responses。通过门禁版的完成审查仅更新审查引用和更新时间，失败轮次保留任务原字节。

```bash
DSH_HOME=/path/to/isolated-home \
DSH_TELEMETRY_DISABLED=1 \
ELECTRON_RUN_AS_NODE=1 \
"/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  --expose-internals tools/evals/spec-review/run.mjs \
  /path/to/isolated-home/profiles/web \
  /path/to/review-workspace TASK-ID \
  /path/to/args.json /path/to/batch-results 1
```

这是付费调用，使用显式隔离 profile 中已配置的 deepseek-account 认证。启动日志可能含本地认证 URL，不提交日志/profile/凭据。计费账户原始文件不由脚本读取或修改。首次执行须确保用户已授权这组调用。

最后参数是同一批次的 1–4 槽位；同一输出目录下每个槽位只使用一次，失败也保留。默认单请求输出上限 8192，可显式设置 `SPEC_EVAL_OUTPUT_TOKENS=16384`；`SPEC_EVAL_REASONING_EFFORT=low` 可用于显式选择推理强度（支持 off/low/high/max，省略时使用宿主默认）。这只是评测器选项，不是 sdlc_spec_review 的工具参数。

每轮墙钟上限 8 分钟，观察用量阈值 80000 tokens，步骤阈值 12。超用量响应若只请求一次 structured_output，允许已生成结果提交；下一模型步骤仍会在开始时取消，其他继续工作立即取消。事件触发的检查可能超过阈值，不是硬计费上限。不得通过换目录绕过已约定的批次预算。`node --test tools/evals/spec-review/budget.test.mjs` 检查终局提交、后续步骤和混合工具三类回归。

每轮输出 call-N.json，包括真实反馈、会话 ID、使用量、响应数、工具调用、实际模型配置、失败诊断、输入状态不变及 preset 归还检查。模型步骤/响应数不是独立审查次数；实际推理强度以会话 request/header 为准。失败尝试没有报告 TokenUsage 时，已知用量只能作为下界。原始结果须检查和脱敏后再分享。本工具不自动重试，也不在生成失败时推断模型结论。

2026-11-18 至 19 的材料、逐例结果和边界见 [首轮报告](../../../.ai/tasks/SPEC-REVIEW-1/eval-2026-11-18/report.md)。该轮完成 2/4，两次复审均触及输出上限，不能作为已跑通完整纠偏流程的证据。

2026-11-19 的 [后续排障](../../../.ai/tasks/SPEC-REVIEW-1/eval-2026-11-19/report.md) 取得修订确认与反证撤回两条有效复审，同时保留生成失败及评测器取消记录。

2026-11-19 的 [正反例补测](../../../.ai/tasks/SPEC-REVIEW-1/eval-2026-11-19-controls/report.md) 提供有限域无发现反馈、措辞歧义和引用校验拒绝三个实际结果；其中终局提交分支在 81,294 tokens 下实际执行成功。独立交付驱动与参数存于任务 delivery/，使用同一真实工具运行方式，临时完整 preset 只关闭该次自动重试。

当前驱动可用 `SPEC_EVAL_TOOL=sdlc_verify` 对处于 VERIFYING 的实际任务执行交付核验，自动在临时 preset 中关闭 malformed 重派。该模式使用 200,000 观察 tokens 与 10 步，默认 SPEC 模式仍为 80,000 与 12 步。取消超过 8 秒未完成时先保存 forced_stop 记录，再终止隔离进程，必要时用 `sdlc_task_issue action=cancel_verification` 清理任务活跃轮次。当前修复与真实宿主回归见 [取消修复记录](../../../.ai/tasks/SPEC-REVIEW-1/delivery/report.md)。
