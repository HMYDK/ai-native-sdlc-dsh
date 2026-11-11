#!/usr/bin/env python3
"""第三轮「全量回归」编排：按固定顺序跑完 5 组实验并逐组官方评分。

组顺序（先跑核心对照，再跑验证者/扩样本，最后重复采样）：
  1) 2x2        5 任务 × 4 条件      = 20 runs
  2) expanded   12 任务 × 2 臂       = 24 runs
  3) verify     10 任务 × B          = 10 runs
  4) stress     1 任务 × B × 3 rep   =  3 runs
  5) repeat     3 任务 × 2 臂 × 3 rep= 18 runs
预算按所有组的 meta token_usage 累计，超过 --budget 即停止后续组。
每组跑完立即用官方 fb eval 评分（CPU，不耗模型 token）。
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
DEFAULT_MANIFEST_DIR = HERE / "manifests" / "regression-0.6.1"


def load_json(p):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def total_tokens(root: Path) -> int:
    """跨 group/repetition 累计 token；优先用各 matrix.json 的 total_tokens。

    只看 meta.json 会漏掉 infra 重试中失败那次的用量（run_matrix 已把每次尝试记进
    matrix.json），跨组预算会在重跑后仍被低估；matrix 覆盖不到的 meta 才单独补。
    """
    matrices = sorted(root.rglob("matrix.json"))
    if matrices:
        total = 0
        covered: list[Path] = []
        for m in matrices:
            d = load_json(m) or {}
            t = d.get("total_tokens")
            if isinstance(t, (int, float)):
                total += int(t)
            else:
                for f in m.parent.glob("**/meta.json"):
                    md = load_json(f) or {}
                    tt = md.get("token_usage")
                    if isinstance(tt, (int, float)):
                        total += int(tt)
            covered.append(m.parent)
        for f in root.glob("**/meta.json"):
            if any(f.is_relative_to(d) for d in covered):
                continue
            d = load_json(f) or {}
            t = d.get("token_usage")
            if isinstance(t, (int, float)):
                total += int(t)
        return total
    total = 0
    for f in root.glob("**/meta.json"):
        d = load_json(f) or {}
        t = d.get("token_usage")
        if isinstance(t, (int, float)):
            total += int(t)
    return total


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest-dir", default=str(DEFAULT_MANIFEST_DIR))
    ap.add_argument("--runs-root", required=True)
    ap.add_argument("--plugin-dir", required=True)
    ap.add_argument("--credentials", required=True)
    ap.add_argument("--image-map", action="append", default=[])
    ap.add_argument("--budget", type=int, default=800_000_000)
    ap.add_argument("--web-port-base", type=int, default=3600)
    ap.add_argument("--cdp-port-base", type=int, default=9900)
    ap.add_argument("--only-group", action="append", default=[])
    ap.add_argument("--execute", action="store_true")
    args = ap.parse_args()

    mdir = Path(args.manifest_dir)
    root = Path(args.runs_root)
    root.mkdir(parents=True, exist_ok=True)
    only = set(args.only_group)

    py = sys.executable
    def matrix(manifest, out, parallel_tasks, arm_parallel, port_base, cdp_base):
        cmd = [py, str(HERE / "run_matrix.py"), "--manifest", str(mdir / manifest),
               "--runs-root", str(out), "--plugin-dir", str(Path(args.plugin_dir).resolve()),
               "--credentials", str(Path(args.credentials).resolve()),
               "--parallel-tasks", str(parallel_tasks), "--arm-parallel", str(arm_parallel),
               "--web-port-base", str(port_base), "--cdp-port-base", str(cdp_base)]
        for m in args.image_map:
            cmd += ["--image-map", m]
        remaining = max(0, args.budget - total_tokens(root))
        cmd += ["--total-budget", str(remaining)]
        if args.execute:
            cmd += ["--execute"]
        return cmd

    def evaluate(manifest, out):
        cmd = [py, str(HERE / "evaluate_matrix.py"), "--manifest", str(mdir / manifest),
               "--runs-root", str(out)]
        # 默认 dry-run 必须一路传到官方评分：只有 --execute 才真正调用 fb eval，
        # 否则默认调用会用已有 patch 覆盖评分产物。
        if args.execute:
            cmd += ["--execute"]
        return cmd

    groups = [
        ("2x2", "2x2.yml", lambda out, i: [matrix("2x2.yml", out, 2, 2, args.web_port_base + i * 20, args.cdp_port_base + i * 20), evaluate("2x2.yml", out)]),
        ("expanded", "expanded.yml", lambda out, i: [matrix("expanded.yml", out, 2, 2, args.web_port_base + i * 20, args.cdp_port_base + i * 20), evaluate("expanded.yml", out)]),
        ("verify", "verify-calibration.yml", lambda out, i: [matrix("verify-calibration.yml", out, 3, 1, args.web_port_base + i * 20, args.cdp_port_base + i * 20), evaluate("verify-calibration.yml", out)]),
        ("stress", "verify-stress.yml", None),
        ("repeat", "repeat-sampling.yml", None),
    ]

    for idx, (name, manifest, fn) in enumerate(groups):
        if only and name not in only:
            continue
        used = total_tokens(root)
        if used > args.budget:
            print(f"[stop] tokens {used} > budget {args.budget}", file=sys.stderr)
            return 4
        print(f"[group] {name} start {time.strftime('%H:%M:%S')} used={used}")
        if name == "stress":
            for rep in (1, 2, 3):
                out = root / "stress" / f"rep{rep}"
                cmd = matrix("verify-stress.yml", out, 1, 1, args.web_port_base + idx * 20 + rep, args.cdp_port_base + idx * 20 + rep)
                subprocess.run(cmd, stdout=open(root / f"{name}-rep{rep}.log", "w"),
                               stderr=subprocess.STDOUT)
                subprocess.run(evaluate("verify-stress.yml", out),
                               stdout=open(root / f"{name}-rep{rep}.eval.log", "w"),
                               stderr=subprocess.STDOUT)
            print(f"[group] {name} done")
            continue
        if name == "repeat":
            cmd = [py, str(HERE / "run_repeats.py"), "--manifest", str(mdir / "repeat-sampling.yml"),
                   "--runs-root", str(root / "repeat"), "--reps", "3",
                   "--plugin-dir", str(Path(args.plugin_dir).resolve()),
                   "--credentials", str(Path(args.credentials).resolve()),
                   "--parallel-tasks", "2", "--arm-parallel", "2",
                   "--web-port-base", str(args.web_port_base + idx * 20),
                   "--cdp-port-base", str(args.cdp_port_base)]
            for m in args.image_map:
                cmd += ["--image-map", m]
            remaining = max(0, args.budget - total_tokens(root))
            cmd += ["--budget", str(remaining)]
            if args.execute:
                cmd += ["--execute"]
            subprocess.run(cmd, stdout=open(root / f"{name}.log", "w"), stderr=subprocess.STDOUT)
            print(f"[group] {name} done")
            continue
        out = root / name
        for cmd, logname in zip(fn(out, idx), [f"{name}.matrix.log", f"{name}.eval.log"]):
            subprocess.run(cmd, stdout=open(root / logname, "w"), stderr=subprocess.STDOUT)
        print(f"[group] {name} done tokens={total_tokens(root)}")
    print(f"[done] total_tokens={total_tokens(root)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
