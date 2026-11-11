#!/usr/bin/env python3
"""验证者裁决 vs 官方评分的混淆矩阵（实验②用，也可用于任意 B 组结果）。

输入：summarize_runs.py 产出的 report-data.json（含每个 B run 的官方 resolved 与
verify_verdicts）。按「最终裁决」归类：
- approve / reject / needs_human / none（超时截断没产出裁决）；
- 官方 resolved / unresolved。
输出：
- 2×2（approve/reject × resolved/unresolved）与假阳性率（approve 中官方 unresolved 的比例）、
  假阴性率（reject 中官方 resolved 的比例）；
- 多裁决序列的分布（验证者是否 iterated：reject→…→approve 等）；
- needs_human / none 单列，不混进 2×2 分母。

用法：
    python3 analyze_verifier.py --data /tmp/fb-runs-verify/report-data.json \
        --out /tmp/fb-runs-verify/verifier-confusion.json --markdown /tmp/fb-runs-verify/verifier.md
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def is_sdlc_arm(row: dict) -> bool:
    preset = row.get("preset") or ""
    return "SDLC" in preset


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="summarize_runs.py 的 report-data.json")
    ap.add_argument("--out", required=True)
    ap.add_argument("--markdown", required=True)
    args = ap.parse_args()

    data = json.loads(Path(args.data).read_text(encoding="utf-8"))
    rows = [r for r in data["runs"] if is_sdlc_arm(r) and "resolved" in r]

    buckets = {"agree_approve": [], "false_positive": [], "false_negative": [],
               "agree_reject": [], "needs_human": [], "no_verdict": []}
    sequences = {}
    for r in rows:
        vs = r.get("verify_verdicts") or []
        final = vs[-1] if vs else None
        key = (final, r["resolved"])
        sequences[" → ".join(vs) if vs else "(none)"] = sequences.get(
            " → ".join(vs) if vs else "(none)", 0) + 1
        if final is None:
            buckets["no_verdict"].append(r)
        elif final == "needs_human":
            buckets["needs_human"].append(r)
        elif final == "approve":
            buckets["agree_approve" if r["resolved"] else "false_positive"].append(r)
        elif final == "reject":
            buckets["agree_reject" if not r["resolved"] else "false_negative"].append(r)

    approve = buckets["agree_approve"] + buckets["false_positive"]
    reject = buckets["agree_reject"] + buckets["false_negative"]
    decided = approve + reject
    out = {
        "data": str(Path(args.data).resolve()),
        "sdlc_runs": len(rows),
        "official_resolved": sum(1 for r in rows if r["resolved"]),
        "confusion": {
            "approve_resolved": len(buckets["agree_approve"]),
            "approve_unresolved_false_positive": len(buckets["false_positive"]),
            "reject_unresolved": len(buckets["agree_reject"]),
            "reject_resolved_false_negative": len(buckets["false_negative"]),
            "needs_human": len(buckets["needs_human"]),
            "no_verdict": len(buckets["no_verdict"]),
        },
        "false_positive_rate": (len(buckets["false_positive"]) / len(approve)) if approve else None,
        "false_negative_rate": (len(buckets["false_negative"]) / len(reject)) if reject else None,
        "verdict_accuracy_on_decided": (
            (len(buckets["agree_approve"]) + len(buckets["agree_reject"])) / len(decided)
            if decided else None),
        "verdict_sequences": sequences,
        "details": [
            {"task_id": r["task_id"], "repo": r["repo"], "verdicts": r.get("verify_verdicts"),
             "resolved": r["resolved"], "pass_rate": r.get("pass_rate"),
             "bucket": next(k for k, v in buckets.items() if r in v)}
            for r in rows
        ],
    }
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    c = out["confusion"]
    lines = [
        "# 验证者裁决 vs 官方评分", "",
        f"- B 组运行数：{len(rows)}；官方 resolved：{out['official_resolved']}",
        f"- 2×2（只有 approve/reject 进入）：approve→resolved {c['approve_resolved']}、"
        f"approve→unresolved（假阳性）{c['approve_unresolved_false_positive']}、"
        f"reject→unresolved {c['reject_unresolved']}、reject→resolved（假阴性）{c['reject_resolved_false_negative']}",
        f"- 假阳性率（approve 中官方 unresolved）：{out['false_positive_rate']}",
        f"- 假阴性率（reject 中官方 resolved）：{out['false_negative_rate']}",
        f"- needs_human：{c['needs_human']}；无裁决（超时导致）：{c['no_verdict']}",
        "", "| task | verdicts | 官方 resolved | bucket |", "|---|---|---|---|",
    ]
    for d in out["details"]:
        lines.append(f"| {d['task_id']} | {' → '.join(d['verdicts'] or []) or '(none)'} | "
                     f"{d['resolved']} | {d['bucket']} |")
    Path(args.markdown).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
