# verify01：VERIFY-01 分析/实验工具

对应 GitHub issue **HMYDK/ai-native-sdlc-dsh#16**（Step 1 归因、Step 4 A/B 汇总）。
本目录只有分析工具，不含 verifier 代码改动。

- `attribute_cases.py` —— 从本机只读原始归档重算 11 个案例的
  `sdlc_verify` 裁决来源、官方评分结果、spec/AC、verifier 子会话动作，并附上
  Step 1 归因标签（标签是人工复核结论，以常量形式固化，便于复跑得到同一份数据）。
- `summarize_ab.py` —— 从 A/B runs 目录聚合 Step 4 指标：官方 resolved、
  verifier 裁决序列（主会话 callId 配对）、token/耗时/失败分类，输出机读 JSON +
  markdown 表。**分母口径全部显式列出、不插补缺失值**。
- 产物（生成/维护于 `docs/evals/`，不在本目录）：
  - `docs/evals/verify-01-attribution.md`（可读归因表 + 失败模式 + 数据限制）
  - `docs/evals/verify-01-attribution-data.json`（机读版，无本机绝对路径）
  - `docs/evals/verify-01-experiment-data.json`（Step 4 机读结果）

## 用法

```bash
# 依赖：Python 3.9+ + zstandard（本机可用 eval 环境）
PY=~/.local/share/uv/tools/featurebench/bin/python

# 默认归档根：$DSH_EVAL_ARCHIVE_ROOT，否则 ~/.dsh-eval-archive/2026-11-08
$PY tools/evals/verify01/attribute_cases.py --pretty            # stdout

# 生成 docs 里的数据文件（本仓库当前 JSON 即此命令产物）
$PY tools/evals/verify01/attribute_cases.py \
  --archive-root ~/.dsh-eval-archive/2026-11-08 \
  --pretty --out docs/evals/verify-01-attribution-data.json
```

可选参数：`--archive-root`、`--out`、`--pretty`。默认 stdout JSON。

## 输入归档结构（只读）

脚本只读下列约定路径（`<archive-root>` 下）：

```
fb-runs*/                          # 每组实验一个目录
  <repo>/<task_id>/<arm>/          # 或 fb-runs-stress/repN/<task>/<arm> 等扁平化
    meta.json                      # task/arm/repeat?/agent_failure/plugin_version/dsh_cli
    prompt.txt                     # 任务说明（FeatureBench task statement）
    patch.diff                     # agent 代码补丁（不含 .ai/ 制品）
    eval_outputs/<task_id>/attempt-1/
      report.json                  # 官方逐 F2P/P2P 结果（resolved/pass_rate）
      test_output.txt              # 官方 pytest 输出（失败栈/错误签名）
    sessions/sessions/--testbed--/
      session-<uuid>/session.v4.jsonl.zstd     # 主会话（作者 + sdlc_verify 调用）
      <uuid>/session.v4.jsonl.zstd             # 验证者子会话（origin=subagent）
```

## 提取口径（与 #15 一致）

1. 只扫描**主会话**（目录名以 `session-` 开头）的 `tool/call`，且 `data.name == "sdlc_verify"`。
2. 按 `data.callId == tool/result.data.message.toolCallId` 配对；文本里出现的
   `sdlc_verify` 字样、验证者子会话里的同名 JSON 都不计数。
3. 最终裁决 = 最后一个**有结构化 payload 且非 `isError`** 的 `status`（缺 `status` 回退
   `raw_status`）。`isError` 记为 `error`，没有 tool/result（timeout 截断）记为 `no_result`，
   两者都不产生裁决。JSON 里保留 `main_verify_calls_without_result` 便于审计。
4. 结果与 canonical `docs/evals/featurebench-runs.jsonl` 的 `verify_verdicts` 逐案例比对
   （字段 `canonical_consistency`）；11/11 一致。
5. spec/AC 来自主会话最后一次 `kind=spec` 的 `sdlc_artifact_write` 内容，按 `- AC-xxx:` 行解析。
6. verifier 动作来自子会话 bash 命令分类：`real_build`（`python -m sphinx` / `sphinx-build`）、
   `project_tests`（`pytest`）、`own_probe`（写/跑 `/tmp` 自写脚本）、`read_author_evidence`
   （读 `.ai/rsi` / `.ai/tasks`）；`observed_official_failure_signature` 用官方失败签名的
   精确串匹配（gettext: `add_uids`；doctest: `DocTestBuilder' object has no attribute 'compile'`）。

## 边界

- **只读**：不写归档、不联网、不调模型。只有 `--out` 时写一个文件。
- **依赖归档存在**：raw run 目录不入库（L2）；离开本机归档无法重跑本表，脚本会报错退出。
- **不重跑官方评分**：官方 F2P 测试文件在 testbed 中被隐藏，结果只来自归档的
  `eval_outputs/`；脚本不假装重新评分。
- **repN ↔ rN 映射**：verify-stress / repeat-sampling 的目录是 `rep1|rep2|rep3`，
  与 canonical run_id 的 `rN` 对应关系不是靠目录名断言，而是靠“主会话有效裁决序列 +
  官方 resolved”与 canonical 记录逐项对齐（脚本运行结果中的 `canonical_consistency`
  可直接复核；V1-4/V1-5/V1-6/V1-7/FN 的映射均在 JSON 的 run_id 与序列上可对照）。
- **标签是分析结论**：`attribution_labels` 依赖脚本里的常量（人工复核后的结论），
  每个标签都带独立证据文本；事实部分（调用/官方/spec/动作/哈希）由脚本重算。
  新增案例时需同时更新 `CASES`、`LABELS`、`CASE_CONFIDENCE`。
- **不要把本脚本当 verifier 判据**：它只提取历史证据，不评估代码质量。
