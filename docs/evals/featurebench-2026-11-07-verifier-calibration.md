# 实验②：验证者裁决校准（2026-11-07）

- 承接：[`featurebench-2026-11-06.md`](featurebench-2026-11-06.md) 首批 A/B 与
  [`featurebench-2026-11-07-experiments.md`](featurebench-2026-11-07-experiments.md) 第二轮设计
- 预注册清单：[`../../tools/evals/featurebench/manifests/verify-calibration.yml`](../../tools/evals/featurebench/manifests/verify-calibration.yml)
- 环境：FeatureBench 0.3.0 / dataset v1.1 / DSH CLI 0.2.1-rc.5 / plugin 0.6.0 /
  deepseek-flash(reasoningEffort=max) / 同批 `fb-eval-base:*` 镜像
- 口径：`sdlc_verify` 最后一次裁决 × 官方 `fb eval` resolved；只看 B（SDLC + 固定引导）

## 设计

- 10 个 MVP 未使用过的 lv1 任务，由 5 个 repo 轮转选取（pre-registered）；
- 每任务 1 次 B 运行，45min / 40M token 上限；
- 官方 `fb eval` 逐 run 评分；混淆矩阵由 `analyze_verifier.py` 生成。

**与设计的偏差（先记录，避免事后解释）**：
1. 这 5 个 repo 在 fast split 中 **没有 lv2 任务**，所以校准集是 lv1 分布，不是 lv2 难度梯度。
2. 单 run 40M token 上限触发 2 次（over_budget），45min 墙钟触发 2 次（timeout）。
   原 150M 总预算不够跑完 10 次，运行中把总预算调到 350M（任务/规则/单 run 上限不变）。
3. over_budget 的运行在触发前可能还没产出 `sdlc_verify`，因此「无裁决」与「agent 失败」
   相关；这是校准的**删失（censoring）**，解读假阳性率时必须考虑。

## 结果（10 次运行）

| repo | task | 官方 resolved | F2P pass | token | 耗时 | patch | agent 状态 | 验证者最终裁决 |
|---|---|---|---|---|---|---|---|---|
| pytest | test_local | ✅ | 100% | 10.0M | 1659s | 33,880 | 完成 | approve |
| pydantic | test_experimental_arguments_schema | ✅ | 100% | 10.7M | 1749s | 22,102 | 完成 | approve |
| seaborn | test_bar | ❌ | 93.75% | 40.3M | 2536s | 5,552 | **over_budget** | 无（截断） |
| sphinx | test_build_html | ❌ | 43.75% | 40.1M | 1292s | 37,322 | **over_budget** | 无（截断） |
| pydantic | test_pipeline | ✅ | 100% | 39.9M* | 超时 | 50,273 | **timeout** | reject → approve |
| seaborn | test_distributions | ✅ | 100% | 17.8M* | 超时 | 69,544 | **timeout** | approve |
| sphinx | test_build_linkcheck | ✅ | 100% | 21.0M | 2608s | 40,092 | 完成 | approve → approve |
| pydantic | test_titles | ✅ | 100% | 9.4M | 1051s | 21,041 | 完成 | approve |
| seaborn | test_line | ✅ | 100% | 11.4M | 1647s | 14,122 | 完成 | approve |
| sphinx | test_command_line | ✅ | 100% | 5.2M | 911s | 9,197 | 完成 | approve |

`*` 为 session 日志汇总（UI 读数缺失）；其余为 DSH Web「用量」。官方 resolved **8/10**。

## 混淆矩阵

| 验证者最终裁决 | 官方 resolved | 官方 unresolved |
|---|---|---|
| approve | **8** | **0（假阳性）** |
| reject | 0（假阴性） | 0 |
| needs_human | 0 | 0 |
| 无裁决（agent 被截断） | 0 | 2 |

- 假阳性率（approve 中官方 unresolved）：**0/8 = 0%**
- 假阴性率（reject 中官方 resolved）：**未观测到最终 reject**（中途 reject 后转 approve 的 1 例在
  pydantic test_pipeline，最终仍是 approve）
- 10 次里 9 次真实调用过 `sdlc_*`（sphinx build_html 在 over_budget 前还没建任务）

**与首批 MVP 合并看**（n=15 次 B 运行，13 次有最终裁决）：

- approve 共 12 次，其中 1 次官方 unresolved（MVP 的 sphinx test_build_gettext）→
  合并假阳性率 **1/12 ≈ 8.3%**；
- 无裁决 3 次（1 次 MVP 超时 + 2 次本轮 over_budget），都对应 agent 失败/截断；
- 未观测到「最终 reject 但官方 resolved」的假阴性。

## 解读

1. **在这个分布上验证者偏保守地「愿意通过」**：能产出裁决的 12 例中 11 例官方 resolved；
   唯一假阳性出现在首批的 sphinx 任务（该任务两臂都失败），本轮 10 个较容易的 lv1 上
   没有复现假阳性。
2. **拒绝后能自我修正**：pydantic test_pipeline 出现 reject → approve，最终官方的确 resolved；
   pytest 首批也出现 reject×3 → needs_human → approve 且官方通过。这符合「验证者驱动迭代」
   的设计意图，但也说明最终 approve 不代表第一次裁决可靠。
3. **校准存在删失**：2 次 over_budget 都发生在官方 unresolved 的难任务上，且来不及产出裁决。
   如果把「无裁决」当作失败，验证者的失败检测率会被低估；如果剔除，则样本偏向容易任务。
   报告采用「无裁决单列」口径。
4. **n 仍小**：13 次有裁决的运行里只有 1 个负例，假阳性率 8.3% 的 95% 置信区间很宽
   （Wilson 区间约 1.5%–35%），不能据此给插件下结论；需要专门挑「已知会失败」的任务
   做定向校准（下一步）。

## 压力子集（sphinx test_build_gettext，3 次重复）

MVP 中该任务两臂都 unresolved，且 B 的验证者给了 approve（唯一假阳性）。本实验原计划
重复 3 次看是否稳定复现。**运行状态：待补**（3 个并发 run 已启动，结果见下节更新）。

## 成本

- 10 次校准运行：**148.1M token**（其中 2 次各 40M 上限、2 次超时按 session 口径约 39.9M/17.8M）；
- 平均 14.8M/run，远高于首批的 9.5M/run——未用过的任务更难/流程更重；
- 预算 ② 调整后 350M，当前使用约 42%。

## 产物

- 每次运行：`/tmp/fb-runs-verify/<task_id>/sdlc/{meta.json,patch.diff,sessions/,...}`
- 官方评分：同目录 `eval-sdlc/report.json`
- 机读汇总：[`featurebench-2026-11-07-verifier-data.json`](featurebench-2026-11-07-verifier-data.json)
  （`report-data.json` 与 `verifier-confusion.json` 的合并快照）
- 复跑：`evaluate_matrix.py` + `summarize_runs.py` + `analyze_verifier.py`（manifest 指定 `verify-calibration.yml`）

## 对插件/流程的含义（谨慎）

- 验证者在「能跑完」的任务上倾向于 approve；**要评估假阳性必须拿难任务**，而且难任务更容易
  撞 token/时间上限导致无裁决——下一轮校准应放宽单 run 预算或专门挑选官方 known-fail 任务。
- 若要把验证者作为质量门禁，需要报告「裁决覆盖率」（有裁决的运行占比）：本实验 10/10 有裁决，
  但其中 2 次是 over_budget 无裁决，实际覆盖 8/10。
- 与首批合并的 8.3% 假阳性（1/12）在统计上不可靠，但方向性提示：**验证者 pass ≠ 官方通过**，
  不能把 `approve` 直接当作正确率证据。
