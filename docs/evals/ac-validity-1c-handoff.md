# #22 / AC-VALIDITY-1C 交接包（另一台机器执行）

- **生成时间**：2026-11-15
- **生成位置**：作者机器（本机）；本机**没有**执行 Phase 0/1/2，没有跑付费模型、没有安装 `featurebench`、没有拉取官方镜像、没有恢复归档。
- **目标读者**：另一台已经具备 Docker 官方镜像与 `~/.dsh-eval-archive` 的机器上的 agent / 维护者。
- **用途**：让执行机器在不重新讨论目标的前提下接手 #22，知道已经确认什么、环境有什么、下一步做什么、哪些事不能做。

---

## 1. 一句话

#22 要用独立证据判定：**「Delivery Contract（#20）+ Verifier 充分性审查（#21）」是否真的减少了「`approve` 但原始用户目标未交付」，同时没有把误拒、`needs_human`、无裁决、Token/墙钟和返工成本推高。** 官方 FeatureBench `resolved` 只是旁证，不是用户目标本身。

---

## 2. 当前基线

- 仓库：`HMYDK/ai-native-sdlc-dsh`
- 分支：`dev`
- 交接时基线：`90e48ce`（PR #25 合并后；本交接提交在其后，用 `git log -1 -- docs/evals/ac-validity-1c-handoff.md` 确认）
- #20（Delivery Contract）与 #21（Verifier 消费契约）已合并到 `dev`。
- `AC-VALIDITY-1B` 已完成（DONE），最终独立复验 `8e6c63ee` approve，AC-001..AC-006 全 `met`。
- #22 仍 OPEN；Phase 0 已获准，Phase 1/2 付费未授权。
- 本任务 `AC-VALIDITY-1C` 是**草稿**：目录 `.ai/tasks/AC-VALIDITY-1C/`，状态 `INTENT`，已有 intent/spec/plan，**未验证、未 DONE**。执行机器可以继续它，也可以按本交接重建；不要把它当作已完成任务。
- 关键材料：
  - [#22 方案评论](https://github.com/HMYDK/ai-native-sdlc-dsh/issues/22#issuecomment-6891752451)
  - [维护者 2026-11-15 确认](https://github.com/HMYDK/ai-native-sdlc-dsh/issues/22)
  - [历史基线](docs/evals/featurebench-baseline.md)、[VERIFY-01 报告](docs/evals/verify-01-report.md)
  - [#21 离线反例](docs/evals/ac-validity-1b-counterexamples.md)
  - [FeatureBench 工具说明](tools/evals/featurebench/README.md)
  - [预注册模板](tools/evals/featurebench/manifests/verify-01/verify-01.yml)

---

## 3. 已确认决策（除非有新证据，不要重开）

| 决策 | 结论 |
|---|---|
| Phase 0 | 已授权；不调用付费模型、不安装大型依赖、不拉镜像；先交付 case table、离线 fixture、预注册、预算、交接。 |
| 首轮模型 | `deepseek-flash`；A/B 必须固定同一 route/model/参数。 |
| Phase 1 | 固定 #21 场景 **1/2/3**（正向通过、明确缺口、范围外独立失败）× 2 臂；6 次 verifier 调用；≤8M Token / 2h；单次 ≤2M。 |
| Phase 2 主实验 | A vs B2；3 个新任务 + 2 个历史诊断任务；≤120M Token / 8h。 |
| Phase 2 消融 | B1（只有 #20、旧 Verifier）条件性消融；触发阈值由 Phase 0 起草、Phase 2 前批准；B1 另批 ≤30M / 2h。 |
| 独立任务 | **新 repo + 新任务**；不复用 VERIFY-01 已用过的 astropy 3 任务；Phase 0 提出候选并报告镜像体积，不直接拉取。 |
| 人工 gold label | 由审查者最终核对；必须独立于 A/B Actor 生成的 Spec/Delivery Contract/Verifier 裁决。 |
| 历史归档 | 另一台机器有 `~/.dsh-eval-archive`；切换后核对并用于历史案例 raw 证据。 |
| 环境 | 在另一台有镜像的机器执行；本机不安装/不拉镜像。 |
| Phase 0 交付 | 建 `AC-VALIDITY-1C` 任务 + 文档/案例表/manifest；按维护者要求**直接提交到 `dev`**（若分支保护阻止，停下报告，不要绕过）。 |

---

## 4. 环境与数据（执行机器）

### 4.1 需要确认可用

- Docker 可运行 `linux/amd64` 容器（Docker Desktop + Rosetta 或等价方案）。
- `featurebench==0.3.0`（`uv tool install featurebench==0.3.0`）。
- Node 24（容器内用 linux-x64 tarball 烤进派生镜像；宿主驱动用 Node 24）。
- `@deepseek-ai/dsh` CLI **0.2.2-rc.3**（当前插件 peer 是 `^0.2.2-rc.3`；旧 README 的 0.2.1-rc.5/rc.1 不再适用于本插件）。
- Chrome（CDP 驱动无头 Web；`tools/evals/featurebench/README.md` 有路径说明）。
- 隔离的模型凭据：`$DSH_HOME/.credentials.yaml`（provider `deepseek-account`，model `deepseek-flash`）。
- `~/.dsh-eval-archive`：历史 raw session/patch/verifier 输入、官方 report/test_output；本机没有，另一台机器应提供。
- 官方镜像：已有镜像的 DSH 版本可能不是 rc.3；**不要假设可用**，先核对并按 `bake_base.py` 用 rc.3 rebake 派生镜像。

### 4.2 不要做的事

- 不要在作者机器上安装 `featurebench`、拉 10–14GB 镜像或恢复归档。
- 不要把凭据、raw session、私有数据提交进 repo。
- 不要用 `--execute` 跑付费调用，除非 Phase 1/2 已获单独授权。

### 4.3 安全/隔离

- 零宿主目录挂载；只通过 `put_archive` 注入最小文件。
- 运行泄漏扫描；记录 `leak_scan.txt`。
- 默认 dry-run；`run_arm.py` / `run_matrix.py` / `evaluate_matrix.py` 只有显式 `--execute` 才真正调用。
- 容器内清代理环境变量；关闭 session-log 上传与 OTel。
- 官方镜像可能含参考实现副本，结果解释要带 caveat。

---

## 5. Phase 0（免费，先做）

目标：让审查者在**不花钱**的前提下 review 评测设计与证据边界。产物建议：

1. **`docs/evals/ac-validity-1c-case-table.md` + `.json`**
   - 案例覆盖：历史诊断、局部接口 vs 外部扩需、正向完成、无关既有失败、原始需求歧义、关键证据缺失。
   - 每例字段：Source 原文/位置、`source_available`、Outcome、Boundary、Oracle、官方 FeatureBench `resolved/pass_rate`、Source 与 Grader 是否一致（agree/conflict/unknown）、人工预期 verdict 与置信度、dedup key、unavailable reason。
   - 历史 11 个案例来自 `docs/evals/verify-01-attribution-data.json`（7 V1 FP + 1 V2 FP + 3 FN），按 task 去重后是 **2 个 FP 任务 + 3 个 FN 任务**；7 次 FP 只诊断，不是 7 个独立样本。
   - raw archive 缺失时标 unavailable，不用模型推断补齐；审查者最终核对 labels。

2. **`docs/evals/ac-validity-1c-offline-fixtures.md`**
   - 至少 6 类场景：正向通过、明确缺口、范围外独立失败、关键证据缺失、无关旧失败、Source 歧义。
   - Phase 1 固定用 #21 场景 1/2/3；另外 3 类保留。
   - 每例写输入、操作、预期 verdict、可复核命令；不新建 Runner。

3. **`tools/evals/featurebench/manifests/ac-validity-1c/ac-validity-1c.yml` + 预注册说明**
   - 沿用 `manifests/verify-01/verify-01.yml` 的字段：arms、run_policy、metrics、scoring、tasks、selection_rule、stop_rules。
   - A vs B2 主实验；B1 条件性消融；3 新任务 + 2 诊断；deepseek-flash；DSH 0.2.2-rc.3；ITT/decided/task/run 分母；失败/超时处理；keep/rework/revert 判定。
   - B1 触发阈值在 Phase 0 起草，Phase 2 前批准；不按结果挑样本。

4. **`docs/evals/ac-validity-1c-budget.md`**
   - Phase 1：3 场景 × 2 臂，6 次调用，≤8M Token / 2h，单次 ≤2M。
   - Phase 2 主实验：≤120M Token / 8h；B1 另批 ≤30M / 2h。
   - 写清 route/model、calls/runs、每 run/总 Token、墙钟/费用、停止条件。
   - **预算未获批准前只做离线工作。**

5. **`docs/evals/ac-validity-1c-handoff.md` 更新**
   - 把 Phase 0 实际候选（new repo/tasks、镜像体积、B1 阈值）写回来，供下一台机器继续。

### Phase 0 完成标准

- Case table 覆盖 6 类、历史去重、unavailable 标注、审查者可复核。
- Fixture 覆盖 6 类，Phase 1 固定 1/2/3。
- 预注册 manifest/文档齐全，运行前固定。
- 预算文档覆盖 Phase 1/2 上限与停止条件。
- 只改文档/任务制品；`npm run verify` 通过；不跑付费、不装环境。
- 提交到 `dev`（或按分支保护停下报告）。

---

## 6. Phase 1（付费；需单独批准）

- 固定 #21 场景 1/2/3，每场景 A/B 两臂，共 6 次 verifier 调用。
- **锁死输入**：同一案例的 Source、Spec/AC、Delivery Contract、代码快照、环境与工具面完全一致，只替换 baseline/candidate Verifier Prompt；否则不能归因给 Verifier。
- 记录：run_id、verdict、findings、工具执行、Token、耗时；人工核对 finding 是否可复现。
- 不作显著性或普遍有效性声称；不把 `needs_human` 增多当成功。
- 预算：≤8M Token / 2h；单次 ≤2M；超限停止。
- 只有维护者明确批准后才运行。

---

## 7. Phase 2（付费；需单独批准）

- **A vs B2 主实验**：A = `0.6.2/master` 基线；B2 = #20 + #21（dev 当前候选）；报**联合效果**。
- **B1 条件性消融**：只有 #20、旧 Verifier；触发阈值 Phase 0 起草、Phase 2 前批准；B1 另批 ≤30M / 2h。
- **任务**：3 个新任务 + 2 个历史诊断任务（sphinx gettext/doctest）；新任务来自新 repo，Phase 0 提出候选并报告镜像体积；历史诊断只作回归，不进入效果宣称。
- **固定**：同一 DSH 0.2.2-rc.3、模型/参数、镜像、权限、超时、预算；A/B 顺序交替。
- **指标**：
  - 主：按已确认原始目标的错误放行（`approve` 但未交付），task 去重、按 run 报数；ITT 与 decided 分开。
  - 守护：误拒、`needs_human`、无裁决/超时、scope 冲突处理正确性、Token/墙钟、二次返工/复验。
  - 新增：验收缺口识别率、finding 可复核率（人工）。
  - 旁证：官方 `resolved/pass_rate` 单列；Source 与 Grader 冲突不得等同于用户任务失败。
- **决策**：keep / rework / revert；不因 B 的 `approve` 更少就直接说质量提升；样本小不做显著性宣称。
- 预算：主实验 ≤120M Token / 8h；B1 另批。

---

## 8. 审批边界

- Phase 1 与 Phase 2 **分别**申请付费授权；没有明确批准不得运行真实模型。
- 镜像 rebake、依赖安装、归档恢复在另一台机器上按 Phase 0 清单执行；作者机器不做。
- 不得按结果挑任务/样本/阈值；预注册后修改需单独提交并说明。
- 不得把官方 `resolved` 当作用户目标，不得把结构合规率当质量收益，不得把 `needs_human` 增加当成功。
- 最终 false approve 必须由审查者/人工独立裁定，不能只看 Verifier 或官方分数。

---

## 9. 已知限制 / 风险

- 历史 7 次 FP 只有 2 个任务；V1/V2 不能混算。
- Source 与官方 Grader 可能冲突（sphinx gettext/doctest）；必须单列。
- A vs B2 同时改变 Actor 写作与 Verifier 判断；只能报联合效果，B1 才能隔离 Verifier。
- 结构合规 ≠ 交付质量。
- 新增 Delivery Contract 会带来在途 Spec 重登记/重跑验证/人工澄清；进入守护指标，与 #24 已知边界分开。
- 小样本；零错误放行不能证明改善；不做显著性。
- 本机没有历史 raw archive；执行机器应提供并核对。
- 评测 README 版本可能过期（0.2.1-rc.5/rc.1 vs 当前 rc.3）；先做兼容检查。

---

## 10. 交接检查清单

- [ ] 从 `dev` 拉取最新提交，确认本交接和 `AC-VALIDITY-1C` 草稿存在。
- [ ] 核对 Docker、FeatureBench 0.3.0、DSH 0.2.2-rc.3、Node/Chrome/凭据。
- [ ] 核对 `~/.dsh-eval-archive` 和历史案例 raw 路径。
- [ ] 决定继续 `AC-VALIDITY-1C` 草稿还是重建任务；草稿不能当已完成。
- [ ] 完成 Phase 0 四类材料并提交到 `dev`；请审查者 review。
- [ ] 申请 Phase 1 预算；批准前不跑真实模型。
- [ ] Phase 1 只跑固定的 3 场景；锁输入；记录证据。
- [ ] 申请 Phase 2 预算；B1 阈值先批准再决定是否启动。
- [ ] 报告 keep/rework/revert；不夸大。

---

## 11. 需要维护者/审查者决定的问题

1. Phase 0 提出的新 repo/任务候选与镜像体积是否可接受。
2. B1 触发阈值（Phase 0 起草，Phase 2 前批准）。
3. Phase 1/2 预算与模型的最终授权（Phase 1 8M/2h；Phase 2 120M/8h；B1 30M/2h）。
4. 人工 gold label 的最终核对（审查者）。
5. 是否允许在另一台机器上安装依赖、拉取/rebake 镜像、恢复归档。
