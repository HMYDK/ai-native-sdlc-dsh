#!/usr/bin/env python3
"""把 5 任务 × 2 臂的运行产物汇总成报告数据（人读 markdown + 机读 json）。

用法：
    python3 summarize_runs.py --manifest manifest.yml --runs-root /tmp/fb-runs \
        --out /tmp/fb-runs/report-data.json --markdown /tmp/fb-runs/report.md

关键口径（与 issue #8 的报告要求对应）：
- 官方评分为唯一成绩来源；agent 自报/验证者裁决不作为成绩；
- 所有运行都进分母：timeout / over_budget / infra_error / empty_patch / agent_error /
  unresolved 分类单列；
- B 组额外记录：是否真的调用 sdlc_*、sdlc_verify 的裁决（approve/reject/needs_human）、
  以及裁决与官方评分是否错配（verifier false-positive/negative 的线索）；
- 参考副本泄漏扫描命中的文件路径逐个列出（不改官方镜像）。

依赖：zstandard 可选（没有时仍能汇总，只是读不到按工具的 session 统计）。
"""
from __future__ import annotations

import argparse
import glob
import json
from pathlib import Path

import yaml

ARMS = ("standard", "sdlc")


def load_json(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def official_metrics(task_dir: Path, arm: str) -> dict:
    # fb eval 的 report 可能落在 arm 目录或 eval-<arm>/ 下（见 evaluate_matrix 的注释）
    for cand in (task_dir / arm / "report.json", task_dir / f"eval-{arm}" / "report.json"):
        d = load_json(cand) if cand.exists() else None
        if d:
            a = d.get("attempt_1", {})
            return {
                "resolved": bool(a.get("resolved_instances")),
                "pass_rate": a.get("pass_rate"),
                "resolved_rate": a.get("resolved_rate"),
                "errors": a.get("error_instances"),
                "not_applied_empty": a.get("not_applied_patch_empty_instances"),
            }
    return {}


def sdlc_stats(task_dir: Path) -> dict:
    """从 session 日志统计实际工具调用与 verify 裁决（zstandard 可选）。"""
    try:
        import zstandard  # noqa: F401
    except Exception:
        return {"available": False, "reason": "zstandard not installed"}
    calls: dict[str, int] = {}
    verdicts: list[str] = []
    for f in glob.glob(str(task_dir / "**" / "*.zstd"), recursive=True):
        try:
            raw = zstandard.ZstdDecompressor().stream_reader(open(f, "rb")).read()
        except Exception:
            continue
        for line in raw.splitlines():
            try:
                d = json.loads(line)
            except Exception:
                continue

            def walk(o):
                if isinstance(o, dict):
                    if o.get("type") == "tool-call" and isinstance(o.get("name"), str):
                        calls[o["name"]] = calls.get(o["name"], 0) + 1
                    for v in o.values():
                        walk(v)
                elif isinstance(o, list):
                    for v in o:
                        walk(v)
                elif isinstance(o, str):
                    # sdlc_verify 的裁决 JSON 嵌在 tool/result 的文本里：
                    #   {"status": "approve", ..., "raw_status": "approve"}
                    for k in ("approve", "reject", "needs_human"):
                        if f'"raw_status": "{k}"' in o:
                            verdicts.append(k)
                            break

            walk(d)
    sdlc = {k: v for k, v in calls.items() if k.startswith("sdlc_")}
    return {"available": True, "sdlc_tool_calls": sdlc, "verify_verdicts": verdicts,
            "used_sdlc": bool(sdlc)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default=str(Path(__file__).with_name("manifest.yml")))
    ap.add_argument("--runs-root", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--markdown", required=True)
    args = ap.parse_args()

    manifest = yaml.safe_load(open(args.manifest, encoding="utf-8"))
    runs_root = Path(args.runs_root)
    tasks = []
    for task in manifest["tasks"]:
        task_dir = runs_root / task["id"].split(".")[0]
        for arm in ARMS:
            d = task_dir / arm
            if not (d / "meta.json").exists():
                continue
            meta = load_json(d / "meta.json") or {}
            row = {
                "task_id": task["id"],
                "repo": task["repo"],
                "arm": arm,
                "preset": meta.get("preset"),
                "image": meta.get("image"),
                "image_digest": meta.get("image_digest"),
                "tokens": meta.get("token_usage"),
                "elapsed_seconds": meta.get("elapsed_seconds"),
                "patch_chars": meta.get("patch_chars"),
                "full_patch_chars": meta.get("full_patch_chars"),
                "agent_completed": meta.get("agent_completed"),
                "agent_failure": meta.get("agent_failure"),
                "leak_scan_hits": meta.get("leak_scan_hits", []),
            }
            row.update(official_metrics(task_dir, arm))
            if arm == "sdlc":
                row.update(sdlc_stats(task_dir))
                row["verifier_vs_official"] = (
                    "not_applicable" if "resolved" not in row else
                    ("agree" if (
                        (row.get("verify_verdicts") and row["verify_verdicts"][-1] == "approve") == row["resolved"])
                     else "mismatch")
                )
            tasks.append(row)

    data = {"manifest": str(Path(args.manifest).resolve()),
            "runs_root": str(runs_root.resolve()), "runs": tasks}
    Path(args.out).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = ["# FeatureBench A/B 运行汇总", ""]
    lines.append("| repo | arm | resolved | pass_rate | tokens | elapsed_s | patch_chars | agent_failure |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for r in tasks:
        lines.append(f"| {r['repo']} | {r['arm']} | {r.get('resolved')} | {r.get('pass_rate')} | "
                     f"{r.get('tokens')} | {r.get('elapsed_seconds')} | {r.get('patch_chars')} | "
                     f"{r.get('agent_failure') or ''} |")
    lines.append("")
    for arm in ARMS:
        rows = [r for r in tasks if r["arm"] == arm]
        if rows:
            resolved = sum(1 for r in rows if r.get("resolved"))
            avg = sum(float(r.get("pass_rate") or 0) for r in rows) / len(rows)
            lines.append(f"- **{arm}**: n={len(rows)}, resolved={resolved}, avg_pass_rate={avg:.4f}")
    b = [r for r in tasks if r["arm"] == "sdlc" and "resolved" in r]
    if b:
        used = sum(1 for r in b if r.get("used_sdlc"))
        agree = sum(1 for r in b if r.get("verifier_vs_official") == "agree")
        lines.append(f"- **B 组流程采纳**: {used}/{len(b)} 次真的调用过 sdlc_*；"
                     f"验证者裁决与官方评分一致 {agree}/{len(b)}")
    leaks = sum(1 for r in tasks if r.get("leak_scan_hits"))
    lines.append(f"- **参考副本泄漏**: {leaks}/{len(tasks)} 次运行扫描命中（镜像内 vendored 实现，未修改环境；见 README 已知限制）")
    Path(args.markdown).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
