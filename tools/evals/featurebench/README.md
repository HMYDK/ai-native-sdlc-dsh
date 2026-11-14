# FeatureBench A/B 评测（外部交付质量证据）

> 状态：P0 链路已于 2026-11-06 打通（官方镜像 + 官方 mask/restore + 官方评分器 +
> 无头 Web 驱动）；5 任务 MVP 按 [`manifest.yml`](manifest.yml) 执行。这不是排行榜，
> 单个任务的结果没有任何统计意义。

## 为什么做这件事

本仓库现有的验证（单测、运行时冒烟、`tools/bench/` 双侧回归）证明的都是
「机制符合契约」——它们是**自证**。issue #8 要回答的是另一个问题：

> 相同 DSH、相同模型、相同任务与初始环境下，启用「AI 原生 SDLC」是否实际提升
> 最终软件交付正确率？额外流程是否值得成本？

这个问题只能靠**外部基准 + 官方评分器**回答，不能靠仓库自己的断言。本目录是
FeatureBench A/B 的最小可复跑实现：

- **A（baseline）**：DSH 内置「标准模式」preset。
- **B（candidate）**：本插件「AI 原生 SDLC」preset，并在 prompt 末尾追加固定的
  流程引导（见 manifest 的 `arms.sdlc.prompt_suffix`；单任务实测发现不引导时
  B 组一次 `sdlc_*` 都没调用，所以这是必要的 treatment 说明，A 组不追加）。
- 两臂使用**同一官方镜像、同一任务、同一模型/参数**，最终补丁交给 FeatureBench
  官方 `fb eval` 评分。

## 前置条件

- Docker（需要能运行 `linux/amd64` 容器；本机实测 Docker Desktop + Rosetta）。
- Python 3.12（`uv` 安装的 FeatureBench 环境即可）。
- Node.js 24（宿主侧驱动无头 Chrome）。
- Chrome（`/Applications/Google Chrome.app`；驱动脚本用 CDP，不依赖 Playwright）。
- `featurebench==0.3.0`（`uv tool install featurebench`）。
- npm 上的 `@deepseek-ai/dsh@0.2.1-rc.5`（容器内使用）。
- 本仓库打出的插件 tarball：`npm pack --workspace packages/sdlc`（sha256 记在
  manifest）。容器内手工安装，不依赖 pnpm。
- 模型凭据：隔离的 `$DSH_HOME/.credentials.yaml`（provider `deepseek-account`,
  model `deepseek-flash`），**不要**把本机 `~/.dsh` 整体挂进容器。

### 官方镜像怎么拿（关键，实测踩过）

国内网络**无法**直接 `docker pull` Docker Hub（DNS 污染，大 blob 在
AWS CloudFront 直连超时；本机代理单连接只有 20–30KB/s）。可用路径：

1. 用 DoH 取真实 IP 验证 Docker Hub API 可达（可选）；
2. 用可用的国内镜像站（本次实测 `docker.jiaxin.site`，阿里云 ESA CDN）拉 blob：
   `fetch_image.py --image <image> --digest <manifest-digest>` 并发 Range 下载、
   逐 blob 校验 sha256、拼 OCI layout；
3. `skopeo copy --override-os linux --override-arch amd64 oci:<dir>:latest \
   docker-daemon:<image>:latest` 导入 Docker；
4. `bake_base.py` 把 Node 24 + dsh CLI 烤进派生镜像（每个 repo 一次），得到
   `fb-eval-base:<repo>`，避免每次 A/B 都重装。

镜像 digest 全部在 manifest 里钉死；manifest digest 从 Docker Hub API 取得，
blob 用 manifest 内的 sha256 校验——镜像站不可信也没关系。

## 运行步骤

```bash
# 0. 准备（一次）
uv tool install featurebench==0.3.0
npm pack --workspace packages/sdlc    # 得到 ai-native-sdlc-plugin-dsh-sdlc-0.6.0.tgz

# 1. 取镜像（每个 repo 一次）
python3 tools/evals/featurebench/fetch_image.py \
  --image libercoders/featurebench-specs_sympy-instance_3d889fef \
  --digest sha256:207ff124011e74d2b6abbdce2f8d3244546949cd0abfb7949d7dd414368f8935 \
  --out /tmp/fb-oci/sympy
skopeo copy --override-os linux --override-arch amd64 \
  oci:/tmp/fb-oci/sympy:latest docker-daemon:libercoders/featurebench-specs_sympy-instance_3d889fef:latest

# 2. 烤基础镜像（Node 24 + dsh CLI）
python3 tools/evals/featurebench/bake_base.py \
  --image libercoders/featurebench-specs_sympy-instance_3d889fef \
  --tag fb-eval-base:sympy --node-tarball /path/node-v24.21.0-linux-x64.tar.xz

# 3. 跑一臂（默认 dry-run；--execute 才真正启动容器/模型调用）
python3 tools/evals/featurebench/run_arm.py --manifest tools/evals/featurebench/manifest.yml \
  --task-id sympy__sympy.c1097516.test_inverse.c240ffe7.lv1 --arm standard \
  --image fb-eval-base:sympy --mode agent --out /tmp/fb-runs/sympy-standard

# 4. 整批：跑完 5 任务 × 2 臂（默认 dry-run；--execute 才真跑）
python3 tools/evals/featurebench/run_matrix.py --manifest tools/evals/featurebench/manifest.yml \
  --runs-root /tmp/fb-runs --plugin-dir /tmp/fb-plugin --credentials /tmp/fb-creds.yaml \
  --image-map "pypa/packaging=fb-eval-base:packaging" --image-map "sympy/sympy=fb-eval-base:sympy" \
  --image-map "pydantic/pydantic=fb-eval-base:pydantic" --image-map "mwaskom/seaborn=fb-eval-base:seaborn" \
  --image-map "sphinx-doc/sphinx=fb-eval-base:sphinx" --execute

# 5. 官方评分 + 汇总（默认 dry-run；--execute 才调 fb eval）
python3 tools/evals/featurebench/evaluate_matrix.py --manifest tools/evals/featurebench/manifest.yml \
  --runs-root /tmp/fb-runs --config /tmp/fb/config.toml --execute

# 6. 汇总报告数据（官方成绩 + 成本 + B 组流程采纳 + 验证者/官方错配 + 泄漏扫描）
python3 tools/evals/featurebench/summarize_runs.py \
  --manifest tools/evals/featurebench/manifest.yml --runs-root /tmp/fb-runs \
  --out /tmp/fb-runs/report-data.json --markdown /tmp/fb-runs/report.md

# 手工逐臂评分（对每个 arm 的 patch 生成 predictions.jsonl）
python3 tools/evals/featurebench/make_predictions.py --task-id <id> \
  --out-prefix /tmp/fb-runs/<id>/predictions \
  --arm-dir standard=/tmp/fb-runs/.../standard --arm-dir sdlc=/tmp/fb-runs/.../sdlc
# -> /tmp/fb-runs/<id>/predictions-standard.jsonl 与 predictions-sdlc.jsonl（分别评分）
FEATUREBENCH_IMAGE_PREFIX=docker.io fb eval \
  -p /tmp/fb-runs/<id>/predictions-standard.jsonl \
  --split fast --task-id <id> --n-concurrent 1 --config-path config.toml
```

> `run_arm.py` 必须先通过 `--credentials` 指向隔离凭据文件；凭据只注入容器内
> `$DSH_HOME`，不落盘到结果目录。结果目录里不保存凭据、不保存原始 session。

## 安全与隔离（必须遵守）

本次实测踩到的两个真事故：

1. **宿主目录挂载泄漏**：第一版把 `/eval`（含数据集 `patch` 文件）挂进容器，
   被测 agent 直接读到了 gold patch，B 组产出的补丁与 gold **逐字节相同**——
   那一轮结果作废。现在：**零宿主目录挂载**，只通过 `put_archive` 注入最小
   文件（插件、js-yaml、凭据、启动脚本），session 日志用 `get_archive` 取出。
2. **官方镜像自身含参考实现副本**：packaging 镜像里 pip 自带 vendored
   `packaging 25.0`、以及 26.0 sdist；agent 可以读来「抄实现」。两个 arm 机会
   均等，但结果解释必须带这个 caveat。`run_arm.py` 在初始化后跑一次泄漏扫描并把
   命中写 `leak_scan.txt`，不修改官方镜像。

其他固定动作：

- 复用 FeatureBench 官方 infer 初始化（`RuntimeHandler.initialize_runtime`）：
  从 `/root/my_repo` 恢复、打 mask patch、删除 F2P 测试文件、清 bytecode、
  **重建 git**（消除未来提交历史）。
- 初始化后调用 `clear_package_caches`，避免 pip/conda 缓存成为泄漏面。
- 容器内显式 `unset HTTP_PROXY/HTTPS_PROXY/ALL_PROXY` 再启动 DSH，否则 Model
  API 请求会走宿主机代理地址而失败。
- 关闭 DSH session-log 上传与 OTel（profile patch），避免任务数据外传。
- 官方镜像没有可用 sandbox 后端（无 bubblewrap/Landlock），`workspace-write`
  的 bash 必然失败；两臂统一把会话权限 preset 设为 `danger-full-access`，
  driver 对危险操作自动批准一次（记录在 README/报告，不伪装成默认行为）。
- 默认 dry-run：`run_arm.py`/`make_predictions.py` 不建立容器、不调模型；
  只有 `--execute` 才运行，保证 CI/`npm test` 不会误触发昂贵调用（AC-007）。

## 已知限制

- **驱动是 Web GUI**：DSH 的 `sdk`/`headless` 组合没有 `agentPresets` 服务，
  preset 内验证者的工具会被宿主同名全局工具剥掉（实测只剩 `structured_output`，
  `sdlc_verify` 永远 `needs_human`）。因此 B 组必须走 `web` profile（真实选择
  「AI 原生 SDLC」preset），用容器内 web + 宿主无头 Chrome/CDP 驱动。这是当前
  唯一能让 AC-002 真实成立的自动化方式，但不是官方 headless 形态。
- **参考副本泄漏**见上；本轮不做环境修改。
- **单任务/5 任务都无统计意义**；报告只描述观测，不宣称 Harness 有普遍优势。
- **成本高**：A 单任务实测 10.2M tok（UI 口径），5 任务 × 2 臂按 manifest 的
  200M tok 上限控制；镜像每个 10–14GB，下载受网络影响。
- **B 组可能不采纳流程**：即使加了引导文本，也要看实际 `sdlc_*` 调用与
  `sdlc_verify` 裁决；不采纳就如实记录，不替代成“应该采纳了”。
- 结果不提交原始 session/凭据；只提交摘要、manifest 与可复跑脚本。

## 结果在哪里

- 每次运行：`<out-dir>/meta.json`、`patch.diff`、`sessions/`（本地保留，不提交）；
- 官方评分：`fb eval` 输出 `report.json`（resolved / pass_rate / 各类不可评分）；
- 报告：首批 5 任务 × 2 臂见 [`docs/evals/featurebench-2026-11-06.md`](../../../docs/evals/featurebench-2026-11-06.md)，
  机读快照见 [`featurebench-2026-11-06-data.json`](../../../docs/evals/featurebench-2026-11-06-data.json)。

## 自检 / 归档 / 验证者分析

- `sanity_check.py --structural`：CI 用的清单结构校验（不连 Docker/网络）；
  `--control --task-id <id> --image fb-eval-base:<repo> --execute`：gold/empty 官方评分正负对照
  （每个 control 用独立输出根；共用根会让 `fb eval` 命中前一个 control 的
  `eval_outputs` 缓存，实测 empty 曾误报 resolved=1）。
- `archive_runs.py --runs-root <dir> --out <tar.gz>`：把 runs 归档（默认不含 session，带 sha256）。
- `analyze_verifier.py --data <report-data.json>`：B 组验证者裁决 vs 官方评分的混淆矩阵。

实验②③④的预注册清单在 `manifests/`；设计说明见
[`docs/evals/featurebench-2026-11-07-experiments.md`](../../../docs/evals/featurebench-2026-11-07-experiments.md)。

## 2×2 分析

`analyze_2x2.py --data <report-data.json>`：按 `manifests/2x2.yml` 的四个 arm 计算
preset / 引导的主效应、交互项与 token 倍数；每任务每条件 1 次时只作方向性证据。

## 第二轮结果（2026-11-07）

- ② 验证者校准：[`docs/evals/featurebench-2026-11-07-verifier-calibration.md`](../../../docs/evals/featurebench-2026-11-07-verifier-calibration.md)
- ③ 2×2 拆分：[`docs/evals/featurebench-2026-11-07-2x2.md`](../../../docs/evals/featurebench-2026-11-07-2x2.md)
- ④ 扩样本：[`docs/evals/featurebench-2026-11-07-expanded.md`](../../../docs/evals/featurebench-2026-11-07-expanded.md)
- 总结：[`docs/evals/featurebench-2026-11-07-summary.md`](../../../docs/evals/featurebench-2026-11-07-summary.md)

## 第三轮（2026-11-08）：重复采样

- 报告：[`docs/evals/featurebench-2026-11-08-repeat-sampling.md`](../../../docs/evals/featurebench-2026-11-08-repeat-sampling.md)
- 脚本：`run_repeats.py`（多 rep 编排 + 跨 rep 预算）、`analyze_repeat.py`（per-cell 方差、
  paired diff、bootstrap 区间）

## 版本回归（2026-11-08）

plugin 0.6.1 / DSH 0.2.2-rc.1 最小回归（5 任务 × A/B）：
[`docs/evals/featurebench-2026-11-08-version-regression.md`](../../../docs/evals/featurebench-2026-11-08-version-regression.md)

## EVAL-01：离线复算、审计与数据一致性（2026-11-10）

issue #12 把历史实验收口为「可审计、可离线复算」的基线。入口文档：
[`docs/evals/featurebench-baseline.md`](../../../docs/evals/featurebench-baseline.md)
与 [`featurebench-review-guide.md`](../../../docs/evals/featurebench-review-guide.md)。

数据/脚本分工（全部不调模型、不联网、不依赖 GUI/凭据）：

| 命令 | 作用 |
|---|---|
| `sanity_check.py --structural` | 清单结构 + runtime group + 镜像 digest；递归含 `manifests/regression-0.6.1/*.yml` 与 `manifests/verify-01/*.yml`（VERIFY-01 两臂唯一差异校验） |
| `sanity_check.py --index` | 校验 `docs/evals/featurebench-baseline-index.json` 里所有文件 sha256、版本分组、计数 |
| `audit_runs.py --check` | 校验 canonical `featurebench-runs.jsonl`：唯一性、状态枚举、版本混用、分母对账、快照映射、泄漏/证据/验证者摘要 |
| `reaggregate.py --check` | 从已提交机读数据离线重算全部统计，与 `featurebench-baseline-metrics.json` 逐项比对，并交叉校验 `featurebench-verifier-confusion.json` |
| `check_redaction.py` | 禁止本机绝对路径/凭据形态进入 docs/evals 与 tools/evals |

CI 的 `evals-check` job 会跑上面五项（外加两个 dry-run），只依赖 `pyyaml` + 标准库。

重新生成（本地、需要历史 raw runs 与 HF 数据集缓存；不是 CI 步骤）：

```bash
# 1) canonical run 表 / 证据索引 / 环境身份 / 泄漏 / 验证者混淆（需要 pyarrow+zstandard，
#    用 featurebench 的 uv python；缺依赖默认拒跑，--allow-degraded 只用于排查）
#    （路径用 `uv tool dir featurebench` 查；不要写死本机主目录）
UV_PY="$(uv tool dir featurebench)/bin/python"
"$UV_PY" tools/evals/featurebench/collect_runs.py --check

# 2) 离线统计与索引（只读已提交数据，stdlib+pyyaml）
python3 tools/evals/featurebench/reaggregate.py \
  --out docs/evals/featurebench-baseline-metrics.json \
  --index docs/evals/featurebench-baseline-index.json
```

`baseline-index.json` 钉死了 7 份 `*-data.json`、7 份 manifest、`runs.jsonl`、
`evidence-index.json` 的 sha256：任何一处有意修改后必须重跑 `reaggregate.py` 更新索引，
否则 `sanity_check.py --index` 会失败（防止数据被静默改动）。
