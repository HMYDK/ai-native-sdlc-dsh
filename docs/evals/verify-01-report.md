# VERIFY-01：基于历史错例优化 `sdlc_verify`（verifier 策略 A/B）

- **对应 issue**：[HMYDK/ai-native-sdlc-dsh#16](https://github.com/HMYDK/ai-native-sdlc-dsh/issues/16)
- **前置依赖**：issue #8（FeatureBench A/B）、#12 EVAL-01（已关闭基线）、#15（verdict 提取范围，未修复，见 §5）
- **分支**：`verify-01`
- **数据**：Step 1 归因见 [verify-01-attribution.md](verify-01-attribution.md)；
  Step 4 机读结果见 [verify-01-experiment-data.json](verify-01-experiment-data.json)；
  预注册清单 `tools/evals/featurebench/manifests/verify-01/verify-01.yml`
- **审计级别**：与 EVAL-01 同为 L2（原始 runs 不入库，只有 hash/聚合数据入索引；本机原始证据在
  `~/.dsh-eval-archive/`，不提交）。

> 状态：**Step 1/2/3 已完成；Step 4 结果见 §7，决策见 §8。**（本文件在实验运行前先固定
> §4 的设计与 §8 的决策规则，避免按结果改口径。）

## 1. 结论摘要

（结果出来后填写：一句话结论 + 决策 保留/回退/继续调查 + 关键分母。）

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

## 5. 与 #15 / 历史数据的关系

- #15 的两项修复（tool-call 范围提取、canonical patch hash 对账）未在 issue #16 内实现；本报告使用
  callId 配对重算并逐案例与 canonical 交叉核对。
- 历史原始 runs 在本机 L2 归档，入库存 hash/聚合；离开归档不能完整重放 Step 1 的证据链。

## 6. 环境与评分链路证据（AC-005 前置）

- 0 模型 control（官方评分链路）：gold 补丁 resolved=1 / empty 补丁 resolved=0（修复输出目录碰撞后重跑）。
- pilot（非预注册、不计指标）：一个历史已 resolved 的 seaborn 任务，验证容器/驱动/模型/官方评分
  端到端可用。
- 两臂 tarball 差异已用解包 diff 证明：除 `lib/verify/verdict.js` 外逐字节相同。

## 7. Step 4 结果（AC-005 / AC-006）

（运行完成后填写：逐 run 表 + 配对表 + 成本/失败分类 + 分母；机读数据见
[verify-01-experiment-data.json](verify-01-experiment-data.json)。）

## 8. 决策（AC-008）

（按 §4.3 预先固定的规则填写：保留 / 回退 / 继续调查，并说明是否伴随不可接受的误拒、
弃判或成本增长。）

## 9. 限制与未覆盖

- 每任务每臂 1 rep、独立任务 n=3：只描述方向，不做显著性宣称，不外推到其他任务/模型。
- B 的改进目标是对齐官方评分，不是提升 resolved；官方隐藏 F2P 文件在 agent 运行期不可见。
- M1 的根因是 benchmark 任务说明不完整（官方 F2P 要求超出 Interface Description）；
  仅改 verifier prompt 不能修复任务数据。若 benchmark 期望任务可解，需修任务数据。
- 模型服务端实际版本不可观测；无随机种子；单时间窗；Windows 未覆盖。
- 诊断任务来自历史 run（同 task 复现），不能算"未参与调优的独立任务"；独立任务只用于方向性对照。
- 原始 runs/session 含 prompt，不入库；L2 审计级别。

## 10. 复跑

```bash
# Step 1 归因（只读本机归档；需要 zstandard）
~/.local/share/uv/tools/featurebench/bin/python tools/evals/verify01/attribute_cases.py --pretty

# Step 4 聚合（只读 runs 目录，不调模型）
~/.local/share/uv/tools/featurebench/bin/python tools/evals/verify01/summarize_ab.py \
  --runs-root <runs-root> --out docs/evals/verify-01-experiment-data.json \
  --md docs/evals/verify-01-experiment.md

# 数据结构检查（CI 同款，不调模型）
python3 tools/evals/featurebench/sanity_check.py --structural
python3 tools/evals/featurebench/sanity_check.py --index
python3 tools/evals/featurebench/audit_runs.py --check
python3 tools/evals/featurebench/reaggregate.py --check
python3 tools/evals/featurebench/check_redaction.py
```
