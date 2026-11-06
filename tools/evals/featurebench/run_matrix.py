#!/usr/bin/env python3
"""按 manifest 跑完 5 任务 × 2 臂，并强制执行运行纪律（预算、重试、顺序）。

用法（默认 dry-run）：
    python3 run_matrix.py --manifest manifest.yml --runs-root /tmp/fb-runs \
        --plugin-dir /tmp/plugin --credentials /tmp/creds.yaml --image-map sympy=fb-eval-base:sympy,...

实际会逐个调用 run_arm.py（--execute），并把汇总写 <runs-root>/matrix.json：
- 顺序：奇数任务先 A，偶数任务先 B（避免时间漂移只偏向一臂）；
- 仅基础设施错误（退出码 2）重试一次；
- agent 失败/超时/over_budget（退出码 3）不重试，计入分母；
- 总 token 预算达到后停止剩余运行，只报告已完成部分。

注意：本脚本默认 dry-run，不会调模型；`--execute` 才真跑（AC-007）。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default=str(HERE / "manifest.yml"))
    ap.add_argument("--runs-root", required=True)
    ap.add_argument("--plugin-dir", required=True, help="解包后的插件目录（dsh-sdlc/ + js-yaml/）")
    ap.add_argument("--credentials", required=True, help="隔离 .credentials.yaml")
    ap.add_argument("--image-map", action="append", default=[],
                    help="repo=派生镜像，可重复，例如 sympy=fb-eval-base:sympy")
    ap.add_argument("--execute", action="store_true", help="真正执行（默认 dry-run）")
    args = ap.parse_args()

    manifest = yaml.safe_load(open(args.manifest, encoding="utf-8"))
    images = {}
    for spec in args.image_map:
        repo, _, img = spec.partition("=")
        images[repo] = img
    runs_root = Path(args.runs_root)
    runs_root.mkdir(parents=True, exist_ok=True)
    policy = manifest.get("run_policy", {})
    budget = int(policy.get("total_token_budget", 0))
    infra_retries = int(policy.get("infra_retries", 1))
    plan = []
    for i, task in enumerate(manifest["tasks"]):
        arms = ["standard", "sdlc"] if i % 2 == 0 else ["sdlc", "standard"]
        img = images.get(task["repo"])
        plan.append({"task": task["id"], "repo": task["repo"], "arms": arms, "image": img})
        print(f"[plan] {task['id']} order={arms} image={img or 'MISSING'}")
    if not args.execute:
        print("[dry-run] add --execute to actually run the matrix")
        return 0

    missing = [p["task"] for p in plan if not p["image"]]
    if missing:
        print("missing --image-map for:", missing, file=sys.stderr)
        return 2

    summary = {"started_at": __import__("time").strftime("%Y-%m-%dT%H:%M:%S"),
               "manifest": str(Path(args.manifest).resolve()), "runs": [], "total_tokens": 0,
               "stopped_for_budget": False}
    for item in plan:
        task_dir = runs_root / item["task"].split(".")[0]
        for arm in item["arms"]:
            out = task_dir / arm
            cmd = [sys.executable, str(HERE / "run_arm.py"),
                   "--manifest", str(Path(args.manifest).resolve()),
                   "--task-id", item["task"], "--arm", arm, "--image", item["image"],
                   "--out", str(out), "--plugin-dir", str(Path(args.plugin_dir).resolve()),
                   "--credentials", str(Path(args.credentials).resolve()), "--execute"]
            record = {"task": item["task"], "arm": arm, "image": item["image"]}
            for attempt in range(1 + infra_retries):
                print(f"[run] task={item['task']} arm={arm} attempt={attempt + 1}")
                code = subprocess.run(cmd).returncode
                record["exit"] = code
                record["attempts"] = attempt + 1
                if code in (0, 3):
                    break
            if (out / "meta.json").exists():
                try:
                    meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
                    record["tokens"] = meta.get("token_usage")
                    record["patch_chars"] = meta.get("patch_chars")
                    record["agent_failure"] = meta.get("agent_failure")
                    record["sdlc_tool_calls"] = meta.get("sdlc_tool_calls")
                    summary["total_tokens"] += int(meta.get("token_usage") or 0)
                except Exception:
                    pass
            summary["runs"].append(record)
            (runs_root / "matrix.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
            if budget and summary["total_tokens"] > budget:
                summary["stopped_for_budget"] = True
                print(f"[stop] total tokens {summary['total_tokens']} > budget {budget}", file=sys.stderr)
                (runs_root / "matrix.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
                return 4
    return 0


if __name__ == "__main__":
    sys.exit(main())
