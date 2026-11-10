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

离线复算（issue #12 / AC-003）：`confusion_for_rows(rows)` 与
`compute(report[, data_path])` 是纯函数（不读写文件、不联网、不调模型）；
`reaggregate.py --check` 复用同一口径，对已提交数据快照重算并与已提交 `confusion`
（以及全实验合并的 B 组混淆）逐项对账。CLI 行为保持不变。

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


def confusion_for_rows(rows: list) -> dict:
    """对一组 B 组 run（每行需含 resolved / verify_verdicts）算混淆矩阵（纯函数）。

    与 CLI 的差别只在来源：调用方负责筛出「SDLC arm 且有官方 resolved」的行；
    本函数不再过滤。输出结构就是 `--out` 的机读内容（不含 `data` 路径字段）。
    """
    buckets = {"agree_approve": [], "false_positive": [], "false_negative": [],
               "agree_reject": [], "needs_human": [], "no_verdict": []}
    sequences = {}
    for r in rows:
        vs = r.get("verify_verdicts") or []
        final = vs[-1] if vs else None
        seq = " → ".join(vs) if vs else "(none)"
        sequences[seq] = sequences.get(seq, 0) + 1
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
    details = []
    for r in rows:
        d = {"task_id": r["task_id"], "repo": r["repo"],
             "verdicts": r.get("verify_verdicts"), "resolved": r["resolved"],
             "pass_rate": r.get("pass_rate"),
             "bucket": next(k for k, v in buckets.items() if r in v)}
        if "experiment" in r:
            # 只有跨实验合并时才带来源，单实验输出保持原字段不变。
            d["experiment"] = r["experiment"]
        details.append(d)
    return {
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
        "details": details,
    }


def compute(report: dict, data_path=None) -> dict:
    """从 report-data.json 的内容算 B 组混淆矩阵（纯函数，不碰文件系统）。"""
    rows = [r for r in report["runs"] if is_sdlc_arm(r) and "resolved" in r]
    out = {"data": str(Path(data_path).resolve()) if data_path is not None else None}
    out.update(confusion_for_rows(rows))
    return out


def render_markdown(result: dict) -> str:
    """把 compute() 的结果渲染成 markdown（纯函数）。"""
    rows_total = result["sdlc_runs"]
    c = result["confusion"]
    lines = [
        "# 验证者裁决 vs 官方评分", "",
        f"- B 组运行数：{rows_total}；官方 resolved：{result['official_resolved']}",
        f"- 2×2（只有 approve/reject 进入）：approve→resolved {c['approve_resolved']}、"
        f"approve→unresolved（假阳性）{c['approve_unresolved_false_positive']}、"
        f"reject→unresolved {c['reject_unresolved']}、reject→resolved（假阴性）{c['reject_resolved_false_negative']}",
        f"- 假阳性率（approve 中官方 unresolved）：{result['false_positive_rate']}",
        f"- 假阴性率（reject 中官方 resolved）：{result['false_negative_rate']}",
        f"- needs_human：{c['needs_human']}；无裁决（超时导致）：{c['no_verdict']}",
        "", "| task | verdicts | 官方 resolved | bucket |", "|---|---|---|---|",
    ]
    for d in result["details"]:
        lines.append(f"| {d['task_id']} | {' → '.join(d['verdicts'] or []) or '(none)'} | "
                     f"{d['resolved']} | {d['bucket']} |")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="summarize_runs.py 的 report-data.json")
    ap.add_argument("--out", required=True)
    ap.add_argument("--markdown", required=True)
    args = ap.parse_args()

    data = json.loads(Path(args.data).read_text(encoding="utf-8"))
    result = compute(data, args.data)
    Path(args.out).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    markdown = render_markdown(result)
    Path(args.markdown).write_text(markdown + "\n", encoding="utf-8")
    print(markdown)


if __name__ == "__main__":
    main()
