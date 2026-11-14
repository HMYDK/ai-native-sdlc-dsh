# Intent: 让 Verifier 消费 Delivery Contract 并反查 AC 充分性

## Problem

#20 已合并到 `dev`：`spec.md` 现在有结构化的 `## Delivery Contract`（Source / Outcome / Boundary / Oracle / AC mapping），结构检查也会拒绝缺失、空子节、占位符、重复和错误顺序。但 `buildVerificationPrompt()` 还没有消费它：验证者仍只按 `criteria` 和 `intent_of_change` 验证，不知道原始目标是什么、哪些 AC 支撑哪个 Outcome。结果是「AC 全 met 但原始 Outcome 仍未达成」无法被稳定发现，同时容易被 hidden tests 带偏成扩需求。

## Proposed outcome

1. `buildVerificationPrompt()` 优先读取 `spec.md` 的 Delivery Contract，提取 1–3 个关键 Outcome，反查支撑它们的 AC，构造「AC 全 met、Outcome 仍失败」的最小具体反例；旧任务缺契约时回退 Intent/Spec 散文并标注推导/不确定。
2. 状态与证据矩阵按维护者确认的口径：已证实真实入口/Outcome 失败且属本次承诺 → `reject`；AC 不足但未证交付失败 → `needs_human`；Source/Boundary 实质歧义或关键证据无法确认 → `needs_human` + `unverified`（仅在影响交付结论时阻断）；无关既有失败不阻断；无反例不报缺口。
3. 定向单测 + 离线反例表覆盖正向交付、明确遗漏、明确局部范围、关键证据缺失、无关历史失败；不新增 Agent/Runner/Schema；真实模型 spot check 需单独预算批准，本轮不运行。

## Affected users and systems

- 独立验证者：需要按固定契约和状态矩阵做语义审查。
- SDLC 任务作者：需要通过现有 `sdlc_task_issue` / 退回 SPEC 流程处理验收缺口。
- `packages/sdlc/src/verify/verdict.ts`、`verdict.test.ts`、`docs/evals/` 下的离线反例表。
- #22：仍负责独立 A/B 与效果/成本判断；本任务不宣称统计收益。

## Constraints

- 只修改 `buildVerificationPrompt()` 和定向测试；不新增 Agent、Runner、工作流阶段或 Verdict Schema。
- 复用现有 `spec_mismatch` / `unverified` / `approve|reject|needs_human` / `sdlc_task_issue` / `issue_results` 复验协议。
- 不新增语义硬门禁；`checkAdvance` / 结构检查 / AC 登记 / Spec 指纹规则不变。
- 不依赖 `workflow/skill.ts` 的可见性；规则只放 prompt（VERIFY-01 观察到验证者未加载该 Skill）。
- 不跑真实模型付费案例；预算未经批准前只做离线 fixture、Prompt 回归和人工 Review，并如实标注 AC-002/003 尚缺真实行为证据。
- 不默认跑全项目 E2E；复用 #16 的一条代表性真实消费路径。

## Open questions

无。维护者已在 #21 评论中确认三个待决问题、状态矩阵、旧任务回退口径和证据边界；付费 spot check 仍需单独预算授权，本轮不执行。
