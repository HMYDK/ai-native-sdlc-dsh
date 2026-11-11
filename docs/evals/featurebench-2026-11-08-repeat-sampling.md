# 第三轮：重复采样（运行方差估计，2026-11-08）

- 目的：③（main effect −0.10）与 ④（paired +0.18）方向矛盾。先回答一个更基础的问题：
  **同一任务、同一 arm 多跑几次，结果本身有多大波动？**
- 预注册：[`../../tools/evals/featurebench/manifests/repeat-sampling.yml`](../../tools/evals/featurebench/manifests/repeat-sampling.yml)
- 编排/分析：`run_repeats.py`（3 个独立 rep，各自完整矩阵 + 官方评分）、`analyze_repeat.py`
- 环境：同前（FeatureBench 0.3.0 / dataset v1.1 / DSH 0.2.1-rc.5 / plugin 0.6.0 /
  deepseek-flash max / `fb-eval-base:*`）
- 预算：本实验 UI 口径 **107.2M token**（300M 上限，1B 总预算内）
- 口径：官方 `fb eval`；每任务每臂 k=3；timeout/over_budget 计入失败但保留补丁评分

## 设计与任务选择

3 个 MVP 任务 × 2 臂（standard / sdlc+引导）× **3 次独立重复** = 18 次运行：

| 任务 | 选择理由（跑前写进 manifest） |
|---|---|
| packaging test_metadata | 天花板对照：此前两臂都通过，预期无差异，用来验证「稳定通过」cell 的方差 |
| seaborn test_algorithms | 混合结果：MVP 中 B 超时但补丁通过；③ 中 sdlc_guidance 一次 patch=0 |
| sphinx test_build_gettext | 混合结果：MVP 两臂失败、② stress 1/3 通过、③ 只有 standard 通过 |

## 结果（逐 rep 官方评分）

| task | A resolved | B resolved | rep diffs（B−A） | A token（逐 rep） | B token（逐 rep） |
|---|---|---|---|---|---|
| packaging test_metadata | **3/3** | **3/3** | 0, 0, 0 | 7.3M / 15.1M / 8.5M | 9.8M / 12.2M / 15.7M |
| seaborn test_algorithms | **3/3** | **3/3** | 0, 0, 0 | 0.77M / 0.86M / 1.0M | 6.2M / 14.9M* / 10.1M |
| sphinx test_build_gettext | **0/3** | **0/3** | 0, 0, 0 | 1.8M / 2.7M / 1.0M | 4.0M / 6.2M / 4.0M |

`*` rep2 的 seaborn sdlc 运行 45min timeout，但抽回的补丁仍被官方判 resolved（计入 resolved，
agent_failure=timeout 单列）。

**汇总**：paired n=9，平均差（B−A）= **0.000**，bootstrap 95% CI = **[0.0, 0.0]**；
B 独有胜 0、A 独有胜 0、平局 9/9。

## 关键发现

1. **在这 3 个 cell 上，resolved 是「确定性」的**：同一任务同一 arm 3 次运行结果完全一致
   （packaging 3/3 通过、seaborn 3/3 通过、sphinx 0/3 失败；9 个 paired 差全为 0）。
   → ③ 与 ④ 的方向矛盾**不能由「同一 cell 的运行方差」解释**；它来自**任务集不同**
   （③ 用 5 个 MVP 任务、④ 用 12 个更难任务）以及**跨时间窗漂移**
   （sphinx build_gettext 在 ③ 的 standard 那次通过，在 MVP/本实验 3 次都失败）。
2. **代价方差远大于结果方差**：resolved 完全不变，但 token 在同一 cell 内可差 2–5 倍
   （如 packaging A 7.3M→15.1M；seaborn B 6.2M→14.9M）。所以评测若只看 resolved 会
   低估运行波动；成本必须单独报告。
3. **B 成本仍然更高**：本面板 B/A 的 token 倍数约 1.2×（packaging）、11.6×（seaborn）、
   2.6×（sphinx）；耗时 1.4–7.2×，且 sphinx/seaborn 各出现 timeout。
4. **「重复同一任务」对 binary resolved 的信息量很低**：在 outcome 确定性高的任务上，
   重复采样不能提升对 treatment effect 的检验力；要检测效应必须**增加不同任务数量**，
   并让任务难度有梯度（避免天花板/地板效应）。

## 对三轮实验的修正结论

- ③（5 个偏易任务）与 ④（12 个较难任务）的方向矛盾，**不是单次运行噪声**，而是
  **任务样本组成不同** + 跨时间窗波动；两次实验都不能单独代表「SDLC 的效果」。
- 合并本面板（3 任务 ×3 次）：**A 与 B 在 resolved 上完全打平**（都是
  packaging/seaborn 通过、sphinx 失败），没有任何 treatment effect 的正/负迹象；
  B 的唯一确定差异是**更高成本**。
- 因此本轮能给出的最强结论仍是：**当前证据不支持「SDLC+引导提升正确率」；成本确定更高；
  验证者 approve 不可靠（见②）。** 要回答「有没有小效应」，需要的是**更多任务**而非
  重复同一批任务；建议下一轮扩到 ≥20–30 个任务并覆盖 lv2/更多 repo。

## 产物

- runs：`/tmp/fb-runs-repeat/rep{1,2,3}/<task>/<arm>/`（含 eval-<arm>/report.json）
- 机读：[`featurebench-2026-11-08-repeat-sampling-data.json`](featurebench-2026-11-08-repeat-sampling-data.json)
- 复跑：`run_repeats.py --manifest manifests/repeat-sampling.yml --reps 3 --execute`
  → `summarize_runs.py`（每 rep）→ `analyze_repeat.py --reps rep1/rep2/rep3 report-data.json`
