# RSI 任务可观测性

## Problem

任务级分析能列出最终验证与阶段快照，维护者仍要手动追查独立 SPEC 审查发现了什么、哪次复审收口了问题、最终 Oracle 是否真实运行。原始需求见 [Issue #31](https://github.com/HMYDK/ai-native-sdlc-dsh/issues/31)。

## Proposed outcome

维护者以 task_id 查询，能从结构化结果回到对应的审查轮次、修订版本、最终逐 AC 裁决和真实消费路径的执行证据，也能看到缺失的证据和已观测成本。

## Affected users and systems

DSH 的 SDLC 模式任务维护者、RSI 查询工具、SPEC 审查记录及最终验证的证据采集。

## Constraints

沿用任务、审查和 RSI 文件。仅用受控响应验收，公开材料使用经过检查的夹具摘要。

## Open questions

定价和散文 Oracle 的机器可核查性依赖进一步的显式来源。未记录时在查询中呈现未知。
