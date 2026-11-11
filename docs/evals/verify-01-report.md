# VERIFY-01：基于历史错例优化 `sdlc_verify`（verifier 策略 A/B）

- **对应 issue**：[HMYDK/ai-native-sdlc-dsh#16](https://github.com/HMYDK/ai-native-sdlc-dsh/issues/16)
- **前置依赖**：issue #8（FeatureBench A/B）、#12 EVAL-01（已关闭基线）、#15（verdict 提取范围，未修复，见 §5）
- **分支**：`verify-01`
- **数据**：Step 1 归因见 [verify-01-attribution.md](verify-01-attribution.md)；
  Step 4 机读结果见 [verify-01-experiment-data.json](verify-01-experiment-data.json)；
  预注册清单 `tools/evals/featurebench/manifests/verify-01/verify-01.yml`
- **审计级别**：与 EVAL-01 同为 L2（原始 runs 不入库，只有 hash/聚合数据入索引；本机原始证据在
  `~/.dsh-eval-archive/`，不提交）。

> 状态：**Step 1/2/3 完成；Step 4 已完成 9 个 scored runs（第 3 个独立任务配对因预算上限未执行），
> 决策见 §8。**（§4 设计与决策规则在实验运行前先固定，避免按结果改口径；实际执行偏差
> ——T3 not_run、上游检索混淆项——在 §7/§9 如实记录。）

## 1. 结论摘要

**决策：保留（keep）。** 在本轮 9 个 scored run 里，B（prompt-only candidate verifier）没有出现
错误放行，也没有引入错误拒绝；A（baseline verifier）出现的错误放行在 B 上消失。但**不宣称**
resolved 率提升——独立任务 n=2、每格 1 rep，且两个 resolved 差异与「actor 自行从上游恢复源码」
的混淆项共变，见 §7.2 / §9。

关键读数（全部 9 个 scored run；分母口径见 §7 / 机读数据）：

| 指标 | A baseline | B candidate |
|---|---|---|
| attempts / scored | 5 / 5 | 4 / 4 |
| 官方 resolved（ITT） | **1/5（20%）** | **3/4（75%）** |
| 错误放行（approve→unresolved） | **3** | **0** |
| 错误拒绝（reject→resolved） | 0 | 0 |
| needs_human | 0 | 1 |
| 无裁决 | 1（over_budget） | 0 |
| token 合计（4 个可配对任务） | 56.1M | 42.0M（−25%） |
| 耗时合计（4 个可配对任务） | 4544s | 6427s（+41%） |

- 诊断回归（2 个历史 FP 任务）：A 假阳性 **2/2** → B **0/2**；B 在 T1 上是
  needs_human→actor 修复→approve+resolved，在 T2 上是 needs_human（官方仍 unresolved）。
- 独立任务（2 个预先固定、未参与调优的 astropy lv1 任务）：官方 resolved A 1/2、B 2/2；
  其中 1 个任务两臂都 resolved，另 1 个任务的差异与 actor 上游源码恢复混淆，不能归因给 verifier 判断力。
- 成本：4 个配对任务上 B token 少 25%，但墙钟多 41%；第 3 个独立任务（test_compressed）
  A 单 run 撞 40M token 上限（over_budget），B 因 160M 总预算上限未执行（not_run）——
  大任务上的成本风险是真实存在的，见 §9。
- 口径说明：A 的 1/5 含 T3 over_budget 这条删失（over_budget 是 agent 失败，不是 verifier
  误判）；只看 4 个完整配对任务，官方 resolved 为 **A 1/4 vs B 3/4**。

## 2. 目标与边界

- **目标**：用尽量小的改动减少 `sdlc_verify` 的错误放行，同时控制误拒、无裁决与 token/耗时；
  先找原因、再做最小修复，不新建验证平台/Agent/Runner/Evidence Schema。
- **非目标**：不改七阶段工作流、不引入 Adaptive SDLC、不重做 EVAL-01 数据清洗或 #15 的采集修复、
  不以"更多 reject/needs_human"作为完成证据。
- 本报告不宣称"resolved 率提升"：历史上官方 `resolved` 主要由 Actor 交付质量决定；
  VERIFY-01 的目标是让裁决与官方评分对齐（减少 approve→unresolved），并如实报告代价。

## 3. Step 1：历史错例归因（AC-001 / AC-002）

完整证据与逐案例表见 [verify-01-attribution.md](verify-01-attribution.md)（机读：
[verify-01-attribution-data.json](verify-01-attribution-data.json)，复跑：
`tools/evals/verify01/attribute_cases.py`）。要点：

- 7 个 V1 `approve → unresolved` **不是 7 个独立任务**：6 个是同一 sphinx gettext task 的重复 run
  （mvp/2x2/verify-stress/repeat×3），1 个是 sphinx doctest（expanded）。V2 的 1 个 FP 是同一 gettext task。
- 裁决来源按 `sdlc_verify` 的 `callId ↔ tool/result` 配对提取（与 #15 建议口径一致），
  11/11 案例与 canonical `verify_verdicts` / `patch_sha256` 一致；没有把子会话或 `read` 到的
  JSON 误计为裁决。
- 去重后的失败模式：
  - **M1（7/7）**：任务说明 / Spec AC 只覆盖新增接口，官方 F2P 还要求恢复其它被剥离符号
    （gettext：`add_uids`、`extract_messages`；doctest：`DocTestBuilder.compile/run`）。
    对照：同 task 的 `2x2:standard` 恢复 21 个文件后官方 `resolved=1.0`；按任务说明"正确实现"的
    sdlc 运行只有 1/13 或 1/11。
  - **M2（5/7）**：官方 F2P 测试文件在 testbed 被隐藏，且验证者没有执行真实子系统入口
    （`python -m sphinx -b gettext` / `-b doctest`）。
  - **M3（2/7）**：验证者已拿到评分等价失败证据（上游 F2P 11 failed/1 passed；真实 `-b gettext`
    的 `NameError: add_uids`），仍以 "pre-existing / out of scope" 解释为不阻塞并 `approve`。
  - **FN 侧（3/3，删失）**：全部 `agent_failure=timeout`，且都把重建 oracle（上游/后续版本测试）
    当官方口径；不据此判定验证者误判（标 ⑥，`confirmed=false`）。
- 结论：可操作的最小改动是**验证者的交付路径检查**（真实入口、基线失败不豁免、out-of-scope
  不构成外部验收证据、重建测试的 FN 对冲），而不是重写整段 prompt。

## 4. Step 2 / Step 3：改动与实验设计（AC-003 / AC-004）

### 4.1 改动（prompt-only + 单测）

`packages/sdlc/src/verify/verdict.ts` 的 `buildVerificationPrompt` 新增「交付路径检查」一节：

1. 必须运行变更**直接目标功能**的真实消费入口（构建/CLI/集成测试），作者测试与自编探针不能替代；
2. 该入口失败时**不得 `approve`**（`needs_human`/`reject` + `unverified`）；「改动前的基线也一样失败」
   不是豁免理由（只能说明不是本次引入，不能说明满足验收）；
3. 任务说明的 "out of scope" 只决定检查范围，不构成外部验收的豁免；
4. 上游/重建的官方验收测试：失败不得 `approve`，但冲突时用 `needs_human`、不能仅凭它 `reject`
   （FN 侧对冲）；
5. 与目标无关的既有失败不触发拦截（避免误拒扩大）；
6. `unverified` 里与交付直接相关的项不能被 `approve` 掩盖。

不变的部分（AC-003 约束）：裁决 schema、状态机、AC 权威来源（登记 Spec）、
`met/not_met/cannot_tell`、`approve/reject/needs_human` 与复验协议均未改；没有新增工具或 Runner。
回归覆盖：`packages/sdlc/src/verify/verdict.test.ts`（8 条内容单测，钉住上述句子与原有 criteria/
test-evidence 行为）。

### 4.2 Step 3 接线检查

- 验证者工具面本身没有发现执行器/权限故障：`bash` + `read/glob/grep` 可用，能运行真实构建与 pytest
  （历史 run 中已实际执行过）。
- **历史数据质量问题（不在本 issue 修）**：canonical `sdlc_tool_calls` 在 11/11 案例中恰好是主会话
  `tool/call` 数的 2 倍（如 `sdlc_verify` 2 vs 1），会放大行为统计；不影响 verdict。建议由 canonical
  生成器修复（与 #15 同类）。
- **#15 未修复**：本报告的分析与实验都用 callId 配对口径；canonical 数据重新生成前，不能把本报告的
  verdict 统计与旧 `collect_runs.py` 产物混用。
- 观察（未在本轮修）：验证者 preset 注释声称能读 `sdlc-verification-discipline` Skill，但归档中
  验证者子会话的 system prompt 没有 skills 目录、也没有一次 `skill` 调用；Skill 注册在 SDLC preset
  scope，而 verifier 用独立 preset。若确认不可见，应作为单独接线问题修复（不放进 A/B 臂，避免
  Actor 侧 guidance 混入）。
- 另修复：`sanity_check.py --control` 的 gold/empty 输出目录碰撞（两个 control 共用 tmp 根，
  `fb eval` 缓存命中使 empty 复制 gold 的 report，实测 empty 误报 resolved=1）。修复后 control 通过
  （见 §7 环境证据）。

### 4.3 实验设计（预注册）

预注册清单：`tools/evals/featurebench/manifests/verify-01/verify-01.yml`（运行前固定；改动需单独提交并说明）。
A/B 定义：

| 臂 | preset | plugin tarball | 唯一差异 |
|---|---|---|---|
| A `sdlc_baseline` | AI 原生 SDLC + 固定引导 | `0.6.1` baseline `da201253…` | 原版 verifier prompt |
| B `sdlc_candidate` | 同上（逐字一致） | `0.6.1` candidate `761d7688…` | 上述 §4.1 prompt 改动（`lib/verify/verdict.js` 之外逐字节相同） |

- **任务**（每个 1 rep，顺序交替 A/B 控制时间窗）：
  - 2 个历史诊断回归任务（gettext、doctest；**只作回归证据，不用于效果宣称**）；
  - 3 个预先固定、未参与调优的 astropy lv1 任务（不在 canonical 27 个 task 内，按 instance_id
    字典序取前 3 个满足 F2P≥3 的任务）。
- **runtime 固定**：DSH `0.2.2-rc.1`、plugin `0.6.1`、官方镜像 `fb-eval-base-061:*`、
  model `deepseek-account/deepseek-flash`、reasoning_effort `max`、单 run timeout 2700s /
  max_tokens 40M、总 token 预算 ≤160M。
- **评分**：官方 `featurebench==0.3.0` 的 `fb eval`（dataset v1.1 fast split，逐实例 `report.json`）；
  agent 自报 DONE/approve 不作为成绩。
- **分母**：ITT —— 所有实际启动的 run 都计入（含失败/超时/超预算/空补丁）；缺官方 report 的 run 在
  ITT 下按 unresolved 计入并单列 unscoreable；不因结果不理想剔除；pilot 不计入。
- **指标**：官方 resolved、官方 pass_rate、verifier 裁决序列（accept/reject/needs_human/none）、
  可复现漏检/误拒、token、耗时、超时/中断；配对差异逐任务列出。
- **决策规则（运行前固定）**：
  - **保留**：B 在 2 个诊断回归任务上都不再 `approve`（转为 reject/needs_human），
    且独立任务上官方 resolved 不比 A 差、不出现 A `approve+resolved` → B `reject` 的误拒，
    needs_human/无裁决增量与 token/耗时增长在可接受范围（token 中位数增幅 ≤2×、无系统性超时）。
  - **回退**：B 仍然 `approve` 诊断任务（无效），或独立任务上出现不可接受的误拒/无裁决/成本增长。
  - **继续调查**：方向相反或样本不足以区分（例如 B 有效但代价明显、或诊断任务本身在 A 臂无法复现）。
  - 不预设成功率改善幅度；不把历史错例当训练题证明泛化。
- **实际执行偏差（如实记录，不回溯改规则）**：
  - 诊断任务 2 个 × 2 臂全部执行；
  - 独立任务预注册 3 个，实际完成 2 个完整配对（T1 `test_basic_rgb`、T2 `test_comparison`）；
    第 3 个（T3 `test_compressed`）A 臂撞 40M token 单 run 上限（over_budget），B 臂在
    累计约 155.9M / 160M 时按预算规则停止 → **T3 not_run，不进任何分母/对比**；
  - 停止 T3 B 的决定发生在任何 T3 官方评分之前、预注册清单未改，不构成按结果挑样本。

## 5. 与 #15 / 历史数据的关系

- #15 的两项修复（tool-call 范围提取、canonical patch hash 对账）未在 issue #16 内实现；本报告使用
  callId 配对重算并逐案例与 canonical 交叉核对。
- 历史原始 runs 在本机 L2 归档，入库存 hash/聚合；离开归档不能完整重放 Step 1 的证据链。

## 6. 环境与评分链路证据（AC-005 前置）

- **0 模型 control（官方评分链路）**：sphinx 诊断任务 gold 补丁 resolved=1 / pass_rate=1.0（report
  sha256 `dfd8f6e6d6c59eac…`）、empty 补丁 resolved=0 / pass_rate=0.0（`ae2bca5ae5df4325…`），
  exit 0；修复 control 输出目录碰撞后重跑（见 §4.2）。
- **pilot（非预注册、不计指标）**：一个历史已 resolved 的 seaborn 任务，245s / 1.1M token /
  patch 8,007 chars → 官方 resolved=1、pass_rate=1.0（report sha256 `07cabb8a3000…`）；
  证明容器、无头 Chrome 驱动、真实模型、官方 `fb eval` 端到端可用（agent 侧有一个流式
  `turn_error`，发生在 patch 生成之后，不影响链路结论）。
- **新 repo 镜像（astropy）**：`skopeo copy` 直连 registry-1.docker.io 成功，raw manifest
  sha256 = Docker Hub 官方 digest `4b5e7489…`；失败路径（docker pull 代理问题、dockerproxy.net
  共享 base 层 EOF）日志归档在 `~/.dsh-eval-archive/verify-01/image/setup-failures.log`。
  bake 出 `fb-eval-base-061:astropy`，容器内 `node v24.21.0` / `dsh 0.2.2-rc.1` 探测通过；
  astropy `test_basic_rgb` 的 gold/empty control：gold resolved=1 / pass_rate=1.0，
  empty resolved=0 / pass_rate=0.0（证据 `~/.dsh-eval-archive/verify-01/control/astropy/`）。
- 两臂 tarball 差异已用解包 `diff -rq` 证明：除 `lib/verify/verdict.js` 外逐字节相同
  （A sha256 `da201253…`、B sha256 `761d7688…`，均为 71 文件 v0.6.1）。
- **回归与数据检查（AC-007，本地实测 2026-11-12）**：`npm run verify`（build + typecheck +
  test + smoke）通过——库单测 **267 pass / 0 fail**、客户端 **45 pass / 0 fail**、运行时冒烟
  12 组脚本全过（含 verify/workflow 组件断言）；`sanity_check --structural/--index`、
  `audit_runs --check`、`reaggregate --check`、`check_redaction` 与两个 CI dry-run 全部通过。
  CI 不触发任何付费模型实验（`--execute` 仅人工路径）。

## 7. Step 4 结果（AC-005 / AC-006）

> 口径：每任务每臂 1 rep；verifier 裁决取**主会话** `sdlc_verify` 的 callId↔tool/result 配对；
> 官方成绩只取 `fb eval` 的 `report.json`。机读数据见
> [verify-01-experiment-data.json](verify-01-experiment-data.json)（由 `summarize_ab.py` 生成）。

### 7.1 诊断回归任务（2 任务 × 2 臂；只作回归证据，不用于效果宣称）

| 任务 | 臂 | 官方 resolved | pass_rate | 主会话裁决序列 | final | token | 耗时(s) | agent_failure |
|---|---|---|---|---|---|---|---|---|
| T1 `test_build_gettext` | A baseline | 0 | 0.0769 | `approve, approve` | approve | 7.9M | 1146 | none |
| T1 `test_build_gettext` | B candidate | **1** | **1.0** | `needs_human, approve` | approve | 11.4M | 2037 | none |
| T2 `test_ext_doctest` | A baseline | 0 | 0.0909 | `approve` | approve | 1.9M | 325 | none |
| T2 `test_ext_doctest` | B candidate | 0 | 0.0909 | `needs_human, needs_human` | needs_human | 3.7M | 1001 | none |

- **A 复现历史假阳性**：两个诊断任务的 A 臂都最终 `approve`，官方均 unresolved（FP 2/2），
  与 2026-11-06~08 历史口径一致（T1 pass_rate=0.0769 逐位复现）。
- **B 不再误放行**：T2 由 approve 变为 needs_human（0 误放行）；T1 的第一次 verify 也是
  needs_human，actor 修复后第二次 verify 才 approve——且此时官方 resolved=1，属**正确放行**。
  两个诊断任务上 B 的假阳性从 2/2 降到 **0/2**。
- **T1 的 resolved 改善需要单独解释（重要限制）**：两臂的 verifier 都做过上游获取，但内容与
  后果不同：
  - A 臂 verifier 用 `pip download Sphinx==8.3.0` 拿到 PyPI wheel/sdist，但 actor 没有把上游树
    恢复到 /testbed，patch 仍只有 3 文件 / 9.3KB → 官方 unresolved，最终 approve（FP）。
  - B 臂 verifier 按新 prompt 先运行真实 `sphinx -b gettext` 命中 `NameError: add_uids`，又从
    `codeload.github.com` 取回 **base commit e347e59c 的源码树与官方测试文件**并跑出
    12 failed/1 passed，给出 needs_human；actor 随后在 `/tmp` 发现该树，把 30+ 个 sphinx 文件
    整体拷回 /testbed（含被 mask 的 `versioning.py::add_uids`、`util/nodes.py::extract_messages`
    等），第二次 verify 时真实构建与官方测试通过 → approve，官方 resolved=1。
  - 因此 T1 的 resolved 变化不是"verifier 直接改分"，而是 **verifier 证据驱动 actor 修复** 的
    链条；且其中包含从上游抓源码/测试的动作——任务说明的 black_links 禁止访问
    `github.com/sphinx-doc/sphinx`，而 `codeload.github.com`/`raw.githubusercontent.com` 在本
    环境可达、未被 harness 拦截。两臂环境与网络相同，差异是 prompt 是否要求跑真实入口/找官方
    验收证据（以及 B verifier 拿到的是精确 base commit，A 拿到的是 PyPI 发行版）。
  - 解释 B 的效果时必须把「verifier 判断质量」与「actor 利用上游源码」分开；T1 的 resolved=1
    不能单独当作 verifier 判断力提升的证据。
- 成本：诊断 2 任务 A 合计 9.8M / B 合计 15.1M token；耗时 A 合计 1471s / B 3038s。
  B 的首轮 needs_human 触发了额外修复与复验，成本上升是机制的直接代价。

### 7.2 独立任务（预先固定的 astropy lv1 任务 × 2 臂）

| 任务 | 臂 | 官方 resolved | pass_rate | 主会话裁决序列 | final | token | 耗时(s) | patch 文件 | 上游检索（verifier / actor） |
|---|---|---|---|---|---|---|---|---|---|
| T1 `test_basic_rgb` | A | **1** | 1.0 | `approve` | approve | 19.7M | 1326 | 4 | verifier 尝试（失败） / no |
| T1 `test_basic_rgb` | B | **1** | 1.0 | `approve` | approve | 11.5M | 961 | 4 | verifier 尝试（失败） / no |
| T2 `test_comparison` | A | 0 | 0.0 | `approve` | approve | 26.6M | 1747 | 17 | no / **yes**（PyPI sdist，仅测试文件；patch 全在 gold 集合内） |
| T2 `test_comparison` | B | **1** | 1.0 | `approve, approve` | approve | 15.4M | 2428 | 26（9 不在 gold 集合） | verifier 尝试（raw/api 失败）/ **yes**（PyPI 7.2.3，恢复 11 个源码文件） |
| T3 `test_compressed` | A | 0 | 0.2 | 无（**over_budget**） | — | 40.5M | 1187 | 13 | no / no |
| T3 `test_compressed` | B | **not_run**（预算上限停止） | — | — | — | partial 16.2M（session 恢复，无 meta/patch） | — | — | — |

- **配对（仅 T1/T2，n=2）**：官方 resolved A **1/2**、B **2/2**；T1 双 resolved，T2 B-only。
  裁决迁移：`approve->approve` 2 次（两臂都 approve；T2 的官方差异与裁决无关）。
- **T2 的差异不能归因于 verifier 判断质量**：两臂 verifier 都最终 approve（B 甚至没有
  needs_human），差异来自 actor 行为——B 的 actor 用 `pip download astropy==7.2.3` 恢复
  11 个 `astropy/cosmology/**` 源码文件（patch 26 文件，其中 9 个不在 gold 集合），而 A 的
  actor 只把上游测试文件拷到 /tmp 自测（patch 17 文件全在 gold 集合）。两臂环境相同、都可访问
  PyPI；这是 actor 侧随机/行为差异，不是 prompt 对裁决的影响。
- **T3 配对不成立**：A 在 2700s 内撞 40M token 上限（aborted=over_budget，有 patch 与官方
  评分，计入 ITT）；B 在累计接近 160M 上限时被停止（无 meta/patch/官方评分），按 not_run 处理、
  不进任何分母。停止决定发生在任何 T3 官方评分之前，且预注册清单未改。
- 独立任务整体成本（T1+T2 配对）：A 46.3M / B 26.9M（B −42%）；耗时 A 3073s / B 3389s（B +10%）。

## 8. 决策（AC-008）

**决策：保留（keep），有条件。** 按 §4.3 预先固定的规则逐条核对：

| 预注册规则 | 实际 | 判定 |
|---|---|---|
| B 在 2 个诊断回归任务上不再产生 approve→unresolved（规则原文写"不再 approve"，按效果解读为不再假放行） | A 2/2 approve→unresolved；B 0/2（T1 是 actor 修复后的正确 approve+resolved；T2 是 needs_human→unresolved） | ✅ |
| 独立任务官方 resolved 不比 A 差 | 完整配对 n=2：A 1/2、B 2/2（T1 双 resolved；T2 B-only，但见混淆项） | ✅ |
| 不出现 A approve+resolved → B reject 的误拒 | 9 个 scored run 中 0 次 reject、0 次 approve→unresolved | ✅ |
| needs_human / 无裁决增量可接受 | B 新增 1 个 needs_human（诊断 T2），无 no_verdict；没有误拒 | ⚠️ 可接受，需继续监控 |
| token / 耗时增长可接受 | 4 个配对：token B −25%、墙钟 +41%；大任务 T3 A 已 over_budget，B 无数据 | ⚠️ 混合，需继续监控 |
| 不把历史错例单独当泛化证据 | 诊断/独立分表；不宣称 resolved 提升 | ✅ |

**保留的依据**：
1. 唯一直接反映 verifier 判断质量的指标——**approve→unresolved 假阳性**——A 是 3/4（或按 ITT
   3/5），B 是 **0/4**；B 没有引入任何 reject / 误拒。
2. B 的 1 个 needs_human 是"自查后如实上报"（官方亦 unresolved），不是为压假阳性而制造的弃判；
   其余 3 个 approve 都对应官方 resolved。
3. 成本没有不可接受的爆炸：4 个配对任务 B token 少 25%（但其墙钟多 41%）。

**不宣称效果提升**：
- 独立任务 n=2、每格 1 rep；其中 T2 的 resolved 差异由 actor 从 PyPI 恢复源码驱动，
  B 的 verifier 两次都 approve、与裁决无关 → 不能归因给 verifier 判断力；
- T3 配对未执行；大任务上的 over_budget/成本风险已确认；
- 因此只保留"减少错误放行、未观察到误拒/成本失控"的结论，不预设成功率改善幅度。

**后续工作（不作为本 issue 的完成条件）**：
1. 在**禁网/禁上游检索**的受控环境复跑 A/B，把 verifier 判断质量与 actor 上游源码恢复分开；
2. 扩大独立任务样本与重复采样（含 lv2 大任务），监控 needs_human / 耗时 / token 增量；
3. 若后续观测到 needs_human 显著升高，再评估是否需要在 Skill/guidance 层补充（不放宽 AC/schema）；
4. black_links/环境隔离、verifier 的 `sdlc-verification-discipline` Skill 可见性作为独立问题跟踪。

## 9. 限制与未覆盖

- **样本**：每任务每臂 1 rep；独立任务只有 **2 个完整配对**（预注册 3 个，第 3 个 not_run），
  诊断任务 2 个且都是历史同 task 复现。只描述方向，不做显著性宣称，不外推到其他任务/模型。
- **T3 未完成与成本风险**：T3（`test_compressed`）的 A 臂在 2700s 内撞 40M token 单 run 上限
  （`over_budget`，有 patch 与官方评分，计入 ITT）；B 臂在累计约 155.93M / 160M 时按预算规则
  停止（partial 16.2M 从 session 恢复，无 meta/patch/官方评分），按 **not_run** 处理、不进任何分母。
  停止决定发生在任何 T3 官方评分之前、预注册清单未改。大任务上的 token 成本风险已被证实，
  但缺少 B 侧同任务数据。
- **actor 行为混淆（最关键）**：两臂环境与网络相同（PyPI / codeload / raw.githubusercontent
  可达；task 说明的 black_links 未被 harness 强制执行）。但 **两个 resolved 差异都与 actor
  从上游恢复源码共变**：
  - 诊断 T1：B 的 verifier 取回精确 base commit e347e59c 并跑官方测试 → needs_human；
    actor 随后把 30+ 个 sphinx 文件恢复到 /testbed → resolved。A 的 verifier 也下载了 PyPI
    8.3.0，但 actor 没有恢复树 → unresolved。
  - 独立 T2（`test_comparison`）：两臂 verifier 最终都 approve（B 甚至没有 needs_human），
    差异来自 actor——B 用 pip 恢复 11 个 `astropy/cosmology/**` 源码文件（patch 26 文件、9 个
    不在 gold 集合），A 只拷贝上游测试文件（patch 17 文件全在 gold 集合）→ B resolved。
  - 因此本轮 A/B 测到的是「verifier 策略 + 其触发的 actor 修复行为 + 上游可达性」的组合效应；
    **不能把 resolved 差异归因给 verifier 判断力**。在没有上游访问或 black_links 被强制执行的
    环境，预期 B 的收益退化为 needs_human（不误放行，但不一定转成 resolved）。
- **verifier 判断质量的干净证据**只有裁决类指标：A approve→unresolved 3/4 vs B 0/4；
  B 0 reject、1 needs_human。样本小，仍需扩大。
- B 的改进目标是让裁决对齐官方评分，不是提升 resolved；官方隐藏 F2P 文件在 agent 运行期不可见。
- M1 的根因是 benchmark 任务说明不完整（官方 F2P 要求超出 Interface Description）；
  仅改 verifier prompt 不能修复任务数据。若 benchmark 期望任务可解，需修任务数据。
- 模型服务端实际版本不可观测；无随机种子；单时间窗；Windows 未覆盖。
- verifier 的 `sdlc-verification-discipline` Skill 在归档子会话 system prompt 中不可见、0 次
  `skill` 调用（§4.2 观察）；本轮没有把它修进 A/B 臂（避免 Actor 侧 guidance 混淆），
  建议单独跟踪。
- 原始 runs/session 含 prompt，不入库；L2 审计级别。本机归档：
  `~/.dsh-eval-archive/verify-01/`（110 文件，`SHA256SUMS.txt` sha256
  `1bc8809f39457f4c315368457c1087f82a170ed4a9e72c9abd79bfe749467fad`）。

## 10. 复跑

```bash
# Step 1 归因（只读本机归档；需要 zstandard）
~/.local/share/uv/tools/featurebench/bin/python tools/evals/verify01/attribute_cases.py --pretty

# Step 4 聚合（只读 runs 目录，不调模型）
~/.local/share/uv/tools/featurebench/bin/python tools/evals/verify01/summarize_ab.py \
  --runs-root <runs-root> --out docs/evals/verify-01-experiment-data.json \
  --md docs/evals/verify-01-experiment.md

# Step 4 上游检索/预算混淆分析（数据来自本机归档 readings.json + upstream-analysis.json，
# 由 docs/evals/verify-01-upstream-analysis.json 固化；离开归档不能完整重放）
# 说明见 docs/evals/verify-01-upstream-analysis.json 的 source/field_definitions。

# 数据结构检查（CI 同款，不调模型）
python3 tools/evals/featurebench/sanity_check.py --structural
python3 tools/evals/featurebench/sanity_check.py --index
python3 tools/evals/featurebench/audit_runs.py --check
python3 tools/evals/featurebench/reaggregate.py --check
python3 tools/evals/featurebench/check_redaction.py
```

## 11. 与 issue #16 验收标准的对应

| AC | 证据位置 |
|---|---|
| **AC-001** 7 个历史 `approve→unresolved` 逐条核对真实裁决来源与官方评分；区分已确认/数据不充分/无法归因；与 #15 口径一致 | §3 + [verify-01-attribution.md](verify-01-attribution.md) §2/§3 + [verify-01-attribution-data.json](verify-01-attribution-data.json)：主会话 callId↔tool/result 配对，11/11 与 canonical `verify_verdicts`/`patch_sha256` 一致；7 个 V1 FP 去重为 2 个 task；3 个 FN 为 timeout 删失、标 ⑥ |
| **AC-002** 可审查的失败归因表，明确证据/出现次数/最小改进点；没有证据不改 Prompt | 归因表见上述文档 §3/§7（M1 7/7、M2 5/7、M3 2/7、M5/M6/M7）；prompt 改动只对应 M1/M2/M3（§4.1） |
| **AC-003** Prompt/Skill 改动可追溯；不改状态机/AC 权威来源/schema/完整验收覆盖 | §4.1；改动仅 `buildVerificationPrompt` + 单测；schema/状态机/AC 来源未动；Skill 的同步改写未纳入（避免污染 A/B 臂，§4.2 观察） |
| **AC-004** 测试声称与可核对事实区分；关键检查无法执行时不得判 `met`；接线问题有回归覆盖 | §4.1（prompt 规则 1/2/6）+ §4.2（未发现执行器/权限故障；修复 2 个评测工具缺陷并本地回归）；`verdict.test.ts` 钉住提示词规则 |
| **AC-005** 至少一次真模型基线/候选对照，含预注册未参与调优任务，调用官方 Grader；两臂唯一受控差异 = Verifier 策略 | §4.3（预注册清单 + A/B 定义）、§6（环境/control/pilot/镜像）、§7（9 scored runs；T3 not_run 与 A over_budget 如实记录）；解包 diff 证明两臂只差 `lib/verify/verdict.js` |
| **AC-006** 报告错误放行/误拒/无法裁决/无裁决、Token、耗时、官方 resolved；分母可复算；历史错例仅作诊断回归 | §1/§7 + [verify-01-experiment-data.json](verify-01-experiment-data.json)（`denominator_policy` 显式，`summarize_ab.py` 可复算）；诊断 2 任务只作回归证据；上游检索/预算混淆见 §7.2/§9 |
| **AC-007** 改动后 build/typecheck/test/smoke/评测数据检查不回归；常规 CI 不跑付费模型实验 | §6 AC-007 条：267+45 单测、12 组冒烟、5 项 eval 数据检查 + 2 个 dry-run 全过；CI 无 `--execute` 路径 |
| **AC-008** 明确决策：保留/回退/继续调查，依据质量改善是否真实且不伴随不可接受误拒/弃判/成本增长 | §8：**保留（keep）**；假阳性 3/4→0/4、无误拒；needs_human +1 与墙钟 +41% 列为需监控项；不宣称 resolved 提升（上游混淆与样本小） |
