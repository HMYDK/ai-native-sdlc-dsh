# 实验③：2×2 拆分（preset × 引导话术）

- 日期：2026-11-07
- 设计/预注册：[`featurebench-2026-11-07-experiments.md`](featurebench-2026-11-07-experiments.md)、
  [`../../tools/evals/featurebench/manifests/2x2.yml`](../../tools/evals/featurebench/manifests/2x2.yml)
- 环境：同首批（FeatureBench 0.3.0 / dataset v1.1 / DSH 0.2.1-rc.5 / plugin 0.6.0 / deepseek-flash max）
- 口径：官方 `fb eval` 为唯一成绩；每任务每条件 1 次；超时/over_budget 计入分母
- **2026-11-12 修订**：`summarize_runs.py` 原先对 SDLC 统计按 task 目录递归，2×2 下会把
  `sdlc/` 与 `sdlc_guidance/` 的会话合并计入两臂；已改为按当前 arm 目录统计并重算数据快照。
  原先「4 个 B 侧 arm 中 4/5 调用 sdlc_*」与「两个 SDLC arm 各有 1 例 mismatch」两句按真实
  分臂结果更正（见解读 4/5）。

## 问题

首批 B 组 = SDLC preset + 固定引导话术，两者混在一起。正确率没有差异到底说明
「SDLC 机制无增益」，还是「流程没被触发 / 引导话术本身有效或有副作用」？

## 设计

5 个 MVP 任务 × 4 个条件（共 20 次运行）：

| arm | preset | prompt_suffix |
|---|---|---|
| `standard` | 标准模式 | 无 |
| `standard_guidance` | 标准模式 | B 的固定引导话术 |
| `sdlc` | AI 原生 SDLC | 无 |
| `sdlc_guidance` | AI 原生 SDLC | B 的固定引导话术 |

**与设计的偏差**：中途出现并发 6 会话时模型流大量 `STREAM_CLOSED`（turn_error），
已把补跑降到低并发并 `--retry-failed`；最终 20 次里 2 次带 agent_failure 标记
（pytest/standard 的 turn_error、pydantic/sdlc 的 over_budget），仍按已有补丁
官方评分并计入分母，报告单列。

## 结果（官方评分，按任务）

| repo | standard | standard_guidance | sdlc | sdlc_guidance |
|---|---|---|---|---|
| pypa/packaging | ❌ 98.98% | ✅ 100% | ✅ 100% | ✅ 100% |
| pytest-dev/pytest | ✅ 100%* | ✅ 100% | ✅ 100% | ✅ 100% |
| pydantic/pydantic | ✅ 100% | ✅ 100% | ✅ 100%* | ✅ 100% |
| mwaskom/seaborn | ✅ 100% | ✅ 100% | ✅ 100% | ❌ **0%**（patch=0） |
| sphinx-doc/sphinx | ✅ **100%** | ❌ 7.69% | ❌ 7.69% | ❌ 7.69% |

`*` 该 run 有 agent_failure 标记（turn_error / over_budget），但补丁仍被官方判 resolved。
packaging 的 standard 这次 F2P 98.98%（1 个测试没通过）——与 MVP/重复采样里 packaging standard
通过的结果不同，说明即使在同一任务上，单次运行仍可能出现少量翻转（0.99 vs 1.0）。

## 结果（按 arm 汇总）

| arm | n | resolved | resolved_rate | avg F2P | avg tokens | avg elapsed | agent_failure |
|---|---|---|---|---|---|---|---|
| standard | 5 | 4 | 0.80 | 0.998 | 10.7M | 832s | 1 |
| standard_guidance | 5 | 4 | 0.80 | 0.815 | 5.2M | 540s | 0 |
| sdlc | 5 | 4 | 0.80 | 0.815 | 11.7M | 716s | 1 |
| sdlc_guidance | 5 | 3 | 0.60 | 0.615 | 16.8M | 1625s | 0 |

## 主效应（resolved 比例，n=5）

- **preset 效应**（SDLC − 标准）：**−0.10**
- **引导效应**（有引导 − 无引导）：**−0.10**
- **交互项**：**−0.20**
- token 倍数：sdlc/standard **+9.8%**；引导/无引导 **−1.3%**
- 平均耗时：standard 832s、sdlc 716s、sdlc_guidance 1625s（B+引导最慢）

## 解读

1. **没有观测到 SDLC preset 或引导话术的正向主效应**；在这 5 个任务上，两组主效应
   都是 −0.10，交互 −0.20，方向甚至偏负。
2. **天花板效应明显**：pytest/pydantic 两个任务四个 arm 全过；packaging 四臂里只有
   standard 失败（F2P 98.98%）；差异主要来自 seaborn 与 sphinx 两个任务的方差，
   以及 packaging 这一次的 edge case。
3. **差异更像运行方差，而不是 treatment**：
   - sphinx 这次只有 `standard` 通过（首批与②都是两臂失败/偶发通过），同一任务在
     不同运行间结果翻转；
   - seaborn 的 `sdlc_guidance` 是 patch=0（agent 没改代码就结束），属于模型行为，
     不是流程机制本身的稳定效果。
4. **引导话术决定流程是否被触发，但没有改变成绩**：`sdlc_guidance` 臂 4/5 真的调用了
   `sdlc_*`；而裸 `sdlc`（纯 preset、无引导）**0/5** 触发流程（见 report-data）。正确率
   没有提升；token 也没有因为流程而下降（sdlc 反而 +9.8%）。
5. **验证者与官方**：裸 `sdlc` 臂 0/5 触发流程、全部无裁决；`sdlc_guidance` 臂 4/5 有裁决
   （3 例 agree；sphinx 4 次 approve 但官方 unresolved，1 例 mismatch；seaborn patch=0 无
   裁决），与②结论一致：approve 不可靠。
6. **n=5、每条件 1 次**：这些主效应（±0.1）完全在单次运行的方差范围内，不能据此
   下「SDLC 无用」的结论；但可以排除「大效应」——如果流程有显著提升，5 个任务全过
   的天花板下也应看到更少失败，而不是 sdlc_guidance 更差。

## 成本

- 20 次运行 UI 口径约 **82.7M token**；加补跑（turn_error 的重复）约再 20M。
- 单 run 最高 40.2M（pydantic sdlc over_budget），其次 37.8M、30.4M。
- 与首批相比：B+引导平均 token 从 9.5M 升到 16.8M（本轮任务/流程更重），
  说明「引导 + 验证循环」在难任务上成本可以翻倍。

## 产物

- 原始 runs：`/tmp/fb-runs-2x2/<task_id>/<arm>/`
- 官方评分：同目录 `eval-<arm>/report.json`
- 机读：[`featurebench-2026-11-07-2x2-data.json`](featurebench-2026-11-07-2x2-data.json)
  （report-data + 2x2 分析）
- 复跑：`run_matrix.py --manifest manifests/2x2.yml --retry-failed`（低并发）
  → `evaluate_matrix.py` → `summarize_runs.py` → `analyze_2x2.py`

## 下一步

- ④ 扩样本正在低并发补跑（12 个新任务 × 2 臂），用于估计 resolved 的分布与成本方差；
- 若要检验「SDLC 是否提升」，需要每条件多次重复（同一任务多次采样）才能压过当前
  观测到的运行方差；这应作为第三轮设计，而不是从本次 2×2 强行下结论。
