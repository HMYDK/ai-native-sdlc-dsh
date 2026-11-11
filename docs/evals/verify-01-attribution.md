# VERIFY-01 Step 1：7 个 V1 `approve → unresolved` 案例归因

- **对应 issue**：HMYDK/ai-native-sdlc-dsh#16（AC-001 裁决来源、AC-002 失败归因），也是 Step 2「最小 prompt 改动」的证据输入。
- **数据**：本机只读原始归档 `~/.dsh-eval-archive/2026-11-08/`（L2，raw run 不入库）+ canonical
  [featurebench-runs.jsonl](featurebench-runs.jsonl)、
  [featurebench-verifier-confusion.json](featurebench-verifier-confusion.json)、
  [featurebench-baseline.md](featurebench-baseline.md) §3.4。
- **机读版**：[verify-01-attribution-data.json](verify-01-attribution-data.json)（每个案例的调用/结果配对、官方报告、spec/AC、verifier 动作、标签证据与文件 sha256）。
- **复跑脚本**：[tools/evals/verify01/attribute_cases.py](../../tools/evals/verify01/attribute_cases.py)（只读归档；默认 stdout JSON）。
- **边界**：只做分析，不改 verifier 代码、不改归档、不改 `packages/` 与队友文件。

---

## 1. 结论摘要（先看这里）

**7 个 V1 假阳性不是 7 个独立任务**：其中 **6 个是同一个 sphinx gettext task**
（`sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1`，mvp/2x2/verify-stress/repeat×3，
prompt sha256 完全相同），**1 个是 sphinx doctest task**
（`...test_ext_doctest.530dec5f.lv1`，expanded）。把它们按任务去重后再看，失败机制只有三条：

| 去重后的模式 | 出现 | 案例 | 机制（有证据） |
|---|---|---|---|
| **M1 任务说明 ≠ 官方评分要求（spec/AC 覆盖不到外部评分）** | **7/7** V1（+V2） | 全部 | 官方 F2P 要求修复的符号（gettext: 第一层失败是 `sphinx/versioning.py::add_uids`，同批被剥离代码还包括 `sphinx/util/nodes.py::extract_messages`；doctest: `DocTestBuilder.compile/run`）**不在** prompt/spec/AC 中：prompt 只要求恢复列出的 4 个接口，`add_uids` 连提都没提，i18n builder 等还被明确写成 out of scope。按说明实现只能拿到 1/13 或 1/11。 |
| **M2 官方 F2P 测试文件在 testbed 中不可见，且无等价真实入口被执行** | **5/7** V1 | V1-1、V1-3、V1-4、V1-5、V1-7（+V2） | 官方 F2P 文件（`tests/test_builders/test_build_gettext.py` / `tests/test_extensions/test_ext_doctest.py`）被隐藏：验证者 `pytest` 得到 `ERROR: file or directory not found`、`find`/`git ls-files` 无结果。5 个案例的作者与验证者都**没有**执行 `python -m sphinx -b gettext` / `-b doctest` 真实入口；只在接口级 probe 上 approve。 |
| **M3 Verifier 已拿到评分等价失败证据，仍按“任务 scope / 与 pristine 无回归”解释为不阻塞** | **2/7** V1 | V1-2、V1-6 | V1-2 的验证者从 GitHub 取回上游 `test_build_gettext.py`，实测 `11 failed, 1 passed`、root cause 11×`NameError: name 'add_uids' is not defined`，最后写 “stripped out of scope” 后 **approve**；V1-6 的验证者直接执行 `python -m sphinx -b gettext`，拿到与官方完全一致的 `add_uids` 异常，写成 “E7. End-to-end gettext build impossible in this repo (pre-existing, out of scope)” 后 **approve**。 |

**对照证据（同一 task 的另一 arm）**：
- gettext task 的 2x2 `standard` 对照臂（无 SDLC 流程）恢复 **21 个文件**（含 `versioning.py::add_uids`、
  `nodes.py::extract_messages` 等）后官方 **resolved=1.0、F2P 12/12、P2P 137/137**；
  而所有 6 个小改动的 sdlc 运行都是 **1/13 + `NameError: name 'add_uids' is not defined`**。
- doctest task 的 expanded `standard` 对照臂同样只恢复 `is_allowed_version`，官方也是
  **resolved=False / pass_rate=0.0909 / `AttributeError: 'DocTestBuilder' object has no attribute 'compile'`**——
  按任务说明“正确实现”也无法通过官方评分。

**最小改进点候选（Step 2 prompt 改动，按收益排序）**：
1. **强制真实入口**：验证者必须执行被改子系统的真实入口/真实构建（如 `python -m sphinx -b <builder>`、
   `sphinx-build`、真实 CLI），不得只用作者 probe 与周边单测；端到端失败必须进入裁决。→ 直接覆盖 M2（5/7）。
2. **官方 F2P 等价测试优先**：官方测试文件通常不在树内；若能从上游/已发布 sdist 取到对应测试，
   必须运行；**失败即不得 approve**（“在 pristine HEAD 上也失败”不是理由——F2P 正是要求本改动修复它）。
   → 直接覆盖 M3（2/7）+ M2。
3. **scope 不能当免责**：任务说明声明 out of scope 的模块，如果它的缺失会导致真实入口/官方等价测试失败，
   验证者必须给出 `grading_risk` finding 并 reject/needs_human，而不是以 spec 的边界为由 approve。
   → 覆盖 M1/M3 的交界。
4. **隐藏测试重建纪律**（FN 侧，防止反向误判）：从上游/相邻 commit 重建的测试只能作为风险提示，
   当它与任务说明/官方 oracle 可能冲突时应标 `needs_human`+`unverified`，不得单独据此 reject。
   → 对应 FN-1/FN-3。
5. **数据质量（非 prompt）**：canonical `sdlc_tool_calls` 恰好是主会话 `tool/call` 数的 **2 倍**（11/11 案例），
   见 §8；#15 的宽口径提取缺陷未修复，本分析改用 callId 配对重算。

---

## 2. 裁决提取口径与防重复计数（#15 的直接回应）

本分析**不用**“任意字符串里 regex 匹配 verdict/status”的口径（那会把 `read` 到的旧裁决、验证者子会话的
同名 JSON 也算成一次调用）。规则：

1. 只取**主会话**（目录名以 `session-` 开头；header `origin` 非 `subagent`、`parentSession` 为空）中的
   `tool/call`，且 `data.name == "sdlc_verify"`。
2. 按 `data.callId == tool/result.data.message.toolCallId` 配对。会话里存在**同名工具但不同 callId** 的
   文本（例如 bash 输出里提到 `sdlc_verify`）不会被误计。
3. **最终裁决** = 最后一个**主会话、有结构化 payload、且 `isError=false`** 的 `status`
   （`status` 缺失才回退 `raw_status`）。`isError=true` 的调用记为 `error`，**没有 tool/result** 的调用
   （timeout 截断）记为 `no_result`，两者都不产生裁决。
4. 与 canonical 交叉核对：11/11 案例的“主会话有效裁决序列”与
   `featurebench-runs.jsonl` 的 `verify_verdicts` **完全一致**
   （字段 `canonical_consistency.verdict_sequence_matches_canonical=true`）。

逐案例的调用序列（含 error / no_result）见下表；这也说明 canonical 口径没有把截断调用算进去：

| 案例 | 主会话 sdlc_verify 调用（按发生顺序） | 有效裁决序列 | canonical `verify_verdicts` |
|---|---|---|---|
| V1-1 | 1 次：`approve` | `approve` | `["approve"]` ✅ |
| V1-2 | 3 次：`approve` → `error` → `approve` | `approve, approve` | `["approve","approve"]` ✅ |
| V1-3 | 1 次：`approve` | `approve` | `["approve"]` ✅ |
| V1-4 | 2 次：`approve` → `approve` | `approve, approve` | `["approve","approve"]` ✅ |
| V1-5 | 1 次：`approve` | `approve` | `["approve"]` ✅ |
| V1-6 | 2 次：`approve` → `approve` | `approve, approve` | `["approve","approve"]` ✅ |
| V1-7 | 1 次：`approve` | `approve` | `["approve"]` ✅ |
| V2 | 4 次：`approve` → `error` → `error` → `approve` | `approve, approve` | `["approve","approve"]` ✅ |
| FN-1 | 2 次：`reject` → `no_result`（超时） | `reject` | `["reject"]` ✅ |
| FN-2 | 3 次：`approve` → `error` → `reject` | `approve, reject` | `["approve","reject"]` ✅ |
| FN-3 | 3 次：`reject` → `error` → `no_result`（超时） | `reject` | `["reject"]` ✅ |

`error` 的拒绝文案共有三类（插件门禁在工作）：V1-2 与 FN-2 是“上轮验证后代码/需求/计划或验收标准已改变，
但没有相应退回记录”；V2 的第二个 error 与 FN-3 是“任务验证不能用其他文件覆盖已登记的需求/计划制品”；
V2 的第一个 error 是“先处理上一轮问题并提交证据（F1）”。这些都是 sdlc 制品/裁决门禁在工作，
不是验证执行崩溃。

> 注意：`sdlc_tool_calls`（`meta.json`/`runs.jsonl`）与主会话真实 `tool/call` 数**恰好 2:1**（11/11 案例，
> 例如 V1-1 声明 `sdlc_verify=2`、真实 1；`sdlc_artifact_write=6`、真实 3）。这是 canonical 汇总的
> 重复计数问题（§8），不影响 `verify_verdicts`（后者是主会话口径且与本分析一致）。

---

## 3. 逐案例归因表

### 3.1 裁决与官方结果

| 案例 | run_id（实验/arm/repeat） | agent_failure | 最终裁决（来源） | canonical bucket | 官方 resolved / pass_rate | 官方 F2P | 失败签名（官方 test_output） |
|---|---|---|---|---|---|---|---|
| V1-1 | `mvp:…test_build_gettext…:sdlc:r1` | null | **approve**（1 次，主会话 call `call_00_4BezY…`） | approve_unresolved_false_positive | **false** / 0.0769 | 1/13（仅 `test_Catalog_duplicated_message`） | `NameError: name 'add_uids' is not defined` |
| V1-2 | `2x2:…test_build_gettext…:sdlc_guidance:r1` | null | **approve**（3 次，末次 `call_00_ET_bx4V…`） | approve_unresolved_false_positive | **false** / 0.0769 | 1/13 | `NameError: name 'add_uids' is not defined` |
| V1-3 | `expanded:…test_ext_doctest…:sdlc:r1` | null | **approve**（1 次，`call_00_JrnMW…`） | approve_unresolved_false_positive | **false** / 0.0909 | 1/11（仅 `test_is_allowed_version`） | `AttributeError: 'DocTestBuilder' object has no attribute 'compile'`（另有 `NotImplementedError: Must override run()`） |
| V1-4 | `verify-stress:…test_build_gettext…:sdlc:r1` | null | **approve**（2 次） | approve_unresolved_false_positive | **false** / 0.0769 | 1/13 | `NameError: name 'add_uids' is not defined` |
| V1-5 | `repeat-sampling:…test_build_gettext…:sdlc:r1` | null | **approve**（1 次） | approve_unresolved_false_positive | **false** / 0.0769 | 1/13 | `NameError: name 'add_uids' is not defined` |
| V1-6 | `repeat-sampling:…test_build_gettext…:sdlc:r2` | null | **approve**（2 次） | approve_unresolved_false_positive | **false** / 0.0769 | 1/13 | `NameError: name 'add_uids' is not defined` |
| V1-7 | `repeat-sampling:…test_build_gettext…:sdlc:r3` | null | **approve**（1 次） | approve_unresolved_false_positive | **false** / 0.0769 | 1/13 | `NameError: name 'add_uids' is not defined` |
| V2（参考，不混入 V1） | `version-regression-mvp:…test_build_gettext…:sdlc:r1` | null | **approve**（4 次，末次 `call_00_v5SqR…`） | approve_unresolved_false_positive | **false** / 0.0769 | 1/13 | `NameError: name 'add_uids' is not defined` |
| FN-1 | `version-regression-mvp:…test_algorithms…:sdlc:r1` | **timeout** | reject（2 次，末次 no_result） | **reject_resolved_false_negative** | **true** / 1.0 | 13/13 | —（无失败） |
| FN-2 | `version-regression-mvp:…test_metadata…:sdlc:r1` | **timeout** | reject（3 次，末次 reject） | **reject_resolved_false_negative** | **true** / 1.0 | 294/294 | —（无失败） |
| FN-3 | `repeat-sampling:…test_algorithms…:sdlc:r2` | **timeout** | reject（3 次，末次 no_result） | **reject_resolved_false_negative** | **true** / 1.0 | 13/13 | —（无失败） |

补充：6 个 gettext 案例的官方 P2P 都是 **137/137 pass**，doctest 是 **124/124 pass**——官方失败只发生在
F2P，说明不是环境大范围损坏，而是“被剥离代码 + 隐藏测试”的定向差异。

### 3.2 Spec/AC 覆盖、Verifier 动作与归因标签

| 案例 | spec AC 数 | prompt / spec AC 是否提及官方失败符号 | 补丁文件（数） | Verifier 实际动作（子会话） | 归因标签 | 确信度 | 可复现 |
|---|---|---|---|---|---|---|---|
| V1-1 | 10 | **否**（`add_uids`/`extract_messages` 0 次） | gettext.py, template.py（2） | real build ✗；项目测试 ✓；自写 probe ✓；读作者证据 ✓ | ①②④⑤ | high | 是 |
| V1-2 | 10 | **否** | 同 2 文件（2） | real build ✗；项目测试 ✓（**并运行取回的上游 F2P 文件：11 failed/1 passed**）；自写 probe ✓；作者证据 ✓ | **③**④⑤ | high | 是 |
| V1-3 | 12（AC-012 明确“不恢复其它被剥离 helper”） | **否**（`DocTestBuilder`/`compile` 0 次） | ext/doctest.py（1） | real build ✗；项目测试 ✗；自写 probe ✓；作者证据 ✓ | ①②④⑤ | high | 是 |
| V1-4 | 12 | **否** | gettext.py, template.py, 作者新增 test 文件（3） | real build ✗；项目测试 ✓（**执行官方 F2P 路径→file not found**）；自写 probe ✓；作者证据 ✓ | ①②④⑤ | high | 是 |
| V1-5 | 9 | **否** | 2 文件（2） | real build ✗；项目测试 ✓；自写 probe ✓；作者证据 ✓ | ①②④⑤ | high | 是 |
| V1-6 | 9 | **否** | 2 文件 + 作者新增 test 文件（3） | **real build ✓（`python -m sphinx -b gettext`→add_uids）**；项目测试 ✓；自写 probe ✓；作者证据 ✓ | **③**④⑤ | high | 是 |
| V1-7 | 10 | **否** | 2 文件（2） | real build ✗；项目测试 ✓；自写 probe ✓；作者证据 ✓（取回上游 F2P 文件但只单跑 1 个测试） | ①②④⑤ | high | 是 |
| V2 | 11 | **否** | 2 文件（2） | real build ✗；项目测试 ✓；自写 probe ✓；作者证据 ✓ | ①②④⑤ | high | 是 |
| FN-1 | 15 | n/a | 3 文件（含作者本地测试） | 自写 probe/重建测试 ✓；官方 F2P 不可见 | **⑥**（删失） | high | 否 |
| FN-2 | 11 | n/a | 3 文件 | 项目测试 ✓；自写 probe ✓；作者证据 ✓ | **⑥**（删失） | high | 否 |
| FN-3 | 14 | n/a | 2 文件 | 重建上游测试 ✓；自写 probe ✓ | **⑥**（删失） | high | 否 |

标签定义（与 issue #16 一致）：①缺少/无法执行关键测试；②测试有运行但覆盖不足；
③Verifier 漏看代码缺陷或错误解释证据；④Spec/AC 未覆盖外部评分要求；
⑤评分/环境/数据提取问题；⑥证据不足。每个标签的**单独证据**在 JSON 的 `attribution_labels[].evidence`。

- **①的判定**：V1-2/V1-6 不计 ①，因为验证者实际执行了与官方评分等价的 E2E（上游测试文件 / 真实构建）；
  其余 5 个案例官方 F2P 文件不可见、也没有执行真实入口。
- **②的判定**：仅按“是否覆盖真实子系统入口”判；V1-2/V1-6 执行了，故不计 ②。
- **③的判定**：只在验证者**已经观察到评分等价失败**（官方签名/上游 F2P 测试失败）却仍 approve 时给；
  其余案例没有观察到，故不给（不把“没跑到”算成“漏看”）。
- **⑤的判定**：指 benchmark 任务构造/评分口径问题（任务说明声明的实现范围 ≠ 官方 F2P 要求），
  证据是对照臂与跨 run 一致性；本分析没有把容器/网络异常作为 ⑤ 的证据（本批 run 未发现需要归因的此类异常）。
- **⑥只用于 3 个 FN**：`agent_failure=timeout` 删失，且最后一次 `sdlc_verify` 结果缺失/被截断，
  不能据此判定验证者误判。

---

## 4. 逐案例证据要点

> 证据路径统一用 `archive:` 前缀（相对归档根），完整 sha256 见
> [verify-01-attribution-data.json](verify-01-attribution-data.json) 的 `evidence_paths`。

### V1-1（mvp / gettext / r1）
- **裁决来源**：主会话 `session-c9b69e6b…` 只有 1 次 `sdlc_verify`（`call_00_4BezYCrXFvFCq5KGEXHS7837`），
  result 为结构化 JSON：`status=approve, raw_status=approve, verification_complete=true, 10/10 AC met, findings=[]`。
  没有其他同名裁决来源；子会话 `46a23d25…`（`origin=subagent, agentPreset=sdlc-verifier`）没有 `sdlc_verify` 调用。
- **作者补丁**：2 文件（`sphinx/builders/gettext.py`、`sphinx/util/template.py`），只补回任务说明列出的接口；
  `patch.diff` 无 `add_uids` / `extract_messages`。
- **官方**：F2P 12/13 失败，第一层根因 `NameError: name 'add_uids' is not defined`
  （`sphinx/versioning.py:172`），P2P 137/137 pass。
- **Verifier 实际检查**：61 条 bash——自写 `/tmp/verify_gettext.py`（9 项行为断言）、
  `/tmp/negative_control.py`（8 个 in-process 变异）、`tests/test_util/test_util_fileutil.py` 与
  `test_util_template.py`、`git archive HEAD` 的 pristine 对照、读作者 `.ai/rsi/runs/49ed971c…`；
  **没有**执行 `python -m sphinx -b gettext`，也没有运行官方 F2P 文件（该文件不在树中）。
- **归因**：①（关键测试不可执行且真实入口未跑）②（只覆盖接口/周边单测）④（AC 只覆盖接口）
  ⑤（官方评分要求超出任务说明；2x2 standard 对照臂 21 文件→resolved=1.0）。
- **确信度**：high；**可复现**：是（同类 6 run 同签名）。

### V1-2（2x2 / gettext / r1，guidance arm）
- **裁决来源**：3 次调用——`approve`（`call_00_ET_OdLa…`，1 条 minor finding：作者 baseline 计数写错）→
  `error`（`call_00_SsnnWa…`）→ `approve`（`call_00_ET_bx4V…`）。最终 approve。
- **关键证据（③）**：验证者 `3e4d61cd…` 从 `raw.githubusercontent.com` 取回上游
  `tests/test_builders/test_build_gettext.py`，在 `/tmp/runpristine` 与 `/testbed` 运行：
  pristine `12 failed`；changed 后仍 **`11 failed, 1 passed`**，root cause 汇总为
  `11 NameError: name 'add_uids' is not defined`（另有 i18n `extract_messages`）。
  最终 verify 的 `unverified[0]` 原文承认：
  “End-to-end gettext builder use … cannot be exercised in this tree: sphinx/transforms/i18n.py:412
  (extract_messages) and sphinx/versioning.py:172 (add_uids) … The upstream tests/… E2E tests fail with
  NameError on both pristine and changed trees; only its direct test_Catalog_duplicated_message passes
  after the change (12 failed/0 passed pristine -> 11 failed/1 passed changed)”，但仍 approve。
- **归因**：③（观察到评分等价失败并解释为 out of scope）④⑤。
- **确信度**：high；**可复现**：是。

### V1-3（expanded / doctest / r1）
- **裁决来源**：主会话 `session-aef69cf8…` 1 次 `sdlc_verify`（`call_00_JrnMWSSSCDFqXlIBZ6dB2494`），
  12/12 AC met、findings=[]、approve。
- **Spec**：AC-001..AC-011 是 `is_allowed_version` 的语义；**AC-012 明写**
  “The implementation is the only addition to /testbed/sphinx/ext/doctest.py; no other stripped helpers
  are restored and existing imports are unchanged.”——把官方失败面（DocTestBuilder）**写进了 out of scope**。
- **官方**：F2P 1/11 通过（只有 `test_is_allowed_version`），其余 10 项失败在
  `AttributeError: 'DocTestBuilder' object has no attribute 'compile'` /
  `NotImplementedError: Must override run() in subclass.`；P2P 124/124 pass。
- **隐藏测试**：验证者 `find / -path … -name 'test_ext_doctest*'` 无输出、`git ls-files` 无匹配，
  但 `pyproject.toml` 中列有 `tests.test_extensions.test_ext_doctest`；**53 条 bash 里没有任何项目测试或
  `python -m sphinx -b doctest`**，只有自写 `/tmp/verify_doctest_version.py` 与作者 `.ai/rsi` 复跑。
- **对照**：expanded `standard` 臂同样只改 `doctest.py`、官方同样 0.0909 + 同一签名。
- **归因**：①②④⑤。**确信度** high；**可复现** 是。

### V1-4（verify-stress / gettext / r1）
- **裁决来源**：2 次 `sdlc_verify` 都 approve：第一次（`call_00_ET_pxbM…`）1 条 minor spec wording finding；
  第二次（`call_00_yICZp…`）0 findings，12/12 AC。
- **官方 F2P 不可执行的直接证据**：验证者 `e26aa097…` 执行
  `python -m pytest tests/test_builders/test_build_gettext.py -q`
  → `ERROR: file or directory not found: tests/test_builders/test_build_gettext.py`；
  之后转去跑作者新增的 `tests/test_builders/test_gettext_interfaces.py`、`test_quickstart`、自写 probe 与 mutation。
- **patch**：3 文件（2 个源码 + 作者新增测试文件）——作者本地测试写的是自己的 AC，不是官方 F2P。
- **归因**：①②④⑤。**确信度** high；**可复现** 是。

### V1-5（repeat-sampling / gettext / r1）
- **裁决来源**：1 次 `sdlc_verify`（`call_00_oxlXjS…`），9/9 AC met、1 条 minor evidence caveat、approve。
- **Verifier 实际检查**：自写 `/tmp/verify_gettext.py`、作者 `.ai/tasks/GETTEXT-CATALOG-RENDER/proof_check.py`
  （并在 HEAD 临时树上验证其非平凡）、`tests/test_util/test_util_template.py`；
  对 `tests/test_builders/test_build_gettext.py` 的 grep 无输出（文件不存在）；无真实构建。
- **归因**：①②④⑤。**确信度** high；**可复现** 是。

### V1-6（repeat-sampling / gettext / r2）——最直接的③证据
- **裁决来源**：2 次 approve：第一次 1 条 minor（作者 proof 覆盖缺口），第二次 0 findings。
- **Verifier 实际执行**：子会话 `e6046190…` 明确运行
  `cd /testbed && python -m sphinx -b gettext -q /tmp/verify/proj/src /tmp/verify/proj/pot`
  → `sphinx/versioning.py:172: list(add_uids(self.document, versioning_condition))`
  → **`NameError: name 'add_uids' is not defined`**（`EXIT=2`）；又在 `/tmp/verify/baseline_repo` 上验证 pristine
  同样失败；随后写证据文件：“**E7. End-to-end gettext build impossible in this repo (pre-existing, out of scope)**”，
  最终 approve、unverified 里也记录了该失败。**这说明验证者并非“没跑到”，而是主动选择了“pre-existing/out of scope
  ⇒ 不阻塞”的验收口径**，与官方 F2P 口径冲突。
- **归因**：③④⑤（不计①②，因为真实入口已执行）。**确信度** high；**可复现** 是（同 task 同签名）。

### V1-7（repeat-sampling / gettext / r3）
- **裁决来源**：1 次 `sdlc_verify`，10/10 AC、2 条 minor evidence caveat、approve。
- **Verifier 实际检查**：自写 `/tmp/verify_gettext_restore.py`（AC-001..AC-010，且在 HEAD 与上游 8.3.0 上对照）、
  取回上游 sdist 的 `tests/test_builders/test_build_gettext.py` 但**只抽出 `test_Catalog_duplicated_message`
  单跑**（1 passed）；没有跑整份官方测试、没有真实 `-b gettext` 构建。
  其 summary 自认 “Out-of-scope I18nBuilder/MessageCatalogBuilder code remains stripped and was not assessed.”
- **归因**：①②④⑤。**确信度** high（①的单项证据偏间接，但文件缺失+未执行真实入口是直接观测）；**可复现** 是。

---

## 5. V2 参考案例（单独统计，不并入 V1）

`version-regression-mvp:sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1:sdlc:r1`
（plugin 0.6.1 / DSH 0.2.2-rc.1）：

- 4 次 `sdlc_verify`：approve（1 条 minor missing-evidence）→ error（制品改动后未退回）→ error → approve（0 findings）。
  最终 **approve**；canonical bucket 与 V1 一样是 `approve_unresolved_false_positive`。
- 官方：**resolved=false / 0.0769 / 1/13 / `NameError: name 'add_uids' is not defined`**，与 V1 完全相同。
- Verifier 动作：把恢复代码与取回的上游 Sphinx master/v8.2.3 逐段比对（“byte-identical”）、自写
  `/tmp/verify_acs.py`、作者 17 个 proof 测试（clean HEAD 上 17/17 失败）、mutation 13/13；
  **没有真实 gettext 构建**，也没有运行官方 F2P 文件。
- 结论：**该 FP 机制不是 0.6.0/0.2.1 特有**，V2 仍存在（1/3 approve 是 FP）。
- 归因：①②④⑤；确信度 high；可复现是。

---

## 6. 3 个 FN（`reject → resolved`，均为删失样本）

任务说明明确要求：这些 run 的 `agent_failure=timeout`，**不要直接当成验证者误判**。我们的处理：
给出可核对的事实与矛盾点，但标签统一为 **⑥证据不足**，`confirmed=false`、`reproducible=false`。

| 案例 | 最终裁决（来源） | 官方 | 关键事实（含矛盾） |
|---|---|---|---|
| **FN-1** | reject（第 1 次，`call_00_ET_3mEB…`；第 2 次 **no_result**） | resolved=1.0，F2P 13/13 | 第 1 次 reject 依据“从 base commit 7001ebe7 重建的 held-out `tests/test_algorithms.py` 3/14 失败”；作者随后修复；**第 2 次验证的子会话已跑出 `/tmp/sb7001_test_algorithms.py` → 13 passed，但该次 tool/call 没有 result（超时截断）**，所以最终观测仍是 reject。官方 F2P 恰好包含 verifier 声称失败的 `test_bootstrap_reproducibility` / `test_nanaware_func_warning` 且全部通过。 |
| **FN-2** | reject（第 3 次，`call_00_wyWaO…`） | resolved=1.0，F2P 294/294 | 第 1 次是 **approve**；第 2 次 error（`上轮验证后代码、需求/计划或验收标准已经改变…`）；第 3 次 reject 的 2 条 important finding 基于 **packaging 26.3** 的后续修复（CR/U+2028 summary、malformed content-type），而任务与官方 oracle 是 packaging 26.0 套件（294/294 pass）。最后 run 在 timeout 处结束。 |
| **FN-3** | reject（第 1 次，`call_00_joLSlG…`；第 3 次 **no_result**） | resolved=1.0，F2P 13/13 | 第 1 次 reject 依据“上游 7001ebe 的 `tests/test_algorithms.py` 2 failed/11 passed：random_seed 发 FutureWarning 而非 UserWarning、warning 文本不匹配”；第 2 次 error；第 3 次 no_result（超时）。官方对应测试通过。 |

**FN 的模式（与 FP 对照）**：隐藏 F2P 文件不可见 → 验证者用“上游/相邻 commit 的测试”或“后续版本行为”当 oracle；
重建 oracle 可能比官方评分**更严**（FN-1/FN-3：基线与任务的期望不同）或**更新**（FN-2：26.3 > 26.0），
从而产生 reject。这与 FP 的“用任务说明当 oracle，比官方评分更松”是同一个病根的两端：
**验证者拿不到官方评分文件时，缺少一个明确的“oracle 优先级 + 不确定就 needs_human”规则**。
该发现支持 Step 2 候选 4（但修改要小心：不能因此把真实缺陷放行）。

---

## 7. 去重后的失败模式 × 最小改进点

| # | 模式 | 次数 | 案例 | 证据锚点 | Step 2 候选 |
|---|---|---|---|---|---|
| M1 | 任务说明/AC 只覆盖新增接口，官方 F2P 还要求恢复其它被剥离代码 | 7 V1（+V2） | 全部 | prompt 0 命中 `add_uids`/`extract_messages`/`DocTestBuilder`；官方 F2P 失败签名；2x2 standard 21 文件对照 resolved=1.0 | 候选 1/2/3（verifier prompt） |
| M2 | 官方 F2P 文件隐藏 + 未执行真实子系统入口 | 5/7 V1（+V2） | V1-1/3/4/5/7, V2 | `ERROR: file or directory not found`、`find` 无输出、`ls tests/…` 无该文件；0 次 `-b doctest`、1/7 次 `-b gettext` | 候选 1 |
| M3 | 已观察到评分等价失败仍按 scope/无回归 approve | 2/7 V1 | V1-2、V1-6 | 上游 F2P 11 failed/1 passed；真实 `-b gettext` 的 add_uids；最终 approve | 候选 2/3 |
| M4 | 官方测试使用的模块在任务说明里被明确 out-of-scope 或完全未提及 | 7/7 V1 | 全部 | gettext prompt “the complete internationalization builder are outside…”（add_uids 未提及），doctest prompt “restore only is_allowed_version”；官方失败都落在这些模块 | 候选 3 |
| M5 | 作者新增本地测试/自写 probe 被当作覆盖，但这些测试编码的是作者自己的 AC | 2/7 V1 | V1-4、V1-6 | patch 含 `tests/test_builders/test_gettext_interfaces.py`、`test_gettext_catalog_renderer.py`；verifier 复跑它们 | 候选 1（E2E 优先于本地测试） |
| M6 | canonical 汇总重复计数 | 11/11 | 全部 | `sdlc_tool_calls` = 2×主会话 tool/call | 数据修复（非 prompt） |
| M7 | 隐藏测试重建导致反向误判（FN） | 3/3 FN | FN-1/2/3 | 重建 base-commit/上游测试或后续版本行为当 oracle；官方 resolved=1.0 | 候选 4（FN 侧，谨慎） |

**“最小”含义**：不改 verifier 代码、不动 workflow/状态机，只改派发给验证者的 prompt 文本。
候选 1+2 足以覆盖 7/7 V1 假阳性的直接机制；候选 3 是防止“用 spec 边界规避官方评分”的补丁；
候选 4 是防止为压 FP 而引入 FN 的对冲条款。

---

## 8. 与 canonical 数据的一致性 / 不一致发现

**一致（已核）**：
1. 11/11 案例的主会话有效裁决序列与 `featurebench-runs.jsonl` 的 `verify_verdicts` 一致；
   bucket 与 `featurebench-verifier-confusion.json` 一致（V1 7 个 approve_unresolved_false_positive，
   V2 1 个，FN 3 个 reject_resolved_false_negative）。
2. 官方 resolved/pass_rate/F2P 数量与 `featurebench-runs.jsonl` 的 `official` 字段一致
   （gettext 0.0769、doctest 0.0909、FN 1.0）。
3. `patch.diff` 的 sha256 与 canonical `patch_sha256` 逐一相等（11/11）。

**不一致 / 数据质量（需告知 Lead）**：
1. **`sdlc_tool_calls` 系统性 2 倍**：11/11 案例中 `meta.json`/`runs.jsonl` 的每个 sdlc 工具计数都恰好是
   主会话 `tool/call` 数的 2 倍（V1-1: `sdlc_verify` 2 vs 1、`sdlc_artifact_write` 6 vs 3、`sdlc_task_advance`
   20 vs 10；V1-2: 6 vs 3；V2: 8 vs 4；FN-2: 6 vs 3……）。看起来汇总脚本把同一 session 数了两遍（或把
   call/result 各计一次）。**不影响 verdict**（verdict 是主会话口径），但任何用 `sdlc_tool_calls` 的行为
   统计都会被放大 2 倍，建议在 canonical 生成器里修；也与 #15 关注的“口径/重复计数”同类。
2. 官方 F2P 测试文件在 testbed 中不存在（gettext：`tests/test_builders/test_build_gettext.py` 缺失；
   doctest：`tests/test_extensions/test_ext_doctest.py` 缺失，但 doctest 的 `pyproject.toml` 仍列有
   `tests.test_extensions.test_ext_doctest`）。这是官方隐藏测试设计的副作用，不是本次数据提取错误；
   引用 pass_rate 时需注明“agent 运行期不可见官方 F2P 文件”。
3. **被 timeout 截断的 `sdlc_verify` 调用确实存在**：本表 11 个案例中 FN-1、FN-3 各有一条调用没有 result；
   未纳入本表的 verify-stress rep2/rep3 也有被截断的第三次调用（本分析在 mapping 阶段核对过，
   canonical 的 `verify_verdicts` 同样正确排除）。本脚本显式记录 `main_verify_calls_without_result`，
   避免把截断调用当裁决。

---

## 9. 数据限制

- **L2 原始归档不在库**：本分析依赖本机 `~/.dsh-eval-archive/2026-11-08/`（raw run 目录不入库）。
  入库的只有 `docs/evals/*.jsonl|json|md` 摘要；离开该归档无法独立重跑本归因表（脚本会在缺目录时明确报错）。
- **不是独立复评**：官方评分结果直接取自归档的 `eval_outputs/<task>/attempt-1/report.json` /
  `test_output.txt`；本次没有（也无法）在容器里重跑官方 F2P（文件已被隐藏），因此“若补回剥离代码就会通过”
  的依据是对照实验的 2x2 `standard` 臂（21 文件补丁后 resolved=1.0），不是本研究重跑。
- **#15 未修复**：canonical 提取器仍是旧口径；本分析用 callId 配对从原始 session 重算，
  并逐案例与 canonical 交叉核对（§2）。如果后续重新生成 canonical，需确保口径一致，否则
  “重复计数”可能重新出现在子会话同名 JSON 上。
- **子会话不可全量复现**：归档只含 session JSONL（`tool/call`/`tool/result`/assistant message 等），
  不含完整 verifier prompt、模型 reasoning 全量（assistant message 里的 reasoning 未逐条核对）；
  2x2 是 3 次 verify / 2 个子会话，V2 是 4 次 verify / 2 个子会话（error 调用不派生子会话），
  V1-4 两个子会话的对应关系是按时间+structured_output 推断的。`verify-01-attribution-data.json`
  里对每个子会话给出了 path/sha256/event_count，可复核。
- **样本与重复**：6/7 V1 是同一个 gettext task 的重复 run（prompt sha256 全同），
  “7 个案例”不等于“7 个独立任务”；expanded doctest 只有 1 次 V1 运行，无法估计该任务的 run 间方差。
  不做显著性宣称（与 baseline §3.4 一致）。
- **版本边界**：V1 = plugin 0.6.0 / DSH 0.2.1-rc.5；V2 = 0.6.1 / 0.2.2-rc.1；FN 全部在
  version-regression/repeat 组。引用结论时须带版本与日期。
- **FN 删失**：3 个 FN 全部 `agent_failure=timeout`，其中 2 个最后一次 `sdlc_verify` 没有 result；
  官方 resolved=1.0 与最终 reject 矛盾无法进一步区分“删失”与“误判”，故统一 ⑥，不把它们计入
  V1 假阳性率/结论。
- **归档固定点**：canonical 数据文件另行给出 sha256（见 JSON `canonical_sources`）；归档根另有
  `SHA256SUMS.txt`，但本分析未逐个校验全部归档文件（只对每个案例的 session/patch/prompt/meta/官方报告
  计算 sha256 并写入 JSON）。

---

## 10. 复跑方式

```bash
# 默认读取 $DSH_EVAL_ARCHIVE_ROOT 或 ~/.dsh-eval-archive/2026-11-08
~/.local/share/uv/tools/featurebench/bin/python tools/evals/verify01/attribute_cases.py --pretty

# 指定归档根并写文件（本 JSON 即该命令产物）
~/.local/share/uv/tools/featurebench/bin/python tools/evals/verify01/attribute_cases.py \
  --archive-root ~/.dsh-eval-archive/2026-11-08 \
  --pretty --out docs/evals/verify-01-attribution-data.json
```

脚本只读归档：不联网、不调模型、不写归档；默认 stdout JSON，`--out` 才落盘。
依赖：Python 3.9+ 标准库 + `zstandard`（本机可用
`~/.local/share/uv/tools/featurebench/bin/python`）。详见
[tools/evals/verify01/README.md](../../tools/evals/verify01/README.md)。

---

## 11. 与 issue #16 AC 的对应

- **AC-001（裁决来源可复核）**：§2 的 callId 配对规则 + §2 表格里每个案例的调用序列 + JSON 的
  `main_verify_calls[]`（含 callId、status、raw_status、criteria_results、findings_count、
  `has_result`/`is_error`）以及 `evidence_paths`（session zstd 的 sha256）。
- **AC-002（FP 归因）**：§3 的标签表 + §4 的逐案例证据 + §7 的去重模式表；每个标签的证据在 JSON
  `attribution_labels[].evidence`（可多标签、每标签单独证据）；不确定处显式 `confirmed=false` /
  `unconfirmed_reason`（仅 FN 3 例）与 `⑥证据不足`。
- **Step 2 输入**：§1 的候选 1–4（verifier prompt 最小改动）+ 候选 5（canonical 数据修复）。
