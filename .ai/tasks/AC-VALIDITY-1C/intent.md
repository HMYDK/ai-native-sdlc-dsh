# Intent: 用独立反例与 FeatureBench A/B 判定验收有效性提升及成本（Phase 0）

## Problem

#20 已在 Spec 中建立 Delivery Contract，并加了结构检查；#21 让 Verifier 消费该契约、反查 Outcome→AC 充分性。两者已合并到 `dev`（`90e48ce`），但只有 prompt 单测和离线反例，**没有真实模型行为证据**，也没有独立评测判断：

- 是否真的减少了「`approve` 但原始用户目标未交付」；
- 是否只是把 `needs_human`、误拒、Token/墙钟和返工成本推高；
- 收益到底来自 Delivery Contract（#20）、Verifier prompt（#21），还是 Actor 写作改善；
- 官方 FeatureBench `resolved` 与原始需求的冲突如何处理。

历史数据只有 canonical 汇总，raw session/patch 不在本机；评测工具链与环境也需要在另一台已有镜像的机器上恢复。

## Proposed outcome

Phase 0（不调用付费模型、不安装大型评测依赖、不拉镜像）交付：

1. **独立 case table / ground truth**：历史诊断、局部接口 vs 外部扩需、正向完成、无关既有失败、原始需求歧义、关键证据缺失；含 Source 原文、Outcome/Boundary、Oracle、官方分数、Source 与 Grader 是否一致、人工预期裁决与去重键；历史 raw 缺失标 unavailable。
2. **可复核离线 fixture**：至少覆盖 Phase 1 固定的 3 个核心场景（正向通过、明确缺口、范围外独立失败），并保留另外 3 个场景供 Phase 2/后续；不新建 Runner。
3. **预注册实验方案**：A vs B2 主实验、B1 条件性消融、3 个新任务 + 2 个诊断、deepseek-flash、DSH 0.2.2-rc.3、指标分母、失败处理、停止条件、keep/rework/revert 规则。
4. **分阶段预算申请**：Phase 1（3 场景 × 2 臂，≤8M Token / 2h，单次 ≤2M，6 次调用）、Phase 2（主实验 ≤120M / 8h；B1 另批 ≤30M / 2h）。
5. **另一台机器的交接文档**：环境/镜像/归档位置、已确认决策、任务清单、运行步骤、审批边界。

## Affected users and systems

- 维护者、独立审查者：需要可审查的 Phase 0 材料与最终 keep/rework/revert 依据。
- 执行 Phase 1/2 的另一台机器：需要完整上下文、环境/镜像/归档和运行命令。
- `docs/evals/`、`tools/evals/featurebench/manifests/`、任务 `AC-VALIDITY-1C`。
- #22：最终验收；本任务只做 Phase 0。

## Constraints

- 本轮**不运行付费模型**；Phase 1/2 的真实模型调用分别申请授权。
- 本轮**不安装 `featurebench`、不拉取官方镜像、不恢复 `~/.dsh-eval-archive`**；这些在另一台已有镜像/归档的机器上执行。
- 只新增文档/案例表/manifest/任务制品；不改插件代码、不新增 Runner/评测平台。
- 人工 gold label 必须独立于 A/B Actor 生成的 Spec/Delivery Contract/Verifier 裁决；最终由审查者核对。
- 模型首轮固定 `deepseek-flash`；Phase 2 主实验 A vs B2 报联合效果，B1 条件性消融阈值在 Phase 0 起草、跑前批准。
- 独立任务必须是新的 repo/task，不复用 VERIFY-01 已用过的 astropy 3 任务；具体候选在 Phase 0 提出并标注镜像体积，不直接拉取。
- 官方 FeatureBench `resolved` 只作旁证；Source 与 Grader 冲突时不得等同于用户任务失败。

## Open questions

无阻塞项。Phase 0 需要产出以下待批准事项：新的独立 repo/task 候选与镜像体积、B1 触发阈值、Phase 1/2 预算申请。环境安装与归档恢复在切换到另一台机器后按 Phase 0 清单执行。
