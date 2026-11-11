# 实验④：扩样本 A/B（12 任务 × 2 臂）

- 日期：2026-11-07
- 预注册清单：[`../../tools/evals/featurebench/manifests/expanded.yml`](../../tools/evals/featurebench/manifests/expanded.yml)
- 设计：[`featurebench-2026-11-07-experiments.md`](featurebench-2026-11-07-experiments.md)
- 环境与首批一致：FeatureBench 0.3.0 / dataset v1.1 / DSH 0.2.1-rc.5 / plugin 0.6.0 /
  deepseek-flash(reasoningEffort=max) / 同批 `fb-eval-base:*` 镜像
- 口径：官方 `fb eval` 为唯一成绩；`timeout` / `over_budget` 计入分母不重试；
  每任务每臂各 1 次
- **2026-11-12 修订**：`analyze_expanded.py` 的 `both_resolved` 原先把 `diff==0`（含两臂
  都失败）也算作「都通过」；已改为只统计两臂都为 resolved。④ 的「两臂都通过」从 9 更正为
  **7**（都失败 2、B 独有 2、A 独有 0，共 11 对）。

## 设计

5 个已有镜像 repo 里 MVP 与②都未用过的 lv1 任务共 **12 个**（fast split 中这些 repo
没有 lv2），每任务跑两个 arm：

- `standard`：标准模式，prompt 无引导；
- `sdlc`：AI 原生 SDLC + 固定引导话术。

## 结果（官方评分）

| 指标 | A 标准 | B SDLC+引导 |
|---|---|---|
| resolved（有官方评分的 n=12） | **7/12（58.3%）** | **10/12（83.3%）** |
| 平均 F2P pass rate | 0.685 | 0.856 |
| token 中位数 | 4.6M | 10.4M |
| token p90 | 16.3M | 40.1M |
| timeout / over_budget | 1 / 0 | 3 / 1 |

> 注：一个 A 组任务（seaborn regression）没有成功产出可评分运行，paired 口径下是 11 对。

### paired 比较（两臂都有评分的 11 个任务）

- **B 独有通过 2 个**（seaborn test_relational、sphinx test_ext_napoleon_docstring）；
- **A 独有通过 0 个**；
- 7 个任务两臂都通过；
- 2 个任务两臂都失败（sphinx test_ext_doctest、test_ext_math）；
- 平均差（B − A）= **+0.182**（方向性，n=11，不能据此做显著性结论）。

### 按 repo

| repo | A | B |
|---|---|---|
| mwaskom/seaborn | 3/4 | 5/5 |
| pydantic/pydantic | 1/1 | 1/1 |
| sphinx-doc/sphinx | 3/6 | 4/6 |

### 逐任务

| task | A | B | A tokens | B tokens | A 失败 | B 失败 |
|---|---|---|---|---|---|---|
| seaborn test_plot | ✅ | ✅ | 1.9M | 7.7M | — | — |
| seaborn test_regression | —（无可评分） | ✅ | — | 40.1M | — | timeout |
| seaborn test_relational | ❌（F2P 0.118） | ✅ | 4.6M | 10.4M | — | — |
| seaborn test_scales | ✅ | ✅ | 1.9M | 0.16M | — | timeout |
| seaborn test_statistics | ✅ | ✅ | 0.7M | 4.9M | turn_error | — |
| pydantic test_types_self | ✅ | ✅ | 13.2M | 10.3M | — | — |
| sphinx test_domain_c | ✅ | ✅ | 5.3M | 12.0M | — | — |
| sphinx test_ext_doctest | ❌（0.091） | ❌（0.091） | 0.13M | 3.5M | — | — |
| sphinx test_ext_intersphinx | ✅ | ✅ | 16.3M | 0.79M | — | timeout |
| sphinx test_ext_math | ❌（0.074） | ❌（0.185） | 21.3M | 40.1M | — | over_budget |
| sphinx test_ext_napoleon_docstring | ❌（0.941） | ✅ | 4.2M | 36.1M | — | timeout |
| sphinx test_util_nodes | ✅ | ✅ | 4.7M | 12.7M | — | — |

## 解读

1. **方向与首批相反、与③不同**：扩样本上 B 的 resolved 更高（10/12 vs 7/12，B 独有 2、
   A 独有 0）。但这**不等于「SDLC 有效」**：
   - n=12、每臂 1 次，2 个 B 独有通过里有一个是 timeout 截断后的补丁；
   - 2 个任务两臂都失败，B 在 sphinx test_ext_napoleon 是 timeout 但补丁通过；
   - ③（同任务 4 条件）没有观测到 B/引导的正向主效应 → ④ 的正向信号与 ③ 的方向
     不一致，最可能的解释是**单次运行方差** + 任务难度分布不同（④ 的任务更难，
     两臂都会失败，B 的流程在部分难任务上恰好奏效）。
2. **成本差异是确定的**：B 的 token 中位数是 A 的 **2.3 倍**、p90 是 **2.5 倍**，
   且有 3 次 timeout、1 次 over_budget；A 只有 1 次 timeout。若要把 B 作为默认流程，
   需要按 resolved/成本权衡，而不是只看 resolved。
3. **验证者**：12 次 B 运行中 9 次与官方一致、1 次不一致、2 次无裁决（timeout 截断），
   与②结论一致：approve 不能当成绩使用。
4. **泄漏**：24 次运行扫描均未命中 gold 签名（这些镜像没有 packaging 那种 vendored 参考实现）。

## 局限

- 每任务每臂 1 次，无法估计运行方差；④ 与③ / 首批的结论方向不一致，说明单次样本
  的噪声足以翻转 ±25pp 的 resolved 率。
- 任务是「5 个 repo 的剩余 lv1」，不是按难度分层的随机样本；fast split 里这批 repo
  没有 lv2，无法覆盖多文件大任务。
- timeout/over_budget 的补丁被官方评分并计入（若有补丁），这是「固定预算下的结果」；
  报告中单列了失败类型，不能与「完整跑完的运行」混为一谈。

## 产物

- runs：`/tmp/fb-runs-expanded/<task_id>/<arm>/`（含 eval-<arm>/report.json）
- 机读：[`featurebench-2026-11-07-expanded-data.json`](featurebench-2026-11-07-expanded-data.json)
- 复跑：`run_matrix.py --manifest manifests/expanded.yml --retry-failed`
  → `evaluate_matrix.py` → `summarize_runs.py` → `analyze_expanded.py`

## 下一步（建议）

1. **重复采样**：同一任务每臂跑 ≥3 次，先估计运行方差，再看 ③/④ 的方向矛盾是否能被
   方差解释；这是回答「SDLC 是否提升」的必要条件。
2. **按难度分层选任务**：需要 lv2 或多 repo 的难任务（要额外镜像），避免 4/5 全过的
   天花板效应。
3. **成本感知评估**：把 timeout/over_budget 作为明确约束，报告「每 1M token 的 resolved 数」。
