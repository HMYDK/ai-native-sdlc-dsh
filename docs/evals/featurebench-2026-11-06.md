# FeatureBench A/B 评测：标准模式 vs AI 原生 SDLC（MVP）

- 日期：2026-11-06
- 对应 issue：[#8](https://github.com/HMYDK/ai-native-sdlc-dsh/issues/8)（AC-005 / AC-006 的 MVP）
- 基准：FeatureBench 0.3.0，dataset `LiberCoders/FeatureBench` fast split，revision `76b4a4566e04f4bcc13c35125d4f301791efa736`
- 被测：DeepSeek Harness CLI 0.2.1-rc.5 + `@ai-native-sdlc-plugin/dsh-sdlc` 0.6.0，模型 `deepseek-flash`（reasoningEffort=max）
- 预注册清单：`tools/evals/featurebench/manifest.yml`（任务、镜像 digest、prompt 规则、运行纪律全部在跑之前固定）
- 复跑脚本：`tools/evals/featurebench/`（下载/烤镜像 → 单臂执行 → 矩阵 → 官方评分 → 汇总）

## 结论（先说结果）

5 个 repo 各 1 个 lv1 任务、A/B 各跑 1 次，官方 `fb eval` 评分：

| 指标 | A 标准模式 | B AI 原生 SDLC |
|---|---|---|
| resolved | **4/5**（packaging、pytest、pydantic、seaborn） | **4/5**（同上） |
| sphinx build_gettext | 未解决（F2P 通过率 7.7%） | 未解决（F2P 通过率 7.7%） |
| 平均 F2P pass rate | 0.815 | 0.815 |
| 总 token | 23.0M | 47.4M |
| 平均耗时 | 约 10.7 min | 约 33.8 min（含 1 次 45min 超时） |

5 个任务上，**两臂的最终正确率没有差异**（都是 4/5）；B 组确实启用了流程（5/5 次真实调用 `sdlc_*`），但代价明显更高：同一任务 B 的耗时是 A 的 1.8–7.6 倍、token 是 1.2–6.5 倍。唯一未解决的任务（sphinx）两臂都失败。**n=5、每臂 1 次，不能据此判断 SDLC 是否提升正确率**，只能作为「可复现评测底座 + 首批证据」。

值得单独记录的两个信号：

1. **B 组验证者假阳性 1 例**：sphinx 任务上 `sdlc_verify` 最终裁决 `approve`，官方评分 unresolved（F2P 7.7%）。
2. **B 组超时但补丁有效 1 例**：seaborn 任务 B 在 45min 上限被截断，抽回的代码补丁仍被官方判 resolved。说明 45min 上限对 B 偏紧，且「超时」不等于「补丁无效」，报告必须分开统计。



## 背景与要回答的问题

仓库现有验证（单测、运行时冒烟、`tools/bench` 双侧回归）证明的是「机制符合契约」，回答不了「启用 SDLC 流程是否让 agent 最终交付更正确」。本评测把 DSH 两种 preset 放到同一个第三方基准上，用官方评分器出分，并提供逐 run 记录（成本、失败原因、流程采纳、验证者裁决、参考副本泄漏扫描），让结论可复核。

## 实验设计

### 任务（预注册，禁止按结果挑）

选择规则写在 `manifest.yml`：5 个 repo 固定、每个 repo 内只取 lv1 任务、按 `instance_id` 字典序取第一个。

| # | repo | task id |
|---|---|---|
| 1 | pypa/packaging | `pypa__packaging.013f3b03.test_metadata.e00b5801.lv1` |
| 2 | pytest-dev/pytest | `pytest-dev__pytest.68016f0e.raises_group.c28bf36a.lv1` |
| 3 | pydantic/pydantic | `pydantic__pydantic.e1dcaf9e.test_deprecated_fields.40a2ec54.lv1` |
| 4 | mwaskom/seaborn | `mwaskom__seaborn.7001ebe7.test_algorithms.1f0181c2.lv1` |
| 5 | sphinx-doc/sphinx | `sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1` |

**替换记录（镜像可用性，不是按结果挑样本）**：原计划有 sympy；sympy 镜像的大层在镜像站连续 3 次整层 sha256 不符，按规则换 astropy；astropy 的 `05be` 冷层在 CDN 上长期只有 0.03–0.2MB/s、多轮重试无法完成，按同一规则换 pytest。两次替换都写进 `manifest.yml` 与提交历史。pydantic、seaborn、sphinx 未替换。

### A/B treatment

- **A（标准模式）**：prompt = 数据集 `problem_statement`，选择 DSH「标准模式」preset。
- **B（AI 原生 SDLC）**：prompt = `problem_statement` + 固定的流程引导话术（`manifest.yml` 的 `arms.sdlc.prompt_suffix`），选择「AI 原生 SDLC」preset。

**这是一个 treatment 差异，不是纯 preset 对比**：B 组多了一段引导话术。首轮实测发现不引导时 B 一次 `sdlc_*` 都没调用（模型会直接干活），所以为了让「流程被启用」这一变量可观测，固定加引导。报告里 B 的收益/成本都包含这段 prompt 的影响。

### 运行纪律（宽松上限）

- 单 run 墙钟上限 45min、token 上限 40M；
- 总 token 预算 200M，达到即停剩余运行；
- 仅基础设施错误（镜像/初始化/setup/Chrome 崩溃/模型流中断）允许重试 1 次；agent 失败、超时、unresolved 不重试；
- 任务按 manifest 顺序、A/B 启动顺序交替（奇偶）以避免时间漂移只偏向一臂；
- 所有运行都进分母（timeout / over_budget / 空补丁 / unresolved 分类单列）。

### 隔离与计分

- **零宿主挂载**：容器内不挂任何宿主目录。首轮事故是把含数据集 patch 的 `/eval` 挂进容器，B 组直接抄到 gold；该轮作废。现在只通过 `put_archive` 注入「凭据 + 插件 + 启动脚本」，注入前用官方 `RuntimeHandler.initialize_runtime` 恢复 `/root/my_repo`、应用 mask patch、删除 F2P 测试、清 bytecode、重建 git，再清包管理器缓存。
- **参考副本泄漏**：每镜像用 gold 实现签名扫描可见文件系统，命中只记录、不修改官方镜像（按确认的策略）。已知 packaging 镜像里有 pip vendored `packaging 25.0`，两臂都可见。
- **驱动**：SDK/headless 组合没有 `agentPresets` 服务、验证者工具会被宿主同名工具剥掉，所以两臂都走真实 DSH Web（`dsh web`）+ 无头 Chrome CDP，preset 在 UI 里真实点选。
- **补丁口径**：官方 `complete_runtime` 抽 patch；B 组 `.ai/` 流程制品（可到 19MB）从 `model_patch` 剔除，只交代码；流程证据保留在本地 `patch.full.diff` 与 session 日志。
- **评分**：每个 arm 用官方 `fb eval`（split=fast，n-concurrent=1）单独评分；`success=true` 覆盖所有 run，空补丁也进分母。

## 结果（官方评分）

| repo | arm | resolved | F2P pass rate | tokens | 耗时 | 代码补丁 | agent 状态 | B 流程采纳 | 验证者裁决 |
|---|---|---|---|---|---|---|---|---|---|
| pypa/packaging | standard | ✅ | 100% | 7.7M* | 370s | 50,959 | 完成 | — | — |
| pypa/packaging | sdlc | ✅ | 100% | 9.5M* | 1,121s | 51,027 | 完成 | 8 种 sdlc 工具 | approve（与官方一致） |
| pytest-dev/pytest | standard | ✅ | 100% | 3.3M* | 305s | 13,964 | 完成 | — | — |
| pytest-dev/pytest | sdlc | ✅ | 100% | 13.4M* | 2,318s | 13,964（与 A 字节相同） | 完成 | 7 种，verify×6 | reject×3→needs_human→approve（一致） |
| pydantic/pydantic | standard | ✅ | 100% | 8.5M* | 606s | 23,758 | 完成 | — | — |
| pydantic/pydantic | sdlc | ✅ | 100% | 13.5M* | 1,977s | 23,347 | 完成 | 7 种，verify×4 | approve×4（与官方一致） |
| mwaskom/seaborn | standard | ✅ | 100% | 2.2M | 1,526s | 6,026 | 完成 | — | — |
| mwaskom/seaborn | sdlc | ✅ | 100% | 2.9M | **2,700s 超时** | 14,327 | 超时（补丁仍有效） | 5 种，verify×2 | 无裁决（超时截断） |
| sphinx-doc/sphinx | standard | ❌ | 7.7% | 1.2M | 415s | 2,387 | 完成 | — | — |
| sphinx-doc/sphinx | sdlc | ❌ | 7.7% | 8.1M | 2,017s | 2,629 | 完成 | 6 种，verify×2 | **approve（与官方不一致）** |

`*` 为 DSH Web「用量」读数；无读数时用 session 日志 `usage.totalTokens` 汇总（口径一致，B 组会多算验证者子会话）。数据快照：`docs/evals/featurebench-2026-11-06-data.json`（机读，10 次运行全部字段）。

**汇总**：A 4/5 resolved，平均 F2P 0.815；B 4/5 resolved，平均 F2P 0.815。唯一失败任务（sphinx）两臂同样失败。

## 关键发现

1. **B 组真的在走流程**：5 个任务里 4 个出现 `sdlc_task_create` / `sdlc_artifact_write` / `sdlc_task_advance` / `sdlc_verify` 等调用（pytest 任务：advance×26、issue×30、verify×6；packaging：issue×8、verify×2）。引导话术有效，B 不是「名义上选了 preset 但行为同 A」。

2. **成本显著更高，正确率没有差异**：同任务 B/A 耗时比 3.0×（packaging）、7.6×（pytest）、1.35×（pydantic）、1.8×（seaborn，且超时）、4.9×（sphinx）；token 比 1.2–6.5×。pytest 任务两臂最终补丁**字节完全相同**，B 只是多花了 7.6 倍时间和 4 倍 token——在小任务上流程开销没有换来不同代码。

3. **sphinx 任务两臂都失败**（F2P 7.7%），B 还花了 8.1M token。说明流程不能弥补模型对任务本身的理解不足；这类任务值得做失败原因归类，而不是只统计 resolved。

4. **验证者裁决与官方评分**：3/5 一致（packaging、pytest、pydantic 的最终 `approve` 都对应官方 resolved）；**sphinx 的 `approve` 与官方 unresolved 不一致（假阳性）**；seaborn 因超时截断没有裁决（不计入）。pytest 上验证者先 reject×3、needs_human，最终 approve（官方通过）——验证者能迭代，但假阳性/反复是真实存在的行为，需要更大样本量估计混淆矩阵。

5. **B 组超时但补丁有效**：seaborn B 在 45min 被截断，抽回的补丁官方判 resolved。超时率和 resolved 率必须分开统计；下一步应放宽 B 的时间上限或改为「按步数/成本」而不是墙钟截断。

6. **参考副本泄漏**：packaging 镜像内 pip vendored `packaging 25.0` 命中 gold 实现签名（两臂都可见），该任务的通过率不能完全排除参考实现泄漏；其它 4 个镜像的签名扫描未命中。按确认策略只记录、未改官方镜像。

7. **基础设施本身是评测的一部分**：镜像站坏缓存/冷层低速（换了两个 repo）、Docker CLI 把宿主代理注入容器导致 npm 失败、driver 的完成判据/页面水合/引导弹层、`fb eval` report 路径——这些坑都会静默污染结果，已全部修在 `tools/evals/featurebench/` 并写进提交历史。

## 成本

- 10 次运行（5 任务 × 2 臂）总计约 **70.4M token**（A 23.0M / B 47.4M），在确认的 200M 总预算内。
- 单 run 最高：pydantic B 13.5M（约 1,977s）、pytest B 13.4M（约 2,318s）；未出现 over_budget。
- B 组单次运行平均约 2,027s，A 组约 644s；B 组 1 次触发 45min 上限（seaborn）。
- 镜像准备成本（一次性，不占总预算）：约 55GB 下载 + 5 个 base 镜像（每个 ~30GB），详见 `README.md` 的镜像准备流程。

## 局限

- **n=5、每臂 1 次**：不能做显著性判断，任务难度、模型/服务波动、缓存命中率都会影响结果。
- **B 组含 prompt 引导**：不是纯 preset 对比；若要分离「preset」与「引导话术」，需要 2×2 设计。
- **镜像可用性替换 2 次**（sympy→astropy→pytest）：替换依据是镜像可下载性，不是任务难度；报告保留记录。
- **参考副本泄漏未消除**：只记录；packaging 任务尤其受影响。
- **驱动依赖 UI**：preset 选择、完成判据、引导弹层都靠页面结构，DSH Web 升级会破坏驱动；已把判据与重试写成代码，但仍需维护。
- **token 口径**：DSH Web「用量」与 session `totalTokens` 在 B 组（含验证者子会话）不一致，报告逐 run 标注来源。

## 复跑

```bash
# 1. 取官方镜像并校验 digest（国内网络需镜像站，见 README）
python3 tools/evals/featurebench/fetch_image.py --image <official-image> --digest <digest> --out /tmp/oci-<repo> --workers 20 --blob-cache /tmp/blob-cache
skopeo copy --override-os linux --override-arch amd64 oci:/tmp/oci-<repo>:latest docker-daemon:<official-image>:latest

# 2. 烤入 Node 24 + DSH CLI
python3 tools/evals/featurebench/bake_base.py --image <official-image> --tag fb-eval-base:<repo> \
  --node-tarball /path/node-v24.21.0-linux-x64.tar.xz --execute

# 3. 跑 A/B（默认 dry-run；--execute 才真的调模型）
python3 tools/evals/featurebench/run_matrix.py --manifest tools/evals/featurebench/manifest.yml \
  --runs-root /tmp/fb-runs --plugin-dir /tmp/fb-plugin --credentials /tmp/fb-creds.yaml \
  --image-map "<repo>=fb-eval-base:<repo>" --execute

# 4. 官方评分 + 汇总
python3 tools/evals/featurebench/evaluate_matrix.py --runs-root /tmp/fb-runs --config /tmp/fb/config.toml --execute
python3 tools/evals/featurebench/summarize_runs.py --runs-root /tmp/fb-runs \
  --out /tmp/fb-runs/report-data.json --markdown /tmp/fb-runs/report.md
```

产物（本地，不入库）：`/tmp/fb-runs/<repo>/<arm>/{patch.diff,patch.full.diff,meta.json,run.json,adoption.json,sessions/,leak_scan.txt}` 与 `/tmp/fb-runs/summary.json`。仓库只提交本报告 + `report-data.json` 快照。

## 下一步（对应 issue #8 未完成部分）

1. 扩样本：每臂 ≥5 次重复或更多任务，报告 resolved 置信区间与成本分布。
2. 拆分 treatment：2×2（preset × 引导话术），回答「提升来自流程机制还是来自提示词」。
3. 验证者专项评测：以官方评分为金标准，统计 approve 的假阳性/假阴性，重点复测 sphinx 类失败。
4. 调整 B 组预算：45min 墙钟对 B 偏紧；改为 step/token 预算或给 B 更长上限，并单独报告超时。
5. 泄漏对策：把 vendored 参考实现列为基准的已知偏差，或在允许修改镜像时做隔离实验（与本次「只记录」策略对照）。
