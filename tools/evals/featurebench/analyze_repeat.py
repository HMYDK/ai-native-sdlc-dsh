#!/usr/bin/env python3
"""重复采样分析：同一任务 × arm 跑多次，先估计运行方差，再给 treatment 差值的区间。

输入：多个 `summarize_runs.py --manifest manifests/repeat-sampling.yml` 的 report-data.json
（每个对应一次重复 rep），例如 /tmp/fb-runs-repeat/rep{1,2,3}/report-data.json。

输出：
- 每个 task × arm 的 resolved 次数/k、token 均值/标准差、agent_failure 计数；
- 每个 task 的 paired diff（B − A）逐 rep 列表与均值；
- 总体 paired diff 的 bootstrap 95% 区间（按 task 分层重采样）；
- markdown 报告。

口径：官方 resolved 为唯一成绩；timeout/over_budget 计入失败；每 cell k=rep 数。

离线复算（issue #12 / AC-003）：`compute(reports[, rep_paths])` 是纯函数（不读写
文件、不联网、不调模型），`reaggregate.py --check` 用已提交数据快照的 `reps` 重算
后与已提交 `analysis` 逐项对账；CLI 行为保持不变（`--reps` / `--out` / `--markdown`）。
"""
from __future__ import annotations

import argparse
import json
import random
import statistics
from collections import defaultdict
from pathlib import Path


def boot_ci(values, n=5000, seed=42):
    if len(values) < 2:
        return (None, None)
    rng = random.Random(seed)
    means = []
    for _ in range(n):
        sample = [rng.choice(values) for _ in values]
        means.append(sum(sample) / len(sample))
    means.sort()
    return (means[int(0.025 * n)], means[int(0.975 * n) - 1])


def compute(reports, rep_paths=None) -> dict:
    """从各 rep 的 report-data 内容算重复采样分析（纯函数，不碰文件系统）。

    `reports` 是 report-data dict 的列表（按 rep 顺序）；
    `rep_paths` 只影响输出里的 `reps` 字段（路径溯源），不参与任何统计。
    """
    cells = defaultdict(list)       # (task_id, arm) -> [scoreable row]
    attempted = defaultdict(list)   # (task_id, arm) -> [row] 含 unscoreable/infra
    tasks = set()
    for rep_idx, data in enumerate(reports, start=1):
        for r in data["runs"]:
            r = dict(r)
            r["_rep"] = rep_idx
            attempted[(r["task_id"], r["arm"])].append(r)
            tasks.add(r["task_id"])
            if "resolved" in r:
                cells[(r["task_id"], r["arm"])].append(r)

    def cell_stats(task_id, arm):
        all_rs = attempted.get((task_id, arm), [])
        rs = cells.get((task_id, arm), [])
        resolved = sum(1 for r in rs if r["resolved"])
        toks = [r.get("tokens") for r in all_rs if isinstance(r.get("tokens"), (int, float))]
        fails = [r.get("agent_failure") for r in all_rs if r.get("agent_failure")]
        return {
            "k": len(all_rs),            # attempted replicates
            "scoreable": len(rs),
            "resolved": resolved,
            "resolved_rate": resolved / len(rs) if rs else None,
            "tokens_mean": statistics.mean(toks) if toks else None,
            "tokens_stdev": statistics.stdev(toks) if len(toks) > 1 else None,
            "failures": fails,
            "unscoreable_reps": [r["_rep"] for r in all_rs if "resolved" not in r],
        }

    per_task = {}
    diffs = []
    for task_id in sorted(tasks):
        a = cell_stats(task_id, "standard")
        b = cell_stats(task_id, "sdlc")
        # paired：同一 rep 内 A/B 都有 resolved 时算差值
        rep_map = defaultdict(dict)
        for (t, arm), rows in cells.items():
            if t != task_id:
                continue
            for r in rows:
                rep_map[r["_rep"]][arm] = 1 if r["resolved"] else 0
        rep_diffs = {rep: (v["sdlc"] - v["standard"])
                     for rep, v in rep_map.items() if "sdlc" in v and "standard" in v}
        diffs.extend(rep_diffs.values())
        per_task[task_id] = {"A": a, "B": b, "rep_diffs": rep_diffs,
                             "repo": next((r.get("repo") for r in cells.get((task_id, "standard"), [])
                                           if r.get("repo")), "")}

    lo, hi = boot_ci(diffs)
    return {
        "reps": list(rep_paths) if rep_paths is not None else [],
        "per_task": per_task,
        "paired": {
            "n": len(diffs),
            "mean_diff_B_minus_A": (sum(diffs) / len(diffs)) if diffs else None,
            "bootstrap95_ci": [lo, hi],
            "B_only": sum(1 for d in diffs if d > 0),
            "A_only": sum(1 for d in diffs if d < 0),
            "ties": sum(1 for d in diffs if d == 0),
        },
    }


def render_markdown(result: dict) -> str:
    """把 compute() 的结果渲染成 markdown（纯函数）。"""
    per_task = result["per_task"]
    lines = ["# 重复采样结果（每任务每臂 3 次）", "",
             "| task | A resolved | B resolved | A token mean±sd | B token mean±sd | rep diffs (B-A) |",
             "|---|---|---|---|---|---|"]
    for task_id, d in per_task.items():
        a, b = d["A"], d["B"]
        def tmean(s):
            return (f"{s['tokens_mean']/1e6:.1f}M±{s['tokens_stdev']/1e6:.1f}M"
                    if s["tokens_mean"] is not None and s["tokens_stdev"] is not None
                    else (f"{s['tokens_mean']/1e6:.1f}M" if s["tokens_mean"] is not None else "—"))
        lines.append(f"| {task_id} | {a['resolved']}/{a['k']} | {b['resolved']}/{b['k']} | "
                     f"{tmean(a)} | {tmean(b)} | {sorted(d['rep_diffs'].items())} |")
    p = result["paired"]
    lo, hi = p["bootstrap95_ci"]
    lines += ["", "## 汇总", "",
              f"- paired n={p['n']}，平均差（B−A）= {p['mean_diff_B_minus_A']:+.3f}，"
              f"bootstrap 95% CI = [{lo if lo is None else round(lo,3)}, {hi if hi is None else round(hi,3)}]",
              f"- B 独有胜：{p['B_only']}，A 独有胜：{p['A_only']}，平局：{p['ties']}",
              "", "> 每任务每臂 k=3；resolved 是 0/1，k=3 时单 cell 方差很大；",
              "> bootstrap 区间按 rep 差值重采样，仅作方向性参考，不要当成显著性检验。"]
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", nargs="+", required=True, help="各 rep 的 report-data.json 路径")
    ap.add_argument("--out", required=True)
    ap.add_argument("--markdown", required=True)
    args = ap.parse_args()

    reports = [json.loads(Path(p).read_text(encoding="utf-8")) for p in args.reps]
    result = compute(reports, args.reps)
    Path(args.out).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    markdown = render_markdown(result)
    Path(args.markdown).write_text(markdown + "\n", encoding="utf-8")
    print(markdown)


if __name__ == "__main__":
    main()
