# Spec: 让 Verifier 消费 Delivery Contract 并反查 AC 充分性

## Delivery Contract

### Source

- Issue #21：AC-VALIDITY-01B，要求 Verifier 反向验证 AC 的交付充分性，并把验收缺口反馈到 SPEC。
- 维护者 2026-11-14 确认评论：同意只调整 `buildVerificationPrompt()` 和定向测试；确认状态矩阵、旧任务回退、具体反例门槛与幂等口径；付费真实模型 spot check 须另行审批预算。
- 可追溯位置：https://github.com/HMYDK/ai-native-sdlc-dsh/issues/21

### Outcome

- O-1: `buildVerificationPrompt()` 读取 Delivery Contract 的五个子节，提取关键 Outcome 并映射到 AC；旧任务缺契约时回退 Intent/Spec 散文并标注推导/不确定。
- O-2: Prompt 给出可执行的状态与证据矩阵：已证实交付失败用 `reject`，仅证明 AC 不足用 `needs_human`，来源/边界实质歧义用 `needs_human` + `unverified`，无关旧失败不阻断；hidden tests 不扩需求。
- O-3: 定向单测和至少 5 个离线反例覆盖正向交付、明确遗漏、明确局部范围、关键证据缺失、无关历史失败；真实模型行为证据因预算未批不运行，交给后续预算批准 / #22。

### Boundary

- 承诺：上述 O-1..O-3；只修改 `packages/sdlc/src/verify/verdict.ts`、`verdict.test.ts` 和 `docs/evals/ac-validity-1b-counterexamples.md`。
- 排除：不新增 Agent、Runner、工作流阶段、Verdict Schema 或语义硬门禁；不修改状态机、AC 解析/登记、Spec 指纹、`checkAdvance` 或 `enforceCriteriaPolicy`。
- 排除：不运行真实模型付费案例；不做统计性评测或 A/B（#22 负责）；不默认跑全项目 E2E；不依赖 `workflow/skill.ts` 的可见性。
- 假设：验证者能读取已登记 Spec 和 Delivery Contract；旧任务可能没有契约；Source 的原始文本可能无法取得。
- 依据：Issue #21 与维护者确认评论；#20 已在 `dev` 合并（`085c8fd`）。

### Oracle

- O-1: `cd packages/sdlc && npm run build && node --test lib/verify/verdict.test.js` 通过；prompt 输出包含 Delivery Contract 消费和回退规则。
- O-2: 定向单测断言状态矩阵、`needs_human` 与 blocking finding 的区别、hidden tests 不是承诺；人工 Review prompt 文本。
- O-3: `npm run verify` 通过；`docs/evals/ac-validity-1b-counterexamples.md` 含 5 个反例及预期 verdict；真实模型行为明确标注“未取得/待预算批准”。

### AC mapping

- O-1 → AC-001, AC-002
- O-2 → AC-003, AC-004, AC-005
- O-3 → AC-006

## Acceptance Criteria

- AC-001: `buildVerificationPrompt()` 优先读取已登记 Spec 的 `## Delivery Contract` 五子节，提取 1–3 个关键 Outcome；缺少契约的旧任务回退 Intent/Spec 散文并明确标注“推导/不确定”；`## Acceptance Criteria` 仍是唯一权威清单，`AC mapping` 只用于充分性反查，不能缩减必验 AC。
- AC-002: Prompt 区分查找顺序与事实权威：可核对的原始需求/Issue 原文 > Actor 撰写的 Delivery Contract > `intent_of_change`；Source 字段只是引用、不是已验证事实，Source 与 Outcome/Boundary 冲突时指出矛盾，不采纳自洽改写；hidden tests / 官方 Grader 不进入 Outcome 列表，除非 Source 明确引用。
- AC-003: Prompt 要求每个关键 Outcome 反查支撑 AC，并给出“这些 AC 全部 `met`、该 Outcome 仍失败”的最小具体反例；反例必须落在已确认 Boundary 内且可实现；说不出来就不报缺口；关键真实入口无法执行或决定性交付证据缺失时写进 `unverified`，影响交付结论时用 `needs_human`，不得默认 `approve`。
- AC-004: Prompt 明确状态矩阵：已证实真实消费入口/已确认 Outcome 失败且属本次承诺 → `reject`（命令/输出/来源/影响）；已证实 AC 不足但未证实际交付失败 → `needs_human`（顶层，不得用 `approve` + blocking finding 代替）；Source/Boundary 实质歧义或关键证据无法确认 → `needs_human` + `unverified`（仅在影响交付结论时阻断）；无关既有失败留证不阻断；已确认范围外的独立功能不能因 hidden tests 失败而扩需求。
- AC-005: Prompt 复用现有 issue / `issue_results` 做幂等复验：前轮同一问题没有新证据时不得重复创建 finding 或无意义返工，但也不得因“此前提过”自动放行；必须确认 resolved / clarified / deferred / unresolved；AC 缺口建议经 `sdlc_task_issue` 退回 SPEC、补 AC/证据后复验；不修改状态机、AC 解析或 Verdict Schema。
- AC-006: 定向单测覆盖上述 prompt 规则；`docs/evals/ac-validity-1b-counterexamples.md` 至少 5 个离线反例（正向交付、明确遗漏、明确局部范围、关键证据缺失、无关历史失败）及预期 verdict；`npm run verify` 通过；由于付费预算未批准，AC-002/003 的真实模型行为证据未取得，任务不得宣称已行为验证；独立 A/B 留 #22。

## Requirements

1. 在 `buildVerificationPrompt()` 的「交付路径检查」之前新增「验收充分性反查」小节；不重写 #16 的交付路径规则，引用它跑同一条代表性真实路径。
2. 反查流程：读取 Delivery Contract（旧任务回退散文并标注推导）→ 提取 1–3 个 Outcome → 映射支撑 AC → 构造最小具体反例 → 缺口用 `spec_mismatch` 报 Source/遗漏 Outcome/反例/建议 AC 或证据。
3. 状态矩阵、`needs_human` 与 blocking finding 的区别、Source 事实权威、hidden tests 边界、幂等和 SPEC 返工规则写进 prompt。
4. 定向单测覆盖 prompt 不变量；明确字符串存在不等于行为验证；不新增 schema/状态机/Agent/Runner。
5. 新增 `docs/evals/ac-validity-1b-counterexamples.md`，至少 5 个离线反例及预期 verdict；明确真实模型行为待预算批准，#22 做独立 A/B。
6. 保持 prompt 紧凑；`evidence` 仍按 2–4 行写；不要求验证者输出完整 Outcome→AC 映射，只报缺口/`unverified`。

## Design

- 在 `buildVerificationPrompt()` 的“必须回答的问题”之后、“交付路径检查”之前插入新小节，按“来源与事实权威 → Outcome 提取 → AC 映射 → 最小反例 → 真实路径 → 状态矩阵 → 幂等/SPEC 返工”的顺序写。
- 复用现有 `Finding.category='spec_mismatch'`、`unverified`、三态 verdict 和 `issue_results`；不新增输出字段。
- 明确机械约束：`approve` + `severity=blocking` 会被 `enforceCriteriaPolicy()` 改成 `reject`；所以“AC 充分性不明”必须让顶层裁决为 `needs_human`，不能靠 blocking finding 表达不确定。
- 旧任务缺 Delivery Contract 时，先从 Intent/Spec 散文推导 Outcome 并标注“推导/不确定”；不确定性只在影响目标/范围判断时升级为 `needs_human`。
- 测试只断言 prompt 规则存在、顺序和关键边界；离线反例表用于人工 Review 和后续模型 spot check，#22 负责统计性效果。
- 不修改 `workflow/skill.ts`；规则只随任务 prompt 下发，避免依赖未验证的 Skill 可见性。

## Areas of concern

- **误报与 `needs_human` 膨胀**：必须用“具体、可实现、落在 Boundary 内”的反例门槛约束；说不出来就不报。
- **blocking finding 的机械语义**：`approve` + blocking 会变成 `reject`，不是 `needs_human`；AC 缺口必须显式让顶层为 `needs_human`。
- **Source 权威**：查找顺序不等于事实权威；Actor 写的 Delivery Contract 可能自洽但偏离原始需求，Source 原文冲突时要指出。
- **旧任务回退**：缺契约不等于不可验证，也不等于必然 `needs_human`；只在实质影响判断时阻断。
- **hidden tests / Grader**：不是用户承诺；不能因外部评分扩 AC，也不能用模糊的 out-of-scope 掩盖真实入口失败。
- **幂等**：不重复报同一问题，但也不能因“此前提过”自动放行；必须走 `issue_results` 复验。
- **证据层级**：单测只证明规则存在；真实模型行为未取得（预算未批），不能宣称行为已验证；#22 才做 A/B。
- **prompt 体积与生成失败风险**：新小节保持紧凑，不要求长 mapping；`evidence` 仍短写，长日志写 `/tmp`。
