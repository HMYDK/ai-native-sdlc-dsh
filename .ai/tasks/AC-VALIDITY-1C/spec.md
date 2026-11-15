# Spec: 用独立反例与 FeatureBench A/B 判定验收有效性提升及成本（Phase 0）

## Delivery Contract

### Source

- Issue #22（AC-VALIDITY-01C）：要求用独立反例与 FeatureBench A/B 判定「交付契约 + Verifier AC 充分性审查」是否真实减少错误放行，并控制误拒、needs_human、Token/墙钟和返工成本。
- 维护者 2026-11-15 确认：批准建立 `AC-VALIDITY-1C` 并开展不调用付费模型的 Phase 0；不授权付费 spot check/A/B、不授权安装大型评测依赖或拉取 10–14GB 镜像。
- 用户 2026-11-15 逐项确认：历史口径修正、sympy 新任务、B1 3 runs / 30M / 2h、Phase 1 A=`085c8fd` / B=`5ee68cd`、Phase 2 A=`920b0eb` / B2=`5ee68cd` / B1=`085c8fd`、只跑 1 次 `sdlc_verify`（首次）。
- 首次 Phase 0 完成后，唯一一次独立 `sdlc_verify` 返回 **reject**（run `760afaff-1138-43ed-a80a-2436bcd7fc5b`），AC-002/AC-003 `not_met`，并给出 F1–F7。
- 审核者 2026-11-15 整改要求（[#22 comment](https://github.com/HMYDK/ai-native-sdlc-dsh/issues/22#issuecomment-6895299706)）：接受材料为草稿但不接受 Phase 0 完成；主实验与 B1 拆成两份 manifest；每臂真实使用各自插件构建；六类 fixture 可执行；handoff 提供可复现 preflight/dry-run；S-01/Oracle/arm key/工作区表述修正；提交独立 Draft PR；修复后申请一次单独授权的复验，暂不启动 Phase 1/2，不直接合入 `dev`。
- 用户 2026-11-15 授权：允许修改 `tools/evals/featurebench` 的 runner/preflight/fixture 与 CI 确定性检查；批准第二次 `sdlc_verify`（1 call / ≤2M / ≤30min / 不重试）；按独立分支 + Draft PR 交付；A 臂为 `AI 原生 SDLC` preset + `920b0eb` 基线插件构建。
- 可追溯位置：https://github.com/HMYDK/ai-native-sdlc-dsh/issues/22

### Outcome

- O-1: 独立 case table / ground truth（MD + JSON）覆盖历史诊断与 6 类场景；每例含 Source 原文/位置、Outcome/Boundary/Oracle、官方分数、Source 与 Grader 一致性、人工预期裁决与不确定性、去重键、unavailable/censored 原因；官方 FP 8 runs / 2 任务、官方 FN 3 runs / 2 任务；官方 FP 与 Source 层错误放行分开；gettext/doctest 标 conflict/provisional；3 个 FN 标 censored；增加 Source 依赖核验，明确“0 confirmed 不等于已证实 FP=0/FN=0”。
- O-2: 可执行离线 fixture：仓库内脚本物化六类 git repo（S1 正向、S2 明确缺口、S3 范围外、S4 证据缺失、S5 无关旧失败、S6 歧义），用 `unittest` 检查真实入口/测试；单一命令可复跑；S1 缺 amount 错误含订单 ID；不新建 Runner，不调用付费模型。
- O-3: 预注册方案与两份 manifest：主实验 A=`master@920b0eb` vs B2=`dev@5ee68cd`（5 任务 × 2 臂 = 10 runs）；B1=`085c8fd` 单独 manifest（3 sympy × 1 臂 = 3 runs，不含 sphinx）；每臂固定 commit → tarball sha256 → 解包目录 → preset/DSH/镜像；`run_matrix.py`/`run_arm.py` 支持 per-arm plugin dir 与 hash 校验；preflight 负例 fail closed。
- O-4: 分阶段预算与另一台机器的交接文档，包含 Phase 0 第二次 verify（1 call / 2M / 30min）、Phase 1（6 calls / 8M / 2h / 单次 2M）、Phase 2 主实验（10 runs / 120M / 8h）、B1（3 runs / 30M / 2h）、route/model、调用/run 数、停止条件、费用/墙钟口径、环境/镜像/归档、Phase 1/2 精确命令、审批边界；提交到 `evals/ac-validity-1c-phase0` 的 Draft PR，不直接合入 `dev`。

### Boundary

- 承诺：上述 O-1..O-4；修改/新增 docs、任务制品、`tools/evals/featurebench` 的 manifest/runner/preflight/fixture 与 CI 确定性检查。
- 排除：不运行 Phase 1/2/B1 付费模型（Phase 0 只允许第二次 `sdlc_verify`）；不安装 `featurebench`、不拉官方镜像、不恢复归档；不改 `packages/sdlc` 插件代码、不新增 Runner/评测平台；不把结构合规率当质量收益；不宣称减少错误放行或行为已验证；不直接合入 `dev`。
- 交付形态：Phase 0 交付 **provisional/censored 标注 + reviewer 待办 + 可执行 fixture + 两份 manifest + preflight + Draft PR**；最终人工 gold label 签字是 Phase 1/2 前置条件，不是本任务完成条件。
- 假设：另一台机器有 Docker、官方镜像和 `~/.dsh-eval-archive`；本机已有 featurebench 0.3.0、DSH App 0.2.2-rc.3、归档和 Chrome；sympy 镜像 10.65GB 在 Phase 1/2 前按批准 rebake。
- 依据：Issue #22、维护者/用户 2026-11-15 确认、审核者 2026-11-15 整改要求、`verify-01-attribution-data.json`、`featurebench-runs.jsonl`、`featurebench-verifier-confusion.json`、`~/.dsh-eval-archive/2026-11-08/`。

### Oracle

- O-1: `docs/evals/ac-validity-1c-case-table.md` 与 `.json` 存在；JSON 的 `summary.official_fp` 为 runs=8/tasks=2、`summary.official_fn` 为 runs=3/tasks=2、`source_layer_false_approvals.confirmed==0`、`source_layer_false_rejections.confirmed==0`、`synthetic_cases==6`；每个历史案例有 `source_quote`/`source_location`/`outcome`/`boundary`/`oracle`/`official_fb`/`source_grader_agreement`/`expected_verdict`/`label_status`/`dedup_key`；8 个官方 FP 为 `conflict` + `pending_reviewer`，3 个 FN 为 `censored`；JSON 含 `source_dependency_analysis`，且文本不写“已证实 FP=0/FN=0”。
- O-2: `tools/evals/featurebench/fixtures/ac-validity-1c/check_fixtures.py` 存在；`python3 ... --workdir /tmp/validity-1c-fixtures` 退出 0 且最后一行 `FIXTURES OK`；六类 repo 均被创建；S1 缺 amount 错误含 `ord-3`；S2 失败是 `NoneType`/`isoformat` 而非 import error；S3 外部失败来自 `Settings.verbose` 且不含 `parse_date`；S4 是 `missing_native_dep`；S5 legacy 在 base/head 都失败；S6 是 `app.versioning`/`add_uids`。
- O-3: `ac-validity-1c.yml` 只含 A/B2、5 任务、plan runs=10；`ac-validity-1c-b1.yml` 只含 B1、3 sympy、plan runs=3、无 sphinx；`check_ac_validity_1c.py --self-test` 输出 `SELF-TEST OK` 并拒绝 B1 加回主 arms、任务/预算变化、缺 image-map、同 hash、改 commit、删 B1 arm、phase1 calls 变化、B1 含 sphinx、TBD hash；主/B1 strict dry-run 分别输出 5/3 条 `[plan]` 与 `[preflight] OK`；`sanity_check.py --structural` 通过。
- O-4: `docs/evals/ac-validity-1c-budget.md` 含 Phase 0 第二次 verify、Phase 1/2/B1 的 route/model、calls/runs、Token/墙钟、停止条件；`docs/evals/ac-validity-1c-handoff.md` 列出两份 manifest、每臂 commit/tarball hash/解包目录、image-map、主/B1 strict preflight 命令、Phase 1 fixture 与 DSH 运行面、Draft PR 分支、审批边界、F1–F7 对应；不写“工作区干净”这类过期状态。
- AC-007 全局：`git diff --name-only` 不含 `packages/sdlc/src` 插件代码；`cd packages/sdlc && DSH_APP="$DSH_APP" npm run verify` 通过；`check_ac_validity_1c.py --self-test`、`check_fixtures.py`、`sanity_check.py --structural` 通过；CI `evals-check` 包含三条确定性检查；无付费 Phase 1/2 调用；文档明确“未运行/未宣称/未 DONE”。

### AC mapping

- O-1 → AC-001, AC-005
- O-2 → AC-002
- O-3 → AC-003
- O-4 → AC-004, AC-006
- 全局 → AC-007

## Acceptance Criteria

- AC-001: 产出独立 case table / ground truth（MD + JSON），覆盖历史诊断与局部接口 vs 外部扩需、正向完成、无关既有失败、原始需求歧义、关键证据缺失；每例含 Source 原文/位置、Outcome/Boundary/Oracle、官方分数（如适用）、Source 与 Grader 一致性、人工预期裁决与不确定性、task/scenario 去重键、unavailable/censored 原因；历史 11 个案例按数据修正为官方 FP 8 runs / 2 任务、官方 FN 3 runs / 2 任务，官方 FP 与 Source 层错误放行分开；gettext/doctest 标 Source/Grader conflict 且 provisional 待审查者；3 个 FN 标 censored；含 Source 依赖核验，且**不写“Source 层已证实 FP=0/FN=0”**。
- AC-002: 产出可执行离线 fixture，覆盖至少 6 类场景；Phase 1 固定使用 #21 场景 1/2/3（正向通过、明确缺口、范围外独立失败），其余 3 类保留；`check_fixtures.py` 用单一命令物化 repo 并运行真实入口/`unittest`，S1 补“错误包含订单 ID”，S2 失败不是 import error，S3 外部失败不指向目标路径；不新增 Runner，不调用付费模型。
- AC-003: 产出预注册方案与两份 manifest：主实验 A=`master@920b0eb` vs B2=`dev@5ee68cd`、5 任务 × 2 臂 = **10 runs**；B1=`085c8fd` **单独 manifest**、3 个 sympy × 1 臂 = **3 runs**、不含 sphinx；3 个 sympy 新任务（test_inverse / test_nullspace / test_puiseux）+ 2 个诊断任务；deepseek-flash、DSH 0.2.2-rc.3、ITT/decided/task/run 分母、失败/超时、停止/决策；每臂固定 commit → tarball sha256 → 解包目录 → preset/DSH/镜像；`run_matrix.py`/`run_arm.py` 支持 per-arm plugin dir 与 hash 校验；`check_ac_validity_1c.py --self-test` 负例 fail closed；B1 触发阈值 Phase 0 起草、Phase 2 前批准。
- AC-004: 产出分阶段预算申请：Phase 0 第二次 verify 1 call / ≤2M / ≤30min / 不重试；Phase 1 3 场景 × 2 臂 = 6 次 verifier 调用 / ≤8M / 2h / 单次 ≤2M；Phase 2 主实验 10 runs / ≤120M / 8h；B1 3 runs / ≤30M / 2h；写清 route/model、调用/run 数、停止条件、费用/墙钟口径；`--only-arm` 不能代替预注册计划。
- AC-005: 人工 gold label 由审查者最终核对；标签独立于 A/B Actor 生成的 Spec/Delivery Contract/Verifier 裁决；历史 raw 存在时列出归档路径与 sha256，缺失时标 unavailable，不用模型推断补齐；8 个官方 FP 的 Source 层标签为 provisional + conflict，3 个 FN 为 censored；Source 依赖核验只给“未证明是承诺路径必要依赖”，不代替审查者签字；不把官方 resolved 直接当 Source 层结论。
- AC-006: 产出/更新另一台机器的交接文档，包含已确认决策、Phase 0 成果清单、环境/镜像/归档位置（含 sympy 10.65GB 未拉取）、**两份 manifest**、每臂 commit/tarball sha256/解包目录、image-map、主/B1 strict preflight 命令、Phase 1 fixture/DSH 运行面、Phase 2 命令、预算与审批边界、禁止事项、独立分支 + Draft PR（base `dev@5ee68cd`，不直接合入 dev）、F1–F7 对应。
- AC-007: 本轮只改文档/案例表/manifest/任务制品，以及 `tools/evals/featurebench` 的 runner/preflight/fixture 与 CI 确定性检查；不改 `packages/sdlc` 插件代码；在 `packages/sdlc/` 运行 `DSH_APP="$DSH_APP" npm run verify`（build + test + smoke）通过；`check_ac_validity_1c.py --self-test`、`check_fixtures.py`、`sanity_check.py --structural` 通过；CI `evals-check` 包含这些确定性检查；不运行 Phase 1/2 付费评测；不宣称减少错误放行或行为已验证，任务不宣称 DONE。

## Requirements

1. 从 `docs/evals/verify-01-attribution-data.json`、`featurebench-runs.jsonl`、`featurebench-verifier-confusion.json`、`featurebench-baseline.md` 提取历史案例；用 `~/.dsh-eval-archive/2026-11-08/` 的 prompt/report/patch 核对 sha256；官方 FP 8/2、FN 3/2；V1/V2 分层。
2. 用只读归档核对 gettext/doctest 的承诺接口、缺失符号、官方 F2P 通过/失败项；说明缺失符号**未证明**是承诺消费路径的必要依赖；不写 FP=0/FN=0。
3. 把 #21 的 6 个离线场景变成仓库内可执行 fixture：git repo 生成器 + `unittest` 行为检查；S1 补订单 ID；Phase 1 固定 1/2/3。
4. 用现有 `tools/evals/featurebench` 工具；主实验/B1 两份 manifest；`run_matrix.py`/`run_arm.py` 支持 per-arm plugin dir 与 tarball hash；preflight 负例 fail closed；不新建 Runner。
5. 预注册和预算必须在运行前固定；不允许按结果挑任务、样本或阈值；sympy 任务选择规则为 fast split 中 sympy lv1 按 instance_id 字典序前 3 个。
6. 明确 Source/Outcome/Boundary/Oracle 与人工裁决的独立性；官方 `resolved` 只作旁证；官方 FP 与 Source 层错误放行分开。
7. 记录迁移/流程成本（在途 Spec 返工、结构检查误报、重登记/复验、人工澄清），与 #24 的已知边界分开。

## Design

- Case table 采用 markdown + JSON 双份：markdown 供人 review，JSON 供脚本/Phase 1 使用；字段包含 `case_id`、`source_case_key`、`group`、`stratum`、`task_id`、`run_id`、`source_location`、`source_quote`、`source_sha256`、`source_available`、`outcome`、`boundary`、`oracle`、`official_fb`、`official_vs_verdict`、`source_grader_agreement`、`source_layer_assessment`、`expected_verdict`、`provisional_candidates`、`label_status`、`label_confidence`、`dedup_key`、`unavailable_reason`、`evidence_paths`；顶层 `source_dependency_analysis`。
- 历史案例：V1 FP 7 + V2 FP 1 = 官方 FP 8 runs / 2 tasks（gettext 7、doctest 1）；FN 3 runs / 2 tasks（seaborn 2、packaging 1）；全部 8 个官方 FP 为 Source/Grader conflict，3 个 FN 为 censored；Source 依赖核验只给 provisional。
- 合成案例：`fixtures/ac-validity-1c/check_fixtures.py` 生成六类 repo；S1/S2/S3 用于 Phase 1；S4/S5/S6 保留；fixture 源码在脚本内的 `S*_BASE/S*_HEAD`。
- 预注册：主 manifest 只 A/B2（10 runs）；B1 单独 manifest（3 runs）；每臂 `plugin_tarball_sha256`/`plugin_dir`/`plugin_tarball`/preset/DSH/镜像；`check_ac_validity_1c.py` 做计划/身份/预算/负例检查；CI `evals-check` 接入。
- Runner：`run_matrix.py` 新增 `--arm-plugin-dir`/`--arm-plugin-tarball`/`--strict-preflight`；`run_arm.py` 新增 `--plugin-tarball`/`--expected-plugin-sha256`；hash 不一致/缺映射 fail closed；旧 `--plugin-dir` 兼容。
- 预算文档按 Phase 0 第二次 verify / Phase 1 / Phase 2 / B1 分列，给出 route/model、calls/runs、每 run/总 Token、墙钟、停止条件。
- 交接文档面向另一台机器：环境、两份 manifest、每臂身份链、image-map、主/B1 preflight、Phase 1 fixture/DSH、Phase 2 命令、审批边界、Draft PR。

## Areas of concern

- **Source 与官方 Grader 冲突**：gettext/doctest 是历史例子；必须单列，不能把官方 unresolved 直接当用户目标失败。8 个官方 FP 的 Source 层标签 provisional，由审查者核对。
- **官方 FP ≠ Source 层错误放行**：历史官方 FP 8 runs / 2 tasks，但 Source 层错误放行 0 confirmed；不得写成“已证实 FP=0”。
- **FN 删失**：3 个 FN 全部 agent_failure=timeout，官方 resolved=1.0 与 reject 矛盾；标 censored，不当作验证者误判。
- **A vs B 混淆**：A vs B2 同时改变 Actor Spec 写作和 Verifier 判断；只能报联合效果。B1 条件性消融必须预注册触发阈值，不能事后挑样本。
- **主实验与 B1 混跑**：B1 必须在单独 manifest，不能留在主 arms；`--only-arm` 不能代替两份计划。
- **插件身份**：三个 commit 的 package.json 都是 0.6.2；必须用 tarball sha256 + 解包目录 + preset + DSH/镜像共同绑定；`--allow-version-mismatch` 不能绕过 hash。
- **零错误放行不等于改善**：小样本零 FP 不能证明有效；报告原始计数、task 去重数和分母，不夸大比例。
- **结构合规不是质量**：Delivery Contract 子节存在/非空不代表 Source 真实、Outcome 正确、AC 充分；结构合规率单列。
- **迁移/返工成本**：新增必需章节可能导致在途 Spec 重登记、重跑验证；进入守护指标，与 #24 分开。
- **历史 raw 可用但未入库**：本机有归档；案例表列路径与 sha256，仓库不提交 raw session/patch。
- **环境/数据在另一台机器**：本机有归档/featurebench，但 sympy 镜像未拉；Phase 1/2 前需 rebake；宿主 PATH 无 dsh。
- **无付费授权**：Phase 1/2/B1 分别申请；Phase 0 只允许第二次 verify。
- **Draft PR**：不直接合入 dev；分支保护/工具阻塞时停下报告。
