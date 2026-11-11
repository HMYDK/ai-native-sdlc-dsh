#!/usr/bin/env python3
"""VERIFY-01 A/B experiment results → machine-readable rows + aggregate metrics.

对应 GitHub issue HMYDK/ai-native-sdlc-dsh#16 的 AC-005 / AC-006：
两臂（A = 原版 verifier，B = 仅改 verifier 策略）在同一预注册任务上的
真实模型运行，官方 FeatureBench `fb eval` 评分。本脚本**只读** runs 目录
（不联网、不调模型、不写 runs），把每个 run 的官方结果、verifier 裁决、
token/耗时/失败分类与分母口径整理成可复算的 JSON，并可输出 markdown 表。

口径（与 docs/evals/verify-01-attribution.md §2 一致）：
- verifier 裁决只取**主会话** `sdlc_verify` 的 tool/call，按 callId 与
  tool/result 配对；isError 的 result 与没有 result 的调用不产生裁决；
- 最终裁决 = 最后一个结构化 verdict.status（缺失回退 raw_status）；
- 官方结果只取 `fb eval` 写出的逐实例 `report.json`（resolved/pass_rate/F2P），
  不采用 agent 自报的 DONE/approve；
- 分母显式给出：attempts / scoreable（有官方 report）/ decided（有裁决）/
  approve / reject / needs_human / no_verdict；不对缺失值做插补。

用法::

    PY=~/.local/share/uv/tools/featurebench/bin/python
    $PY tools/evals/verify01/summarize_ab.py \
        --runs-root /tmp/fb-verify01/runs \
        --out docs/evals/verify-01-experiment-data.json \
        --md docs/evals/verify-01-experiment.md

runs 目录约定（`run_arm.py` / `run_matrix.py` 的输出）::

    <runs-root>/<task_id>/<arm>/          # meta.json / patch.diff / sessions/
    <runs-root>/<task_id>/eval-<arm>/report.json   # 官方评分（或 arm 下同名）

边界：原始 runs（含 session/prompt）不入库；入库的只是本脚本产出的聚合数据。
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import attribute_cases as ac  # noqa: E402  (同目录复用会话解析/官方报告提取)

EXPERIMENT = "verify-01"
ARMS = ("A", "B")  # 展示顺序；实际 arm 名从 run 目录读取


# ---------------------------------------------------------------------------
# run 发现与逐 run 提取
# ---------------------------------------------------------------------------
def find_official_report(arm_dir: Path, task_id: str) -> tuple[Path | None, dict[str, Any]]:
    """找官方逐实例 report.json 并返回 (path, instance payload)。

    兼容 run_matrix 的几种落盘位置（按优先级）：
    1. `<arm>/eval_outputs/<task>/attempt-1/report.json`
    2. `<task>/eval-<arm>/report.json` 内的 `attempt_1` 汇总（只有 resolved/pass_rate）
    3. `<arm>/report.json`
    第 2 种没有逐测试明细时仍可作为官方 resolved 来源（fb eval 写的 summary），
    但要标 `report_shape=summary`，不能拿它冒充逐测试证据。
    """
    candidates = [
        arm_dir / "eval_outputs" / task_id / "attempt-1" / "report.json",
        arm_dir.parent / f"eval-{arm_dir.name}" / "report.json",
        arm_dir / f"eval-{arm_dir.name}" / "report.json",
        arm_dir / "report.json",
    ]
    for path in candidates:
        if not path.is_file():
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if "attempt_1" in payload and "resolved_instances" in (payload.get("attempt_1") or {}):
            summary = payload["attempt_1"]
            return path, {
                "report_shape": "summary",
                "resolved": bool(summary.get("resolved_instances")),
                "pass_rate": summary.get("pass_rate"),
                "f2p_failed": [],
                "f2p_success": [],
                "p2p_failed": [],
                "p2p_success_count": None,
                "resolved_instances": summary.get("resolved_instances"),
                "total_instances": summary.get("total_instances"),
            }
        instance = payload.get(task_id)
        if isinstance(instance, dict) and "resolved" in instance:
            tests = instance.get("tests_status") or {}
            f2p = tests.get("FAIL_TO_PASS") or {}
            p2p = tests.get("PASS_TO_PASS") or {}
            return path, {
                "report_shape": "per_instance",
                "resolved": instance.get("resolved"),
                "pass_rate": instance.get("pass_rate"),
                "f2p_failed": list(f2p.get("failure") or []),
                "f2p_success": list(f2p.get("success") or []),
                "p2p_failed": list(p2p.get("failure") or []),
                "p2p_success_count": len(p2p.get("success") or []),
                "resolved_instances": 1 if instance.get("resolved") else 0,
                "total_instances": 1,
            }
    return None, {}


def bucket_for(final_verdict: str | None, official_resolved: bool | None) -> str:
    """Verifier 裁决 × 官方 resolved 的混淆 bucket（官方缺失单列）。"""
    if official_resolved is None:
        return "official_missing"
    if final_verdict is None:
        return "no_verdict_resolved" if official_resolved else "no_verdict_unresolved"
    if final_verdict == "approve":
        return "approve_resolved" if official_resolved else "approve_unresolved_false_positive"
    if final_verdict == "reject":
        return "reject_resolved_false_negative" if official_resolved else "reject_unresolved"
    if final_verdict == "needs_human":
        return "needs_human_resolved" if official_resolved else "needs_human_unresolved"
    return f"unknown_verdict:{final_verdict}"


def collect_run(runs_root: Path, arm_dir: Path, task_id: str | None = None) -> dict[str, Any]:
    arm = arm_dir.name
    task_id = task_id or arm_dir.parent.name
    rel = lambda p: (Path(p).resolve().relative_to(runs_root.resolve()).as_posix()  # noqa: E731
                    if Path(p).resolve().is_relative_to(runs_root.resolve()) else None)
    row: dict[str, Any] = {
        "task_id": task_id,
        "arm": arm,
        "run_dir": rel(arm_dir),
        "meta": {},
        "official": {},
        "verifier": {},
        "verdict_bucket": None,
        "run_status": None,
    }
    meta_path = arm_dir / "meta.json"
    if meta_path.is_file():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        row["meta"] = {
            k: meta.get(k)
            for k in (
                "started_at", "elapsed_seconds", "token_usage", "token_usage_source",
                "agent_completed", "agent_failure", "aborted", "patch_chars",
                "patch_sha256", "plugin_version_actual", "dsh_cli_actual",
                "image_digest", "sdlc_tool_calls", "policy", "repeat",
            )
        }
    else:
        row["run_status"] = "missing_meta"

    report_path, official = find_official_report(arm_dir, task_id)
    official["report_rel"] = rel(report_path) if report_path else None
    official["report_sha256"] = ac.sha256_file(str(report_path)) if report_path else None
    row["official"] = official

    main_session, children = ac.session_paths(str(arm_dir))
    main_events = ac.read_session(main_session) if main_session else []
    verify_calls, unmatched_results, calls_without_result = ac.extract_verify_calls(main_events)
    seq = ac.verdict_sequence(verify_calls)
    final = ac.final_verdict(verify_calls)
    verifier_sessions = [(name, ac.read_session(path)) for name, path in children]
    actions = ac.classify_verifier_actions(
        ([("main", main_events, "main")] if main_events else [])
        + [(name, events, "child") for name, events in verifier_sessions],
        f2p_test_file="",
        signature_needles=[],
    )
    row["verifier"] = {
        "main_session_rel": rel(main_session) if main_session else None,
        "verifier_session_count": len(verifier_sessions),
        "verify_calls": len(verify_calls),
        "verify_calls_without_result": calls_without_result,
        "unmatched_results": unmatched_results,
        "verdict_sequence": seq,
        "final_verdict": final,
        "ran_real_build": actions["ran_real_build"],
        "ran_project_tests": actions["ran_project_tests"],
        "ran_own_probe": actions["ran_own_probe"],
        "read_author_evidence": actions["read_author_evidence"],
        "real_build_commands": actions["evidence"]["real_build_commands"],
    }
    resolved = official.get("resolved") if official else None
    row["verdict_bucket"] = bucket_for(final, resolved)
    if row["run_status"] is None:
        if meta_path.is_file() and row["meta"].get("agent_completed") is not True:
            row["run_status"] = "agent_incomplete"
        elif meta_path.is_file() and row["meta"].get("agent_failure"):
            row["run_status"] = "agent_failure"
        elif report_path is None:
            row["run_status"] = "official_missing"
        else:
            row["run_status"] = "complete"
    return row


def discover_runs(runs_root: Path) -> list[tuple[Path, str]]:
    """返回 (arm_dir, task_id) 列表。

    支持两种布局（pilot 用单层，正式矩阵用两层）：
    - `<runs-root>/<task_id>/<arm>/meta.json`
    - `<runs-root>/<arm>/meta.json`（task_id 取 meta.json 里的 task_id）
    """
    found: list[tuple[Path, str]] = []
    for meta in sorted(runs_root.glob("*/*/meta.json")):
        found.append((meta.parent, meta.parent.parent.name))
    for meta in sorted(runs_root.glob("*/meta.json")):
        try:
            task_id = json.loads(meta.read_text(encoding="utf-8")).get("task_id")
        except Exception:
            task_id = None
        if task_id:
            found.append((meta.parent, task_id))
    return found


# ---------------------------------------------------------------------------
# 聚合（所有分母显式给出，不插补缺失值）
# ---------------------------------------------------------------------------
def _median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def aggregate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    def is_complete(r: dict[str, Any]) -> bool:
        return r["run_status"] == "complete"

    arms = sorted({r["arm"] for r in rows})
    out: dict[str, Any] = {
        "experiment": EXPERIMENT,
        "generated_by": "tools/evals/verify01/summarize_ab.py",
        "runs_root_layout": "<task_id>/<arm>/{meta.json,patch.diff,sessions/}; official via fb eval report.json",
        "denominator_policy": {
            "attempts": "发现的全部 run（含 agent 失败、超时、缺官方评分）",
            "scoreable": "有官方 report.json 的 run（resolved 可判定）",
            "decided": "主会话有结构化 sdlc_verify 最终裁决的 run",
            "no_verdict": "decided 的补集；其中 agent_failure/timeout 是删失，不当通过或失败",
            "tokens": "只对 meta.token_usage 非空的 run 求和/取中位数，不对缺失值插补",
            "verdict_bucket": "verifier 最终裁决 × 官方 resolved；approve_unresolved 为假阳性",
        },
        "arms": {},
        "paired": {},
        "runs": rows,
    }
    for arm in arms:
        subset = [r for r in rows if r["arm"] == arm]
        complete = [r for r in subset if is_complete(r)]
        scoreable = [r for r in subset if r["official"].get("resolved") is not None]
        decided = [r for r in subset if r["verifier"]["final_verdict"] is not None]
        buckets: dict[str, int] = {}
        for r in subset:
            buckets[r["verdict_bucket"]] = buckets.get(r["verdict_bucket"], 0) + 1
        tokens = [r["meta"]["token_usage"] for r in subset
                  if isinstance(r["meta"].get("token_usage"), (int, float))]
        elapsed = [r["meta"]["elapsed_seconds"] for r in subset
                   if isinstance(r["meta"].get("elapsed_seconds"), (int, float))]
        out["arms"][arm] = {
            "attempts": len(subset),
            "completed": len(complete),
            "agent_failures": sum(1 for r in subset
                                  if r["meta"].get("agent_failure") or r["run_status"] == "agent_incomplete"),
            "scoreable": len(scoreable),
            "official_resolved": sum(1 for r in scoreable if r["official"]["resolved"]),
            "official_resolved_rate_on_scoreable": (
                sum(1 for r in scoreable if r["official"]["resolved"]) / len(scoreable)
                if scoreable else None
            ),
            "decided": len(decided),
            "approve": sum(1 for r in subset if r["verifier"]["final_verdict"] == "approve"),
            "reject": sum(1 for r in subset if r["verifier"]["final_verdict"] == "reject"),
            "needs_human": sum(1 for r in subset if r["verifier"]["final_verdict"] == "needs_human"),
            "no_verdict": len(subset) - len(decided),
            "verifier_ran_real_build": sum(1 for r in subset if r["verifier"]["ran_real_build"]),
            "buckets": dict(sorted(buckets.items())),
            "tokens": {
                "sum": sum(tokens) if tokens else None,
                "median": _median(tokens),
                "n_with_value": len(tokens),
            },
            "elapsed_seconds": {
                "median": _median(elapsed),
                "sum": sum(elapsed) if elapsed else None,
                "n_with_value": len(elapsed),
            },
        }
    # 配对：同一 task 恰好两臂时配对（arm 名不做硬编码，按字典序取两臂）。
    by_task: dict[str, dict[str, dict[str, Any]]] = {}
    for r in rows:
        by_task.setdefault(r["task_id"], {}).setdefault(r["arm"], r)
    pairs = []
    for task_id, arms_map in sorted(by_task.items()):
        arm_names = sorted(arms_map)
        if len(arm_names) != 2:
            continue
        a_name, b_name = arm_names
        a, b = arms_map[a_name], arms_map[b_name]
        pairs.append({
            "task_id": task_id,
            "arm_a": a_name,
            "arm_b": b_name,
            "A": {
                "resolved": a["official"].get("resolved"),
                "final_verdict": a["verifier"]["final_verdict"],
                "bucket": a["verdict_bucket"],
                "token_usage": a["meta"].get("token_usage"),
                "elapsed_seconds": a["meta"].get("elapsed_seconds"),
            },
            "B": {
                "resolved": b["official"].get("resolved"),
                "final_verdict": b["verifier"]["final_verdict"],
                "bucket": b["verdict_bucket"],
                "token_usage": b["meta"].get("token_usage"),
                "elapsed_seconds": b["meta"].get("elapsed_seconds"),
            },
        })
    out["paired"] = {
        "n_pairs": len(pairs),
        "official_resolved": {
            "A": sum(1 for p in pairs if p["A"]["resolved"]),
            "B": sum(1 for p in pairs if p["B"]["resolved"]),
            "both": sum(1 for p in pairs if p["A"]["resolved"] and p["B"]["resolved"]),
            "A_only": sum(1 for p in pairs if p["A"]["resolved"] and not p["B"]["resolved"]),
            "B_only": sum(1 for p in pairs if not p["A"]["resolved"] and p["B"]["resolved"]),
            "neither": sum(1 for p in pairs if not p["A"]["resolved"] and not p["B"]["resolved"]),
        },
        "verdict_transitions": {
            f"{p['A']['final_verdict']}->{p['B']['final_verdict']}": 1 for p in pairs
        },
        "pairs": pairs,
    }
    transitions: dict[str, int] = {}
    for p in pairs:
        key = f"{p['A']['final_verdict']}->{p['B']['final_verdict']}"
        transitions[key] = transitions.get(key, 0) + 1
    out["paired"]["verdict_transitions"] = dict(sorted(transitions.items()))
    return out


# ---------------------------------------------------------------------------
# markdown 渲染
# ---------------------------------------------------------------------------
def render_markdown(data: dict[str, Any]) -> str:
    lines = [
        "# VERIFY-01 真实模型 A/B 数据（由脚本生成）",
        "",
        "> 生成器：`tools/evals/verify01/summarize_ab.py`；数值全部来自 runs 目录里的",
        "> `meta.json`、主会话 `sdlc_verify` tool/result 与官方 `fb eval` 的 `report.json`。",
        "> 分母口径见 [experiment data](./verify-01-experiment-data.json) 的 `denominator_policy`。",
        "",
        "## 各臂",
        "",
        "| 臂 | attempts | scoreable | 官方 resolved | approve | reject | needs_human | 无裁决 | 实跑真实入口 | 总 token | 中位耗时(s) |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for arm, agg in data["arms"].items():
        tokens = agg["tokens"]["sum"]
        lines.append(
            f"| {arm} | {agg['attempts']} | {agg['scoreable']} | "
            f"{agg['official_resolved']}/{agg['scoreable']} | {agg['approve']} | {agg['reject']} | "
            f"{agg['needs_human']} | {agg['no_verdict']} | {agg['verifier_ran_real_build']} | "
            f"{tokens if tokens is not None else 'n/a'} | "
            f"{agg['elapsed_seconds']['median'] if agg['elapsed_seconds']['median'] is not None else 'n/a'} |"
        )
    lines += ["", "## 配对差异", ""]
    paired = data["paired"]["official_resolved"]
    lines.append(
        f"- 配对数 = {data['paired']['n_pairs']}；官方 resolved：A {paired['A']}、B {paired['B']}、"
        f"双过 {paired['both']}、仅 A {paired['A_only']}、仅 B {paired['B_only']}、双败 {paired['neither']}"
    )
    lines.append(f"- 裁决迁移：`{json.dumps(data['paired']['verdict_transitions'], ensure_ascii=False)}`")
    lines += ["", "## 逐 run", "",
              "| task_id | arm | run_status | 裁决 | 官方 resolved | pass_rate | bucket | token | 耗时(s) |",
              "|---|---|---|---|---|---|---|---|---|"]
    for r in data["runs"]:
        off = r["official"]
        lines.append(
            f"| {r['task_id']} | {r['arm']} | {r['run_status']} | "
            f"{r['verifier']['final_verdict']} | {off.get('resolved')} | {off.get('pass_rate')} | "
            f"{r['verdict_bucket']} | {r['meta'].get('token_usage')} | {r['meta'].get('elapsed_seconds')} |"
        )
    lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs-root", required=True, help="run_arm/run_matrix 的输出根目录")
    parser.add_argument("--out", help="写出机器可读 JSON（默认 stdout）")
    parser.add_argument("--md", help="写出 markdown 表")
    args = parser.parse_args(argv)

    runs_root = Path(args.runs_root).expanduser().resolve()
    discovered = discover_runs(runs_root)
    if not discovered:
        print(f"error: 在 {runs_root} 下没找到 arm/meta.json", file=sys.stderr)
        return 2
    rows = [collect_run(runs_root, arm_dir, task_id) for arm_dir, task_id in discovered]
    data = aggregate(rows)
    data["runs_root"] = "runs-root（不写本机绝对路径）"
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"wrote {args.out}", file=sys.stderr)
    else:
        print(text, end="")
    if args.md:
        Path(args.md).write_text(render_markdown(data), encoding="utf-8")
        print(f"wrote {args.md}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
