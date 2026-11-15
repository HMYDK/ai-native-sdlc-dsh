# AC-VALIDITY-1C 分阶段预算申请（Phase 0 草稿）

- **对应 issue**：[#22](https://github.com/HMYDK/ai-native-sdlc-dsh/issues/22)
- **状态**：**Phase 1 / Phase 2 / B1 未批准任何付费调用**。Phase 0 的两次独立验证已分别获用户批准：首次 1 次 `sdlc_verify`（≤2M / 30min / 不重试，已返回 reject）；整改后的第二次 1 次 `sdlc_verify`（≤2M / 30min / 不重试）。本文件是 Phase 1 / Phase 2 / B1 的预算上限与停止条件；批准前只做离线工作。
- **口径**：token 按 DSH driver 的 `usage_tokens`（UI 口径）记录；缺失时用 session 汇总兜底并标注来源。墙钟按 `run_arm` / driver 的 `meta.json` 记录。失败、超时、超预算的 run 都进入 ITT 分母，不静默剔除。

---

## 1. 汇总

| Phase | 内容 | 调用/run 数 | Token 上限 | 墙钟上限 | 单次上限 | 状态 |
|---|---|---|---:|---:|---:|---|
| Phase 0 整改复验 | 1 次独立 `sdlc_verify` | **1 call** | **2M** | **30min** | **2M/call** | 已批准（用户） |
| Phase 1 | 3 场景 × 2 臂 verifier 调用 | **6 calls** | **8M** | **2h** | **2M/call** | 未批准 |
| Phase 2 主实验 | 3 新任务 + 2 诊断 × 2 臂 A/B2 | **10 runs** | **120M** | **8h** | **40M/run** | 未批准 |
| Phase 2 B1 消融 | 3 新任务 × 1 臂 `085c8fd` | **3 runs** | **30M** | **2h** | **10M/run** | 未批准；阈值待批准 |

- 模型/路由：`deepseek-account` / `deepseek-flash`；`reasoning_effort=max`。
- 运行环境：DSH `0.2.2-rc.3`；镜像按仓库 `bake_base.py` 用 rc.3 rebake；Phase 2 的 sympy 官方镜像 10.65GB，Phase 0 不拉取。
- **费用**：本文件只批准 token/墙钟上限，不写未经核实的单价；实际费用按 provider 账单核对。任何超限都停止，不先花后补。
- **计划数**：主实验 5 任务 × A/B2 = **10 runs**；B1 单独 manifest 3 任务 × B1 = **3 runs**。`--only-arm` 只是筛选工具，不能代替两份预注册清单（审核意见 F1）。

---

## 1.1 Phase 0 整改后的第二次验证（已批准）

| 项目 | 值 |
|---|---|
| 目的 | 复核 F1–F7 修复与 AC-002/AC-003 的 `not_met` 项；首次 `reject` 保留为历史事实 |
| 调用 | **1 次 `sdlc_verify`**；不重试；不跑 Phase 1/2 |
| 模型/路由 | `deepseek-account/deepseek-flash` |
| Token | **≤2M**；工具未返回用量时以 session 汇总兜底并标注 |
| 墙钟 | **≤30min**；超时停止，不重试 |
| 环境 | 只读文档/工具/确定性检查；不启动 Docker、不拉 sympy 镜像、不调用 FeatureBench |
| 记录 | run_id、verdict、逐项 AC、findings、工具执行、token/墙钟（可得时） |
| 停止 | token/墙钟超限或工具阻塞即停止；不因 reject 自动重跑 |

---

## 2. Phase 1（3 场景 × 2 臂）

**目的**：只比较 verifier prompt（A=`085c8fd` 旧 verifier / B=`5ee68cd` #21 verifier），固定 #21 场景 1/2/3 的输入。

| 项目 | 值 |
|---|---|
| 场景 | S-01 正向通过、S-02 明确缺口、S-03 范围外独立失败 |
| 臂 | A=`085c8fd`、B=`5ee68cd` |
| 调用 | 3 × 2 = **6 次 verifier 调用** |
| 模型 | `deepseek-account/deepseek-flash`，`reasoning_effort=max` |
| Token | 总 **≤8M**；单次 **≤2M**；超出即停止 |
| 墙钟 | 总 **≤2h**；单场景/单臂不单独超 30min 硬限（记录实际值） |
| 输入锁定 | 同一场景的 Source、criteria、diff、test_evidence、scope、代码快照、环境、工具面逐字相同；只换插件构建 |
| 记录 | run_id、verdict、findings、实际命令/工具、token、耗时；人工复核 finding 可复现 |
| 统计 | 不做显著性、不外推；不把 needs_human 增多当成功 |

**停止条件**：总 token 8M、总墙钟 2h、单次 2M 任一达到即停止；基础设施错误最多重试 1 次（前后都记录），agent 失败/超时/无裁决不重试。

**分母**：6 次调用全部计入；没有拿到结构化 verdict 的调用记为 `no_verdict`，不剔除。

---

## 3. Phase 2 主实验（A vs B2）

**目的**：在 3 个新 sympy 任务 + 2 个历史诊断任务上，比较 A=`master@920b0eb` 与 B2=`dev@5ee68cd` 的**联合效果**（#20 + #21），并记录成本/返工。

| 项目 | 值 |
|---|---|
| 任务 | 3 新（sympy test_inverse/test_nullspace/test_puiseux）+ 2 诊断（sphinx gettext/doctest） |
| 臂 | A=`920b0eb`、B2=`5ee68cd`；每任务每臂 1 rep；顺序交替 |
| Run 数 | 5 × 2 = **10 scored runs** |
| Token | 总 **≤120M**；单 run **≤40M**；达到总上限立即停止 |
| 墙钟 | 总 **≤8h**；单 run timeout **2700s** |
| 模型/环境 | `deepseek-flash`；DSH 0.2.2-rc.3；同一镜像、权限、工具面、超时、预算 |
| 控制 | 每个任务先做 gold/empty control；control 失败的任务不进入效果分母，单列 unscoreable |
| 分母 | ITT（所有启动的 run，含失败/超时/超预算/空补丁）、decided（有结构化 verdict）、task（按任务去重）三套并报 |
| 主指标 | Source 层错误放行（人工 gold label；task 去重；报 run/task 原始计数） |
| 守护指标 | Source 层错误拒绝、needs_human、无裁决/超时、scope 冲突处理、token、墙钟、返工/复验 |
| 旁证 | 官方 `resolved` / `pass_rate` 单列，不与 Source 层混算 |

**停止条件**：

- 总 token 120M 或总墙钟 8h 达到：停止，保留已产生 run，报告未完成数。
- 单 run >40M 或 >2700s：按失败记录（ITT），不重试。
- 同一 task/arm 连续 2 次 infra error：停止该 phase，先修环境。
- gold/empty control 失败：不进入效果分母，单列并报告。
- 分支保护/凭据/镜像/工具链阻塞：停止并报告，不绕过。

**费用口径**：10 个 run 的实际 token 以 driver/UI 为准；缺 UI 口径时用 session 汇总并标注。总预算 120M 是上限，不是目标；用不完不补跑。

---

## 4. Phase 2 B1 条件性消融

**目的**：只有 #20、旧 verifier 的 `085c8fd` 是否已经足够；隔离 verifier 效应。

| 项目 | 值 |
|---|---|
| 臂 | `085c8fd`（只有 #20、旧 verifier） |
| 任务 | 3 个新 sympy 任务（与主实验相同） |
| Run 数 | 3 × 1 = **3 runs** |
| Token | 总 **≤30M**；单 run **≤10M** |
| 墙钟 | 总 **≤2h**；单 run timeout 2700s |
| 触发 | 按 [preregistration](ac-validity-1c-preregistration.md#b1-threshold) 的阈值；Phase 2 前单独批准 |
| 不触发 | A/B2 都是 0 或相同（无信号），或 B2 引入已确认的 Source 层错误拒绝（先报 guardrail 回归） |

**停止条件**：30M / 2h / 单 run 10M 任一达到即停止；不重试。

**解释边界**：B1 只回答“旧 verifier + #20 是否足够”，不能把 B1 的改善直接归因给 #21，也不能在 B1 未触发时声称 #20 无效。

---

## 5. 预算会计与审批

- **Token 来源**：优先 driver 的 `usage_tokens`；缺失时用 session 汇总，报告里标注 `tokens_source`。
- **墙钟来源**：`run_arm` 的 `meta.json` / driver 记录；包含容器启动、模型、评分之外的实际耗时按 run 记录。
- **失败/超时**：全部进入 ITT 分母；`no_verdict` 与 `unscoreable` 单列，不并入 decided。
- **重试**：仅 infra_error 允许 1 次，前后都记录；agent 失败/超时/unresolved 不重试。
- **超限**：任一上限达到即停止该 phase；不把超限 run 算作有效裁决；不先超额再申请。
- **批准**：Phase 0 的两次 verify 已分别批准（各 1 call/2M/30min）；Phase 1（8M/2h/6 calls/2M）、Phase 2 主实验（120M/8h）、B1（30M/2h）分别批准。
- **人工 gold label**：审查者最终核对，不计入模型 token/墙钟预算，但属于实验完成的前置条件。
- **费用**：按 provider 实际账单；本文件不承诺金额，只约束 token/墙钟。

---

## 6. 与其它文档的关系

- [预注册方案](ac-validity-1c-preregistration.md)：臂、任务、指标、停止/决策规则。
- [主 manifest](../../tools/evals/featurebench/manifests/ac-validity-1c/ac-validity-1c.yml) / [B1 manifest](../../tools/evals/featurebench/manifests/ac-validity-1c/ac-validity-1c-b1.yml)：机读上限。
- [offline fixtures](ac-validity-1c-offline-fixtures.md)：Phase 1 的 6 次调用怎么跑。
- [case table](ac-validity-1c-case-table.md)：历史 FP/FN 口径。

**除 Phase 0 的两次验证外，本文件不批准任何调用**；Phase 1/2/B1 需要维护者分别批准。
