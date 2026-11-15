# Spec: 用独立反例与 FeatureBench A/B 判定验收有效性提升及成本（Phase 0）

## Delivery Contract

### Source

- Issue #22：AC-VALIDITY-01C，要求用独立反例与 FeatureBench A/B 判定「交付契约 + Verifier AC 充分性审查」是否真实减少错误放行，并控制误拒、needs_human、Token/墙钟和返工成本。
- 维护者 2026-11-15 确认：批准建立 `AC-VALIDITY-1C` 并开展不调用付费模型的 Phase 0；不授权付费 spot check/A/B、不授权安装大型评测依赖或拉取 10–14GB 镜像。
- 用户确认：完整 Phase 0；首轮模型 `deepseek-flash`；Phase 1 固定 3 个核心场景（#21 场景 1/2/3）× 2 臂、≤8M Token / 2h、单次 ≤2M、6 次调用；Phase 2 A vs B2 主实验 + B1 条件性消融、3 新任务 + 2 诊断、≤120M / 8h，B1 另批 ≤30M / 2h；独立任务使用新 repo + 新任务；人工 gold label 由审查者最终核对；历史归档在另一台机器上提供；Phase 0 以任务 + PR 到 dev 交付。
- 可追溯位置：https://github.com/HMYDK/ai-native-sdlc-dsh/issues/22

### Outcome

- O-1: 独立 case table / ground truth 覆盖历史诊断、局部接口 vs 外部扩需、正向完成、无关既有失败、原始需求歧义、关键证据缺失；含 Source/Outcome/Boundary/Oracle、官方分数、Source 与 Grader 一致性、人工预期裁决、去重键与 unavailable 标注。
- O-2: 可复核离线 fixture 覆盖 6 类场景；Phase 1 固定使用场景 1/2/3，另外 3 类保留给 Phase 2/后续；不新增 Runner。
- O-3: 预注册方案固定 A vs B2、B1 条件性消融、3 新任务 + 2 诊断、deepseek-flash、DSH 0.2.2-rc.3、指标分母、失败处理、停止条件、keep/rework/revert 规则。
- O-4: 分阶段预算申请与另一台机器的交接文档，包含 Phase 1/2 上限、route/model、calls/runs、环境/镜像/归档、已确认决策和运行步骤。

### Boundary

- 承诺：上述 O-1..O-4；只新增文档、案例表、manifest 和任务制品。
- 排除：不运行付费模型；不安装 `featurebench`、不拉官方镜像、不恢复归档；不改插件代码、不新增 Runner/评测平台；不把结构合规率当质量收益。
- 假设：另一台机器有 Docker、官方镜像和 `~/.dsh-eval-archive`；Phase 1/2 在切换后按 Phase 0 清单执行并单独申请授权。
- 依据：Issue #22、维护者 2026-11-15 确认评论、用户逐项确认。

### Oracle

- O-1: case table 的每个案例可追溯到 Source 原文/位置、官方 report 或明确 unavailable；人工预期裁决由审查者复核。
- O-2: fixture 文档包含输入、操作、预期 verdict 与可复核命令；Phase 1 只跑固定的 3 个场景。
- O-3: 预注册 manifest 在运行前固定；`tools/evals/featurebench/manifests/ac-validity-1c/ac-validity-1c.yml` 可被现有 `sanity_check.py` 做结构校验。
- O-4: 预算文档给出 Phase 1/2 的 route/model、调用/run 数、每 run 与总 Token、墙钟/费用上限、停止条件；交接文档可让另一台机器独立执行。

### AC mapping

- O-1 → AC-001, AC-005
- O-2 → AC-002
- O-3 → AC-003
- O-4 → AC-004, AC-006
- 全局 → AC-007

## Acceptance Criteria

- AC-001: 产出独立 case table / ground truth，覆盖历史诊断、局部接口 vs 外部扩需、正向完成、无关既有失败、原始需求歧义、关键证据缺失；每例含 Source 原文/位置、Outcome/Boundary、Oracle、官方分数（如适用）、Source 与 Grader 是否一致、人工预期裁决与不确定性、task/scenario 去重键；历史 7 次 FP 按 2 个任务去重并单列诊断。
- AC-002: 产出可复核离线 fixture，覆盖至少 6 类场景；Phase 1 固定使用 #21 场景 1/2/3（正向通过、明确缺口、范围外独立失败），其余 3 类保留；fixture 含输入、操作、预期 verdict、可复核命令，不新增 Runner，不调用付费模型。
- AC-003: 产出预注册方案：A vs B2 主实验、B1 条件性消融、3 个新任务 + 2 个诊断任务、deepseek-flash、DSH 0.2.2-rc.3、同一镜像/权限/超时/预算、ITT/decided/task/run 分母、失败/超时处理、停止条件、keep/rework/revert 判定规则；B1 触发阈值在 Phase 0 起草、Phase 2 前批准。
- AC-004: 产出分阶段预算申请：Phase 1 为 3 场景 × 2 臂、6 次 verifier 调用、≤8M Token / 2h、单次 ≤2M；Phase 2 主实验 ≤120M Token / 8h；B1 另批 ≤30M / 2h；写清 route/model、调用/run 数、停止条件、费用/墙钟口径。
- AC-005: 人工 gold label 由审查者最终核对；标签独立于 A/B Actor 生成的 Spec/Delivery Contract/Verifier 裁决；历史 raw session/patch 缺失时标 unavailable，不用模型推断补齐；另一台机器的归档位置在交接文档中列出。
- AC-006: 产出另一台机器的交接文档，包含已确认决策、Phase 0 成果清单、环境/镜像/归档位置、Phase 1/2 运行步骤、预算与审批边界、禁止事项（未批准不得付费、不得拉镜像等）。
- AC-007: 本轮只改文档/案例表/manifest/任务制品，不改插件代码；`npm run verify` 通过；CI 不运行付费评测；不宣称减少错误放行或行为已验证（真实模型与官方 A/B 尚未执行）。

## Requirements

1. 从 `docs/evals/featurebench-runs.jsonl`、`featurebench-verifier-confusion.json`、`verify-01-attribution-data.json`、`featurebench-baseline.md` 和历史 #16 归因表提取历史案例；raw archive 缺失时标 unavailable。
2. 把 #21 的 6 个离线场景转成可复核 fixture 说明，固定 Phase 1 的 3 个核心场景。
3. 使用现有 `tools/evals/featurebench` 的 manifest/运行/评分/汇总工具；不新建 Runner 或评测平台。
4. 预注册和预算必须在运行前固定；不允许按结果挑任务、样本或阈值。
5. 明确 Source/Outcome/Boundary/Oracle 与人工裁决的独立性；官方 `resolved` 只作旁证。
6. 记录迁移/流程成本（在途 Spec 返工、结构检查误报、重登记/复验、人工澄清），与 #24 的已知边界分开。

## Design

- Case table 采用 markdown + JSON 双份：markdown 供人 review，JSON 供后续脚本/Phase 1 使用；字段包含 `case_id`、`group`、`task_id`、`run_id`、`source_quote`、`source_available`、`outcome`、`boundary`、`oracle`、`official_fb`、`source_grader_agreement`、`expected_verdict`、`label_confidence`、`unavailable_reason`、`dedup_key`。
- 历史案例从 `verify-01-attribution-data.json` 的 11 个案例（7 V1 FP + 1 V2 FP + 3 FN）提取；按 task 去重后为 2 个 FP 任务 + 3 个 FN 任务；历史 7 次 FP 仅诊断。
- 合成案例复用 #21 的 6 个场景，补充 fixture 说明与预期 verdict；Phase 1 只跑 1/2/3。
- 预注册 manifest 沿用 `manifests/verify-01/verify-01.yml` 的字段结构：arms、run_policy、metrics、scoring、tasks、selection_rule、stop_rules；A/B2 主实验，B1 条件性消融单独写。
- 预算文档按 Phase 1/2 分列，给出 route/model、calls/runs、每 run/总 Token、墙钟/费用、停止条件。
- 交接文档面向另一台机器：环境清单、镜像/归档位置、已确认决策、Phase 1/2 命令、审批边界、禁止事项。

## Areas of concern

- **Source 与官方 Grader 冲突**：sphinx gettext/doctest 是历史例子；必须单列，不能把官方 unresolved 直接当用户目标失败。人工 gold label 需审查者核对。
- **A vs B 混淆**：A vs B2 同时改变 Actor Spec 写作和 Verifier 判断；只能报联合效果。B1 条件性消融必须预注册触发阈值，不能事后挑样本。
- **零错误放行不等于改善**：小样本零 FP 不能证明有效；报告原始计数、task 去重数和分母，不夸大比例。
- **结构合规不是质量**：Delivery Contract 子节存在/非空不代表 Source 真实、Outcome 正确、AC 充分；结构合规率单列。
- **迁移/返工成本**：新增必需章节可能导致在途 Spec 重登记、重跑验证；进入守护指标，与 #24 分开。
- **历史证据缺失**：raw session/patch 不在本机；历史案例以 canonical 与归因数据为准，unavailable 要如实标注。
- **环境/数据在另一台机器**：本机不安装、不拉镜像；交接文档必须让另一台机器知道全部上下文和禁止事项。
- **无付费授权**：Phase 1/2 分别申请；未经批准不跑真实模型。
