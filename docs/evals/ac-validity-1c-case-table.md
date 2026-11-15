# AC-VALIDITY-1C：独立 case table / ground truth（Phase 0）
- **对应 issue**：[#22](https://github.com/HMYDK/ai-native-sdlc-dsh/issues/22)（AC-VALIDITY-1C）
- **状态**：Phase 0 材料；**不是**任务完成声明。8 个官方 FP 的 Source 层标签为 provisional（待审查者）；3 个 FN 为 censored/unknown。
- **机读版**：[`ac-validity-1c-case-table.json`](ac-validity-1c-case-table.json)。本文的每个数字与 JSON 一致；JSON 是逐案例字段的权威副本。
- **数据来源**：`docs/evals/verify-01-attribution-data.json`（11 个历史案例）、`docs/evals/featurebench-runs.jsonl`、`docs/evals/featurebench-verifier-confusion.json`；Source 原文与官方 report 从本机只读归档 `~/.dsh-eval-archive/2026-11-08/` 复核，关键文件 sha256 与 attribution data 一致。
- **边界**：本轮不调用付费模型、不拉镜像、不安装评测依赖。合成案例只做设计材料，没有真实模型运行结果。

---
## 1. 计数摘要（先看这里）
| 口径 | runs | 去重后任务 | 说明 |
|---|---:|---:|---|
| 官方 FeatureBench FP（`resolved=false` + `approve`） | **8** | **2** | 7 gettext + 1 doctest；含 V1 7 + V2 1；V1/V2 分层，不混算 |
| 官方 FeatureBench FN（`resolved=true` + `reject`） | **3** | **2** | seaborn 2 runs + packaging 1 run；全部 `agent_failure=timeout`，**censored** |
| Source 层错误放行：0 confirmed（**未证实为零**） | **0** | — | 8 个官方 FP 全部是 conflict/provisional 待审查；不能表述为“已证实 FP=0” |
| Source 层错误放行（provisional / conflict） | 8 | 2 | 待审查者；不并入确认计数 |
| Source 层错误拒绝：0 confirmed（**未证实为零**） | **0** | — | 3 个 FN 全部 censored；不能表述为“已证实 FN=0” |
| Source 层错误拒绝（censored） | 3 | 2 | 仅记录矛盾，归因不可定 |

**去重键**：FP = 2 个 task（`sphinx...test_build_gettext...` ×7、`sphinx...test_ext_doctest...` ×1）；FN = 2 个 task（`seaborn...test_algorithms...` ×2、`packaging...test_metadata...` ×1）。历史原始 11 个案例不是 11 个独立任务。

## 2. 关键修正：官方 FP ≠ Source 层错误放行
草案曾把“8 次官方 `resolved=false` 的 approve”直接称为“历史 7 次 FP”。按数据与 Source 原文修正：
1. **官方 FP 是 8 runs / 2 任务**，不是 7；V1 的 7 次与 V2 的 1 次必须分层。
2. **官方 FP 只表示官方 Grader 与裁决不一致**。gettext 的 Source 明确写 “complete internationalization builder are outside these listed implementations”，doctest 明确写 “restore only `is_allowed_version` … rest of the doctest extension are outside this interface”。官方 F2P 失败落在这些模块（`add_uids` / `extract_messages` / `DocTestBuilder.compile`），属于 **Source/Grader conflict**，不能直接算成“approve 但原始用户目标未交付”。
3. 因此 **Source 层错误放行 = 0 confirmed（8 个 conflict，provisional 待审查者）**。审查者若认定某案例的排除句不足以覆盖官方失败面，才把它改成 Source 层错误放行；改判必须写理由并更新 JSON。
4. **FN 是 3 runs / 2 任务，不是 3 个任务**；3 个 run 全部 `agent_failure=timeout`，最后一次 `sdlc_verify` 缺失/被截断，官方 `resolved=1.0` 与 `reject` 矛盾。标 **censored**，不计入 Source 层错误拒绝，也不据此否定验证者。

<a id="source-dependency-check"></a>
## 2.1 Source 依赖核验（provisional，不代替审查者）
审核者要求独立核验：所谓 out-of-scope 的缺失符号，是否是已承诺消费路径的**必要依赖**。以下只做只读归档核对；结论仍是 provisional，不写“Source 层已证实 FP=0/FN=0”。

### gettext（7 个官方 FP runs）
- 承诺接口：`Catalog.add`, `GettextRenderer.__init__`, `GettextRenderer.render`。
- 官方失败所需符号：`add_uids`, `extract_messages`。
- Prompt 是否提及缺失符号：`False`；Agent patch 是否提及：`False`。
- 官方 F2P 通过：`tests/test_builders/test_build_gettext.py::test_Catalog_duplicated_message`。
- 官方 F2P 失败（完整 builder/extension）：`test_build_gettext`, `test_msgfmt`, `test_gettext_index_entries`, `test_gettext_disable_index_entries`, `test_gettext_template`, `test_gettext_template_msgid_order_in_sphinxpot` …。
- 评估：`not_proven_necessary_dependency_of_promised_interfaces`。The prompt defines only Catalog.add / GettextRenderer; add_uids and extract_messages appear in neither the prompt nor the agent patch. The one passing F2P test is the Catalog helper; all 12 failures are full gettext-builder tests. The Source explicitly excludes the complete i18n builder, so this is a Source/Grader conflict, not a proven Source-layer false approval. Reviewer must decide whether the exclusion is legitimate.

### doctest（1 个官方 FP run）
- 承诺接口：`is_allowed_version`。
- 官方失败所需符号：`DocTestBuilder.compile`, `DocTestBuilder.run`。
- Prompt 是否提及缺失符号：`False`；Agent patch 是否提及：`False`。
- 官方 F2P 通过：`tests/test_extensions/test_ext_doctest.py::test_is_allowed_version`。
- 官方 F2P 失败（完整 builder/extension）：`test_build`, `test_skipif`, `test_reporting_with_autodoc`, `test_fail_fast[False]`, `test_fail_fast[True]`, `test_fail_fast[None]` …。
- 评估：`not_proven_necessary_dependency_of_promised_interface`。The prompt says restore only is_allowed_version and explicitly excludes the rest of the doctest extension; the agent patch does not touch DocTestBuilder. The one passing F2P test is is_allowed_version; all others exercise the full extension. Conflict, provisional; reviewer must decide.

**结论**：No claim that Source-layer false approvals or false rejections are zero. 0 confirmed; 8 official FPs are conflict/provisional; 3 FNs are censored. The reviewer must check whether the excluded symbols are necessary for a promised consumption path before recording a Source-layer label.

## 3. 可复核性
```bash
# 1) 重算官方 FP/FN（canonical runs；只读）
python3 - <<'PY'
import json
runs=[json.loads(l) for l in open("docs/evals/featurebench-runs.jsonl") if l.strip()]
fp=[];fn=[]
for r in runs:
    o=r.get("official") or {}; vv=r.get("verify_verdicts") or []
    last=vv[-1] if vv else None
    if isinstance(last,dict): last=last.get("status") or last.get("verdict")
    if o.get("resolved") is False and last=="approve": fp.append(r)
    if o.get("resolved") is True and last=="reject": fn.append(r)
print("FP",len(fp),len({r["task_id"] for r in fp}))
print("FN",len(fn),len({r["task_id"] for r in fn}))
PY
# 2) 核对 Source 原文与 sha256（本机归档存在时）
shasum -a 256 ~/.dsh-eval-archive/2026-11-08/fb-runs/sphinx-doc__sphinx/sdlc/prompt.txt
# 3) JSON 结构自检
jq -e '.summary.official_fp.runs==8 and .summary.official_fp.tasks==2 and .summary.official_fn.runs==3 and .summary.official_fn.tasks==2' docs/evals/ac-validity-1c-case-table.json
```

> `archive:` 前缀在 attribution data 中解析到 `~/.dsh-eval-archive/2026-11-08/`。本机已核对 gettext/doctest/seaborn/packaging 的 prompt sha256 与 attribution data 一致；V1-1 的 official report/test_output sha256 也一致。

---
## 4. 历史案例表（11 runs；按 task 去重后 4 个任务）
| case | 原案例 | 分层 | 任务/run | 官方 resolved / pass | 官方 vs 裁决 | Source/Grader | 预期裁决 | 标签状态 |
|---|---|---|---|---|---|---|---|---|
| H-FP-01 | V1-1 | V1 FP | `sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1` / `mvp:r1` | false / 0.0769 | false_positive | conflict | provisional | pending_reviewer |
| H-FP-02 | V1-2 | V1 FP | `sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1` / `2x2:r1` | false / 0.0769 | false_positive | conflict | provisional | pending_reviewer |
| H-FP-03 | V1-3 | V1 FP | `sphinx-doc__sphinx.e347e59c.test_ext_doctest.530dec5f.lv1` / `expanded:r1` | false / 0.0909 | false_positive | conflict | provisional | pending_reviewer |
| H-FP-04 | V1-4 | V1 FP | `sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1` / `verify-stress:r1` | false / 0.0769 | false_positive | conflict | provisional | pending_reviewer |
| H-FP-05 | V1-5 | V1 FP | `sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1` / `repeat-sampling:r1` | false / 0.0769 | false_positive | conflict | provisional | pending_reviewer |
| H-FP-06 | V1-6 | V1 FP | `sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1` / `repeat-sampling:r2` | false / 0.0769 | false_positive | conflict | provisional | pending_reviewer |
| H-FP-07 | V1-7 | V1 FP | `sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1` / `repeat-sampling:r3` | false / 0.0769 | false_positive | conflict | provisional | pending_reviewer |
| H-FP-08 | V2 | V2 FP | `sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1` / `version-regression-mvp:r1` | false / 0.0769 | false_positive | conflict | provisional | pending_reviewer |
| H-FN-01 | FN-1 | FN | `mwaskom__seaborn.7001ebe7.test_algorithms.1f0181c2.lv1` / `version-regression-mvp:r1` | true / 1.0 | false_negative | unknown | unknown | censored |
| H-FN-02 | FN-2 | FN | `pypa__packaging.013f3b03.test_metadata.e00b5801.lv1` / `version-regression-mvp:r1` | true / 1.0 | false_negative | unknown | unknown | censored |
| H-FN-03 | FN-3 | FN | `mwaskom__seaborn.7001ebe7.test_algorithms.1f0181c2.lv1` / `repeat-sampling:r2` | true / 1.0 | false_negative | unknown | unknown | censored |

### 4.1 逐案例字段

#### H-FP-01（V1-1；V1 FP；plugin 0.6.0 / DSH 0.2.1-rc.5）
- **Source**（`archive:fb-runs/sphinx-doc__sphinx/sdlc/prompt.txt#L4-L11`；sha256 `4bcd18e96fc985fd07e49a61c867882ec10bca856bd2c778ff99406c56bc7d1a`）：Restore the listed `Catalog.add` and `GettextRenderer.__init__` interfaces together with the renderer's directly required `render` override described below. ... General template inheritance, theme loader construction, catalog iteration, file writing and the complete internationalization builder are outside these listed implementations.
- **Outcome**：Restore the listed Catalog/GettextRenderer interfaces and their documented behavior.
- **Boundary**：The complete internationalization builder is explicitly outside the listed implementations.
- **Oracle**：Official F2P tests/test_builders/test_build_gettext.py; failure signature NameError: add_uids.
- **官方结果**：resolved=false，pass_rate=0.0769，F2P=1/13，failure signatures=["NameError: name 'add_uids' is not defined"]；report sha256 `5f9bc4dca31befd1cef5cfd6e03981958cd31df85c4433b61b036fbb45c89752`。
- **裁决**：最终 `approve`；主会话 `sdlc_verify` 序列 `['approve']`；experiment=`mvp`，arm=`sdlc`，repeat=1（来自 attribution JSON）。
- **Verifier 实际动作**：ran_project_tests, ran_own_probe, read_author_evidence, f2p_test_file_referenced（布尔口径；命令原文在 attribution data 的 `verifier_actions.evidence`）。
- **归因标签**：1=缺少/无法执行关键测试, 2=测试有运行但覆盖不足, 4=Spec/AC 未覆盖外部评分要求, 5=评分/环境/数据提取问题。
- **Source/Grader**：`conflict`；Source 层评估：`not_established_conflict`。
- **人工预期裁决**：`provisional`（low (provisional)）。候选：approve (accept explicit Source boundary)；needs_human (grading risk; missing symbols not unambiguously excluded)；reject (reviewer finds missing symbols inside promised path)。
- **去重键**：`task:sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1`；spec AC 数：10；spec sha256 `4d4209c9aac779200452753c1f65a5cbd9047dc98f76b6417b4c79968934e904`。

#### H-FP-02（V1-2；V1 FP；plugin 0.6.0 / DSH 0.2.1-rc.5）
- **Source**（`archive:fb-runs/sphinx-doc__sphinx/sdlc/prompt.txt#L4-L11`；sha256 `4bcd18e96fc985fd07e49a61c867882ec10bca856bd2c778ff99406c56bc7d1a`）：Restore the listed `Catalog.add` and `GettextRenderer.__init__` interfaces together with the renderer's directly required `render` override described below. ... General template inheritance, theme loader construction, catalog iteration, file writing and the complete internationalization builder are outside these listed implementations.
- **Outcome**：Restore the listed Catalog/GettextRenderer interfaces and their documented behavior.
- **Boundary**：The complete internationalization builder is explicitly outside the listed implementations.
- **Oracle**：Official F2P tests/test_builders/test_build_gettext.py; failure signature NameError: add_uids.
- **官方结果**：resolved=false，pass_rate=0.0769，F2P=1/13，failure signatures=["NameError: name 'add_uids' is not defined"]；report sha256 `96b4caef81b47bc0b30ba5370e8a0f6d1570fbb2c52b54b19feed7bf3458349e`。
- **裁决**：最终 `approve`；主会话 `sdlc_verify` 序列 `['approve', 'approve']`；experiment=`2x2`，arm=`sdlc_guidance`，repeat=1（来自 attribution JSON）。
- **Verifier 实际动作**：ran_project_tests, ran_own_probe, read_author_evidence, observed_official_failure_signature, f2p_test_file_referenced（布尔口径；命令原文在 attribution data 的 `verifier_actions.evidence`）。
- **归因标签**：3=Verifier 漏看代码缺陷或错误解释证据, 4=Spec/AC 未覆盖外部评分要求, 5=评分/环境/数据提取问题。
- **Source/Grader**：`conflict`；Source 层评估：`not_established_conflict`。
- **人工预期裁决**：`provisional`（low (provisional)）。候选：approve (accept explicit Source boundary)；needs_human (grading risk; missing symbols not unambiguously excluded)；reject (reviewer finds missing symbols inside promised path)。
- **去重键**：`task:sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1`；spec AC 数：10；spec sha256 `1697de63194d1ae8f568316937ff183c405cae7d3b767e42713b0da0387e357d`。

#### H-FP-03（V1-3；V1 FP；plugin 0.6.0 / DSH 0.2.1-rc.5）
- **Source**（`archive:fb-runs-expanded/sphinx-doc__sphinx.e347e59c.test_ext_doctest.530dec5f.lv1/sdlc/prompt.txt#L4-L8`；sha256 `4f55c4cf112d8b1f53285d9d7e9751cf9ff6f7b7df06419e32d2de5f4b3b797f`）：Restore only `is_allowed_version(spec, version)`. It returns whether `version` belongs to the supplied PEP 440 specifier set ... Directive execution and the rest of the doctest extension are outside this interface.
- **Outcome**：Restore only is_allowed_version(spec, version).
- **Boundary**：Directive execution and the rest of the doctest extension are outside this interface.
- **Oracle**：Official F2P tests/test_extensions/test_ext_doctest.py; failure signature DocTestBuilder.compile.
- **官方结果**：resolved=false，pass_rate=0.0909，F2P=1/11，failure signatures=["AttributeError: 'DocTestBuilder' object has no attribute 'compile'", 'NotImplementedError: Must override run() in subclass.']；report sha256 `171eee16fa9c943be040ba921dc48daca25e921439cc4466359a8eea748351cf`。
- **裁决**：最终 `approve`；主会话 `sdlc_verify` 序列 `['approve']`；experiment=`expanded`，arm=`sdlc`，repeat=1（来自 attribution JSON）。
- **Verifier 实际动作**：ran_own_probe, read_author_evidence, f2p_test_file_referenced（布尔口径；命令原文在 attribution data 的 `verifier_actions.evidence`）。
- **归因标签**：1=缺少/无法执行关键测试, 2=测试有运行但覆盖不足, 4=Spec/AC 未覆盖外部评分要求, 5=评分/环境/数据提取问题。
- **Source/Grader**：`conflict`；Source 层评估：`not_established_conflict`。
- **人工预期裁决**：`provisional`（low (provisional)）。候选：approve (accept explicit Source boundary)；needs_human (grading risk; missing symbols not unambiguously excluded)；reject (reviewer finds missing symbols inside promised path)。
- **去重键**：`task:sphinx-doc__sphinx.e347e59c.test_ext_doctest.530dec5f.lv1`；spec AC 数：12；spec sha256 `f4a34a8477df0d50499c94cb905fa667743d33ace4aee2152ba1ee0708e11093`。

#### H-FP-04（V1-4；V1 FP；plugin 0.6.0 / DSH 0.2.1-rc.5）
- **Source**（`archive:fb-runs/sphinx-doc__sphinx/sdlc/prompt.txt#L4-L11`；sha256 `4bcd18e96fc985fd07e49a61c867882ec10bca856bd2c778ff99406c56bc7d1a`）：Restore the listed `Catalog.add` and `GettextRenderer.__init__` interfaces together with the renderer's directly required `render` override described below. ... General template inheritance, theme loader construction, catalog iteration, file writing and the complete internationalization builder are outside these listed implementations.
- **Outcome**：Restore the listed Catalog/GettextRenderer interfaces and their documented behavior.
- **Boundary**：The complete internationalization builder is explicitly outside the listed implementations.
- **Oracle**：Official F2P tests/test_builders/test_build_gettext.py; failure signature NameError: add_uids.
- **官方结果**：resolved=false，pass_rate=0.0769，F2P=1/13，failure signatures=["NameError: name 'add_uids' is not defined"]；report sha256 `25bd8e9530a596f260c1e31881bfc0b8f00a56948c9d7eea565628beb997cafd`。
- **裁决**：最终 `approve`；主会话 `sdlc_verify` 序列 `['approve', 'approve']`；experiment=`verify-stress`，arm=`sdlc`，repeat=1（来自 attribution JSON）。
- **Verifier 实际动作**：ran_project_tests, ran_own_probe, read_author_evidence, f2p_test_file_referenced（布尔口径；命令原文在 attribution data 的 `verifier_actions.evidence`）。
- **归因标签**：1=缺少/无法执行关键测试, 2=测试有运行但覆盖不足, 4=Spec/AC 未覆盖外部评分要求, 5=评分/环境/数据提取问题。
- **Source/Grader**：`conflict`；Source 层评估：`not_established_conflict`。
- **人工预期裁决**：`provisional`（low (provisional)）。候选：approve (accept explicit Source boundary)；needs_human (grading risk; missing symbols not unambiguously excluded)；reject (reviewer finds missing symbols inside promised path)。
- **去重键**：`task:sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1`；spec AC 数：12；spec sha256 `31168ec05dcf2abcb37fda64a4a6dfba0d9707ea22f4790cc0f02b072b87f805`。

#### H-FP-05（V1-5；V1 FP；plugin 0.6.0 / DSH 0.2.1-rc.5）
- **Source**（`archive:fb-runs/sphinx-doc__sphinx/sdlc/prompt.txt#L4-L11`；sha256 `4bcd18e96fc985fd07e49a61c867882ec10bca856bd2c778ff99406c56bc7d1a`）：Restore the listed `Catalog.add` and `GettextRenderer.__init__` interfaces together with the renderer's directly required `render` override described below. ... General template inheritance, theme loader construction, catalog iteration, file writing and the complete internationalization builder are outside these listed implementations.
- **Outcome**：Restore the listed Catalog/GettextRenderer interfaces and their documented behavior.
- **Boundary**：The complete internationalization builder is explicitly outside the listed implementations.
- **Oracle**：Official F2P tests/test_builders/test_build_gettext.py; failure signature NameError: add_uids.
- **官方结果**：resolved=false，pass_rate=0.0769，F2P=1/13，failure signatures=["NameError: name 'add_uids' is not defined"]；report sha256 `eb6d29fe2571a4bf3cd53064d0e3fc3a43bf269d2ab3e131248033e075c31090`。
- **裁决**：最终 `approve`；主会话 `sdlc_verify` 序列 `['approve']`；experiment=`repeat-sampling`，arm=`sdlc`，repeat=1（来自 attribution JSON）。
- **Verifier 实际动作**：ran_project_tests, ran_own_probe, read_author_evidence, f2p_test_file_referenced（布尔口径；命令原文在 attribution data 的 `verifier_actions.evidence`）。
- **归因标签**：1=缺少/无法执行关键测试, 2=测试有运行但覆盖不足, 4=Spec/AC 未覆盖外部评分要求, 5=评分/环境/数据提取问题。
- **Source/Grader**：`conflict`；Source 层评估：`not_established_conflict`。
- **人工预期裁决**：`provisional`（low (provisional)）。候选：approve (accept explicit Source boundary)；needs_human (grading risk; missing symbols not unambiguously excluded)；reject (reviewer finds missing symbols inside promised path)。
- **去重键**：`task:sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1`；spec AC 数：9；spec sha256 `0f9758cbaf3d76e2b6b593fa5410b1cc2c688ea4efcb074e055bfff189f55ecd`。

#### H-FP-06（V1-6；V1 FP；plugin 0.6.0 / DSH 0.2.1-rc.5）
- **Source**（`archive:fb-runs/sphinx-doc__sphinx/sdlc/prompt.txt#L4-L11`；sha256 `4bcd18e96fc985fd07e49a61c867882ec10bca856bd2c778ff99406c56bc7d1a`）：Restore the listed `Catalog.add` and `GettextRenderer.__init__` interfaces together with the renderer's directly required `render` override described below. ... General template inheritance, theme loader construction, catalog iteration, file writing and the complete internationalization builder are outside these listed implementations.
- **Outcome**：Restore the listed Catalog/GettextRenderer interfaces and their documented behavior.
- **Boundary**：The complete internationalization builder is explicitly outside the listed implementations.
- **Oracle**：Official F2P tests/test_builders/test_build_gettext.py; failure signature NameError: add_uids.
- **官方结果**：resolved=false，pass_rate=0.0769，F2P=1/13，failure signatures=["NameError: name 'add_uids' is not defined"]；report sha256 `69371515dbd65242386175e4d5bc774919fc5cf671ff5f17573492abb425cddb`。
- **裁决**：最终 `approve`；主会话 `sdlc_verify` 序列 `['approve', 'approve']`；experiment=`repeat-sampling`，arm=`sdlc`，repeat=2（来自 attribution JSON）。
- **Verifier 实际动作**：ran_real_build, ran_project_tests, ran_own_probe, read_author_evidence, observed_official_failure_signature, f2p_test_file_referenced（布尔口径；命令原文在 attribution data 的 `verifier_actions.evidence`）。
- **归因标签**：3=Verifier 漏看代码缺陷或错误解释证据, 4=Spec/AC 未覆盖外部评分要求, 5=评分/环境/数据提取问题。
- **Source/Grader**：`conflict`；Source 层评估：`not_established_conflict`。
- **人工预期裁决**：`provisional`（low (provisional)）。候选：approve (accept explicit Source boundary)；needs_human (grading risk; missing symbols not unambiguously excluded)；reject (reviewer finds missing symbols inside promised path)。
- **去重键**：`task:sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1`；spec AC 数：9；spec sha256 `0eea367ab9050f80ab7235f423eccec393b4248448df7047731e9ec3e8d8282f`。

#### H-FP-07（V1-7；V1 FP；plugin 0.6.0 / DSH 0.2.1-rc.5）
- **Source**（`archive:fb-runs/sphinx-doc__sphinx/sdlc/prompt.txt#L4-L11`；sha256 `4bcd18e96fc985fd07e49a61c867882ec10bca856bd2c778ff99406c56bc7d1a`）：Restore the listed `Catalog.add` and `GettextRenderer.__init__` interfaces together with the renderer's directly required `render` override described below. ... General template inheritance, theme loader construction, catalog iteration, file writing and the complete internationalization builder are outside these listed implementations.
- **Outcome**：Restore the listed Catalog/GettextRenderer interfaces and their documented behavior.
- **Boundary**：The complete internationalization builder is explicitly outside the listed implementations.
- **Oracle**：Official F2P tests/test_builders/test_build_gettext.py; failure signature NameError: add_uids.
- **官方结果**：resolved=false，pass_rate=0.0769，F2P=1/13，failure signatures=["NameError: name 'add_uids' is not defined"]；report sha256 `61488f3c0b321cde5acfa05609f84c0b97032d51c4865e4cecdc586bcf978363`。
- **裁决**：最终 `approve`；主会话 `sdlc_verify` 序列 `['approve']`；experiment=`repeat-sampling`，arm=`sdlc`，repeat=3（来自 attribution JSON）。
- **Verifier 实际动作**：ran_project_tests, ran_own_probe, read_author_evidence, f2p_test_file_referenced（布尔口径；命令原文在 attribution data 的 `verifier_actions.evidence`）。
- **归因标签**：1=缺少/无法执行关键测试, 2=测试有运行但覆盖不足, 4=Spec/AC 未覆盖外部评分要求, 5=评分/环境/数据提取问题。
- **Source/Grader**：`conflict`；Source 层评估：`not_established_conflict`。
- **人工预期裁决**：`provisional`（low (provisional)）。候选：approve (accept explicit Source boundary)；needs_human (grading risk; missing symbols not unambiguously excluded)；reject (reviewer finds missing symbols inside promised path)。
- **去重键**：`task:sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1`；spec AC 数：10；spec sha256 `2b3d8da547a055f297be48ea25ecba5855b16bfbc97ac2905216259259bcdced`。

#### H-FP-08（V2；V2 FP；plugin 0.6.1 / DSH 0.2.2-rc.1）
- **Source**（`archive:fb-runs/sphinx-doc__sphinx/sdlc/prompt.txt#L4-L11`；sha256 `4bcd18e96fc985fd07e49a61c867882ec10bca856bd2c778ff99406c56bc7d1a`）：Restore the listed `Catalog.add` and `GettextRenderer.__init__` interfaces together with the renderer's directly required `render` override described below. ... General template inheritance, theme loader construction, catalog iteration, file writing and the complete internationalization builder are outside these listed implementations.
- **Outcome**：Restore the listed Catalog/GettextRenderer interfaces and their documented behavior.
- **Boundary**：The complete internationalization builder is explicitly outside the listed implementations.
- **Oracle**：Official F2P tests/test_builders/test_build_gettext.py; failure signature NameError: add_uids.
- **官方结果**：resolved=false，pass_rate=0.0769，F2P=1/13，failure signatures=["NameError: name 'add_uids' is not defined"]；report sha256 `e694b0c90db8541c4ede6cb30b80694bac709614745cf64a3e4200d7952ac642`。
- **裁决**：最终 `approve`；主会话 `sdlc_verify` 序列 `['approve', 'approve']`；experiment=`version-regression-mvp`，arm=`sdlc`，repeat=1（来自 attribution JSON）。
- **Verifier 实际动作**：ran_project_tests, ran_own_probe, read_author_evidence, f2p_test_file_referenced（布尔口径；命令原文在 attribution data 的 `verifier_actions.evidence`）。
- **归因标签**：1=缺少/无法执行关键测试, 2=测试有运行但覆盖不足, 4=Spec/AC 未覆盖外部评分要求, 5=评分/环境/数据提取问题。
- **Source/Grader**：`conflict`；Source 层评估：`not_established_conflict`。
- **人工预期裁决**：`provisional`（low (provisional)）。候选：approve (accept explicit Source boundary)；needs_human (grading risk; missing symbols not unambiguously excluded)；reject (reviewer finds missing symbols inside promised path)。
- **去重键**：`task:sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1`；spec AC 数：11；spec sha256 `79281270df39ccb86eb8457fec70024e9afc8423943a08cac86f4587d0cc39e0`。

#### H-FN-01（FN-1；FN；plugin 0.6.1 / DSH 0.2.2-rc.1）
- **Source**（`archive:fb-runs-regression-mvp/mwaskom__seaborn.7001ebe7.test_algorithms.1f0181c2.lv1/sdlc/prompt.txt#L1-L13`；sha256 `a0ac2b52058f99a281d2a7e01ec8c7cb90e280ef9b962951519c76ff7ff66a08`）：Implement a bootstrap resampling algorithm that performs statistical resampling with replacement on one or more input arrays ... Enables structured resampling ... Provides reproducible results through random seed control.
- **Outcome**：Implement bootstrap resampling with the documented arguments, warnings and reproducibility.
- **Boundary**：Task statement covers bootstrap and its interface; no explicit official-test exclusion.
- **Oracle**：Official F2P tests/test_algorithms.py (13/13 pass in the archived run).
- **官方结果**：resolved=true，pass_rate=1.0，F2P=13/13，failure signatures=—；report sha256 `2c946bcea18de3e92454f0ca3039ee5820a62f78bd880efdea672a2e2b25ef0d`。
- **裁决**：最终 `reject`；主会话 `sdlc_verify` 序列 `['reject']`；experiment=`version-regression-mvp`，arm=`sdlc`，repeat=1（来自 attribution JSON）。
- **Verifier 实际动作**：ran_project_tests, ran_own_probe, read_author_evidence, f2p_test_file_referenced（布尔口径；命令原文在 attribution data 的 `verifier_actions.evidence`）。
- **归因标签**：6=证据不足。
- **Source/Grader**：`unknown`；Source 层评估：`censored`。
- **人工预期裁决**：`unknown`（high (censoring fact); unknown (label)）。
- **去重键**：`task:mwaskom__seaborn.7001ebe7.test_algorithms.1f0181c2.lv1`；spec AC 数：15；spec sha256 `d44201ed000abceef04287c05d19d9388162c6bbfc6aa2133f3b127afc1029b2`。
- **不可用/删失原因**：agent_failure=timeout（删失）：最后一次 sdlc_verify 无 result（超时截断），官方 resolved=1.0 与 reject 矛盾，无法区分删失与误判

#### H-FN-02（FN-2；FN；plugin 0.6.1 / DSH 0.2.2-rc.1）
- **Source**（`archive:fb-runs-regression-mvp/pypa__packaging.013f3b03.test_metadata.e00b5801.lv1/sdlc/prompt.txt#L1-L15`；sha256 `42ee88d831cf9fb157ef096e2b0c2c706dc31f148cfa5e5a269cdc84ba7a7225`）：Python Package Metadata Processing and Validation: parse and validate Python package metadata ... handle requirement strings ... support multiple metadata versions (1.0-2.5) ... convert metadata back to RFC822 format.
- **Outcome**：Implement metadata processing/validation and RFC822 serialization described by the task statement.
- **Boundary**：Task statement covers metadata processing; no explicit official-test exclusion.
- **Oracle**：Official F2P tests/test_metadata.py (294/294 pass in the archived run).
- **官方结果**：resolved=true，pass_rate=1.0，F2P=294/294，failure signatures=—；report sha256 `801e2f31e5024a0e1da0875a8dcd69dda82c751f824b70dcc82e4e4ea1e0f944`。
- **裁决**：最终 `reject`；主会话 `sdlc_verify` 序列 `['approve', 'reject']`；experiment=`version-regression-mvp`，arm=`sdlc`，repeat=1（来自 attribution JSON）。
- **Verifier 实际动作**：ran_project_tests, ran_own_probe, read_author_evidence, f2p_test_file_referenced（布尔口径；命令原文在 attribution data 的 `verifier_actions.evidence`）。
- **归因标签**：6=证据不足。
- **Source/Grader**：`unknown`；Source 层评估：`censored`。
- **人工预期裁决**：`unknown`（high (censoring fact); unknown (label)）。
- **去重键**：`task:pypa__packaging.013f3b03.test_metadata.e00b5801.lv1`；spec AC 数：11；spec sha256 `15d95b69378e7fa216f2cc0523b6e56ea5c8d93dbe57451abc1e15ca669379f2`。
- **不可用/删失原因**：agent_failure=timeout（删失）：最终 reject 依据 packaging 26.3 后置修复而非任务/官方 26.0 oracle，且第 2 次验证被插件拒绝；删失使归因不可定

#### H-FN-03（FN-3；FN；plugin 0.6.0 / DSH 0.2.1-rc.5）
- **Source**（`archive:fb-runs-regression-mvp/mwaskom__seaborn.7001ebe7.test_algorithms.1f0181c2.lv1/sdlc/prompt.txt#L1-L13`；sha256 `a0ac2b52058f99a281d2a7e01ec8c7cb90e280ef9b962951519c76ff7ff66a08`）：Implement a bootstrap resampling algorithm that performs statistical resampling with replacement on one or more input arrays ... Enables structured resampling ... Provides reproducible results through random seed control.
- **Outcome**：Implement bootstrap resampling with the documented arguments, warnings and reproducibility.
- **Boundary**：Task statement covers bootstrap and its interface; no explicit official-test exclusion.
- **Oracle**：Official F2P tests/test_algorithms.py (13/13 pass in the archived run).
- **官方结果**：resolved=true，pass_rate=1.0，F2P=13/13，failure signatures=—；report sha256 `36117a1a14d3565cbc604dde33248acc3a0dc31cb10df9d4a0b88043c9befa27`。
- **裁决**：最终 `reject`；主会话 `sdlc_verify` 序列 `['reject']`；experiment=`repeat-sampling`，arm=`sdlc`，repeat=2（来自 attribution JSON）。
- **Verifier 实际动作**：ran_project_tests, ran_own_probe, read_author_evidence, f2p_test_file_referenced（布尔口径；命令原文在 attribution data 的 `verifier_actions.evidence`）。
- **归因标签**：6=证据不足。
- **Source/Grader**：`unknown`；Source 层评估：`censored`。
- **人工预期裁决**：`unknown`（high (censoring fact); unknown (label)）。
- **去重键**：`task:mwaskom__seaborn.7001ebe7.test_algorithms.1f0181c2.lv1`；spec AC 数：14；spec sha256 `27399a9fe8475556282479ec3fab860e2442b4230591ae797848fe71786782c5`。
- **不可用/删失原因**：agent_failure=timeout（删失）：第 3 次 sdlc_verify 无 result（超时截断），官方 resolved=1.0 与 reject 矛盾，无法区分删失与误判

---
## 5. 合成案例（#21 的 6 个离线场景；Phase 1 只跑 1/2/3）
| case | 类别 | 预期裁决 | 说明 | fixture |
|---|---|---|---|---|
| S-01 | positive | `approve` | CSV export with header/rows; missing amount exits non-zero. | [offline fixtures](ac-validity-1c-offline-fixtures.md#s21-1) |
| S-02 | gap | `reject` | CLI empty-date path exits 0 with warning; parse_date returns None. | [offline fixtures](ac-validity-1c-offline-fixtures.md#s21-2) |
| S-03 | out_of_scope | `approve` | parse_date('') returns None; non-empty dates unchanged. | [offline fixtures](ac-validity-1c-offline-fixtures.md#s21-3) |
| S-04 | evidence_missing | `needs_human` | mycli run completes without exception. | [offline fixtures](ac-validity-1c-offline-fixtures.md#s21-4) |
| S-05 | unrelated_failure | `approve` | Invalid input error path; valid input unchanged. | [offline fixtures](ac-validity-1c-offline-fixtures.md#s21-5) |
| S-06 | ambiguity | `needs_human` | Unspecified until symbols/scope/fixture are clarified. | [offline fixtures](ac-validity-1c-offline-fixtures.md#s21-6) |

这些行的 `label_status=design_only`：它们是 #21 的离线设计材料，没有真实模型运行结果；Phase 1 才用固定输入和两臂验证。

---
## 6. 审查者待办（provisional labels）
1. 逐个决定 8 个官方 FP 的 Source 层标签：`approve`（接受 Source 排除句）、`needs_human`（排除句不足以覆盖官方失败面/证据冲突）或 `reject`（缺失符号属于承诺路径）。决定必须写理由，并同步修改 JSON 的 `expected_verdict` / `label_status` / `source_layer_assessment`。
2. 3 个 FN 保持 `censored`，除非能补齐缺失的最后一次 `sdlc_verify` 结果；不要把 `official resolved=1.0` 直接当成 Source 层正确，也不要把 `reject` 直接当成误判。
3. 合成案例的预期裁决由 #21 文案给；审查者只需确认它们与 Source/Grader 边界一致。

## 7. 本表不证明什么
- 不证明 #20/#21 减少了错误放行；真实模型 A/B 尚未执行。
- 不证明官方 `resolved` 等于用户目标；本表已把二者分开。
- 不把 8 个官方 FP 当作 8 个独立 Source 层样本；去重后只有 2 个 task。
- 不把 3 个删失 FN 当作验证者误判。
