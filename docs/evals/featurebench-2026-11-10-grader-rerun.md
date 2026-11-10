# 官方 Grader 复评：A 条补评 + sphinx unresolved 复现（EVAL-01 AC-007）

- 日期：2026-11-10
- 关联 issue：[#12 EVAL-01](https://github.com/HMYDK/ai-native-sdlc-dsh/issues/12)，验收项 AC-007
- 被测历史运行：④ 扩样本中 A 组唯一缺官方评分的一条 + MVP sphinx 一条（原始 unresolved）
- 范围：**只复评 2 条历史运行**；不重跑 agent、不调模型、不重跑历史 85 次 run
- 评分器：官方 `fb eval`（`featurebench==0.3.0`），会起 docker 容器
- 机读快照：[`featurebench-2026-11-10-grader-rerun.json`](featurebench-2026-11-10-grader-rerun.json)

## 结论

**AC-007 完成（2/2）**：两条历史运行都拿到官方 Grader 的真实输出；B 条与原始结果完全一致，
A 条完成缺失补评。没有用 dry-run / 离线汇总冒充官方评分。

| 运行 | 历史状态 | 复评结果 | 判定 |
|---|---|---|---|
| **A** `mwaskom__seaborn.7001ebe7.test_regression.ce8c62e2.lv1` / standard | **缺失**官方评分：`eval-standard/eval.log` 记录 HF dataset revision 解析失败（环境失败，不是 agent 失败；原 run 也从未写出 `report.json`） | **resolved=1，pass_rate=1.0**；F2P 52/52、P2P 218/218、errors=0、not_applied_empty=0；exit 0，49s | 补评成功（无历史结果可比） |
| **B** `sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1` / standard | resolved=0，pass_rate=0.0769，errors=0，not_applied_empty=0 | **resolved=0，pass_rate=0.0769**，errors=0，not_applied_empty=0；F2P 1 成功/12 失败、P2P 137/137；exit 0，36s | **与原始一致**（逐条测试状态相同，仅完成时间戳不同） |

补评结果单独记录在本文件，**不回填**历史聚合表；历史报告是否修订由 EVAL-01 汇总方决定。

## 环境与身份

| 项 | 值 |
|---|---|
| 数据集 | `LiberCoders/FeatureBench`，split `fast`（100 实例） |
| 数据集版本 | 命令请求 `v1.1`；复评时实时解析为 commit `76b4a4566e04f4bcc13c35125d4f301791efa736`（与本地 HF 缓存 revision 目录一致） |
| 评分器 | `featurebench==0.3.0`（`fb eval`） |
| 关键依赖 | `datasets 5.1.0` / `huggingface_hub 2.4.0` / Docker SDK 7.2.0 |
| Docker | Docker Desktop 29.5.3（Darwin arm64）；官方镜像为 `linux/amd64`，经 Rosetta 运行（与历史运行环境一致） |
| 评分方式 | `fb eval` 起容器 → 应用 predictions 的补丁 → 跑 F2P/P2P → 写 `report.json`；不调用模型 |

官方镜像（本机已有，来自 2026-11-05 的 OCI 导入）：

| 运行 | 镜像 tag（数据集 `image_name`） | 本地 `docker image inspect` id / repo digest | 清单/历史 `meta.json` 登记的 `image_digest` |
|---|---|---|---|
| A | `libercoders/featurebench-specs_seaborn-instance_52738fbb:latest` | `sha256:f0024c7d25078a2a0c38a26bc35fa72cf5f0378b65d7c755779bd6dd807ae574` | `sha256:fe27a1a5205fa0939453e79d0f40c74cb402bad8ea1d42fff7de5e2106e77ce1` |
| B | `libercoders/featurebench-specs_sphinx-instance_6191afb1:latest` | `sha256:e8c6256c96deaa7670c55882dad325a82e1496c73169ede340a2d0b5989404a8` | `sha256:15b434473e16386e33c864d8b7f4a3bddb9c5585961758c0ed0f06b51b3f0268` |

> 两个 digest 口径不同：`image_digest` 是 Docker Hub 上官方 manifest 的 digest，导入脚本
> `fetch_image.py` 会校验官方 manifest 与每个 blob 的 sha256；`skopeo copy` 把 OCI layout
> 导入本地 Docker 时重新编码了 manifest，所以本地 tag 的 manifest digest 不等于官方值
> （layer blob 未变）。本表只作追溯记录，不据此宣称「字节级可复现」。

## 输入与补丁校验

原始 runs 目录**只读**访问，未覆盖任何 `report.json`；复评输出全部写在 `/tmp/fb-grader-rerun/`。

| 运行 | 原始目录（/tmp，只读） | `patch.diff` sha256 | `meta.json.patch_sha256` | 复评 predictions |
|---|---|---|---|---|
| A | `/tmp/fb-runs-expanded/mwaskom__seaborn.7001ebe7.test_regression.ce8c62e2.lv1/standard/` | `54048dd0fdfe5c2a1d10936d87cfef9f0794442efd668e127a813151f3c9ebe8`（33,855 字符） | 一致 | 由 `patch.diff` 重生成，`cb957add877a5bdffbb9cb236cf117854fd884d0990a923a68a9f37eb5811ffc` |
| B | `/tmp/fb-runs/sphinx-doc__sphinx/standard/` | `5d5f2bd3d3406a1a12d96cc31cf0d5a636d55525519e4bcb37ce6d28a6d7c6b8`（2,387 字符） | 一致 | 由 `patch.diff` 重生成，`91f84e31238c5ba21c22ea659fa46781812ce60edf4669e4f093a8f8e428e362` |

- 复评用的 predictions 与历史目录里已有的 `predictions.jsonl` **逐字节相同**（A/B 都是）。
  A 条的历史 predictions 此前从未被成功评分（正是缺失那条）；B 条原始评分用的就是同一份预测内容。
- 评分时容器内实际应用的补丁与历史补丁一致：`eval_outputs/<task>/attempt-1/patch.diff`
  的 sha256 分别等于上表 `patch.diff` sha256（A `54048dd0…`，B `5d5f2bd3…`），
  且两条 `patch_successfully_applied=true`。

## 完整命令

复评目录 `/tmp/fb-grader-rerun/`。以下命令与历史 `evaluate_matrix.py` 的官方评分参数一致
（`--split fast --n-concurrent 1 --data-version v1.1`，`FEATUREBENCH_IMAGE_PREFIX=docker.io`），
只额外做了两处环境修复（见下一节，不改评分逻辑）。

```bash
# 0) 评分器配置：只钉 dataset revision，不含 token/endpoint
mkdir -p /tmp/fb-grader-rerun
cat > /tmp/fb-grader-rerun/config.toml <<'TOML'
[dataset]
revision = "v1.1"
TOML

# 1) 从历史 patch.diff 重新生成 predictions（输出到独立复评目录）
python3 tools/evals/featurebench/make_predictions.py \
  --task-id mwaskom__seaborn.7001ebe7.test_regression.ce8c62e2.lv1 \
  --out-prefix /tmp/fb-grader-rerun/A/predictions \
  --arm-dir standard=/tmp/fb-runs-expanded/mwaskom__seaborn.7001ebe7.test_regression.ce8c62e2.lv1/standard
python3 tools/evals/featurebench/make_predictions.py \
  --task-id sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1 \
  --out-prefix /tmp/fb-grader-rerun/B/predictions \
  --arm-dir standard=/tmp/fb-runs/sphinx-doc__sphinx/standard

# 2) 官方评分：A、B 各一次
env -u all_proxy -u ALL_PROXY \
  HF_DATASETS_CACHE=/tmp/fb-grader-rerun/hf-datasets-cache \
  FEATUREBENCH_IMAGE_PREFIX=docker.io \
  fb eval \
    -p /tmp/fb-grader-rerun/A/predictions-standard.jsonl \
    --split fast \
    --task-id mwaskom__seaborn.7001ebe7.test_regression.ce8c62e2.lv1 \
    --n-concurrent 1 \
    --data-version v1.1 \
    --config-path /tmp/fb-grader-rerun/config.toml

env -u all_proxy -u ALL_PROXY \
  HF_DATASETS_CACHE=/tmp/fb-grader-rerun/hf-datasets-cache \
  FEATUREBENCH_IMAGE_PREFIX=docker.io \
  fb eval \
    -p /tmp/fb-grader-rerun/B/predictions-standard.jsonl \
    --split fast \
    --task-id sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1 \
    --n-concurrent 1 \
    --data-version v1.1 \
    --config-path /tmp/fb-grader-rerun/config.toml
```

A 复评：2026-11-10T14:07:30Z → 14:08:19Z，**49s**（其中官方测试执行阶段 43s），exit 0。
B 复评：2026-11-10T14:08:30Z → 14:09:06Z，**36s**（测试执行阶段 30s），exit 0。

## 环境问题与修复（只动环境，不动评分器）

| # | 阶段 | 现象 | 原因 | 处理 |
|---|---|---|---|---|
| 1 | 历史原始失败（A，2026-11-07） | `RuntimeError: Unable to resolve dataset revision 'v1.1' … Refusing to use an unverified cached dataset.` 底层 `httpx2.ConnectError: [SSL: UNEXPECTED_EOF_WHILE_READING]` | 网络/代理层失败，与 agent、补丁无关 | 历史证据 `/tmp/fb-runs-expanded/mwaskom__seaborn.7001ebe7.test_regression.ce8c62e2.lv1/eval-standard/eval.log`（116 行，sha256 `3f0c10cb…`）。当时未产出 `report.json` → 本条缺失评分 |
| 2 | 复评探测（2026-11-10） | `ImportError: Using SOCKS proxy, but the 'socksio' package is not installed` | 本会话环境含 `all_proxy=socks5://…`，`httpx2` 缺 SOCKS 支持 | `env -u all_proxy -u ALL_PROXY`（保留 `http_proxy/https_proxy` 的本地 HTTP 代理）；`v1.1` 随即解析为 `76b4a45…`。失败日志 `logs/attempt0-hf-revision-socks-proxy.log` |
| 3 | 复评第 1 次 A（14:06:38Z，exit 1，5s） | `PermissionError: [Errno 1] Operation not permitted: '…/.cache/huggingface/datasets/…_76b4a45….lock'` | `datasets` 重建缓存要写 builder lock，而本 agent 会话的文件沙箱（workspace-write）不允许写工作区外的主目录 | `HF_DATASETS_CACHE=/tmp/fb-grader-rerun/hf-datasets-cache`；hub 缓存仍只读复用，评分器自带的 `verify_loaded_dataset_revision` 通过。失败日志 `logs/attempt1-A-lock-permission-error.log`（sha256 `2d2b46b7…`） |
| 4 | 复评第 2 次 A、第 1 次 B | 成功，exit 0 | — | 见上表结果 |

> 上述两处修复只影响 **HF 网络访问与缓存写路径**；数据集内容（commit 未变）、补丁、官方镜像、
> `fb eval` 评分逻辑均未替换。两次复评都是真实调用官方评分器（起容器、执行 F2P/P2P），
> 不是 dry-run，也不是离线汇总。

## 结果对比（官方 `report.json`）

| 运行 | 原始 resolved | 原始 pass_rate | 原始 errors | 原始 not_applied_empty | 复评 resolved | 复评 pass_rate | 复评 errors | 复评 not_applied_empty | 复评耗时 | exit |
|---|---|---|---|---|---|---|---|---|---|---|
| A（seaborn test_regression / standard） | —（无 report.json） | — | — | — | **1** | **1.0** | 0 | 0 | 49s | 0 |
| B（sphinx test_build_gettext / standard） | 0 | 0.0769 | 0 | 0 | **0** | **0.0769** | 0 | 0 | 36s | 0 |

原始 A 条「缺失」的定性：`.../eval-standard/eval.log` 只有失败 traceback，`.../standard/` 与
`.../eval-standard/` 下都从未生成 `report.json`。这是**环境失败**，不能解读为「agent 未产出」
或「未运行」——该 run 的 `meta.json` 记录 `agent_completed=true`、`patch_chars=33855`。

逐实例测试状态（`eval_outputs/<task>/attempt-1/report.json`）：

- **A 复评**：`patch_successfully_applied=true`，`resolved=true`，`pass_rate=1.0`；
  FAIL_TO_PASS 52 成功 / 0 失败，PASS_TO_PASS 218 成功 / 0 失败。
- **B 原始 vs 复评**：两者都是 `patch_successfully_applied=true`、`resolved=false`、
  `pass_rate=0.0769`；FAIL_TO_PASS 1 成功 / 12 失败，PASS_TO_PASS 137 成功 / 0 失败。
  两份逐实例 report 的**唯一差异**是 `featurebench_eval_completed_at`
  （2026-11-06T21:50:37 vs 2026-11-10T22:08:55）。

## 判定与敏感度

- **AC-007 完成**：官方 Grader 实际复评 2 条历史运行——A 条补上缺失评分，B 条 unresolved 复现且
  指标一致。判定只看 `fb eval` 写出的 `report.json`，不引用 agent 的完成状态。
- 补评 A 条若计入（**仅敏感性参考，不回填历史聚合**）：A 组 ITT 从 7/12 → 8/12；可评分口径
  从 7/11 → 8/12（补评后 A 组 12 条全部可评分）；B 组仍 10/12；paired 的 B−A resolved 率差
  从 2/11≈0.182 变为 2/12≈0.167，方向不变（B 仍更高、A-only 仍为 0）。
- 这个变化说明：「缺官方评分按未解决计入 ITT」是保守口径；补评后该条实际 resolved。
  ④ 报告是否修订属于 EVAL-01 汇总方的口径决定，本文件只提供复评证据。

## 证据与可审计性

复评产物（本机 `/tmp/fb-grader-rerun/`，不提交原始日志）：

```text
/tmp/fb-grader-rerun/
  A/{predictions-standard.jsonl, report.json, eval.log, run-meta.txt, eval_outputs/…/}
  B/{predictions-standard.jsonl, report.json, eval.log, run-meta.txt, eval_outputs/…/}
  config.toml
  hf-datasets-cache/            # 复评复用的 HF datasets 缓存（HF_DATASETS_CACHE）
  logs/attempt0-hf-revision-socks-proxy.log      # 环境探测失败，仅留证
  logs/attempt1-A-lock-permission-error.log      # 环境失败，仅留证
```

关键 artifact sha256：

| 文件 | sha256 |
|---|---|
| `A/predictions-standard.jsonl` | `cb957add877a5bdffbb9cb236cf117854fd884d0990a923a68a9f37eb5811ffc` |
| `A/report.json`（官方评分） | `e69a248a7d39d12851bbdd834a1a514b9c92e0a575dc4f7d0f8fd3a703f347e7` |
| `A/eval.log` | `b0e78e47c8ce2550bd5160391c0cd4b484ca3de18282926650621c81eea55185` |
| `A/eval_outputs/…/patch.diff` | `54048dd0fdfe5c2a1d10936d87cfef9f0794442efd668e127a813151f3c9ebe8` |
| `A/eval_outputs/…/report.json` | `f52cdb8ee24426b75720cbd82a26cf92f4a2d58a36cd45f1f2f45991c5961d77` |
| `B/predictions-standard.jsonl` | `91f84e31238c5ba21c22ea659fa46781812ce60edf4669e4f093a8f8e428e362` |
| `B/report.json`（官方评分） | `50223c65c8f40b268ebabcdef1b06dd35bff8bcdf9bd7da6650da678af8eb3f5` |
| `B/eval.log` | `1c58d821f3d86e889b47d239bd61de196902e2b9478fc974d83ee054526ae64b` |
| `B/eval_outputs/…/patch.diff` | `5d5f2bd3d3406a1a12d96cc31cf0d5a636d55525519e4bcb37ce6d28a6d7c6b8` |
| `B/eval_outputs/…/report.json`（复评） | `7ada1c723e99d429fa0c207005c48284c4d684cf9d859dfd824611baeaec4c9a` |
| `logs/attempt0-hf-revision-socks-proxy.log` | `fd026283171851e0a2064d2e9a0a77b224e0b268bd645ad5b2e9157937ff6f7f` |
| `logs/attempt1-A-lock-permission-error.log` | `2d2b46b7f36a4cf6c1d92d2debdfc3f9604bbfa5e486b9d3b6d8d070a27cc123` |

原始只读证据：

| 文件 | sha256 |
|---|---|
| A `standard/patch.diff` | `54048dd0fdfe5c2a1d10936d87cfef9f0794442efd668e127a813151f3c9ebe8` |
| A `eval-standard/eval.log`（原始失败日志） | `3f0c10cbc195869dfa27b3d823178145f5ebc2fae03d6371ab7fb6f48e710448` |
| B `standard/patch.diff` | `5d5f2bd3d3406a1a12d96cc31cf0d5a636d55525519e4bcb37ce6d28a6d7c6b8` |
| B `standard/report.json`（原始官方评分） | `d541a14ce945ec551dff5704e864e9316a2e41baab95733a0d910f9d14a10487` |
| B `standard/eval_outputs/…/report.json`（原始逐实例） | `71d0c99c400b379ba7b8e3a0017f987f08411630d241c87363882df85a7050ef` |

## 限制

- 复评在本机（Darwin arm64 + Docker Desktop/Rosetta）执行；第 2、3 条环境修复依赖本 agent
  会话的约束（SOCKS 代理缺 socksio、文件沙箱禁止写工作区外主目录）。按上面命令复跑时需保留
  `env -u all_proxy` 与 `HF_DATASETS_CACHE=/tmp/...`，否则会在数据集加载阶段失败。
- 评分器版本、dataset commit、官方镜像 tag 与历史一致；但镜像是本地导入副本（digest 口径见上），
  不能宣称「字节级可复现」或「严格盲评」。审计级别仍按 review guide 的 L2。
- 复评只回答「这两条历史运行在官方 Grader 下的真实成绩」，不改变样本量限制：每任务每臂 1 次，
  不做显著性宣称，也不能外推为「所有历史 run 可复现」。
- 复评不调用模型、不重跑 agent，因此不涉及 token 成本；但不能用于验证模型服务端行为的变化。
