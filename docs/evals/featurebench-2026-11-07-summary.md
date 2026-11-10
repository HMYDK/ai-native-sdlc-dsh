# FeatureBench 第二轮实验总结（2026-11-07）：②③④

- 承接首批（2026-11-06）：[`featurebench-2026-11-06.md`](featurebench-2026-11-06.md)
- 本轮总预算：用户确认追加到 **1B token**；实际 UI 口径累计约 **672M**（含重试；见预算一节）
- 环境恒定：FeatureBench 0.3.0 / dataset v1.1 / DSH CLI 0.2.1-rc.5 / plugin 0.6.0 /
  deepseek-flash(reasoningEffort=max) / 同批 5 个 `fb-eval-base:*` 镜像
- 所有清单在首次运行前提交到 `tools/evals/featurebench/manifests/`；2026-11-10 已推送
  到 `dev` 并开 PR #13（此前本地未 push）
- **2026-11-10 EVAL-01 修订**：④ 表格改为 ITT / 可评分双口径（A 组 1 次缺官方评分）；
  更完整的审计数字（分母规则、泄漏、验证者混淆）以
  [`featurebench-baseline.md`](featurebench-baseline.md) 为准，本文件保留当时口径。

## 三项实验与结论

### ② 验证者校准 — [`featurebench-2026-11-07-verifier-calibration.md`](featurebench-2026-11-07-verifier-calibration.md)

10 个未用过的 lv1（5 repo 轮转）B 组各 1 次 + sphinx 失败任务重复 3 次：

- 校准集官方 **8/10 resolved**；能产出裁决的 8 次全部 `approve` 且与官方一致；
- 压力子集（同一 known-fail 任务 3 次）：官方 1/3 resolved，验证者最终 2 approve + 1 reject，
  **假阳性复现**（rep1 approve 但官方 unresolved；rep3 自己改判 reject）；
- 合并首批 + ② + stress：18 次 B 运行、15 次有裁决，**approve 13 次中 2 次官方 unresolved
  （合并假阳性率 15.4%）**；最终 reject 1 次且正确；无最终 reject 的假阴性；
  3 次无裁决全部对应 agent 失败/截断（删失）。

**结论**：`sdlc_verify` 的 approve **不能当正确率证据**；同一任务多次运行会在 approve/reject
之间翻转，单次裁决不可靠。验证者作为质量门禁需要先做校准，且难任务上存在「无裁决」删失。

### ③ 2×2 拆分 — [`featurebench-2026-11-07-2x2.md`](featurebench-2026-11-07-2x2.md)

5 个 MVP 任务 × {标准, 标准+引导, SDLC, SDLC+引导}，各 1 次：

| arm | resolved | avg tokens | avg 耗时 |
|---|---|---|---|
| standard | 4/5 | 10.7M | 832s |
| standard_guidance | 4/5 | 5.2M | 540s |
| sdlc | 4/5 | 11.7M | 716s |
| sdlc_guidance | 3/5 | 16.8M | 1625s |

- 主效应：preset **−0.10**、引导 **−0.10**、交互 **−0.20**（n=5，方向性证据，不显著）；
- token：sdlc/standard **+9.8%**，引导/无引导 −1.3%；
- pytest/pydantic 四臂全过（天花板）；packaging 只有 standard 失败（F2P 98.98%）；
  差异主要来自 seaborn（sdlc_guidance 一次 patch=0）与 sphinx（这次只有 standard 通过）。

**结论**：没有观测到 SDLC preset 或引导话术的正向主效应；n=5 不能证明「无用」，但能排除
「存在大效应」。

### ④ 扩样本 — [`featurebench-2026-11-07-expanded.md`](featurebench-2026-11-07-expanded.md)

12 个剩余 lv1 × {standard, sdlc+引导}，各 1 次：

| 指标 | A 标准 | B SDLC+引导 |
|---|---|---|
| resolved（ITT，n=12；A 组 1 次缺官方评分按未解决计入） | **7/12（58.3%）** | **10/12（83.3%）** |
| resolved（可评分口径） | 7/11（63.6%） | 10/12（83.3%） |
| 平均 F2P | 0.685 | 0.856 |
| token 中位数 | 4.6M | 10.4M |
| token p90 | 16.3M | 40.1M |
| timeout/over_budget | 1/0 | 3/1 |

- paired（11 对）：**B 独有通过 2、A 独有通过 0**，9 个都通过，2 个都失败；
- 方向与③相反（③ 是 −0.1，④ 是 +0.18），且 ④ 的 2 个 B 独有里有一个是 timeout 后的补丁。
- 分母说明：A 组 12 次尝试中 1 次（seaborn `test_regression`）官方评分因 HF revision
  解析失败缺失；ITT 按未解决计入 → 7/12，可评分口径 7/11（63.6%）。详见
  [`featurebench-2026-11-07-expanded.md`](featurebench-2026-11-07-expanded.md) 结果表注。
- 补评：该条已于 2026-11-10 用官方 Grader 复评 **resolved=1.0**（见
  [`featurebench-2026-11-10-grader-rerun.md`](featurebench-2026-11-10-grader-rerun.md)）；
  仅作敏感性参考，不回填本表历史聚合。

**结论**：B 在更难任务集上方向性更好，但**与③方向矛盾**，最可能被单次运行方差解释；
B 的成本显著更高（中位数 2.3×、p90 2.5×，另有 3 次 timeout/1 次 over_budget）。

## 跨实验的总判断（谨慎措辞）

1. **没有任何一致证据表明「SDLC + 固定引导」提升最终正确率**：③ 平坦/偏负，④ 偏正但与③
   矛盾，②/首批也无稳定增益；观测到的 resolved 差异完全可能是单次运行方差。
2. **成本差异是稳定且一致的**：B 组 token 是 A 的 1.2–6.5 倍（随任务难/流程重而变大），
   耗时 1.8–7.6 倍，并更容易触发 timeout/over_budget。
3. **验证者 approve 不可靠**：合并假阳性率 15.4%；同一任务裁决会翻转；难任务上常因
   timeout/over_budget 没有裁决（删失），不能把「无裁决」当通过或失败。
4. **参考副本泄漏**：packaging 镜像存在 pip vendored packaging 25.0（两臂都可见，已记录但
   未修改官方镜像）；其余镜像扫描未命中。
5. **基础设施是实验的一部分**：6 并发模型会话会导致 DeepSeek 流 `STREAM_CLOSED`
   （turn_error），本轮前期因此丢失大量运行，后改为低并发 + `--retry-failed` 补跑；
   45min/40M 的上限对 B 偏紧，B 的 timeout 会截断验证者裁决。

## 预算

| 实验 | 运行数（meta） | UI token |
|---|---|---|
| 首批 | 12（含重复目录） | 73.1M |
| ② 校准 + stress | 13 | 156.5M |
| ③ 2×2 | 20 | 222.1M |
| ④ 扩样本 | 24 | 219.9M |
| **合计** | **69 meta 文件** | **约 672M / 1B** |

另有部分 timeout/over_budget 运行只记录在 session 日志（UI 读数缺失），其消耗未计入上表；
按 session 汇总的补充数字在各报告里标注。

## 产物索引

- 报告：② `...verifier-calibration.md`、③ `...2x2.md`、④ `...expanded.md`、设计 `...experiments.md`
- 机读数据：`...verifier-data.json`、`...verifier-stress-*.json`、`...2x2-data.json`、`...expanded-data.json`
- 脚本：`tools/evals/featurebench/`（run_matrix/evaluate_matrix/summarize_runs/analyze_2x2/
  analyze_expanded/analyze_verifier/sanity_check/archive_runs；CI `evals-check` job）
- 原始 runs：`/tmp/fb-runs*`（本地，不入库）

## 第三轮补充（2026-11-08）：重复采样

用户选择先做重复采样估计方差：[`featurebench-2026-11-08-repeat-sampling.md`](featurebench-2026-11-08-repeat-sampling.md)。

- 3 个任务（packaging / seaborn test_algorithms / sphinx build_gettext）× 2 臂 × 3 次重复；
- **结果完全确定**：packaging A/B 3/3 通过、seaborn A/B 3/3 通过、sphinx A/B 0/3 失败；
  9 个 paired 差全为 0，bootstrap 95% CI = [0.0, 0.0]；
- 因此 **③(−0.1) 与 ④(+0.18) 的矛盾不是同一 cell 的运行方差**，而是**任务样本不同 +
  跨时间窗漂移**（sphinx build_gettext 在 ③ 的 standard 运行中通过，在 MVP 与本实验 3 次
  都失败）；
- 结果方差小，但 **token 方差大**（同一 cell 可差 2–5 倍），B 的成本优势/劣势不能只看
  resolved；B 在本面板 token 仍为 A 的 1.2×/11.6×/2.6×。

### 修正后的最强结论

**当前证据不支持「SDLC + 固定引导提升最终正确率」；成本确定更高；验证者 approve 不可靠。**
要检验小效应，下一轮必须**增加不同任务数量并覆盖难度梯度（lv2/更多 repo）**；重复同一批
任务对 binary resolved 的检验力很低。

## 建议的第四轮（未做）

1. **重复采样**：同任务每臂 ≥3 次，先估计运行方差，再判断 ③/④ 的方向矛盾是否被噪声解释。
2. **难度分层任务集**：需要 lv2/更大 repo（要额外镜像），避免天花板效应。
3. **成本感知指标**：报告「每 1M token 的 resolved 数」，把 timeout/over_budget 作为显式约束。
4. **验证者专项**：用 known-fail 任务校准 approve 的假阳性率与裁决覆盖率；在插件侧考虑
   「无裁决 ≠ 通过」的语义。
5. **并发/重试规则固化**：模型会话并发上限 ≤2–4、turn_error 自动重试、timeout/over_budget
   不重试（已写进 `run_matrix --retry-failed`）。
