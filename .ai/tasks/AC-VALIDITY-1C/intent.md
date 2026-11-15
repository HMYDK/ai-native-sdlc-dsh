# Intent: 用独立反例与 FeatureBench A/B 判定验收有效性提升及成本（Phase 0）

## Problem

#20 已在 Spec 中建立 Delivery Contract 并加了结构检查；#21 让 Verifier 消费该契约、反查 Outcome→AC 充分性。两者已合并到 `dev`（`5ee68cd`），但只有 prompt 单测和离线反例，**没有真实模型行为证据**，也没有独立评测判断：

- 是否真的减少了「`approve` 但原始 Source/用户目标未交付」；
- 是否只是把 `needs_human`、误拒、Token/墙钟和返工成本推高；
- 收益到底来自 Delivery Contract（#20）、Verifier prompt（#21），还是 Actor 写作改善；
- 官方 FeatureBench `resolved` 与 Source 承诺冲突时如何处理。

首次 Phase 0 执行后，唯一一次独立 `sdlc_verify` 返回 **reject**。审核者接受材料作为草稿，但要求先修复 F1–F7：主实验与 B1 消融必须拆成两份可审计 manifest；A/B2/B1 必须真正使用各自的插件构建（per-arm plugin dir + tarball hash）；六类 fixture 必须可执行；handoff 必须给出可复现的 preflight/dry-run；S-01/Oracle/arm key/工作区表述必须修正。修复后申请一次单独授权的复验，暂不启动 Phase 1/2，也不直接合入 `dev`。

## Proposed outcome

Phase 0 整改交付：

1. **独立 case table / ground truth**：官方 FP 8 runs / 2 任务、官方 FN 3 runs / 2 任务；官方 FP 与 Source 层错误放行分开；gettext/doctest 标 Source/Grader conflict，provisional；3 个 FN 标 censored；增加 **Source 依赖核验**（不写“已证实 FP=0/FN=0”）。
2. **可执行离线 fixture**：仓库内 `tools/evals/featurebench/fixtures/ac-validity-1c/check_fixtures.py` 物化六类 git repo 并用 `unittest` 检查真实入口；单一命令可复跑；S-01 补订单 ID；不新建 Runner。
3. **预注册实验方案**：主 manifest 只 A=`master@920b0eb` / B2=`dev@5ee68cd`，5 任务 × 2 臂 = **10 runs**；B1=`085c8fd` 单独 manifest，3 sympy × 1 臂 = **3 runs**，不含 sphinx；每臂固定 commit → tarball sha256 → 解包目录 → preset/DSH/镜像；preflight 负例 fail closed。
4. **分阶段预算**：Phase 0 第二次 verify（1 call / ≤2M / ≤30min，已批准）；Phase 1 6 calls / 8M / 2h；Phase 2 主实验 10 runs / 120M / 8h；B1 3 runs / 30M / 2h。
5. **交接 + Draft PR**：`evals/ac-validity-1c-phase0` 分支上的 Draft PR，列 base/head、F1–F7 修复对照、精确 Phase 1/2 命令、审批边界；首次 reject 保留为历史事实。

## Affected users and systems

- 维护者、独立审查者：需要可审查的 Phase 0 材料、F1–F7 修复证据与最终复验依据。
- 执行 Phase 1/2 的另一台机器：需要完整上下文、每臂插件身份链、镜像/归档和可复制命令。
- `docs/evals/`、`tools/evals/featurebench/manifests/ac-validity-1c/`、`tools/evals/featurebench/` 的 runner/preflight/fixtures、CI `evals-check`、任务 `AC-VALIDITY-1C`。
- #22：最终验收；本任务只做 Phase 0，不宣称 DONE。

## Constraints

- 本轮不运行 Phase 1/2 付费模型；Phase 0 只允许两次独立 `sdlc_verify`（首次已 reject；第二次 1 call / ≤2M / ≤30min / 不重试，已获用户批准）。
- 不安装 `featurebench`、不拉取官方镜像、不恢复归档；sympy 镜像 10.65GB 不拉取；不启动 Docker/无头 Chrome。
- 允许修改/新增 `tools/evals/featurebench` 的 runner/preflight/fixture 与 CI 确定性检查；**不改 `packages/sdlc` 插件代码**、不新建 Runner/评测平台。
- 预注册必须分成主实验（A/B2，10 runs）与 B1（3 runs）两份 manifest；`--only-arm` 不能代替预注册计划。
- 每臂必须固定 commit → npm pack tarball sha256 → 解包目录 → effective preset/DSH/plugin 版本；hash 不匹配/缺映射 fail closed，`--allow-version-mismatch` 不能绕过 hash。
- 人工 gold label 必须独立于 A/B Actor 生成的 Spec/Delivery Contract/Verifier 裁决；最终由审查者核对。
- 官方 FeatureBench `resolved` 只作旁证；Source 与 Grader 冲突时不得等同于用户任务失败；不能写“Source 层已证实 FP=0/FN=0”。
- 独立任务使用 sympy `test_inverse` / `test_nullspace` / `test_puiseux`；不复用 VERIFY-01 的 astropy 3 任务。
- 提交到独立分支 + Draft PR，不直接合入 `dev`；遇到分支保护或工具阻塞停下报告，不绕过。

## Open questions

以下不是 Phase 0 阻塞项，但必须由审查者/维护者决定：

1. 8 个官方 FP 的 provisional Source 层标签：`approve`（接受 Source 排除句）/ `needs_human`（排除句不足）/ `reject`（缺失符号属于承诺路径）。
2. 第二次 `sdlc_verify` 的 verdict 是否接受；若 reject，是否批准下一轮修复（超出当前两次 verify 预算）。
3. Phase 1（8M/2h/6 calls/2M）、Phase 2 主实验（120M/8h）、B1（30M/2h）的付费授权。
4. sympy 镜像 rebake 与 Phase 2 环境准备是否批准。
5. 人工 gold label 的最终核对人。
