# Intent: 在 Spec 中定义可追溯的交付契约（Delivery Contract）

## Problem

Actor 自己生成 Intent/Spec/AC 时，可能把需求遗漏得非常一致：Spec 里只有一份扁平的 AC 清单，没有固定位置表达「原始来源是什么、要交付的可观察 Outcome 是什么、承诺/排除的边界在哪、用什么真实入口判断、每条 Outcome 由哪些 AC 支撑」。现有 `sdlc_artifact_check` 只做结构检查，`shared/acceptance.ts` 只保证 AC 格式、完整登记和 Spec 版本一致；下游验证者（#21）只能从散文里猜目标，无法稳定地反查 AC 是否充分。

## Proposed outcome

1. `spec.md` 有一个唯一的 `## Delivery Contract`，位于 `## Acceptance Criteria` 之前，包含 `### Source / Outcome / Boundary / Oracle / AC mapping` 五个固定子节。
2. `sdlc_artifact_check` 能报出 Delivery Contract 或其子节的缺失、空正文、占位符；现有 AC 解析、AC 注册和 Spec 指纹规则不回归。
3. 写作指导、模板、三个示例和测试同步；文档明确结构完整 ≠ 语义充分、本项不是状态推进硬门禁、不自动重写历史 Spec。

## Affected users and systems

- 使用 AI 原生 SDLC 任务的作者：需要按固定契约写 Spec。
- 独立验证者（#21）：需要一个稳定、可引用、可版本化的 Outcome/AC 锚点。
- `packages/sdlc/src/artifact/`（结构检查、写作指导、模板）、`smoke/`、`TASK.md` 和仓库文档。
- 不涉及 `state.yaml` / Verdict Schema / 状态机。

## Constraints

- 不新增制品文件、任务阶段、`state.yaml` 字段或裁决 Schema。
- 不修改 `checkAdvance`；`checkAdvance` 不调用 `checkArtifact`，所以本项不是任务推进硬门禁。
- 不做语义校验：Source 真实性、Outcome 充分性、AC mapping 完整性由 #21 的验证者和人核对。
- 不建设通用 Markdown AST / 新 DSL；用局部解析完成子节检查。
- 不自动重写历史 Spec；旧任务保留原记录。
- 三个完整示例放文档，不塞进每次验证者 Prompt。
- 真实模型行为验证交给 #22，本次不宣称运行时保证。

## Open questions

- 旧 Spec / 在途任务更新到新契约时，是否需要额外的工具提示或迁移脚本？本次先给出可复现的迁移说明，不做自动改写。
- UI 是否需要在制品面板中突出 Delivery Contract？本次不修改 UI，留给后续需要时处理。
