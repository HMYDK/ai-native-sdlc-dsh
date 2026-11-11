#!/usr/bin/env python3
"""评测清单与评分器的自检（不调模型）。

两种模式：

1) `--structural`（CI 默认，不依赖 Docker/网络）：
   校验 base manifest 与 manifests/*.yml 的结构：字段、任务 id 唯一性、镜像 digest
   格式、level 与 id 后缀一致、arm 的 preset、运行纪律取值上限、标准臂不得带引导
   （否则 A/B 不再可比）等。

2) `--control --task-id <id> --image <派生镜像>`（需要 `--execute`）：
   用官方 fb eval 跑 gold / empty 两个预测做负/正对照：
   - gold（数据集 patch 经官方 preprocess 还原）必须 resolved；
   - empty（空补丁）必须 unresolved。
   这是「评分链路没坏 + 官方 mask 环境可用」的最小证据，不消耗模型 token。

用法：
    python3 sanity_check.py --structural
    python3 sanity_check.py --control --task-id <id> --image fb-eval-base:<repo> \
        --config /tmp/fb/config.toml --execute
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
REQUIRED_TOP = ("version", "date", "benchmark", "runtime", "arms", "run_policy", "tasks")
DIGEST_RE = __import__("re").compile(r"^sha256:[0-9a-f]{64}$")


def check_manifest(path: Path, base: dict | None) -> list[str]:
    errs: list[str] = []
    try:
        m = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as e:
        return [f"{path}: YAML 解析失败: {e}"]
    if not isinstance(m, dict):
        return [f"{path}: 顶层不是 mapping"]
    for k in REQUIRED_TOP:
        if k not in m:
            errs.append(f"{path}: 缺少字段 {k}")
    if errs:
        return errs
    if not isinstance(m["version"], int):
        errs.append(f"{path}: version 必须是整数")
    ids = [t.get("id") for t in m["tasks"] if isinstance(t, dict)]
    if len(ids) != len(set(ids)):
        errs.append(f"{path}: 任务 id 有重复")
    if not m["tasks"]:
        errs.append(f"{path}: tasks 为空")
    for t in m["tasks"]:
        for k in ("id", "repo", "level", "image", "image_digest"):
            if k not in t:
                errs.append(f"{path}: task {t.get('id')} 缺少 {k}")
                continue
        tid = str(t.get("id"))
        if tid.endswith(".lv1") and t.get("level") != 1:
            errs.append(f"{path}: {tid} 后缀 lv1 但 level={t.get('level')}")
        if tid.endswith(".lv2") and t.get("level") != 2:
            errs.append(f"{path}: {tid} 后缀 lv2 但 level={t.get('level')}")
        if not DIGEST_RE.match(str(t.get("image_digest", ""))):
            errs.append(f"{path}: {tid} image_digest 格式不对")
        if base is not None:
            repo_images = {b["repo"]: (b["image"], b["image_digest"]) for b in base["tasks"]}
            if t["repo"] in repo_images and (t["image"], t["image_digest"]) != repo_images[t["repo"]]:
                errs.append(f"{path}: {tid} 的镜像与 base manifest 不一致（会混入不同环境）")
    for name, arm in m["arms"].items():
        if not arm.get("preset"):
            errs.append(f"{path}: arm {name} 缺少 preset")
        if name == "standard" and (arm.get("prompt_suffix") or "").strip():
            errs.append(f"{path}: standard arm 不允许带 prompt_suffix（A/B 可比性）")
    pol = m["run_policy"]
    for k in ("timeout_seconds", "max_tokens_per_run", "total_token_budget"):
        if not isinstance(pol.get(k), (int, float)) or pol.get(k) <= 0:
            errs.append(f"{path}: run_policy.{k} 必须是正数")
    if pol.get("timeout_seconds", 0) > 7200:
        errs.append(f"{path}: timeout_seconds 超过 7200（2h）")
    if pol.get("total_token_budget", 0) > 2_000_000_000:
        errs.append(f"{path}: total_token_budget 超过 2B，疑似写错")
    return errs


def structural(manifests_dir: Path) -> int:
    base_path = HERE / "manifest.yml"
    base = yaml.safe_load(base_path.read_text(encoding="utf-8"))
    errors = check_manifest(base_path, None)
    files = sorted(manifests_dir.glob("*.yml")) if manifests_dir.exists() else []
    for f in files:
        errors += check_manifest(f, base)
    print(f"manifests: base + {len(files)} ({', '.join(f.name for f in files)})")
    if errors:
        print("\n".join(f"ERROR {e}" for e in errors), file=sys.stderr)
        return 1
    print("structural check OK")
    return 0


def read_fresh_report(work: Path, pred: Path, started: float) -> tuple[dict, bool]:
    """读取本次 control 调用写出的官方 report；exit code 之外还要求 report 是新的且有效。

    返回 (report, report_ok)。report_ok=False 表示评分器崩溃/没写出报告/报告为空，
    此时不能把空 report 的 resolved=False 当成「官方判 unresolved」。
    """
    for cand in (work / "report.json", pred.parent / "report.json"):
        if cand.exists() and cand.stat().st_mtime >= started - 1:
            try:
                report = json.loads(cand.read_text(encoding="utf-8")).get("attempt_1", {})
            except Exception:
                report = {}
            ok = bool(report) and "resolved_instances" in report
            return report, ok
    return {}, False


def control(task_id: str, image: str, config: str | None, fb_bin: str) -> int:
    from datasets import load_dataset
    from featurebench.harness.utils import preprocess_hf_patch

    ds = load_dataset("LiberCoders/FeatureBench", "default", split="fast", revision="v1.1")
    row = next((r for r in ds if r["instance_id"] == task_id), None)
    if row is None:
        print(f"task {task_id} 不在 dataset fast split", file=sys.stderr)
        return 2
    gold = preprocess_hf_patch(row.get("patch", ""), row.get("FAIL_TO_PASS", []))
    if not gold.strip():
        print("gold patch 为空，无法做对照", file=sys.stderr)
        return 2
    env = dict(os.environ, FEATUREBENCH_IMAGE_PREFIX="docker.io")
    tmp = Path(tempfile.mkdtemp(prefix="fb-control-"))
    results = {}
    for label, patch in (("gold", gold), ("empty", "")):
        pred = tmp / f"{label}.jsonl"
        pred.write_text(json.dumps({
            "instance_id": task_id, "model_name_or_path": f"control-{label}",
            "model_patch": patch, "success": True, "n_attempt": 1,
        }, ensure_ascii=False) + "\n", encoding="utf-8")
        cmd = [fb_bin, "eval", "-p", str(pred), "--split", "fast", "--task-id", task_id,
               "--n-concurrent", "1", "--data-version", "v1.1"]
        if config:
            cmd += ["--config-path", config]
        work = tmp / label
        work.mkdir()
        started = time.time()
        r = subprocess.run(cmd, cwd=work, env=env, capture_output=True, text=True)
        (work / "eval.log").write_text(r.stdout + "\n" + r.stderr)
        report, report_ok = read_fresh_report(work, pred, started)
        if r.returncode != 0:
            report_ok = False
        results[label] = {
            "resolved": (bool(report.get("resolved_instances")) if report_ok else None),
            "pass_rate": report.get("pass_rate") if report_ok else None,
            "postprocessed_patch_chars": len(patch),
            "eval_exit": r.returncode,
            "report_ok": report_ok,
        }
        print(f"[control] {label}: eval_exit={r.returncode} report_ok={report_ok} "
              f"resolved={results[label]['resolved']} "
              f"pass_rate={results[label]['pass_rate']}")
    both_reports_ok = all(r["report_ok"] for r in results.values())
    ok = (both_reports_ok
          and results["gold"]["resolved"] is True
          and results["empty"]["resolved"] is False)
    print(json.dumps({"task_id": task_id, "image": image, "ok": ok, "results": results},
                     ensure_ascii=False, indent=2))
    if not ok:
        if not both_reports_ok:
            print("CONTROL FAILED：评分器没有为两个 control 都产出有效 report"
                  "（exit code / report 缺失或为空），不能据此判定评分链路正常",
                  file=sys.stderr)
        else:
            print("CONTROL FAILED：gold 应 resolved 且 empty 应 unresolved", file=sys.stderr)
        return 1
    print("control check OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--structural", action="store_true", help="校验清单结构（CI 用）")
    ap.add_argument("--control", action="store_true", help="gold/empty 对照（需 --execute）")
    ap.add_argument("--manifests-dir", default=str(HERE / "manifests"))
    ap.add_argument("--task-id", help="control 用：固定任务 id")
    ap.add_argument("--image", help="control 用：本地派生镜像（fb-eval-base:<repo>）")
    ap.add_argument("--config", help="fb eval 的 config.toml")
    ap.add_argument("--fb-bin", default="fb")
    ap.add_argument("--execute", action="store_true", help="control 模式必须显式开启")
    args = ap.parse_args()
    if args.structural:
        return structural(Path(args.manifests_dir))
    if args.control:
        if not args.execute:
            print("[dry-run] control 需要 --execute（会起容器跑官方测试）", file=sys.stderr)
            return 0
        if not (args.task_id and args.image):
            print("control 需要 --task-id 和 --image", file=sys.stderr)
            return 2
        return control(args.task_id, args.image, args.config, args.fb_bin)
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
