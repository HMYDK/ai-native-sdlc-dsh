#!/usr/bin/env python3
"""④扩样本分析：paired A vs B+引导 的 resolved 差异、成本分布、失败类型与按 repo 分层。

输入：`summarize_runs.py --manifest manifests/expanded.yml` 的 report-data.json
（每任务 standard / sdlc 两个 arm，各 1 次）。
输出：机读 json + markdown；口径：
- 官方 resolved 为唯一成绩；agent_failure（timeout/over_budget/turn_error）全部进分母；
- token 优先用 meta/UI 读数，缺失时 summarize 已用 session 汇总补；
- paired 差异只在两臂都有 resolved 的任务上算，同时报告缺失/失败任务。
"""
from __future__ import annotations

import argparse
import json
import statistics
from collections import defaultdict
from pathlib import Path


def mean(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return sum(xs) / len(xs) if xs else None


def median(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return statistics.median(xs) if xs else None


def p90(xs):
    xs = sorted(x for x in xs if isinstance(x, (int, float)))
    if not xs:
        return None
    idx = min(len(xs) - 1, int(round(0.9 * (len(xs) - 1))))
    return xs[idx]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--markdown", required=True)
    args = ap.parse_args()

    data = json.loads(Path(args.data).read_text(encoding="utf-8"))
    by_task = defaultdict(dict)
    for r in data["runs"]:
        if "resolved" not in r:
            continue
        by_task[r["task_id"]][r["arm"]] = r

    pairs = []
    for task_id, arms in by_task.items():
        a = arms.get("standard")
        b = arms.get("sdlc")
        rec = {"task_id": task_id,
               "repo": (a or b or {}).get("repo", ""),
               "A_resolved": a.get("resolved") if a else None,
               "B_resolved": b.get("resolved") if b else None,
               "A_tokens": a.get("tokens") if a else None,
               "B_tokens": b.get("tokens") if b else None,
               "A_elapsed": a.get("elapsed_seconds") if a else None,
               "B_elapsed": b.get("elapsed_seconds") if b else None,
               "A_failure": a.get("agent_failure") if a else "missing",
               "B_failure": b.get("agent_failure") if b else "missing"}
        if rec["A_resolved"] is not None and rec["B_resolved"] is not None:
            rec["diff"] = int(bool(rec["B_resolved"])) - int(bool(rec["A_resolved"]))
        else:
            rec["diff"] = None
        pairs.append(rec)

    def arm_summary(arm: str) -> dict:
        rs = [r for r in data["runs"] if r.get("arm") == arm and "resolved" in r]
        resolved = [r for r in rs if r["resolved"]]
        return {
            "n": len(rs),
            "resolved": len(resolved),
            "resolved_rate": len(resolved) / len(rs) if rs else None,
            "failures": [r["task_id"] + ":" + str(r.get("agent_failure")) for r in rs
                         if r.get("agent_failure")],
            "tokens_median": median([r.get("tokens") for r in rs]),
            "tokens_mean": mean([r.get("tokens") for r in rs]),
            "tokens_p90": p90([r.get("tokens") for r in rs]),
            "elapsed_median": median([r.get("elapsed_seconds") for r in rs]),
        }

    diffs = [r["diff"] for r in pairs if r["diff"] is not None]
    by_repo = defaultdict(lambda: {"A": [0, 0], "B": [0, 0]})  # [resolved, n]
    for r in pairs:
        repo = r["repo"]
        if r["A_resolved"] is not None:
            by_repo[repo]["A"][1] += 1
            by_repo[repo]["A"][0] += int(bool(r["A_resolved"]))
        if r["B_resolved"] is not None:
            by_repo[repo]["B"][1] += 1
            by_repo[repo]["B"][0] += int(bool(r["B_resolved"]))

    out = {
        "data": str(Path(args.data).resolve()),
        "A": arm_summary("standard"),
        "B": arm_summary("sdlc"),
        "paired": {
            "n_paired": len(diffs),
            "mean_diff_B_minus_A": mean(diffs),
            "A_only": sum(1 for d in diffs if d < 0),
            "B_only": sum(1 for d in diffs if d > 0),
            "both_resolved": sum(1 for d in diffs if d == 0),
            "both_failed": sum(1 for r in pairs
                               if r["A_resolved"] is False and r["B_resolved"] is False),
        },
        "by_repo": {k: {"A": {"resolved": v["A"][0], "n": v["A"][1]},
                        "B": {"resolved": v["B"][0], "n": v["B"][1]}}
                    for k, v in by_repo.items()},
        "pairs": pairs,
    }
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = ["# ④ 扩样本结果（A vs B+引导）", "",
             f"- A（standard）: {out['A']['resolved']}/{out['A']['n']} resolved，"
             f"median token={out['A']['tokens_median']}, p90={out['A']['tokens_p90']}",
             f"- B（sdlc，含引导）: {out['B']['resolved']}/{out['B']['n']} resolved，"
             f"median token={out['B']['tokens_median']}, p90={out['B']['tokens_p90']}",
             f"- paired（两臂都有评分）: n={out['paired']['n_paired']}，"
             f"平均差(B-A)={out['paired']['mean_diff_B_minus_A']}，"
             f"A-only={out['paired']['A_only']}，B-only={out['paired']['B_only']}，"
             f"both-resolved={out['paired']['both_resolved']}",
             "", "| repo | A | B |", "|---|---|---|"]
    for repo, v in sorted(out["by_repo"].items()):
        lines.append(f"| {repo} | {v['A']['resolved']}/{v['A']['n']} | {v['B']['resolved']}/{v['B']['n']} |")
    lines += ["", "| task | A resolved | B resolved | A tokens | B tokens | A fail | B fail |",
              "|---|---|---|---|---|---|---|"]
    for r in sorted(pairs, key=lambda x: x["task_id"]):
        lines.append(f"| {r['task_id']} | {r['A_resolved']} | {r['B_resolved']} | "
                     f"{r['A_tokens']} | {r['B_tokens']} | {r['A_failure']} | {r['B_failure']} |")
    lines += ["", "> 每任务每臂 1 次；paired 差值只能作方向性证据，不能据此做显著性结论。"]
    Path(args.markdown).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
