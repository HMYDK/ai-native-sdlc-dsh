#!/usr/bin/env python3
"""重复采样实验编排：同一 manifest 跑 N 个独立 rep（每 rep 一次完整矩阵 + 官方评分）。

为什么要单独一个脚本：run_matrix 一次运行是一个 rep；重复采样要求同一任务/arm 的
多次运行互相独立（不同 runs-root），并且要跨 rep 累计 token 预算。

用法：
    python3 run_repeats.py --manifest manifests/repeat-sampling.yml \
        --runs-root /tmp/fb-runs-repeat --reps 3 \
        --image-map pypa/packaging=fb-eval-base:packaging ... \
        --plugin-dir /tmp/fb-plugin --credentials /tmp/fb-creds.yaml --execute

每个 rep 的产物：<runs-root>/rep<i>/；日志：<runs-root>/rep<i>.log。
预算：manifest.run_policy.total_token_budget 为总预算，跨 rep 累计；超过后停止后续 rep。
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


def load_json(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def total_tokens(runs_root: Path) -> int:
    """跨 rep 累计 token；优先用 matrix.json 的 total_tokens（已含每次 attempt）。

    只看 meta.json 会漏掉 infra 重试中失败那次的用量（run_matrix 现在会把每次尝试都
    记进 matrix.json），导致跨 rep 预算在重跑后仍被低估。
    """
    matrices = sorted(runs_root.glob("rep*/matrix.json"))
    if matrices:
        total = 0
        covered: list[Path] = []
        for m in matrices:
            d = load_json(m) or {}
            t = d.get("total_tokens")
            if isinstance(t, (int, float)):
                total += int(t)
                covered.append(m.parent)
            else:
                for f in m.parent.glob("**/meta.json"):
                    md = load_json(f) or {}
                    tt = md.get("token_usage")
                    if isinstance(tt, (int, float)):
                        total += int(tt)
                covered.append(m.parent)
        for f in runs_root.glob("**/meta.json"):
            if any(f.is_relative_to(d) for d in covered):
                continue
            d = load_json(f) or {}
            t = d.get("token_usage")
            if isinstance(t, (int, float)):
                total += int(t)
        return total
    total = 0
    for f in runs_root.glob("**/meta.json"):
        d = load_json(f) or {}
        t = d.get("token_usage")
        if isinstance(t, (int, float)):
            total += int(t)
    return total


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default=str(HERE / "manifests" / "repeat-sampling.yml"))
    ap.add_argument("--runs-root", required=True)
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--plugin-dir", required=True)
    ap.add_argument("--credentials", required=True)
    ap.add_argument("--image-map", action="append", default=[])
    ap.add_argument("--parallel-tasks", type=int, default=2)
    ap.add_argument("--arm-parallel", type=int, default=2)
    ap.add_argument("--web-port-base", type=int, default=3500)
    ap.add_argument("--cdp-port-base", type=int, default=9800)
    ap.add_argument("--budget", type=int, default=None,
                    help="覆盖 manifest 的 total_token_budget（父编排传入剩余额度）")
    ap.add_argument("--execute", action="store_true")
    args = ap.parse_args()

    manifest = yaml.safe_load(open(args.manifest, encoding="utf-8"))
    budget = int(manifest.get("run_policy", {}).get("total_token_budget", 0))
    if args.budget is not None:
        budget = min(budget, max(0, args.budget)) if budget else max(0, args.budget)
    runs_root = Path(args.runs_root)
    runs_root.mkdir(parents=True, exist_ok=True)
    plan = []
    for i in range(args.reps):
        rep_root = runs_root / f"rep{i + 1}"
        cmd = [sys.executable, str(HERE / "run_matrix.py"),
               "--manifest", str(Path(args.manifest).resolve()),
               "--runs-root", str(rep_root),
               "--plugin-dir", str(Path(args.plugin_dir).resolve()),
               "--credentials", str(Path(args.credentials).resolve()),
               "--parallel-tasks", str(args.parallel_tasks),
               "--arm-parallel", str(args.arm_parallel),
               "--web-port-base", str(args.web_port_base + i * 20),
               "--cdp-port-base", str(args.cdp_port_base + i * 20)]
        for spec in args.image_map:
            cmd += ["--image-map", spec]
        if args.execute:
            cmd += ["--execute"]
        plan.append((i + 1, rep_root, cmd))
        print("[plan] rep", i + 1, "runs_root", rep_root)
    if not args.execute:
        print("[dry-run] add --execute to run repeats")
        return 0

    for rep, rep_root, cmd in plan:
        used = total_tokens(runs_root)
        remaining = max(0, budget - used) if budget else None
        if budget and remaining <= 0:
            print(f"[stop] total tokens {used} >= budget {budget}", file=sys.stderr)
            return 4
        print(f"[rep] {rep} start {time.strftime('%H:%M:%S')} used={used} "
              f"remaining={remaining}")
        # 每个 rep 的 matrix 必须继承剩余额度：否则已花掉 290M 后，下一个 rep 还会拿到
        # manifest 里的完整 300M 预算，跨 rep 的限制形同虚设。
        rep_cmd = list(cmd)
        if remaining is not None:
            rep_cmd += ["--total-budget", str(remaining)]
        log = runs_root / f"rep{rep}.matrix.log"
        with open(log, "w") as fh:
            code = subprocess.run(rep_cmd, stdout=fh, stderr=subprocess.STDOUT).returncode
        print(f"[rep] {rep} matrix exit={code}")
        # 官方评分（只评这一 rep）
        eval_cmd = [sys.executable, str(HERE / "evaluate_matrix.py"),
                    "--manifest", str(Path(args.manifest).resolve()),
                    "--runs-root", str(rep_root),
                    "--execute"]
        with open(runs_root / f"rep{rep}.eval.log", "w") as fh:
            ecode = subprocess.run(eval_cmd, stdout=fh, stderr=subprocess.STDOUT).returncode
        print(f"[rep] {rep} eval exit={ecode}")
    used = total_tokens(runs_root)
    print(f"[done] reps={args.reps} total_tokens={used} budget={budget}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
