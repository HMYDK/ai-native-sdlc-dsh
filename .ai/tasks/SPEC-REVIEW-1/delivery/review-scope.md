# 待授权发送的核验材料（2026-11-20）

目标服务为 DeepSeek 官方模型接口 `api.deepseek.com`，模型为现有账号配置中的 `deepseek-v4-pro`。实际接口如与该域名不一致，需重新核对目的地。两项可以分开授权，各派发一次，限额见 [执行计划](../eval-2026-11-20/plan.md)。

| 待运行项 | 发给审查者的项目材料 | 要核验的行为 |
|---|---|---|
| 未修反例 | [受控 Source、Intent、未修 Spec 与作者回应](../eval-2026-11-19-controls/inputs/case-2/)，以及同一案例[首次完成的发现](../eval-2026-11-18/call-1.json)中的 F1。旧 Spec 与旧来源内容与当前版本逐字一致。文件哈希见 [复测输入](../eval-2026-11-20/input-hashes.json) | 作者声称补齐构建 Outcome 和 AC，当前 Spec 仍缺这些内容，核对旧问题能否保持 open |
| 独立交付验收 | [需求摘录](../source.md)、[Intent](../intent.md)、[Spec](../spec.md)、[Plan](../plan.md)、已提交的取消问题及 [生成包与测试证据](cancellation-fix.json)。允许读下列变更文件和受控评测结果，用于核验已登记的 AC-001～007 | 校验 SPEC 审查、复审、原文引用、取消失败留痕、现有交付状态与运行时接线，独立验证取消问题的修复证据 |

代码和证据使用下列范围。

- `packages/sdlc/src/verify/{index,runtime,runtime.test,spec-review,spec-review-tool,spec-review.test}.ts`、`packages/sdlc/smoke/spec-review.mjs`。
- `packages/sdlc/src/artifact/policy.ts`、`packages/sdlc/src/workflow/skill.ts`、`packages/sdlc/{README.md,TASK.md,package.json,cordis.patch.yml}`、`docs/spec-review.md`。
- `tools/{profile-runtime-check,profile-cancellation-check}.mjs`、`tools/evals/spec-review/`、[证据记录](../proof.md)、[受控案例结果](../eval-2026-11-19-controls/report.md)、[取消前后读数](report.md)。测试输出限通过数、失败信息和必要的探针结果。

运行前需把可读材料限定在以上范围，核对工作区没有其他任务、完整聊天历史、原始会话日志或账户凭据。前轮方案复制本机凭据文件的步骤已被拒绝。后续运行需要由已授权的账户连接处理认证，并保持认证材料在模型可读工作区之外。现有任务裁决的版本约束仍适用，来自不同代码快照的裁决不能推进当前任务。
