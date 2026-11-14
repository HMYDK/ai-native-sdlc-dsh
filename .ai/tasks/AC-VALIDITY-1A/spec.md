# Spec: 交付契约（Delivery Contract）

## Delivery Contract

### Source

- Issue #20：AC-VALIDITY-01A，要求在现有 Intent/Spec 中定义可追溯的交付契约（Source / Outcome / Boundary / Oracle / AC mapping）。
- 维护者 2026-11-14 决策评论：采用方案 A1，包含五个子章节的结构检查；严格限定保证边界，不把结构检查宣传成需求正确性的强制保证。
- 可追溯位置：https://github.com/HMYDK/ai-native-sdlc-dsh/issues/20

### Outcome

- O-1: `spec.md` 有一个唯一的、可被下游引用的 `## Delivery Contract`，位于 `## Acceptance Criteria` 之前，包含 `### Source` / `### Outcome` / `### Boundary` / `### Oracle` / `### AC mapping` 五个固定子节。
- O-2: `sdlc_artifact_check` 能报出 Delivery Contract 或其子节的缺失、空正文、占位符；现有 AC 解析、AC 注册和 Spec 指纹规则不回归。
- O-3: 写作指导、模板、三个示例和测试同步；文档明确结构完整 ≠ 语义充分、本项不是状态推进硬门禁、不自动重写历史 Spec。

### Boundary

- 承诺：上述 O-1..O-3；只扩展制品结构契约、写作指导和文档/测试。
- 排除：不新增制品文件、任务阶段、`state.yaml` 字段或 Verdict Schema；不修改 `checkAdvance`；不做语义检查、通用 Markdown AST 或新 DSL；不自动重写历史 Spec；不做真实模型行为评测（交给 #22）。
- 假设：旧 Spec 保留原记录；在途 Spec 更新需 `overwrite: true`，并因 Spec 指纹变化记录退回 SPEC、重新登记 AC。
- 依据：维护者决策评论，以及当前代码中 `checkAdvance` 不调用 `checkArtifact` 的事实。

### Oracle

- O-1: `npm test` 中 `artifact.test.ts` 的章节/子节/骨架/别名用例通过；骨架仍判为不通过。
- O-2: `npm run verify`（build + test + smoke）通过；`smoke/acceptance.mjs` 的 spec 夹具在补契约后仍 `structure_ok`；`smoke/artifact.mjs` 能报出缺失子节。
- O-3: `docs/artifact-delivery-contract.md` 含三个示例；`TASK.md` 与 `sdlc:artifact-policy` 含规则；人工 Review 核对覆盖范围。

### AC mapping

- O-1 → AC-001, AC-002
- O-2 → AC-002, AC-004
- O-3 → AC-003, AC-005

## Acceptance Criteria

- AC-001: `spec.md` 必需章节增加唯一的 `## Delivery Contract`，位于 `## Acceptance Criteria` 之前；五个 `###` 子节固定为 Source / Outcome / Boundary / Oracle / AC mapping；不新增制品文件、任务阶段、`state.yaml` 或裁决 Schema。
- AC-002: `checkArtifact('spec', ...)` 检查 Delivery Contract 及五个子节的缺失、空正文、占位符；空 `###` 标题不能被当作正文；复用现有 findings 与局部解析，不建设通用 Markdown AST / 新 DSL；现有 `parseSpecAcceptance`、AC 注册和 Spec 指纹规则不回归。
- AC-003: 写作指导/模板和 `docs/artifact-delivery-contract.md` 覆盖正常功能、只修局部接口、原始需求/外部评分冲突三个示例；明确 hidden tests / Grader 不是用户承诺，Source 不可取得时可标记「待确认」，AC mapping 只引用现有 AC ID。
- AC-004: 同步 `artifact.ts`、`artifact/index.ts`、`artifact.test.ts`、`smoke/artifact.mjs`、`smoke/acceptance.mjs`、`TASK.md`；`npm run verify`（build + test + smoke）通过；旧 AC 解析/登记、旧 Spec/在途任务的兼容影响被如实记录。
- AC-005: 文档明确结构完整 ≠ 语义充分；`checkAdvance` 不调用 `checkArtifact`，本项不是状态推进硬门禁；不自动重写历史 Spec；AC-003 的行为证据只到「规则/模板 + 示例 + 人工 Review」，真实模型行为交 #22。

## Requirements

1. `REQUIRED_SECTIONS.spec` 增加 `Delivery Contract`，放在 `Acceptance Criteria` 之前；其 `subsections` 固定为五个：`Source`、`Outcome`、`Boundary`、`Oracle`、`AC mapping`，并提供宽松别名。
2. `checkArtifact('spec', ...)` 增加局部子节解析：每个子节必须存在、正文非空、不残留以尖括号包裹的待填占位符；空 `###` 标题不能被算作正文。
3. 顶层章节顺序检查：Delivery Contract 必须在 Acceptance Criteria 之前；否则报 `invalid`，并说明这会破坏 AC 解析。
4. `skeletonFor('spec', ...)` 生成包含五个子节及用途注释的骨架；骨架仍因占位符被判不合格。
5. `sdlc:artifact-policy` 写作指导增加 Delivery Contract 说明；模板、`TASK.md` 和 `docs/artifact-delivery-contract.md` 同步。
6. `AC mapping` 只引用 `Acceptance Criteria` 中的 AC ID；不在契约里复制第二份 AC 清单，不改变 `parseSpecAcceptance` 的解析范围。

## Design

- 在 `artifact.ts` 的 `SectionSpec` 上增加可选 `subsections`；用局部 `###` 行解析和 `subsectionBody` 完成检查，不引入通用 Markdown AST。
- 子节 finding 的 `section` 使用 `Delivery Contract / Source` 形式；`kind` 复用现有 `missing` / `empty` / `placeholder`。
- 顶层顺序检查只在 `kind === 'spec'` 且两个章节都出现时执行；顺序错误用 `invalid` findings，保留 `SectionFinding` 原类型。
- 写作指导文本移到纯模块 `policy.ts`，`artifact/index.ts` 引用它，便于单测验证内容；不改变 system prompt 的注册方式。
- 所有新检查只作用于 `sdlc_artifact_check` / `sdlc_artifact_write` 的制品结构层；`checkAdvance`、`parseSpecAcceptance`、AC 注册和裁决 Schema 不改。

## Areas of concern

- **不是硬门禁**：`checkAdvance` 不调用 `checkArtifact`；Actor 直接写 `spec.md` 仍可绕过。文档必须写实，不能宣传成强制保证。
- **语义无法自动验证**：Source 真实性、Outcome 充分性、AC mapping 完整性由 #21 的独立验证者和人核对；结构检查只保证章节存在且非空。
- **旧任务迁移**：新增必需章节会让旧 Spec 在 `sdlc_artifact_check` 下报缺章；旧骨架不再匹配 `isUnmodifiedSkeleton`，需要 `overwrite: true`；更新在途 Spec 会改变 Spec 指纹，必须退回 SPEC 重新登记。不得自动重写历史 Spec。
- **解析器交互**：Delivery Contract 必须在 Acceptance Criteria 之前；它的 `###` 子标题若落在 AC 章节内，会让 `parseSpecAcceptance` 把子标题当成非法续行。顺序检查要在报错信息里说清这一点。
- **SMOKE / 文档漂移**：`smoke/acceptance.mjs` 的 spec 夹具、`smoke/artifact.mjs` 的缺失数、`artifact.test.ts` 的章节名列表和 `wellFormed` 必须同步；漏一处就会出现「测试通过但夹具仍是旧契约」的假绿。
