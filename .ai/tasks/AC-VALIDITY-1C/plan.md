# Plan: 用独立反例与 FeatureBench A/B 判定验收有效性提升及成本（Phase 0）

## Files that change

- `docs/evals/ac-validity-1c-case-table.md`（新增）：可读的独立 case table / ground truth。
- `docs/evals/ac-validity-1c-case-table.json`（新增）：机读版，供后续脚本/Phase 1 使用。
- `docs/evals/ac-validity-1c-offline-fixtures.md`（新增）：6 类离线 fixture 说明；Phase 1 固定场景 1/2/3，其余 3 类保留。
- `docs/evals/ac-validity-1c-preregistration.md`（新增）：A/B2 主实验 + B1 条件性消融、任务、指标、分母、停止与决策规则。
- `tools/evals/featurebench/manifests/ac-validity-1c/ac-validity-1c.yml`（新增）：与 verify-01 同构的预注册 manifest。
- `docs/evals/ac-validity-1c-budget.md`（新增）：Phase 1/2 预算申请与停止条件。
- `docs/evals/ac-validity-1c-handoff.md`（新增）：另一台机器的环境/归档/决策/运行步骤/审批边界。
- `.ai/tasks/AC-VALIDITY-1C/`：任务制品与验证记录。

## Order of work

1. 从 `docs/evals/verify-01-attribution-data.json` 的 11 个历史案例（7 V1 FP + 1 V2 FP + 3 FN）和 `featurebench-runs.jsonl` 提取字段；按 task 去重；raw archive 缺失标 unavailable。
2. 把 #21 的 6 个离线场景转成 fixture 说明与预期 verdict；固定 Phase 1 场景 1/2/3。
3. 写预注册 manifest（A/B2、B1 条件性消融、3 新任务 + 2 诊断、deepseek-flash、DSH 0.2.2-rc.3、ITT/decided/task/run、失败/超时、停止/决策规则）。
4. 写预算文档：Phase 1 ≤8M / 2h / 6 calls / 单次 ≤2M；Phase 2 主实验 ≤120M / 8h；B1 另批 ≤30M / 2h。
5. 写另一台机器的交接文档：环境清单、镜像/归档位置、决策摘要、Phase 1/2 命令、审批边界、禁止事项。
6. 自检：case table 覆盖 6 类；历史 7 FP 去重为 2 任务；Phase 1 只固定 3 场景；manifest 字段与 verify-01 对齐；所有“未取得/待批准”标注清楚。
7. `npm run verify`（docs-only，不应影响代码）；如 manifest 可用现有 `sanity_check.py --structural`，跑一次。
8. 独立验证/PR 前审查：确认不改插件代码、不宣称行为已验证、不跑付费/不装环境。

## Risks

- **人工标签尚未独立核对**：case table 的 expected verdict 必须由审查者最终签字；我们只能准备材料并标 confidence。
- **历史 raw 缺失**：本机没有 archive；历史案例只能依赖 canonical/归因数据，raw session/patch 标 unavailable，等另一台机器补。
- **Source 与 Grader 冲突**：sphinx gettext/doctest 不能直接当作用户目标失败；必须单列并说明冲突。
- **A vs B 混淆**：A vs B2 只能报联合效果；B1 条件性消融的触发阈值必须在 Phase 2 前批准，不能事后挑样本。
- **新任务/镜像未定**：Phase 0 只给候选与镜像体积，不拉镜像；具体任务清单由审查者/维护者批准。
- **零 FP 不等于改善**：报告原始计数、task 去重、分母；不因 needs_human 增多宣布成功。
- **迁移成本**：新增 Delivery Contract 的在途 Spec 返工、结构误报、重登记/复验要进入守护指标，与 #24 分开。
- **文档漂移**：预算、任务清单、B1 阈值一旦写入预注册，运行前不得按结果修改；修改必须单独提交并说明。

## Proof

- Case table：至少 6 类案例、历史 11 案例按 task 去重（2 个 FP 任务 + 3 个 FN 任务）、每例有 Source/Outcome/Boundary/Oracle/官方分数/人工预期裁决/置信度/去重键/unavailable 标注。
- Offline fixtures：6 类场景说明，Phase 1 固定 1/2/3；每例含输入、操作、预期 verdict、可复核命令。
- Pre-registration：manifest 字段与 verify-01 同构；A/B2/B1、任务、模型、DSH、预算、指标、停止/决策规则全部固定。
- Budget：Phase 1/2 的 route/model、calls/runs、每 run/总 Token、墙钟/费用、停止条件写清。
- Handoff：另一台机器能据此恢复环境、找到镜像/归档、跑 Phase 1/2，并知道未批准不得付费。
- 回归：`npm run verify` 通过；`git diff --name-only` 不含插件代码/状态机/裁决 schema；不运行付费评测。
- 诚实边界：本轮不宣称减少错误放行；真实模型/官方 A/B 尚未执行。
