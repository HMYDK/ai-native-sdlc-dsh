#!/usr/bin/env python3
"""对 5 任务 × 2 臂的产物逐个调用官方 `fb eval` 评分，并汇总成可审查的报告数据。

用法（默认 dry-run）：
    python3 evaluate_matrix.py --manifest manifest.yml --runs-root /tmp/fb-runs \
        --config /tmp/fb/config.toml --out /tmp/fb-runs/summary.json --execute

产物：
- <runs-root>/<task>/eval-<arm>/report.json  官方评分器的原始 report；
- <runs-root>/summary.json                   汇总：每任务/每臂 resolved、pass_rate、
                                              token、时长、agent_failure、B 组 SDLC 采纳率；
- 标准输出 markdown 表格（可直接贴进报告）。

口径：`success=true` 的预测如果 patch 为空，官方评分器会给 unresolved / not applied，
不剔除分母；agent 失败、超时、over_budget 全部保留在汇总里。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent


def load_meta(task_dir: Path, arm: str) -> dict:
    p = task_dir / arm / "meta.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default=str(HERE / "manifest.yml"))
    ap.add_argument("--runs-root", required=True)
    ap.add_argument("--config", help="fb eval 的 config.toml（可选）")
    ap.add_argument("--fb-bin", default="fb")
    ap.add_argument("--out", help="summary.json 路径（默认 <runs-root>/summary.json）")
    ap.add_argument("--only-task", action="append", default=[],
                    help="只评分指定 task id（可重复，用于分批补评）")
    ap.add_argument("--execute", action="store_true", help="真正调用 fb eval（默认 dry-run）")
    args = ap.parse_args()

    manifest = yaml.safe_load(open(args.manifest, encoding="utf-8"))
    runs_root = Path(args.runs_root)
    out_path = Path(args.out) if args.out else runs_root / "summary.json"
    summary = {"manifest": str(Path(args.manifest).resolve()), "tasks": []}

    only = set(args.only_task)
    jobs = []
    for task in manifest["tasks"]:
        if only and task["id"] not in only:
            continue
        task_dir = runs_root / task["id"]
        if not (task_dir / "sdlc").exists() and not (task_dir / "standard").exists():
            task_dir = runs_root / task["id"].split(".")[0]  # 兼容首批（每 repo 1 任务）目录
        for arm in manifest["arms"]:
            d = task_dir / arm
            if not (d / "patch.diff").exists():
                continue
            patch = (d / "patch.diff").read_text(encoding="utf-8", errors="replace")
            pred = d / "predictions.jsonl"
            pred.write_text(json.dumps({
                "instance_id": task["id"],
                "model_name_or_path": f"dsh-sdlc-eval-{arm}",
                "model_patch": patch,
                "success": True,
                "n_attempt": 1,
            }, ensure_ascii=False) + "\n", encoding="utf-8")
            eval_dir = task_dir / f"eval-{arm}"
            eval_dir.mkdir(parents=True, exist_ok=True)
            cmd = [args.fb_bin, "eval", "-p", str(pred), "--split", "fast",
                   "--task-id", task["id"], "--n-concurrent", "1", "--data-version", "v1.1"]
            if args.config:
                cmd += ["--config-path", str(Path(args.config).resolve())]
            jobs.append({"task": task, "arm": arm, "dir": d, "eval_dir": eval_dir,
                         "cmd": cmd, "patch_chars": len(patch)})

    if not args.execute:
        for j in jobs:
            print("[dry-run]", j["arm"], j["task"], "patch_chars=", j["patch_chars"])
        print("[dry-run] add --execute to actually call fb eval")
        return 0

    env = dict(os.environ, FEATUREBENCH_IMAGE_PREFIX="docker.io")
    for j in jobs:
        print(f"[eval] {j['task']} {j['arm']} ...")
        r = subprocess.run(j["cmd"], cwd=j["eval_dir"], env=env, capture_output=True, text=True)
        (j["eval_dir"] / "eval.log").write_text(r.stdout + "\n" + r.stderr)
        # fb eval 把 report.json 写在 predictions.jsonl 所在目录（arm 目录），
        # 不是我们指定的 eval_dir；两处都找，并复制一份到 eval_dir 便于归档。
        report_path = None
        for cand in (j["dir"] / "report.json", j["eval_dir"] / "report.json"):
            if cand.exists():
                report_path = cand
                break
        report = {}
        if report_path is not None:
            try:
                report = json.loads(report_path.read_text()).get("attempt_1", {})
                if report_path != (j["eval_dir"] / "report.json"):
                    (j["eval_dir"] / "report.json").write_text(
                        json.dumps({"attempt_1": report}, ensure_ascii=False, indent=2))
            except Exception:
                report = {}
        meta = load_meta(j["dir"].parent, j["arm"])
        summary["tasks"].append({
            "task_id": j["task"]["id"],
            "repo": j["task"]["repo"],
            "arm": j["arm"],
            "image_digest": j["task"].get("image_digest"),
            "resolved": bool(report.get("resolved_instances")),
            "pass_rate": report.get("pass_rate"),
            "resolved_rate": report.get("resolved_rate"),
            "error_instances": report.get("error_instances"),
            "not_applied_empty": report.get("not_applied_patch_empty_instances"),
            "tokens": meta.get("token_usage"),
            "elapsed_seconds": meta.get("elapsed_seconds"),
            "patch_chars": meta.get("patch_chars", j["patch_chars"]),
            "agent_completed": meta.get("agent_completed"),
            "agent_failure": meta.get("agent_failure"),
            "sdlc_tool_calls": meta.get("sdlc_tool_calls", {}),
            "eval_exit": r.returncode,
        })
        out_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    # 汇总表
    print("\n| repo | arm | resolved | pass_rate | tokens | patch_chars | agent_failure |")
    print("|---|---|---|---|---|---|---|")
    for t in summary["tasks"]:
        print(f"| {t['repo']} | {t['arm']} | {t['resolved']} | {t['pass_rate']} | "
              f"{t['tokens']} | {t['patch_chars']} | {t['agent_failure'] or ''} |")
    for arm in ("standard", "sdlc"):
        rows = [t for t in summary["tasks"] if t["arm"] == arm]
        if rows:
            resolved = sum(1 for t in rows if t["resolved"])
            avg_pass = sum(float(t["pass_rate"] or 0) for t in rows) / len(rows)
            print(f"\n{arm}: n={len(rows)} resolved={resolved} avg_pass_rate={avg_pass:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
