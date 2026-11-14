# Plan: 交付契约（Delivery Contract）

## Files that change

- `packages/sdlc/src/artifact/artifact.ts`：`SectionSpec.subsections`、`REQUIRED_SECTIONS.spec`、`checkArtifact` 子节/顺序检查、`skeletonFor` 子节骨架、模块说明。
- `packages/sdlc/src/artifact/policy.ts`（新增）：`sdlc:artifact-policy` 的纯文本常量，供 `index.ts` 与单测共用。
- `packages/sdlc/src/artifact/index.ts`：引用 `policy.ts`，更新模块说明和 system prompt 文本。
- `packages/sdlc/src/artifact/artifact.test.ts`：更新 spec 章节列表、`wellFormed`，增加 Delivery Contract 和五个子节的 missing/empty/placeholder、别名、顺序、骨架、AC 解析回归测试，以及 policy 文本断言。
- `packages/sdlc/smoke/artifact.mjs`：更新半成品 spec 的缺失数；增加含契约的合格 spec、缺失子节的 smoke。
- `packages/sdlc/smoke/acceptance.mjs`：spec 夹具补 Delivery Contract 五个子节，保持 AC 解析与登记断言不变。
- `packages/sdlc/TASK.md`：增加交付契约说明、模板、限制和迁移说明；更新 spec 必需章节列表。
- `docs/artifact-delivery-contract.md`（新增）：三个完整示例（正常功能、只修局部接口、原始需求/外部评分冲突）与结构检查边界说明。

## Order of work

1. 在 `artifact.ts` 增加 `SubsectionSpec`、`SectionSpec.subsections` 和 `REQUIRED_SECTIONS.spec` 的 Delivery Contract（放在 Acceptance Criteria 之前）。
2. 实现局部 `###` 子节解析与 `checkArtifact` 子节检查；增加 Delivery Contract 必须在 AC 之前的顺序检查；保留 existing findings 类型。
3. 更新 `skeletonFor`，让 spec 骨架包含五个子节注释，且仍然故意判为不合格。
4. 把 system prompt 文本移到 `policy.ts`，更新 `index.ts` 引用与说明。
5. 更新 `artifact.test.ts`：章节列表、`wellFormed`、子节检查、顺序、别名、AC 解析回归、policy 文本。
6. 更新 `smoke/artifact.mjs` 与 `smoke/acceptance.mjs` 夹具。
7. 写 `TASK.md` 与 `docs/artifact-delivery-contract.md`。
8. 构建并跑定向测试、`npm run verify`；必要时修回归。
9. 进入 VERIFYING，提交独立验证；处理 finding 后复验。

## Risks

- **空子节假通过**：只检查顶层 `##` 会把空 `###` 标题算作正文；必须逐个检查五个子节的 body。
- **AC 解析器交互**：Delivery Contract 的 `###` 子标题若落在 `## Acceptance Criteria` 章节内，会让 `parseSpecAcceptance` 把子标题当成非法续行；顺序检查要在报错信息里点明。
- **旧 Spec / 骨架迁移**：新增必需章节和骨架行会让旧 Spec 在 `sdlc_artifact_check` 下报缺章、旧骨架不再匹配 `isUnmodifiedSkeleton`；更新在途 Spec 需 `overwrite: true` 并退回 SPEC 重新登记。不得自动改写。
- **SMOKE 漂移**：`smoke/acceptance.mjs` 的 spec 夹具若不加契约，`structure_ok` 会红；`smoke/artifact.mjs` 的缺失数和 `required_sections` 会变。
- **边界误宣传**：`checkAdvance` 不调用 `checkArtifact`，本项不是状态推进硬门禁；文档和最终汇报都必须写实。
- **语义越界**：不要为 Source 真实性、Outcome 充分性或 AC mapping 完整性写半吊子语义检查；这些交给 #21 的验证者和人。

## Proof

- 定向单测：`cd packages/sdlc && npm run build && node --test lib/artifact/artifact.test.js`，覆盖章节/子节/顺序/骨架/别名/AC 解析回归。
- 全量：`cd packages/sdlc && npm run verify`，记录 build、test、smoke 的通过读数和关键输出。
- Smoke 证据：`smoke/artifact.mjs` 报出缺失子节；`smoke/acceptance.mjs` 的契约 spec 仍 `structure_ok` 且 AC 注册不回归。
- 文档证据：`docs/artifact-delivery-contract.md` 三个示例覆盖正常功能、局部接口、源冲突；人工 Review 核对 Source/Boundary/AC mapping。
- 边界证据：`git diff` 不包含 `src/task/state.ts`、`src/verify/verdict.ts` 或 `state.yaml`/Verdict Schema 的结构改动；`checkAdvance` 仍未调用 `checkArtifact`。
- 旧任务兼容：说明旧 Spec 不会被自动重写；`sdlc_artifact_check` 的兼容影响、骨架 overwrite 与 Spec 指纹退回重新登记要求写在 `TASK.md` 和示例文档中。
