# FeatureBench A/B 评测基线（EVAL-01）

- 对应 issue：[#12 EVAL-01](https://github.com/HMYDK/ai-native-sdlc-dsh/issues/12)；原始接入任务：[#8](https://github.com/HMYDK/ai-native-sdlc-dsh/issues/8)
- 数据快照截至：2026-11-08（V1 与 V2 最后一轮运行）
- 本文生成：2026-11-10；**审计级别 L2**（见 §2.4）
- 评审入口：[`featurebench-review-guide.md`](featurebench-review-guide.md)
- 机读数字：[`featurebench-baseline-metrics.json`](featurebench-baseline-metrics.json)；
  索引与 hash：[`featurebench-baseline-index.json`](featurebench-baseline-index.json)；
  canonical run 表：[`featurebench-runs.jsonl`](featurebench-runs.jsonl)；
  证据 hash：[`featurebench-evidence-index.json`](featurebench-evidence-index.json)

## 0. 结论摘要

1. **没有任何可复现证据表明「AI 原生 SDLC preset + 固定引导」提升 FeatureBench resolved 率。**
   所有可比配对（n=30，scoreable）合并：A（标准模式）21/30（70.0%）、B（SDLC+引导）
   22/30（73.3%），净差 +1 对（+3.3pp，W3/L2/T25）；不同实验方向不一致，样本量不足以
   排除运行方差。
2. **成本差异方向一致、量级明显**：B 的 token 中位数在 MVP 2.9×、扩样本 2.3×、
   重复采样 5.4×；2×2 里「SDLC+引导」token 中位数是 standard 的 2.1×。
3. **验证者 `approve` 不可靠**：V1 全部 49 个 B 运行（主会话口径）中 approve 36 次里 7 次
   官方 unresolved（假阳性率 19.4%），reject 2 次里 1 次官方 resolved，另有 11 次无裁决
   （22.4%）。V2 单独看更差（FP 1/3、FN 2/2，n=5）。不能把 `approve` 当成绩，也不宜
   直接当门禁。
4. **已知参考实现泄漏只影响 packaging**：packaging 镜像内 pip/setuptools/wheel vendored
   副本（两臂都可见）；其余 4 个 repo 的 135 次泄漏扫描命中为 0。packaging 同时也是
   唯一贡献净差异的 repo（见 §3.5 敏感性），因此「净 +1 对」不能当作 treatment 有效证据。
5. **V1（0.6.0/0.2.1-rc.5）与 V2（0.6.1/0.2.2-rc.1）是不同基线**：V2 只有 5 任务 × 2 臂的
   最小回归（10 run），本文分列、不合并；V2 其余 5 份回归清单**预注册未执行**。
6. **官方评分链路已复核**（AC-007）：对 2 条历史运行真实调用官方 `fb eval`，sphinx
   unresolved 逐条复现，唯一缺评分的那条补评为 resolved=1.0（单独记录、不回填历史聚合）。

## 1. 固定环境身份（AC-002）

### 1.1 版本分组

| 组 | 插件 | DSH CLI | 官方镜像 | run 数 | 官方 report | 时间窗（本机时间） |
|---|---|---|---|---|---|---|
| **V1** | `@ai-native-sdlc-plugin/dsh-sdlc@0.6.0`（tarball sha256 `bac39b42…`） | `0.2.1-rc.5` | `fb-eval-base:*`（由 `libercoders/featurebench-specs_*` 烤制） | 85 | 84（1 条环境失败，见 §3.2） | 2026-11-06 17:18 → 2026-11-08 03:19 |
| **V2** | `0.6.1`（tarball sha256 `da201253…`） | `0.2.2-rc.1` | `fb-eval-base-061:*` | 10 | 10 | 2026-11-08 15:57 → 17:37 |
| pilot | `0.6.1` | `0.2.2-rc.1` | `fb-eval-base-061:packaging` | 1 | 1 | 2026-11-08 15:57 |

- 三组都记录 `dsh_cli_actual` / `plugin_version_actual`（V1 首批 mvp 的 10 条运行在
  driver 加版本探测之前执行，字段为 null，只有 manifest 钉死值；见
  [`featurebench-env-identity.json`](featurebench-env-identity.json) 的 `known_gaps`）。
- 数据集：`LiberCoders/FeatureBench`，split `fast`（100 实例），revision
  `76b4a4566e04f4bcc13c35125d4f301791efa736`（= `v1.1`）。
- 评分器：`featurebench==0.3.0` 的官方 `fb eval`；成绩只取它写出的 `report.json`。
- 模型：`deepseek-account` / `deepseek-flash` / `reasoning_effort=max`（只记录请求参数；
  服务端实际 version/build 不可观测）。
- 运行纪律：单 run `timeout=2700s`、`max_tokens=40M`（V2 总预算 300M）、仅基础设施错误
  重试 1 次、agent 失败/超时/不 resolved 不重试；逐 run 记录 `image_digest`、token、
  耗时、`agent_failure`、`patch_sha256`、泄漏扫描。
- 官方镜像 digest（5 个 repo）与派生镜像 tag 见
  [`featurebench-env-identity.json`](featurebench-env-identity.json)；
  镜像 digest 口径限制见 §6。

### 1.2 V2 预注册但未执行的清单

`tools/evals/featurebench/manifests/regression-0.6.1/` 下的 `2x2.yml`、`expanded.yml`、
`verify-calibration.yml`、`verify-stress.yml`、`repeat-sampling.yml` 共 5 份：
**运行前已提交、但没有跑**（只有 `mvp.yml` 执行了 10 run）。它们保持 `not_run`，
不补跑、不参与任何聚合；机读清单见
[`featurebench-baseline-metrics.json`](featurebench-baseline-metrics.json) 的 `not_run`。

## 2. 数据与证据（AC-001 / AC-004）

### 2.1 已提交数据

| 文件 | 内容 |
|---|---|
| `docs/evals/*-data.json`（7 份） | 各实验的机读快照：每 run 行 + 当时算出的 analysis；已脱敏（无本机绝对路径） |
| [`featurebench-runs.jsonl`](featurebench-runs.jsonl) | **canonical run 表，96 行**：V1 85 + V2 10 + pilot 1；从原始 `meta.json`/官方 `report.json` 重建 |
| [`featurebench-evidence-index.json`](featurebench-evidence-index.json) | 96 run 的关键 artifact sha256（575 条）+ 归档标识 + 计数 |
| [`featurebench-env-identity.json`](featurebench-env-identity.json) | 按版本组/实验聚合的实际版本、镜像、预算、时间窗、#8 对账与已知缺口 |
| [`featurebench-leak-audit.json`](featurebench-leak-audit.json) | 泄漏命中、patch vs gold hash、两臂同补丁、packaging 敏感性 |
| [`featurebench-verifier-confusion.json`](featurebench-verifier-confusion.json) | 验证者裁决 × 官方 resolved 合并矩阵 |

对账口径（程序化校验见 `tools/evals/featurebench/audit_runs.py --check`）：

- 7 份快照共 **105 行**；其中 `version-regression` 的 `old` 10 行是 MVP 复用的基线读数，
  去重后 **95 行**；再加 1 条 pilot（本地、未进快照）= canonical 96 行。
- V1 = 85 run（84 有官方评分）；V2 = 10 run（10 有官方评分）；pilot 独立、不进分母。
- **物理运行只有 95 次**：canonical 96 行里 pilot 与 V2 `packaging/standard` 是同一次运行
  （meta/patch/predictions/session 的 sha256 全同，pilot 是复用副本），
  `featurebench-evidence-index.json` 的 `cross_references` 记录、`audit_runs.py` 校验；
  pilot 不能当额外样本。
- 状态分类只有四种且全部落字段：`included` 94、`unscoreable_missing_official_result` 1、
  `pilot` 1；**没有任何 run 被静默丢弃**。缺官方评分那条的原因与处理见 §3.2。

### 2.2 #8 汇报数字的对账（AC-003 要求的差异解释）

| #8 评论说法 | 从已提交数据复算 | 结论 |
|---|---|---|
| 27 个不同 FeatureBench 任务 | canonical 96 行去重后 27 个 task_id | ✅ 一致 |
| 85 次有效官方评分运行 | V1 共 85 个 run；官方 report **84** 份（expanded 的 seaborn `test_regression`/standard 因 HF revision 解析失败无 report） | 口径差 1：应说「85 次运行 / 84 份官方评分」；ITT 仍按 85 进分母 |
| 含重跑约 164 次尝试 | 现存 `matrix.json` 只能逐 run 追溯 **63** 次（60/96 行有记录）；其余尝试发生在被 `--retry-failed` 覆盖的批次、driver 层重试与已删除的临时 runs 中，日志不完整 | **无法复算 164**；如实报告可审计数字，不用估计冒充记录 |
| 总消耗约 787M / 1B token | V1 UI 口径 **761.6M**，12 个 UI 缺失 run 用 session 汇总补 **182.4M**，合计 **944.0M** | 两套口径都保留；787M 是当时 UI 口径（还含 2 个重复目录），差异已解释 |
| 汇总 n=30 / A 21/30 / B 22/30 / W3 L2 T25 | 按「B = SDLC + 固定引导」定义（MVP/expanded/repeat 取 `sdlc`，2×2 取 `sdlc_guidance`）**精确复现** | ✅ 一致（机读推导在 `reaggregate.py`） |

### 2.3 证据索引与归档

- `featurebench-evidence-index.json`：96 run / **575 条 artifact**（meta、patch、predictions、
  官方 report、eval.log、泄漏扫描等）逐条 sha256；与归档 `SHA256SUMS` 校验
  **0 条 mismatch**；165 条 session 日志只登记 hash，不提交内容。
- 原始 runs（约 2.3GB，含 prompt/session）**不入库**，本机持久归档在
  `~/.dsh-eval-archive/2026-11-08/`（2750 文件 + `SHA256SUMS.txt`）。
- 归档只是本地证据锚点：仓库里的 hash 可校验「提交的数据与当时原始产物一致」的锚点，
  但外部 reviewer 没有原始内容，因此不能宣称完全可复现。

### 2.4 审计级别

**L2**：已提交汇总/推导数据 + 文件 sha256 索引 + 本机原始证据 hash 锚点。
不是 L3（原始证据公开），也不是严格盲评。评审边界见
[`featurebench-review-guide.md`](featurebench-review-guide.md)。

## 3. 独立复算的观测（AC-003 / AC-006）

> 本节所有数字由 `python3 tools/evals/featurebench/reaggregate.py --check` 从
> 已提交机读数据重算并校验；不需要模型、网络、Docker、GUI 或凭据。

### 3.1 各实验逐臂

| 实验 | 臂 | 尝试 | 可评分 | resolved | ITT 率 | 可评分率 | token 中位数 | 耗时中位数 |
|---|---|---|---|---|---|---|---|---|
| MVP（5 任务） | standard | 5 | 5 | 4 | 80.0% | 80.0% | 3.3M | 415s |
| MVP | sdlc | 5 | 5 | 4 | 80.0% | 80.0% | 9.5M | 1997s |
| 2×2（5 任务） | standard | 5 | 5 | 4 | 80.0% | 80.0% | 5.3M | 661s |
| 2×2 | standard_guidance | 5 | 5 | 4 | 80.0% | 80.0% | 4.8M | 515s |
| 2×2 | sdlc | 5 | 5 | 4 | 80.0% | 80.0% | 4.3M | 725s |
| 2×2 | sdlc_guidance | 5 | 5 | 3 | 60.0% | 60.0% | 11.3M | 1596s |
| 扩样本（12 任务） | standard | 12 | 11 | 7 | 58.3% | 63.6% | 4.6M | 440s |
| 扩样本 | sdlc | 12 | 12 | 10 | 83.3% | 83.3% | 10.4M | 1146s |
| 验证者校准（10 B run） | sdlc | 10 | 10 | 8 | 80.0% | 80.0% | 14.6M | 1653s |
| 验证者压力（3 B run） | sdlc | 3 | 3 | 1 | 33.3% | 33.3% | 29.3M | 1576s |
| 重复采样（3 任务×3 rep） | standard | 9 | 9 | 6 | 66.7% | 66.7% | 1.8M | 285s |
| 重复采样 | sdlc | 9 | 9 | 6 | 66.7% | 66.7% | 9.8M | 1261s |

口径：`attempted` = 该臂全部运行；`scoreable` = 有官方 `report.json` 的运行；
`ITT` 把缺官方评分按未解决计入；token/耗时分位数只取 scoreable 行（缺失值不猜）。
逐 run 明细（含 unscoreable 列表与失败分类）见 `featurebench-baseline-metrics.json` 的
`experiments.*.sides.all.arms`；单 run 的 patch/token/版本见 `featurebench-runs.jsonl`。

### 3.2 扩样本缺官方评分那条（AC-004 重点）

- `mwaskom__seaborn.7001ebe7.test_regression.ce8c62e2.lv1` / `standard`（2026-11-07）：
  有补丁（33,855 字符，`agent_completed=true`），但官方 `fb eval` 在加载数据集时
  HF revision 解析失败（网络层失败），从未写出 `report.json`。
- 处理：status=`unscoreable_missing_official_result`，ITT 按未解决计入（7/12），
  可评分口径 7/11；两种分母都在 §3.1 与历史报告中并列。
- 2026-11-10 官方复评该条 **resolved=1.0**（§4），但**不回填**历史聚合；只在
  §5.2 作为「若计入」的敏感性参考。

### 3.3 可比配对面板（与 #8 完全一致的 treatment 定义）

**主面板**（B = 「SDLC preset + manifest 固定引导」：MVP/expanded/repeat 取 `sdlc`，
2×2 取 `sdlc_guidance`；version-regression 的 old 是 MVP 复用，不重复计）：

| 指标 | 值 |
|---|---|
| 尝试配对 / 可评分配对 | 31 / **30** |
| A resolved | **21/30（70.0%）** |
| B resolved | **22/30（73.3%）** |
| 配对结果 | B 胜 3、A 胜 2、平 25（双过 19、双败 6） |
| 平均差（B−A resolved 率） | **+0.033** |

**敏感性（同批数据、不同事先声明的口径）**：

| 变体 | 说明 | A | B | W/L/T |
|---|---|---|---|---|
| 主面板 | 2×2 用 `sdlc_guidance`（带引导），#8 口径 | 21/30 | 22/30 | 3/2/25 |
| `variant_2x2_sdlc` | 2×2 改用纯 `sdlc`（无引导） | 21/30 | 23/30 | 3/1/26 |
| `variant_itt` | expanded 缺官方评分那条按 unresolved 计入 | 21/31 | 23/31 | 4/2/25 |

面板成员与逐对数据见 `featurebench-baseline-metrics.json` 的 `comparable_pairs`。
**arm 选择来自 treatment 定义（B = SDLC + 固定引导），不是按结果挑选**；两个变体
方向一致（B 略高，1–2 对），都在运行方差范围内。

### 3.4 验证者混淆矩阵（AC-006）

裁决 = 本次运行最后一次 `sdlc_verify` 的结果；成绩 = 官方 `fb eval` resolved。两者分开存储，
`featurebench-verifier-confusion.json` 里有逐 run 明细与原因。

| 组 | B run | 官方 resolved | approve→resolved | **approve→unresolved（假阳性）** | reject→unresolved | **reject→resolved（假阴性）** | needs_human | 无裁决 | 假阳性率 | 有裁决准确率 |
|---|---|---|---|---|---|---|---|---|---|---|
| V1 | 49 | 36 | 29 | **7** | 1 | **1** | 0 | 11 | 7/36 = 19.4% | 30/38 = 78.9% |
| V2 | 5 | 4 | 2 | **1** | 0 | **2** | 0 | 0 | 1/3 = 33.3% | 2/5 = 40.0% |
| 合计 | 54 | 40 | 31 | **8** | 1 | **3** | 0 | 11 | 8/39 = 20.5% | 32/43 = 74.4% |

- 口径：**canonical 主会话口径**（`featurebench-runs.jsonl` 的 `verify_verdicts`；
  验证者子会话里的同名 status JSON 不重复计数）。旧 `report-data.json` 的「全 session」
  口径保留在 `featurebench-verifier-confusion.json` 里作对照。修复两处 repeat/arm 身份
  bug 后，18 次 B 运行子集按旧口径重算为 **approve 14、FP 2（14.3%）**；#8 正文的
  13/2（15.4%）是更早一次汇总（未留下脚本），差 1 个 approve，结论不变。V1 两种口径
  现在一致（approve 29+7、无裁决 11）；V2 仍差 1 条（packaging 的旧序列多出子会话
  approve，最后裁决 approve vs 主会话 reject）。**AC-006 以主会话口径为准**。
- 54 个 B run 中 **16 个**带 agent 提前失败/截断标记（timeout/over_budget/turn_error 等），
  其中 11 个最终无裁决（6 个官方 resolved、5 个 unresolved）；「无裁决」是删失，不是
  通过也不是失败。另有 47/54 个 B run 真实触发了 SDLC 工作流。
- 结论：**approve 不能当成绩**；V1 有裁决时准确率约 79%，但覆盖只有 38/49（77.6%），
  且同一 task 的重复运行会在 approve/reject 之间翻转。
- 已知限制：同一 task 的重复 run 不去重（这是验证者行为样本，不是任务级正确率）；
  样本小，不做显著性宣称。

### 3.5 泄漏 / 隔离与敏感性（AC-005）

- 泄漏扫描方法：从官方 dataset 的 gold patch 取实现签名，在容器内 `grep`（排除
  `/testbed`、`/proc`、`/sys`）；逐 run 写 `leak_scan.txt`。
- 命中：**135 次命中，全部在 `pypa/packaging`**（15 个 run）——官方镜像内 pip/setuptools/
  wheel vendored `packaging` 参考副本，两臂都可见；其余 4 个 repo 的 81 个 run 命中 0。
- **gold patch 比对：96 run 中逐字节相同 0、归一化后相同 0**；A/B（A=standard，
  B=treatment）补丁字节完全相同的 pair 有 **4 对**（全跨臂组合 7 对，例：pytest
  `raises_group` 的 standard 与 sdlc）——这是独立性线索，不直接判定抄袭（同模型同任务
  收敛到相同修改是可能的）；同时 96 run 里**没有**「同一补丁得到不同官方成绩」的反例
  （`resolved_outcome_inconsistencies=0`）。明细与限制见 `featurebench-leak-audit.json`。
- packaging 敏感性（**V1-only，不删分母，含/不含并列**；V2 单独列）：
  - 全 V1 面板（30 scoreable 对）：含 packaging **A 21 / B 22、W3 L2 T25、净 +1**；
  - 含 packaging 的 5 对：A 4/5 vs B 5/5、W1 L0 T4、**净 +1**；
  - **不含 packaging 的 25 对：A 17/25 vs B 17/25、W2 L2 T21、净 0**；
  - 即 V1 的净 +1 完全由 packaging 这 1 个边缘个案贡献。ITT 口径下不含 packaging 仍差 1
    （A 17/26 vs B 18/26），那 1 条是 expanded A 侧官方评分环境缺失按未解决计入，不是胜负。
  - V2 的 5 对里 packaging 也是同一个「A 98.64% 边缘失败 / B 通过」个案；V2 单独列，不并入。
- 隔离设计（证据在代码）：每个 run 新建容器、**零宿主目录挂载**，只 `put_archive` 注入
  最小文件（插件/凭据/启动脚本）；官方 `RuntimeHandler` 做 mask/restore；跑前清理包缓存；
  泄漏扫描不修改官方镜像。不能据此宣称严格盲评：容器内 agent 仍有网络，官方镜像
  自身可能含参考实现（packaging 已证实）。

### 3.6 版本回归：V1 → V2（不与其他 effect 估计混用）

| 指标 | V1（0.6.0/0.2.1-rc.5，old=MVP 复用） | V2（0.6.1/0.2.2-rc.1，新跑） |
|---|---|---|
| standard resolved | 4/5 | 3/5 |
| sdlc resolved | 4/5 | 4/5 |
| 配对 | 0W/0L/5T | 1W/0L/4T |
| 总 token（10 run） | 70.4M | **124.9M（+77.5%）** |

- B（SDLC+引导）正确率没有回归（4/5）；A 少 1 个是 packaging 98.64% 的边缘失败。
- 成本上升集中在 packaging/sphinx/seaborn-B；同一任务 token 可涨 1.0–8.5×，不是所有
  任务都涨。V2 只有 10 run、单窗口，不能当作稳定的版本级成本结论。

## 4. 官方 Grader 实跑复评（AC-007）

见 [`featurebench-2026-11-10-grader-rerun.md`](featurebench-2026-11-10-grader-rerun.md)
（机读：同名 `.json`）。摘要：

| 运行 | 历史状态 | 复评结果 |
|---|---|---|
| seaborn `test_regression` / standard | **缺官方评分**（HF revision 解析失败，环境失败） | **resolved=1，pass_rate=1.0**（F2P 52/52、P2P 218/218，errors=0） |
| sphinx `test_build_gettext` / standard | resolved=0，pass_rate=0.0769 | **resolved=0，pass_rate=0.0769**，与原始 report 逐条一致（仅时间戳不同） |

复评用历史 `patch.diff` 重新生成 predictions（sha256 与 `meta.patch_sha256` 一致），
直接调用官方 `fb eval`（`featurebench==0.3.0`、dataset `76b4a456…`、本地官方镜像）；
未调模型、未重跑 agent、未用 dry-run 或离线汇总冒充。命令、环境卡点与失败日志
（SOCKS 代理、HF 缓存写权限）见复评报告。补评结果**不回填**历史聚合。

## 5. 已验证事实 / 当前不支持的结论 / 后续假设（AC-009）

### 5.1 已独立复算/可核对的事实

1. 数据规模与身份：96 canonical run（V1 85 / V2 10 / pilot 1）、27 个任务、7 份快照
   105 行（去重 95）、575 条 artifact hash、0 mismatch；版本分组与镜像 digest 可查。
2. #8 的主要统计：27 任务、paired n=30 / A21 / B22 / W3 L2 T25 可精确复现；
   「85 次官方评分」应为 84 份 report（1 条环境失败）；「164 attempts」无法复算
   （可追溯仅 63）；token 两套口径（UI 761.6M / 含 session 补全 944.0M）。
   V2 UI 合计 124.9M；pilot 20.9M 与 V2 `packaging/standard` 是同一次物理运行，
   不能重复相加。
3. 结果观测：§3.1–3.3 的逐臂与配对数字；方向不一致、净差 +1 对。
4. 成本观测：B 的 token 中位数在可比实验里是 A 的 2.3–5.4×（2×2 的 sdlc_guidance 2.1×）。
5. 验证者（主会话口径）：V1 49 个 B run 中 approve 36（7 次 FP，19.4%）、reject 2
   （1 次 FN）、无裁决 11（22.4%）；V2 单独列出（FP 1/3、FN 2/2，n=5）。旧
   report-data 全 session 口径的差异与 #8 的 15.4% 来源见 §3.4 与
   `featurebench-verifier-confusion.json`。
6. 泄漏：packaging vendored 副本（135 命中/15 run），其他 repo 0；gold 比对 0；
   A/B 同补丁 4 对（线索级）；V1 的净 +1 全部来自 packaging，不含 packaging 时打平。
7. 版本：V2 最小回归 B 4/5 无正确率回归、总 token +77.5%；其余 5 份 V2 清单未执行。
8. 官方评分链路：AC-007 两条真实复评通过（§4）。

### 5.2 当前证据不支持的结论

1. 「SDLC 默认开启能稳定提高正确率」——**不支持**；面板净差 1 对且方向跨实验矛盾。
2. 「0.6.1 与 0.6.0 效果相同/更好」——V2 只有 10 run 最小回归，不能比较效果。
3. 「历史 85 次运行都可复现」「164 次尝试可追溯」——**不支持**（见 §2.2）。
4. 「严格盲评 / 完全可复现」——**不支持**（L2；raw runs 不公开；packaging 泄漏）。
5. 「验证者可以作为质量门禁」——**不支持**；V1 假阳性 19.4%、无裁决 22.4%（11/49）、
   同一 task 的裁决会翻转；V2 样本更小且更差（FP 1/3、FN 2/2）。
6. 「成本差异只是噪声」——**不支持**；方向一致，但具体倍数随任务/窗口变化。
7. 若把补评计入（仅敏感性，不回填）：扩样本 A ITT 7/12→8/12；池化面板 **n=31、
   A 22/31、B 23/31、W3 L2 T26（平均差 +1/31）**，方向不变、仍在方差范围。

### 5.3 后续待验证假设（交给 VERIFY-01 / EVAL-02 的数据入口）

1. **Verifier 专项（VERIFY-01）**：用 gold 补丁与人为破坏补丁建立 precision/recall 与
   阈值校准；明确「无裁决 ≠ 通过」；用本基线的 `featurebench-verifier-confusion.json`
   作为起点与回归对照。
2. **机制消融（EVAL-02）**：2×2 显示 preset 与引导都没有正向主效应，需要更大样本、
   难度梯度（lv2/更多 repo）和重复采样估计功效；用 `comparable_pairs` 的口径与
   `reaggregate.py --check` 保证新结果仍能离线复算。
3. **成本/预算**：把 timeout/over_budget 作为显式约束，报「每 1M token 的 resolved 数」；
   V2 的 +77.5% 成本需要按新预算重估。
4. **泄漏敏感性**：packaging 吸收了全部净差异；下一轮应把「已知泄漏 repo」预注册为
   分层变量，而不是事后删分母。

## 6. 不适用范围与局限

- 仅覆盖 FeatureBench v1.1 `fast` split、5 个 repo、以 lv1 为主、单模型
  `deepseek-flash`、单时间窗；不能外推到真实工程项目、其他模型、lv2 大任务。
- 样本量小、每任务每臂 1 次为主；重复采样只覆盖 3 个任务，binary resolved 的检验力低。
- V2 只有 10 run（MVP 子集）；V1 与 V2 不混合统计；0.6.0 的结论不挂 0.6.1。
- 原始 runs 含 prompt/session，不公开；审计级别 L2，不能宣称完全可复现或严格盲评。
- 模型实际服务版本不可得；无随机种子；权限/网络策略未逐 run 落盘（见
  `featurebench-env-identity.json` 的 `known_gaps`）。
- 镜像 digest 口径：`image_digest` 是 Docker Hub 官方 manifest digest；本地导入副本经
  `skopeo` 重编码，本地 manifest digest 不等，layer blob 未变（复评报告有说明）。
- `attempts` 账本不完整（63 次可追溯 / 96 run），不能把估计当记录。
- 验证者混淆矩阵用**主会话口径**；旧报告与 #8 评论用的是 report-data 全 session 口径
  （会重复计入验证者子会话），两种口径都保留，但 AC-006 以主会话为准。
- canonical 96 行对应 **95 次物理运行**（pilot 是 V2 同一 run 的副本）；不能把 canonical
  行数当作独立样本数。
- 历史编排在 driver wall-clock timeout 时可能把 token 记为 0（`run.json` 未写出），本基线的
  token 汇总已用 session 补全，但当时的预算约束可能因此被低估；该问题已在 PR #13 修复
  （`run_arm` 会话兜底、`run_matrix` 共享预算停止条件、`evaluate_matrix` 拒绝旧 report），
  历史数字不回填，作为当时的编排局限记录。
- 历史报告（2026-11-06 ~ 11-08）保留当时口径；本文与
  [`featurebench-baseline-metrics.json`](featurebench-baseline-metrics.json) 为当前基线；
  分母修订记录见相关报告顶部的「2026-11-10 EVAL-01 修订」注。

## 7. 复算与复跑命令

```bash
# 1) 结构 / 索引 / 审计 / 脱敏检查（无网络、无模型；CI evals-check 同样执行）
python3 tools/evals/featurebench/sanity_check.py --structural
python3 tools/evals/featurebench/sanity_check.py --index
python3 tools/evals/featurebench/audit_runs.py --check
python3 tools/evals/featurebench/check_redaction.py

# 2) 从已提交机读数据离线复算全部统计并校验（不需要 raw runs / 网络 / Docker / GUI）
python3 tools/evals/featurebench/reaggregate.py --check

# 3) 单个任务的 A/B 执行入口（默认 dry-run；--execute 才会起容器/调模型）
python3 tools/evals/featurebench/run_arm.py --task-id <task-id> --arm standard \
  --image fb-eval-base:<repo> --out /tmp/fb-runs/<task-id>/standard
python3 tools/evals/featurebench/run_arm.py --task-id <task-id> --arm sdlc \
  --image fb-eval-base:<repo> --plugin-dir /tmp/fb-plugin \
  --credentials /tmp/fb-creds.yaml --out /tmp/fb-runs/<task-id>/sdlc

# 4) 官方评分（示例；历史回放见 AC-007 复评报告）
FEATUREBENCH_IMAGE_PREFIX=docker.io fb eval -p <predictions.jsonl> --split fast \
  --task-id <task-id> --n-concurrent 1 --data-version v1.1 --config-path <config.toml>
```

完整的镜像获取/烤制、批量矩阵、汇总与报告命令见
[`../../tools/evals/featurebench/README.md`](../../tools/evals/featurebench/README.md)。
统计复算只依赖仓库内文件与标准库 + pyyaml。

## 8. 产物索引

| 类别 | 位置 |
|---|---|
| 预注册清单 | `tools/evals/featurebench/manifest.yml`、`manifests/*.yml`、`manifests/regression-0.6.1/*.yml` |
| 脚本 | `tools/evals/featurebench/`（run_arm / run_matrix / driver / evaluate_matrix / summarize_runs / analyze_* / collect_runs / audit_runs / reaggregate / sanity_check / check_redaction） |
| 机读数据 | `docs/evals/*-data.json`、`featurebench-runs.jsonl`、`featurebench-baseline-metrics.json`、`featurebench-baseline-index.json`、`featurebench-evidence-index.json`、`featurebench-env-identity.json`、`featurebench-leak-audit.json`、`featurebench-verifier-confusion.json` |
| 报告 | `docs/evals/featurebench-2026-11-06.md` 起的历史报告、`featurebench-2026-11-10-grader-rerun.md`、本文、`featurebench-review-guide.md` |
| CI | `.github/workflows/ci.yml` 的 `evals-check`（结构 + 索引 + 审计 + 复算 + 脱敏；不调模型） |
| 原始证据 | 本机 `~/.dsh-eval-archive/2026-11-08/`（不入库，只有 hash 入索引） |

## 9. 修订记录

- 2026-11-10：首次发布（EVAL-01）。历史报告分母修订（扩样本 ITT/可评分双口径）、
  #8 数字对账（84 report / 164 attempts 不可复算 / token 双口径）、AC-007 复评记录、
  数据快照脱敏。
- 2026-11-12：按 PR #13/#14 的 Codex review 修复并重算——2×2 按 arm 统计 SDLC 会话、
  `analyze_expanded` 的 `both_resolved` 口径（9→7）、infra 失败 run 留存、`turn_error`
  归 infra 重试、`run_regression` dry-run 传播、`collect_runs` 的 repeat attempts 身份与
  `--check` 失败语义；同步重算 2×2/扩样本快照、canonical run 表、证据索引与
  baseline metrics/index。主面板与 canonical 验证者数字不变。
