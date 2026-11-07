#!/usr/bin/env python3
"""2×2 拆分分析：preset(标准/SDLC) × 引导(无/有) 对官方 resolved 与成本的影响。

输入：`summarize_runs.py` 产出的 report-data.json（需 2x2 manifest 产生的四个 arm）。
输出：每个 task × arm 的 resolved/pass_rate/token/耗时；四个 arm 的平均；
两个主效应与交互项（resolved 与 token），以及配对比较的明细。

效应定义（arm 名需为 standard / standard_guidance / sdlc / sdlc_guidance，
与 `manifests/2x2.yml` 一致）：
- preset 效应 = E[SDLC arms] - E[standard arms]
- 引导效应   = E[guidance arms] - E[no-guidance arms]
- 交互项     = (sdlc_guidance - sdlc) - (standard_guidance - standard)
单位：resolved 为比例差；token 为相对变化（B 相对 A 的倍数-1）。
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path


ARMS = ("standard", "standard_guidance", "sdlc", "sdlc_guidance")


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--markdown", required=True)
    args = ap.parse_args()

    data = json.loads(Path(args.data).read_text(encoding="utf-8"))
    rows = [r for r in data["runs"] if r.get("arm") in ARMS and "resolved" in r]
    by_arm = defaultdict(list)
    for r in rows:
        by_arm[r["arm"]].append(r)

    def arm_stats(arm: str) -> dict:
        rs = by_arm.get(arm, [])
        return {
            "n": len(rs),
            "resolved": sum(1 for r in rs if r["resolved"]),
            "resolved_rate": mean([1.0 if r["resolved"] else 0.0 for r in rs]),
            "pass_rate": mean([float(r.get("pass_rate") or 0) for r in rs]),
            "tokens": mean([r.get("tokens") for r in rs]),
            "elapsed": mean([r.get("elapsed_seconds") for r in rs]),
            "failures": [{"task": r["task_id"], "failure": r.get("agent_failure")}
                         for r in rs if r.get("agent_failure")],
        }

    stats = {a: arm_stats(a) for a in ARMS}
    resolved = {a: (stats[a]["resolved_rate"] or 0.0) for a in ARMS}
    tokens = {a: stats[a]["tokens"] for a in ARMS}

    preset_effect = (mean([resolved["sdlc"], resolved["sdlc_guidance"]])
                     - mean([resolved["standard"], resolved["standard_guidance"]]))
    guidance_effect = (mean([resolved["standard_guidance"], resolved["sdlc_guidance"]])
                       - mean([resolved["standard"], resolved["sdlc"]]))
    interaction = ((resolved["sdlc_guidance"] - resolved["sdlc"])
                   - (resolved["standard_guidance"] - resolved["standard"]))

    def ratio(a, b):
        return (tokens[a] / tokens[b] - 1) if tokens.get(a) and tokens.get(b) else None

    out = {
        "data": str(Path(args.data).resolve()),
        "arms": stats,
        "main_effects": {
            "preset_effect_resolved": preset_effect,
            "guidance_effect_resolved": guidance_effect,
            "interaction_resolved": interaction,
            "token_ratio_sdlc_vs_standard": ratio("sdlc", "standard"),
            "token_ratio_guidance_vs_none": (
                mean([tokens["standard_guidance"], tokens["sdlc_guidance"]]) /
                mean([tokens["standard"], tokens["sdlc"]]) - 1
                if all(tokens.get(a) for a in ARMS) else None),
        },
        "per_task": rows,
    }
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = ["# 2×2 拆分结果（preset × 引导）", "",
             "| arm | n | resolved | resolved_rate | avg F2P | avg tokens | avg elapsed | failures |",
             "|---|---|---|---|---|---|---|---|"]
    for a in ARMS:
        s = stats[a]
        lines.append(f"| {a} | {s['n']} | {s['resolved']} | {s['resolved_rate']} | "
                     f"{s['pass_rate']} | {round(s['tokens']) if s['tokens'] else None} | "
                     f"{round(s['elapsed']) if s['elapsed'] else None} | "
                     f"{len(s['failures'])} |")
    me = out["main_effects"]
    lines += ["", "## 主效应（resolved 比例）", "",
              f"- preset（SDLC - 标准）：{me['preset_effect_resolved']:+.3f}",
              f"- 引导（有 - 无）：{me['guidance_effect_resolved']:+.3f}",
              f"- 交互项：{me['interaction_resolved']:+.3f}",
              f"- token 倍数（sdlc/standard）：{me['token_ratio_sdlc_vs_standard']:+.2%}"
              if me.get('token_ratio_sdlc_vs_standard') is not None else "",
              f"- token 倍数（引导/无引导）：{me['token_ratio_guidance_vs_none']:+.2%}"
              if me.get('token_ratio_guidance_vs_none') is not None else ""]
    lines += ["", "> n=5 每任务 1 次，效应量只能作为方向性证据；超时/over_budget 计入分母。"]
    Path(args.markdown).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
