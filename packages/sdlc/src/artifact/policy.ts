/**
 * `sdlc:artifact-policy` 的正文。
 *
 * 放在纯模块里，是为了让单测能直接核对“写作指导写了什么”，
 * 而不是只测结构检查。⚠️ 内容测试只能证明句子存在，不能证明 Actor 会照做；
 * 真实行为由 #21 的验证者和 #22 的评测检验。
 *
 * 边界必须写在这里（并同步 TASK.md）：
 *   · 只查结构，不查语义；
 *   · `checkAdvance` 不调用 `checkArtifact`，所以不是状态推进硬门禁；
 *   · hidden tests / 外部 Grader 不是用户承诺，除非 Source 明确引用。
 */
export const ARTIFACT_POLICY_TEXT = [
  '## 制品撰写（AI 原生 SDLC）',
  '',
  '手册给每种制品规定了必需章节，而这些章节**都是下游的输入**——缺一节，下游就少一个输入：',
  '',
  '- `intent.md`：Problem / Proposed outcome / Affected users and systems / Constraints / **Open questions**',
  '  - `Problem` 要能追溯到原始需求（引用/摘录）；`Proposed outcome` 写最终消费者可观察的结果，不是“实现某函数”。',
  '  - `Open questions` 是规格阶段的输入：spec 必须逐条回答或延续。',
  '- `spec.md`：**Delivery Contract** / **Acceptance Criteria** / Requirements / Design / **Areas of concern**',
  '  - 只允许一个 `## Delivery Contract`，且必须放在 `## Acceptance Criteria` 之前，固定五个子节：',
  '    - `### Source`：原始需求/Issue/文档的可追溯引用或摘录；不可取得或含糊时写“待确认”，不编造。',
  '    - `### Outcome`：最终消费者可观察的结果；每个关键目标一条，不写实现动作。',
  '    - `### Boundary`：本次承诺/排除事项与依赖假设；范围变化要有依据。',
  '    - `### Oracle`：代表性真实调用入口 + 预期结果；供验证阶段执行。',
  '    - `### AC mapping`：每个 Outcome 对应哪些 AC；只引用 Acceptance Criteria 的 AC ID，不复制第二份清单。',
  '  - `## Acceptance Criteria` 是唯一的权威 AC 清单：每项单独一行 `- AC-001: 明确要求`；编号唯一，全部必验。',
  '  - hidden tests / 外部 Grader 不是用户承诺，除非 Source 明确引用；范围冲突写进 Areas of concern，不要偷偷扩 AC。',
  '  - 首次进入 PLANNED 或更后续阶段登记整个 Spec；登记后包括说明文字的修改都要回到 SPEC 重新登记。',
  '- `plan.md`：Files that change / Order of work / Risks / **Proof**',
  '  - `Proof` 是验证阶段对账的依据——“计划里承诺的证据”要能对得上。',
  '',
  '用 `sdlc_artifact_write` 写、`sdlc_artifact_check` 先查草稿（不写盘）。',
  '',
  '⚠️ 这两个工具**只查结构，不查质量**：章节和五个子节在不在、是不是空/占位符会被检查；但 Source 是否真实、Outcome 是否充分、AC mapping 是否完整，程序不判断。结构合规的废话照样通过。',
  '⚠️ 这不是状态推进硬门禁：`checkAdvance` 不调用 `checkArtifact`；直接写 `spec.md` 仍可绕过。语义和证据由独立验证者（#21）与人核对。',
].join('\n');
