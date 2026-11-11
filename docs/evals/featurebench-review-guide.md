# EVAL-01 评审指南：两个堆叠 PR 与证据边界

- 关联 issue：[#12 EVAL-01](https://github.com/HMYDK/ai-native-sdlc-dsh/issues/12)、
  [#8 FeatureBench A/B](https://github.com/HMYDK/ai-native-sdlc-dsh/issues/8)
- 本文件是 review 入口；机读索引见
  [`featurebench-baseline-index.json`](featurebench-baseline-index.json)，基线报告见
  [`featurebench-baseline.md`](featurebench-baseline.md)。

## 两个堆叠 PR

| PR | 内容 | 目的 |
|---|---|---|
| PR-1（#13，`dev` → `master`） | 2026-11-06 ~ 11-08 的 51 个历史提交原样推送：驱动、镜像、官方评分、7 份机读数据、9 份报告、CI `evals-check` | 建立 review 边界；证明仓库里有可审查的实现与数据 |
| PR-2（本分支，`evals/eval-01-audit` → `dev`） | EVAL-01 审计交付：canonical run 表、证据索引、环境身份、离线复算、基线报告、CI 数据一致性检查、官方评分复评 | 把结果变成可独立复算、可追溯的基线 |

PR-1 只做「原样推送」；审计发现导致的历史报告修订（分母口径等）放在 PR-2 的独立提交里，
diff 可见。PR-2 合并进 `dev` 后，PR-1 再合入 `master`（或按维护者习惯调整顺序）。

## PR-1：三个 review 单元

总数 49 个文件、+9264 行，全部集中在评测目录，不改插件源码。

### RU1 驱动 / 容器环境

`tools/evals/featurebench/`：`run_arm.py`、`run_matrix.py`、`driver.mjs`、`setup-web.sh`、
`fetch_image.py`、`bake_base.py`、`evaluate_matrix.py`、`make_predictions.py`、
`archive_runs.py`、`run_repeats.py`、`run_regression.py`、`.github/workflows/ci.yml`。

审查重点：A/B 是否用同一官方镜像与同一初始环境；是否零宿主目录挂载（避免 gold patch
泄漏）；隐藏测试/参考实现是否在 agent 运行期间不可见；官方评分是否只由 `fb eval` 产出；
默认 dry-run、`--execute` 才起容器/调模型。

### RU2 数据记录 / 评测 / 统计

`tools/evals/featurebench/manifests/`（base + 5 个实验清单 + `regression-0.6.1/` 6 份）、
`sanity_check.py`、`summarize_runs.py`、`analyze_2x2.py`、`analyze_expanded.py`、
`analyze_verifier.py`、`analyze_repeat.py`、`docs/evals/*-data.json`。

审查重点：预注册清单是否在运行前固定；每 run 是否记录 task/arm/镜像 digest/实际 DSH 与
插件版本/官方评分/token/失败状态；失败、超时、不可评分是否进分母；数据快照是否可离线
复算（见 PR-2 的 `reaggregate.py`）。

### RU3 报告 / 结论

`docs/evals/*.md`、`tools/evals/featurebench/README.md`。

审查重点：结论是否只引用官方评分、不拿 Agent 的 `DONE`/`approve` 当成绩；样本量与
方向矛盾是否被如实说明；0.6.0 与 0.6.1 是否分开；是否宣称了没有证据支持的结论。

## 版本边界（不可混用）

| 组 | 运行时 | 数据 |
|---|---|---|
| V1 | plugin 0.6.0 + DSH CLI 0.2.1-rc.5 | 85 个 run（首批 / 验证者校准 / 2×2 / 扩样本 / 重复采样） |
| V2 | plugin 0.6.1 + DSH 0.2.2-rc.1 | 仅 `regression-0.6.1/mvp.yml` 的 10 个 run；其余 5 份 regression 清单**预注册未执行** |

任何跨版本聚合都不允许（基线报告里 V1/V2 分列）。0.6.0 的结论不能挂到 0.6.1 名下。

## 证据与可复现边界

- **已提交**：预注册清单、脚本、报告、机读数据快照、canonical run 表、证据 hash 索引。
- **不提交**：原始 runs（约 2.3GB，含 prompt/session，不可公开）——本机持久归档在
  `~/.dsh-eval-archive/2026-11-08/`（含 `SHA256SUMS.txt`），仓库只提交逐 artifact 的
  hash 与归档标识。
- **审计级别 L2**：已提交数据 + 原始证据 hash 可审计；原始日志不公开，因此**不能宣称
  「完全可复现」或「严格盲评」**。
- **已知边界**：packaging 官方镜像自带 pip vendored `packaging` 参考实现（两臂都可见，
  只记录未改镜像，已做敏感性分析）；模型实际服务版本不可得，只能记录请求参数；单次
  运行方差大，样本量小，不做显著性宣称。

## 如何在本地复核

```bash
# 1) 结构 / 数据一致性（无网络、无模型；CI 同样执行）
python3 tools/evals/featurebench/sanity_check.py --structural
python3 tools/evals/featurebench/sanity_check.py --index
python3 tools/evals/featurebench/audit_runs.py --check
python3 tools/evals/featurebench/check_redaction.py

# 2) 从已提交机读数据离线复算统计
python3 tools/evals/featurebench/reaggregate.py --check

# 3) 评测链路冒烟（不调模型、不起容器、不拉镜像）
python3 tools/evals/featurebench/sanity_check.py --structural
```

详细的一次任务 A/B 执行与官方评分命令见
[`featurebench-baseline.md`](featurebench-baseline.md) 与
[`../../tools/evals/featurebench/README.md`](../../tools/evals/featurebench/README.md)。

## 不在本范围

- 不新增 Benchmark / 隐藏测试生成器 / 主观打分 Agent / 排行榜；
- 不重跑 0.6.1 的大规模比较实验（V2 其余清单保持「预注册未执行」），不重跑历史 85 次 run；
- 不修改插件七阶段工作流、Verifier 裁决逻辑或 Adaptive SDLC；
- 不用「PR 已合并」代替「外部评分复评 + 离线复算」。
