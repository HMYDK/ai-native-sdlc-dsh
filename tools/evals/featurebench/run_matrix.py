#!/usr/bin/env python3
"""按 manifest 跑完 5 任务 × 2 臂，并强制执行运行纪律（预算、重试、顺序）。

用法（默认 dry-run）：
    python3 run_matrix.py --manifest manifest.yml --runs-root /tmp/fb-runs \
        --plugin-dir /tmp/plugin --credentials /tmp/creds.yaml \
        --image-map "sympy/sympy=fb-eval-base:sympy" --image-map "..."

实际会逐任务调用 run_arm.py（--execute），同一任务的两臂**并发**启动（不同 web/CDP
端口互不干扰），把汇总写 <runs-root>/matrix.json：
- 顺序：奇数任务先 A，偶数任务先 B（避免时间漂移只偏向一臂；记录 start 顺序）；
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
import time
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent


def arm_cmd(args, manifest_path: Path, task_id: str, arm: str, image: str, out: Path) -> list[str]:
    return [sys.executable, str(HERE / "run_arm.py"),
            "--manifest", str(manifest_path.resolve()),
            "--task-id", task_id, "--arm", arm, "--image", image,
            "--out", str(out), "--plugin-dir", str(Path(args.plugin_dir).resolve()),
            "--credentials", str(Path(args.credentials).resolve()), "--execute"]


def collect(out: Path, record: dict) -> None:
    if not (out / "meta.json").exists():
        return
    try:
        meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
    except Exception:
        return
    record["tokens"] = meta.get("token_usage")
    record["patch_chars"] = meta.get("patch_chars")
    record["agent_completed"] = meta.get("agent_completed")
    record["agent_failure"] = meta.get("agent_failure")
    record["sdlc_tool_calls"] = meta.get("sdlc_tool_calls")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default=str(HERE / "manifest.yml"))
    ap.add_argument("--runs-root", required=True)
    ap.add_argument("--plugin-dir", required=True, help="解包后的插件目录（dsh-sdlc/ + js-yaml/）")
    ap.add_argument("--credentials", required=True, help="隔离 .credentials.yaml")
    ap.add_argument("--image-map", action="append", default=[],
                    help="repo=派生镜像，可重复，例如 'sympy/sympy=fb-eval-base:sympy'")
    ap.add_argument("--web-port-base", type=int, default=3115)
    ap.add_argument("--cdp-port-base", type=int, default=9400)
    ap.add_argument("--execute", action="store_true", help="真正执行（默认 dry-run）")
    args = ap.parse_args()

    manifest_path = Path(args.manifest)
    manifest = yaml.safe_load(open(manifest_path, encoding="utf-8"))
    images = {}
    for spec in args.image_map:
        repo, _, img = spec.partition("=")
        images[repo.strip()] = img.strip()
    runs_root = Path(args.runs_root)
    runs_root.mkdir(parents=True, exist_ok=True)
    policy = manifest.get("run_policy", {})
    budget = int(policy.get("total_token_budget", 0))
    infra_retries = int(policy.get("infra_retries", 1))
    plan = []
    for i, task in enumerate(manifest["tasks"]):
        arms = ["standard", "sdlc"] if i % 2 == 0 else ["sdlc", "standard"]
        plan.append({"task": task["id"], "repo": task["repo"], "arms": arms,
                     "image": images.get(task["repo"]), "web_port": args.web_port_base + i * 2,
                     "cdp_port": args.cdp_port_base + i * 2})
        print(f"[plan] {task['id']} order={arms} image={plan[-1]['image'] or 'MISSING'} "
              f"ports={plan[-1]['web_port']}/{plan[-1]['cdp_port']}")
    if not args.execute:
        print("[dry-run] add --execute to actually run the matrix")
        return 0
    missing = [p["task"] for p in plan if not p["image"]]
    if missing:
        print("missing --image-map for:", missing, file=sys.stderr)
        return 2

    summary = {"started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
               "manifest": str(manifest_path.resolve()), "runs": [],
               "total_tokens": 0, "stopped_for_budget": False}
    for item in plan:
        task_dir = runs_root / item["task"].split(".")[0]
        procs = []
        for slot, arm in enumerate(item["arms"]):
            out = task_dir / arm
            port_offset = slot
            cmd = arm_cmd(args, manifest_path, item["task"], arm, item["image"], out)
            cmd += ["--web-port", str(item["web_port"] + port_offset),
                    "--cdp-port", str(item["cdp_port"] + port_offset)]
            print(f"[run] task={item['task']} arm={arm} start={time.strftime('%H:%M:%S')}")
            procs.append((arm, out, subprocess.Popen(cmd)))
            time.sleep(5)  # 错开启动，避免同时抢镜像/Chrome
        for arm, out, proc in procs:
            code = proc.wait()
            record = {"task": item["task"], "arm": arm, "image": item["image"],
                      "exit": code, "attempts": 1}
            for attempt in range(infra_retries):
                if code != 2:
                    break
                print(f"[retry] task={item['task']} arm={arm} infra error, attempt {attempt + 2}")
                cmd = arm_cmd(args, manifest_path, item["task"], arm, item["image"], out)
                cmd += ["--web-port", str(item["web_port"] + (0 if arm == item["arms"][0] else 1)),
                        "--cdp-port", str(item["cdp_port"] + (0 if arm == item["arms"][0] else 1))]
                code = subprocess.run(cmd).returncode
                record["attempts"] += 1
                record["exit"] = code
            collect(out, record)
            summary["runs"].append(record)
            summary["total_tokens"] += int(record.get("tokens") or 0)
            (runs_root / "matrix.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
        if budget and summary["total_tokens"] > budget:
            summary["stopped_for_budget"] = True
            print(f"[stop] total tokens {summary['total_tokens']} > budget {budget}", file=sys.stderr)
            (runs_root / "matrix.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
            return 4
    summary["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    (runs_root / "matrix.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print("[done]", json.dumps(summary, ensure_ascii=False)[:800])
    return 0


if __name__ == "__main__":
    sys.exit(main())
