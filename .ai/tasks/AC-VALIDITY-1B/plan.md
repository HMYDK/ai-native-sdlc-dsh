# Plan: 让 Verifier 消费 Delivery Contract 并反查 AC 充分性

## Files that change

- `packages/sdlc/src/verify/verdict.ts`：在 `buildVerificationPrompt()` 中新增「验收充分性反查」小节（来源/事实权威、Outcome 提取、AC 映射、最小反例、真实路径、状态矩阵、幂等/SPEC 返工）。
- `packages/sdlc/src/verify/verdict.test.ts`：新增 prompt 不变量测试；保留现有 criteria、test evidence、交付路径检查回归。
- `docs/evals/ac-validity-1b-counterexamples.md`（新增）：至少 5 个离线反例及预期 verdict，标明真实模型行为未取得、#22 负责 A/B。
- `.ai/tasks/AC-VALIDITY-1B/`：任务制品与验证记录。

## Order of work

1. 在 `buildVerificationPrompt()` 的“必须回答的问题”之后、“交付路径检查”之前插入新小节；复用现有 `spec_mismatch`、`unverified`、三态 verdict、`issue_results`。
2. 写清 Delivery Contract 读取与旧任务散文回退；区分查找顺序与事实权威；明确 hidden tests / Grader 不进入 Outcome。
3. 写清具体反例门槛、状态矩阵、`approve` + blocking finding 会被改成 `reject` 的机械语义、幂等与 `sdlc_task_issue` 退回 SPEC。
4. 在 `verdict.test.ts` 增加定向断言：契约消费、回退、事实权威、反例门槛、状态矩阵、blocking 机械语义、hidden tests、幂等、真实入口优先 Oracle、AC 权威。
5. 写离线反例表（正向交付、明确遗漏、明确局部范围、关键证据缺失、无关历史失败），每条给 Source/Outcome/Boundary/Oracle/反例/预期 verdict/理由/prompt 条款。
6. 构建并跑定向测试、`npm run verify`；检查没有改 `state.ts`、`verdict` schema、`acceptance.ts`、`workflow/skill.ts`。
7. 进入 VERIFYING 做独立验证；如实报告“无真实模型行为证据（预算未批）”。

## Risks

- **误报 / needs_human 膨胀**：新规则过严会让每个任务都 `needs_human`；必须用“具体、可实现、落在 Boundary 内”的反例门槛，并写明“说不出来就不报”。
- **机械状态语义**：`enforceCriteriaPolicy()` 会把 `approve` + blocking finding 改成 `reject`；AC 缺口必须显式让顶层为 `needs_human`，不能靠 blocking finding 表达不确定。
- **Source 权威混淆**：查找顺序不等于事实权威；Actor 写的 Delivery Contract 可能自洽但偏离原始需求；Source 原文冲突要指出。
- **旧任务回退**：缺契约不等于不可验证，也不等于必然 `needs_human`；只在实质影响结论时阻断。
- **hidden tests / Grader**：不能扩 AC，也不能用模糊 out-of-scope 掩盖真实入口失败；要按 #16 + #21 协调。
- **幂等与自动放行**：不重复报同一问题，但不能因“此前提过”自动放行；必须走 `issue_results`。
- **prompt 体积 / 生成失败**：新小节保持紧凑；`evidence` 仍 2–4 行，长日志写 `/tmp`；不要求输出完整 mapping。
- **证据层级**：单测只证明规则存在；真实模型行为未取得；不得在任务/ PR 中宣称已行为验证。

## Proof

- 定向：`cd packages/sdlc && npm run build && node --test lib/verify/verdict.test.js`，记录 pass/fail。
- 全量：`cd packages/sdlc && DSH_APP="/Applications/DeepSeek Harness.app" npm run verify`，记录单测与 smoke 读数。
- Prompt 证据：打印/断言新小节包含契约读取、散文回退、Source 事实权威、反例门槛、状态矩阵、blocking 机械语义、hidden tests、幂等、Oracle 真实入口、AC 权威。
- 离线反例：`docs/evals/ac-validity-1b-counterexamples.md` 至少 5 条，人工 Review 预期 verdict 与 prompt 条款。
- 边界：`git diff --name-only` 不包含 `src/task/state.ts`、`src/shared/acceptance.ts`、Verdict Schema 或 `workflow/skill.ts`；不运行真实模型。
- 真实行为：明确记录“AC-002/003 的真实模型行为证据未取得（预算未批）”，A/B 留 #22；不把 prompt 字符串测试说成行为验证。
