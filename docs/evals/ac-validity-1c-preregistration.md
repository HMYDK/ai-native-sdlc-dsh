# AC-VALIDITY-1C 预注册方案（Phase 0 整改稿）

- **对应 issue**：[#22](https://github.com/HMYDK/ai-native-sdlc-dsh/issues/22)（AC-VALIDITY-1C）
- **审核意见**：[Phase 0 整改要求](https://github.com/HMYDK/ai-native-sdlc-dsh/issues/22#issuecomment-6895299706)（F1–F7）
- **主实验清单**：[`ac-validity-1c.yml`](../../tools/evals/featurebench/manifests/ac-validity-1c/ac-validity-1c.yml)（A/B2，5 任务 × 2 臂 = **10 runs**）
- **B1 清单**：[`ac-validity-1c-b1.yml`](../../tools/evals/featurebench/manifests/ac-validity-1c/ac-validity-1c-b1.yml)（B1，3 任务 × 1 臂 = **3 runs**）
- **状态**：除 Phase 0 的第二次独立 `sdlc_verify`（1 call / ≤2M / ≤30min，已由用户批准）外，未运行付费模型。Phase 1 / Phase 2 / B1 分别需要维护者批准；批准前只做离线工作。
- **冻结规则**：任务、arm、模型、DSH、镜像、预算、指标、停止/决策规则在本文件与两份 YAML 中固定。运行前修改必须单独提交并说明理由；不得按结果挑任务、样本或阈值；`--only-arm` 只是筛选工具，**不能代替预注册的两份计划**。

---

## 1. 实验问题

#22 要判断：

1. **「Delivery Contract（#20）+ Verifier 充分性审查（#21）」是否减少了“`approve` 但原始 Source 承诺的用户目标未交付”？**
2. 是否把误拒、`needs_human`、无裁决、Token/墙钟和返工成本推高？
3. 收益来自 #20、#21，还是 Actor 写作改善？

官方 FeatureBench `resolved` 只是旁证，不是用户目标本身。历史数据已经证明二者会冲突（见 [case table](ac-validity-1c-case-table.md)）：8 个官方 FP 全部是 gettext/doctest 的 Source/Grader conflict，Source 层错误放行 **0 confirmed**（**不是**“已证实 FP=0”）。

---

## 2. 臂与固定版本

### 2.1 主实验 + B1

| 臂 | commit | 插件 tarball sha256 | 内容 | 用途 |
|---|---|---|---|---|
| **A** | `master@920b0eb` | `40172ed2067b36e07fb2791a57a091240fbc8519140574f2b707d33aed87b0c1` | 0.6.2 基线；AI 原生 SDLC preset + 旧插件构建 | 主实验基线 |
| **B2** | `dev@5ee68cd` | `8bb74f3a8bc20be10b2b2cd704cdf6f081e64fa70a812c6d124c4823faedb404` | #20 + #21 | 主实验候选；与 A 报**联合效果** |
| **B1** | `085c8fd` | `106247171248772794bd0ac99fa20ea9e2ff42d29d04a79e3032241158d27784` | 只有 #20、旧 verifier | 单独 manifest 的条件性消融；隔离 verifier 效应 |

- **A 的定义**：`AI 原生 SDLC` preset + `920b0eb` 的 **真实基线插件构建**；不是标准 preset，也不是“注入一个不会生效的插件”。A/B2/B1 的 preset 与 `prompt_suffix` 逐字相同，唯一受控差异是插件构建。
- 三个 commit 的 `package.json` 版本都是 `0.6.2`，所以**不能**用版本字符串区分；必须用 tarball sha256 + 解包目录 + preset + DSH/镜像身份共同绑定。
- B1 **不在主 manifest 的 `arms` 里**：主 manifest 只有 A/B2，`run_matrix.py` 计划恰好 10 runs；B1 单独 manifest 计划恰好 3 runs，且不含 sphinx 诊断任务。

### 2.2 Phase 1

| 臂 | commit | 插件 tarball sha256 | 用途 |
|---|---|---|---|
| `A_phase1` | `085c8fd` | `106247171248772794bd0ac99fa20ea9e2ff42d29d04a79e3032241158d27784` | 旧 verifier（已有 #20） |
| `B_phase1` | `5ee68cd` | `8bb74f3a8bc20be10b2b2cd704cdf6f081e64fa70a812c6d124c4823faedb404` | #21 verifier |

Phase 1 与 Phase 2 的 A/B 不是同一个比较：Phase 1 固定 #21 场景 1/2/3 的输入，只替换 verifier prompt；Phase 2 同时改变 Actor 写作和 Verifier 判断，只能报联合效果。B1 才隔离 verifier。

**固定 runtime**：DSH `0.2.2-rc.3`、plugin 版本 `0.6.2`、官方镜像（按仓库 rebake 成 `fb-eval-rc3:<repo>`）、`deepseek-account/deepseek-flash`、`reasoning_effort=max`、单 run timeout 2700s、主实验 per-run 40M token / 总 120M / 8h、B1 per-run 10M / 总 30M / 2h。

---

## 3. 任务

### 3.1 新任务：sympy（3 个，固定）

选择规则：FeatureBench `fast` split（v1.1，revision `76b4a456…`）中 `repo=sympy/sympy` 的 lv1 任务共 **5** 个；按 `instance_id` 字典序取前 3 个。三者均满足 F2P 测试函数 ≥3、含 Interface Description、未出现在 canonical 历史 runs。

| task_id | F2P 文件 | F2P 测试函数 | P2P | problem_statement |
|---|---|---:|---:|---:|
| `sympy__sympy.c1097516.test_inverse.c240ffe7.lv1` | `sympy/polys/matrices/tests/test_inverse.py` | 9 | 5 | 28,046 chars |
| `sympy__sympy.c1097516.test_nullspace.f14fc970.lv1` | `sympy/polys/matrices/tests/test_nullspace.py` | 7 | 5 | 18,572 chars |
| `sympy__sympy.c1097516.test_puiseux.cd575f09.lv1` | `sympy/polys/tests/test_puiseux.py` | 12 | 5 | 55,877 chars |

- 官方镜像：`libercoders/featurebench-specs_sympy-instance_3d889fef`，manifest digest `sha256:207ff124011e74d2b6abbdce2f8d3244546949cd0abfb7949d7dd414368f8935`。
- **镜像体积 10.65GB**（维护者 2026-11-15 确认）。**Phase 0 不拉取**；本机 `docker images` 无 sympy。Phase 1/2 运行前按 `bake_base.py` 用 DSH 0.2.2-rc.3 rebake 派生镜像，并先跑 gold/empty control。
- 数据来源：本机缓存 `~/.cache/huggingface/datasets/LiberCoders___feature_bench/default/0.0.0/76b4a456…/feature_bench-fast.arrow`；没有联网拉取。`FAIL_TO_PASS` 按文件记录；表中“测试函数”是从 `test_patch` 恢复文件里数出的 `test_*` 函数。

### 3.2 诊断任务（2 个，固定）

| task_id | 角色 | 历史官方 | Source/Grader | 用法 |
|---|---|---|---|---|
| `sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1` | diagnostic | unresolved / 0.0769 / 1/13 | conflict（i18n builder 明确排除） | 只作评分链路/回归锚点 |
| `sphinx-doc__sphinx.e347e59c.test_ext_doctest.530dec5f.lv1` | diagnostic | unresolved / 0.0909 / 1/11 | conflict（只要求 is_allowed_version） | 只作评分链路/回归锚点 |

诊断任务不进入独立收益分母；官方 unresolved 不得直接等同于 Source 层错误放行。

---

## 4. Phase 1（付费；未批准）

- **固定场景**：`docs/evals/ac-validity-1b-counterexamples.md` 的场景 **1/2/3**；fixture 源码/检查器见 [`ac-validity-1c-offline-fixtures.md`](ac-validity-1c-offline-fixtures.md)。
- **臂**：`A_phase1=085c8fd`、`B_phase1=5ee68cd`；同一场景的 Source、criteria、diff、test_evidence、scope、代码快照、环境、工具面完全一致，**只替换 verifier prompt**。
- **调用**：3 场景 × 2 臂 = **6 次 verifier 调用**；≤8M token 总、单次 ≤2M、≤2h。模型 `deepseek-flash`。
- **记录**：run_id、verdict、findings、实际执行的工具/命令、token、耗时；人工复核 finding 是否可复现。
- **不宣称**：显著性、普遍有效性；不把 `needs_human` 增多当成功。
- **不新建 Runner**：fixture 是仓库内可执行的 git repo 生成器/检查器；DSH 调用复用 `setup-web.sh`/`driver.mjs`。

---

## 5. Phase 2 主实验（A vs B2；付费；未批准）

- **A vs B2**：5 任务 × 2 臂 = **10 scored runs**；每任务每臂 1 rep；顺序交替；≤120M token / 8h。
- **任务**：3 个新 sympy 任务 + 2 个 sphinx 诊断任务；每个任务先做 gold/empty control。
- **主指标**：Source 层错误放行（人工 gold label，task 去重；ITT / decided / run 分母分列）。
- **守护指标**：Source 层错误拒绝、`needs_human`、无裁决/超时、scope 冲突处理、token/墙钟、返工/复验。
- **旁证**：官方 `resolved` / `pass_rate` 单列；官方与 Source 冲突时不得等同于用户任务失败。
- **不宣称**：3 个新任务的零错误放行不能证明改善；不做显著性；不把官方 resolved 当主指标。

**可复制的 preflight / dry-run 命令**（不带 `--execute`，不启动容器/模型）：

```bash
python3 tools/evals/featurebench/run_matrix.py \
  --manifest tools/evals/featurebench/manifests/ac-validity-1c/ac-validity-1c.yml \
  --runs-root /tmp/fb-ac1c/main \
  --credentials /tmp/fb-ac1c/creds.yaml \
  --image-map "sphinx-doc/sphinx=fb-eval-rc3:sphinx" \
  --image-map "sympy/sympy=fb-eval-rc3:sympy" \
  --arm-plugin-dir "A=/tmp/ac1c/plugin/A" \
  --arm-plugin-dir "B2=/tmp/ac1c/plugin/B2" \
  --arm-plugin-tarball "A=/tmp/ac1c/pkgs/A/ai-native-sdlc-plugin-dsh-sdlc-0.6.2.tgz" \
  --arm-plugin-tarball "B2=/tmp/ac1c/pkgs/B2/ai-native-sdlc-plugin-dsh-sdlc-0.6.2.tgz" \
  --strict-preflight
```

预期输出：5 条 `[plan]`、`[preflight] OK: 5 tasks, arms=['A', 'B2']`、`[dry-run]`，退出 0。**不要**用 `--only-arm` 代替本清单；`--strict-preflight` 缺 image-map / plugin dir / tarball / hash 时非 0。

---

<a id="b1-threshold"></a>
## 6. B1 条件性消融（单独 manifest；Phase 0 起草阈值；Phase 2 前批准）

- **清单**：`ac-validity-1c-b1.yml`；臂 B1=`085c8fd`；3 个固定 sympy 任务 × 1 臂 = **3 runs**；≤30M token / 2h；单 run ≤10M；**不含 sphinx 诊断**。
- **触发阈值（草案，待批准）**：仅当以下全部成立才触发：

  (a) 3 个新任务全部完成 A/B2 配对，且 3 个任务都通过 gold/empty control；
  (b) 3 个新任务的 Source 与官方 Grader 无已知冲突（官方 `resolved` 与人工 Source 层 gold 方向一致；有冲突的任务只作旁证）；
  (c) A 在 3 个新任务上至少有 **1 个已确认的 Source 层错误放行**，且 B2 为 **0**；
  (d) B2 没有引入已确认的 Source 层错误拒绝（A `reject+resolved` → B2 相反）；
  (e) B1 预算 ≤30M / 2h 已单独批准。

- **不触发时**：若 (c) 不成立（A/B2 都是 0 或相同），不跑 B1，报告“无信号/不可归因”；若 (d) 成立，不跑 B1，先报告 guardrail 回归。
- **解释边界**：B1 只能回答“旧 verifier + #20 是否已经足够”；不能把 B1 的改善直接归因给 #21，也不能在 B1 未触发时声称 #20 无效。

**B1 preflight / dry-run**：

```bash
python3 tools/evals/featurebench/run_matrix.py \
  --manifest tools/evals/featurebench/manifests/ac-validity-1c/ac-validity-1c-b1.yml \
  --runs-root /tmp/fb-ac1c/b1 \
  --credentials /tmp/fb-ac1c/creds.yaml \
  --image-map "sympy/sympy=fb-eval-rc3:sympy" \
  --arm-plugin-dir "B1=/tmp/ac1c/plugin/B1" \
  --arm-plugin-tarball "B1=/tmp/ac1c/pkgs/B1/ai-native-sdlc-plugin-dsh-sdlc-0.6.2.tgz" \
  --strict-preflight
```

预期：3 条 `[plan]`、`[preflight] OK: 3 tasks, arms=['B1']`、退出 0；不得出现 sphinx。

---

## 7. 每臂 artifact / hash / preset / DSH / 镜像身份链

| arm | commit | tarball sha256 | 解包目录 | plugin version | preset | DSH | 镜像 |
|---|---|---|---|---|---|---|---|
| A | 920b0eb | `40172ed2…b0c1` | `plugins/A` | 0.6.2 | AI 原生 SDLC | 0.2.2-rc.3 | `fb-eval-rc3:*` |
| B2 | 5ee68cd | `8bb74f3a…b404` | `plugins/B2` | 0.6.2 | AI 原生 SDLC | 0.2.2-rc.3 | `fb-eval-rc3:*` |
| B1 | 085c8fd | `10624717…7784` | `plugins/B1` | 0.6.2 | AI 原生 SDLC | 0.2.2-rc.3 | `fb-eval-rc3:sympy` |

- 三份 tarball 互不相同；`package.json` 版本相同，因此**禁止**用版本字符串声称 identity。
- `run_matrix.py` 新增 `--arm-plugin-dir ARM=DIR` / `--arm-plugin-tarball ARM=TGZ`；`run_arm.py` 新增 `--plugin-tarball` / `--expected-plugin-sha256`。任一 hash 不匹配、缺映射、多个不同 hash 共用一个 dir、或 `TBD` 未填，都 fail closed。
- `--allow-version-mismatch` 只影响容器内 version 探测；**不能**绕过 tarball hash/身份不一致（代码中 hash 校验独立于该开关）。

---

## 8. Preflight 与确定性检查（不跑模型）

```bash
# 1) 现有清单回归
python3 tools/evals/featurebench/sanity_check.py --structural

# 2) 两份 AC-VALIDITY-1C 清单：主 5x2=10、B1 3x1=3、身份/hash/预算/触发指针
python3 tools/evals/featurebench/check_ac_validity_1c.py --artifact-root /tmp/ac1c/artifacts

# 3) 负例自检：B1 放回主 manifest、删镜像映射、交换 hash、改预算等必须失败
python3 tools/evals/featurebench/check_ac_validity_1c.py --self-test

# 4) 六类 fixture 物化 + 行为检查（git + unittest，不需要 pytest）
python3 tools/evals/featurebench/fixtures/ac-validity-1c/check_fixtures.py --self-test
python3 tools/evals/featurebench/fixtures/ac-validity-1c/check_fixtures.py \
  --workdir /tmp/validity-1c-fixtures
```

`--self-test` 检查 workdir 所有权：临时根之外的同名目录、缺 marker 的既有目录、符号链接路径都拒绝删除；带 marker 的目录可重复清理。自测目录只用唯一 `mkdtemp`/`TemporaryDirectory` 创建，连续运行两遍无残留。正常六类 fixture 由上面的第二行物化。

`--artifact-root` 需要以下布局（离线打包后可核对）：

```text
/tmp/ac1c/artifacts/plugins/{A,B2,B1}/dsh-sdlc/package.json
/tmp/ac1c/artifacts/pkgs/{A,B2,B1}/ai-native-sdlc-plugin-dsh-sdlc-0.6.2.tgz
```

`check_ac_validity_1c.py --self-test` 会断言以下负例均被拒绝：B1 加回主 arms、B1 任务/预算变化、主 image_map 缺 sphinx、A/B2 hash 相同、A commit 变化、B1 arm 删除、phase1 calls 变化、B1 含 sphinx、B1 hash 留 TBD。CI 的 `evals-check` 已加入这三条确定性检查（不调模型、不起容器）。

---

## 9. 停止与决策

**停止条件**（与两份 YAML 一致）：

- 任一 phase 达到 token 或墙钟上限：立即停止，保留已产生 run，报告未完成数。
- Phase 1 单次 >2M 或总 >8M / 2h：停止，不重试。
- Phase 2 主实验单 run >40M 或 >2700s：按失败记录（ITT），不重试。
- B1 单 run >10M 或总 >30M / 2h：停止，不重试。
- 同一 task/arm 连续 2 次 infra error：停止该 phase，先修环境。
- gold/empty control 失败：不进入效果分母，单列 unscoreable。
- 分支保护/凭据/镜像/工具链阻塞：停止并报告，不绕过。

**决策规则**：

| 决策 | 条件 |
|---|---|
| **keep** | B2 在 3 个新任务上减少已确认的 Source 层错误放行（task 去重至少少 1 个），且没有增加已确认的 Source 层错误拒绝；needs_human/无裁决/token/墙钟增量在预注册可接受范围内。 |
| **rework** | 混合结果（如减少 1 个错误放行但新增 1 个错误拒绝），或成本/返工明显上升；先修再决定是否重跑（重跑需新预算批准）。 |
| **revert** | B2 没有减少 Source 层错误放行，或增加了已确认的 Source 层错误拒绝/无裁决，或成本超预算。 |
| **no claim** | 样本小；零错误放行不能证明改善；不计算显著性、不外推；官方 resolved 只作旁证；needs_human 增加不是成功。 |

---

## 10. 审批边界

- Phase 0 已批准：交付文档/manifest/任务制品 + 本轮 1 次 `sdlc_verify`；第二次整改验证已由用户单独批准（1 call / ≤2M / ≤30min / 不重试）。
- Phase 1：未批准；需单独批准 ≤8M / 2h / 6 calls / 单次 ≤2M。
- Phase 2 主实验：未批准；需单独批准 ≤120M / 8h。
- B1：未批准；需在 Phase 2 前批准阈值与 ≤30M / 2h。
- 人工 gold label：审查者最终核对；必须独立于 A/B Actor 生成的 Spec/Delivery Contract/Verifier 裁决。
- 不得把官方 `resolved` 当用户目标；不得把结构合规率当质量收益；不得把 `needs_human` 增加当成功。
- 历史 8 个官方 FP 只能是 **provisional/conflict**，3 个 FN 只能是 **censored**；不能写“Source 层已证实 FP=0/FN=0”。

---

## 11. 审核意见 F1–F7 对应

| 项 | 落点 |
|---|---|
| F1 主实验与 B1 分开 | 主 manifest 只 A/B2（10 runs）；B1 单独 manifest（3 runs，无 sphinx）；`check_ac_validity_1c.py` 断言 |
| F2 每臂真实插件构建 | 三份 tarball sha256 + `--arm-plugin-dir` / `--arm-plugin-tarball` + `run_arm.py` hash 校验；负例 fail closed |
| F3 可执行 fixture | `fixtures/ac-validity-1c/check_fixtures.py` 六例物化 + 行为检查；S1 补订单 ID |
| F4 可复现 preflight/handoff | 本文件第 5/6/8 节命令；handoff 同步；`--strict-preflight` 缺映射非 0 |
| F5 S1 Oracle | AC-002/复核命令含 `ord-3` |
| F6 arm key | B1 manifest 的 arm key 是 `B1`；phase1 分 `commit` 字段 |
| F7 Draft PR | 独立分支 `evals/ac-validity-1c-phase0` + Draft PR；不直接合入 dev |

---

## 12. 与其它文档

- [case table](ac-validity-1c-case-table.md)：历史案例、Source 依赖核验、provisional/censored。
- [offline fixtures](ac-validity-1c-offline-fixtures.md)：六类 fixture 与 Phase 1 参数。
- [budget](ac-validity-1c-budget.md)：Phase 1/2/B1 与第二次验证预算。
- [handoff](ac-validity-1c-handoff.md)：环境/镜像/归档、Phase 1/2 命令、审批边界。

**本文件不宣称任何效果**：真实模型 A/B 尚未执行；Phase 1/2 预算未批准。
