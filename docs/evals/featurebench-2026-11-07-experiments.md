# FeatureBench 第二轮实验设计（2026-11-07）：验证者校准 / 2×2 拆分 / 扩样本

- 承接：[`featurebench-2026-11-06.md`](featurebench-2026-11-06.md) 的首批 5 任务 × 2 臂结果
- 预算：用户确认追加到 **1B token**（首批已用约 70.4M）
- 纪律：所有清单在首次运行前提交（`tools/evals/featurebench/manifests/`）；不按结果挑样本；
  基础设施失败重试 1 次，agent 失败/超时/超预算不重试；所有运行进分母
- 环境与首批完全一致：FeatureBench 0.3.0 / dataset v1.1 / DSH CLI 0.2.1-rc.5 /
  plugin 0.6.0 / deepseek-flash（reasoningEffort=max）/ 同一批 `fb-eval-base:*` 镜像
- 顺序：② → ③ → ④（用户确认）

## ② 验证者校准（`manifests/verify-calibration.yml`）

**问题**：`sdlc_verify` 的 approve/reject 与官方评分的一致率是多少？首批里出现 1 例
approve 但官方 unresolved（sphinx），需要更多失败样本估计假阳性。

**设计**：只跑 B（AI 原生 SDLC + 固定引导），1 次/任务。任务来自 5 个 repo 里
MVP 未用过的 lv1：按 repo 顺序轮转取 10 个（保证每个有候选的 repo 都被抽到）。
口径：最终裁决（最后一次 `sdlc_verify` 的 raw_status）× 官方 `fb eval` resolved。

**压力子集**（`manifests/verify-stress.yml`）：对首批唯一两臂都失败的 sphinx
`test_build_gettext` 重复 3 次，单独统计，确认假阳性是否稳定复现。

**说明（与设计文档的偏差）**：这 5 个 repo 在 fast split 中 **没有 lv2 任务**
（实测 lv2=0），所以②的校准集是 lv1 分布 + 1 个已失败任务的重复，而不是 lv2 难度梯度。

**产出**：`analyze_verifier.py` 的混淆矩阵（approve/reject × resolved/unresolved；
needs_human 与超时无裁决单列）、裁决序列分布、假阳性率/假阴性率。

**预算**：校准 10 runs + stress 3 runs，上限 150M + 60M token。

## ③ 2×2 拆分（`manifests/2x2.yml`）

**问题**：首批的 B 组 = SDLC preset + 固定引导话术，二者混在一起；正确率没有差异
到底说明「SDLC 机制无增益」还是「引导话术无增益/有副作用」？

**设计**：5 个 MVP 任务 × 4 条件，各跑 1 次（共 20 runs）：

| arm | preset | prompt_suffix |
|---|---|---|
| `standard` | 标准模式 | 无 |
| `standard_guidance` | 标准模式 | B 的固定引导话术 |
| `sdlc` | AI 原生 SDLC | 无 |
| `sdlc_guidance` | AI 原生 SDLC | B 的固定引导话术 |

**分析**：主效应（preset、引导）与交互；正确率 + 成本（token/耗时）+ B 组流程
采纳率（不引导时是否真的不调用 `sdlc_*`）。**预算**：上限 250M token。

## ④ 扩样本（`manifests/expanded.yml`）

**问题**：首批 n=5 且 4/5 任务两臂都过（天花板效应），差异只体现在成本；需要更多
任务估计 resolved 的分布与成本方差。

**设计**：5 个 repo 里 MVP 与②都未用过的全部 lv1（12 个，这些 repo 无 lv2），
各跑 `standard` 与 `sdlc`（SDLC + 引导）1 次，共 24 runs；与②的 10 个 B 运行可合并
为 22 个任务的 B 侧样本（跨约 2 小时时间窗，报告注明）。

**分析**：paired resolved 差异、token/耗时分布（中位数/分位数）、超时率、
按 repo 分层；不做显著性结论前先看效应量。**预算**：上限 350M token。

## 统一记录

每个 run 的 `meta.json` 记录：任务/镜像 digest、arm/preset、prompt 规则、DSH/插件
实际版本（本轮起探测并写入 `dsh_cli_actual` / `plugin_version_actual`）、token、
耗时、patch 字符数、agent 完成/失败分类、`.ai` 制品剥离量、泄漏扫描命中。
`summarize_runs.py` 汇总官方成绩、成本、流程采纳与验证者错配；
`analyze_verifier.py` 给②的混淆矩阵；`archive_runs.py` 可把 runs 归档（默认不含 session）。

## 风险与口径提醒

- **B 组超时**：45min 墙钟上限不变；B 流程重，②中已出现超时。超时是结果的一部分，
  报告里与 resolved 分开统计；超时前产出的验证者裁决仍计入混淆矩阵。
- **时间窗漂移**：②③④跨数小时，模型服务有波动；报告按实验分开，不把不同时间窗的
  运行混成一个 A/B 对照（④ 另注明与②的合并口径）。
- **参考副本泄漏**：沿用首批记录（packaging 镜像的 pip vendored 实现），本轮不做隔离实验。
- **UI 驱动风险**：本轮开始探测 DSH/插件版本；driver 已补工作区选择页/引导弹层/水合的
  处理，但 App 升级仍可能破坏驱动。
