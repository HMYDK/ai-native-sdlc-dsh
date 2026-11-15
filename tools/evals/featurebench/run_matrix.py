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
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import run_arm  # noqa: E402


def arm_cmd(args, manifest_path: Path, task_id: str, arm: str, image: str, out: Path,
            plugin_dir: Path | None = None, plugin_tarball: Path | None = None,
            expected_sha: str = "") -> list[str]:
    plugin_dir = plugin_dir or (Path(args.plugin_dir) if args.plugin_dir else None)
    cmd = [sys.executable, str(HERE / "run_arm.py"),
           "--manifest", str(manifest_path.resolve()),
           "--task-id", task_id, "--arm", arm, "--image", image,
           "--out", str(out), "--plugin-dir", str(plugin_dir.resolve()),
           "--credentials", str(Path(args.credentials).resolve()), "--execute"]
    if plugin_tarball:
        cmd += ["--plugin-tarball", str(plugin_tarball.resolve())]
    if expected_sha:
        cmd += ["--expected-plugin-sha256", expected_sha]
    return cmd


def parse_arm_map(pairs: list[str], flag: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for spec in pairs:
        arm, sep, value = spec.partition("=")
        arm, value = arm.strip(), value.strip()
        if not sep or not arm or not value:
            raise SystemExit(f"{flag} 需要 ARM=PATH，收到 {spec!r}")
        if arm in out:
            raise SystemExit(f"{flag} 重复指定 arm {arm!r}")
        out[arm] = value
    return out


def load_json(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def snapshot_meta(out: Path) -> dict | None:
    p = out / "meta.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


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
    ap.add_argument("--plugin-dir", required=False,
                    help="解包后的插件目录（dsh-sdlc/ + js-yaml/）；旧单目录用法")
    ap.add_argument("--arm-plugin-dir", action="append", default=[],
                    help="按 arm 指定插件目录，可重复，例如 'A=/tmp/plugin/A'（与 --plugin-dir 互斥优先）")
    ap.add_argument("--arm-plugin-tarball", action="append", default=[],
                    help="按 arm 指定 npm pack 产物，可重复；用于校验 manifest arms.<arm>.plugin_tarball_sha256")
    ap.add_argument("--strict-preflight", action="store_true",
                    help="dry-run 也做严格检查：任务 image-map、arm plugin dir/tarball hash 缺一即非 0")
    ap.add_argument("--credentials", required=True, help="隔离 .credentials.yaml")
    ap.add_argument("--image-map", action="append", default=[],
                    help="repo=派生镜像，可重复，例如 'sympy/sympy=fb-eval-base:sympy'")
    ap.add_argument("--web-port-base", type=int, default=3115)
    ap.add_argument("--cdp-port-base", type=int, default=9400)
    ap.add_argument("--parallel-tasks", type=int, default=1,
                    help="同时跑几个任务（每任务内部的 arm 仍并发；注意容器内存）")
    ap.add_argument("--arm-parallel", type=int, default=0,
                    help="每个任务内同时跑几个 arm（0=全部并发；1=串行）。模型流在高并发下会断，"
                         "重跑失败用例时建议 1-2")
    ap.add_argument("--only-arm", action="append", default=[],
                    help="只跑指定 arm（可重复，用于补跑）")
    ap.add_argument("--retry-failed", action="store_true",
                    help="跳过已成功（agent_completed、无 agent_failure、patch 非空）的 arm，只补跑失败/缺失的")
    ap.add_argument("--only-task", action="append", default=[],
                    help="只跑指定 task id（可重复）；顺序仍按 manifest 中的奇偶规则")
    ap.add_argument("--total-budget", type=int, default=None,
                    help="覆盖 manifest 的 total_token_budget（父编排传入剩余额度）")
    ap.add_argument("--execute", action="store_true", help="真正执行（默认 dry-run）")
    args = ap.parse_args()

    manifest_path = Path(args.manifest)
    manifest = yaml.safe_load(open(manifest_path, encoding="utf-8"))
    images = {}
    for spec in args.image_map:
        repo, _, img = spec.partition("=")
        images[repo.strip()] = img.strip()
    arm_dirs = {arm: Path(p) for arm, p in parse_arm_map(args.arm_plugin_dir, "--arm-plugin-dir").items()}
    arm_tarballs = {arm: Path(p) for arm, p in parse_arm_map(args.arm_plugin_tarball, "--arm-plugin-tarball").items()}
    if args.plugin_dir and arm_dirs:
        raise SystemExit("--plugin-dir 与 --arm-plugin-dir 不能同时使用；请二选一")
    arm_sha_cache: dict[str, str] = {}

    def arm_identity(arm: str) -> tuple[Path | None, Path | None, str]:
        """返回 (plugin_dir, tarball, expected_sha)；只做确定性检查，不启动容器。"""
        plugin_dir = arm_dirs.get(arm) or (Path(args.plugin_dir) if args.plugin_dir else None)
        tarball = arm_tarballs.get(arm)
        cfg_sha = str(((manifest.get("arms") or {}).get(arm) or {}).get("plugin_tarball_sha256") or "").strip().lower()
        expected = "" if cfg_sha.startswith("tbd") else cfg_sha
        if tarball:
            if not tarball.exists():
                raise SystemExit(f"arm {arm} plugin tarball 不存在: {tarball}")
            import hashlib
            h = hashlib.sha256()
            with tarball.open("rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            actual = h.hexdigest()
            arm_sha_cache[arm] = actual
            if not expected:
                raise SystemExit(f"arm {arm} 的 manifest plugin_tarball_sha256 未固定（不能是 TBD）")
            if actual != expected:
                raise SystemExit(f"arm {arm} plugin sha256 不匹配: actual={actual!r} expected={expected!r}")
        elif expected and args.strict_preflight:
            raise SystemExit(f"arm {arm} 有 plugin_tarball_sha256 但未提供 --arm-plugin-tarball")
        return plugin_dir, tarball, expected
    runs_root = Path(args.runs_root)
    runs_root.mkdir(parents=True, exist_ok=True)
    policy = manifest.get("run_policy", {})
    budget = int(policy.get("total_token_budget", 0))
    if args.total_budget is not None:
        # 父编排（run_repeats/run_regression）传进来的是「剩余额度」；取两者较小值，
        # manifest 未设预算时才直接采用剩余额度。
        budget = min(budget, max(0, args.total_budget)) if budget else max(0, args.total_budget)
    infra_retries = int(policy.get("infra_retries", 1))
    only = set(args.only_task)
    only_arms = set(args.only_arm)
    all_arms = [a for a in manifest["arms"].keys() if not only_arms or a in only_arms]
    if not all_arms:
        print(f"no arms selected: --only-arm={sorted(only_arms)} not in manifest arms "
              f"{sorted(manifest['arms'])}", file=sys.stderr)
        return 2
    if arm_dirs:
        absent = [a for a in all_arms if a not in arm_dirs]
        if absent:
            raise SystemExit(f"--arm-plugin-dir 缺少 arm 映射: {absent}")
    if arm_tarballs:
        absent = [a for a in all_arms if a not in arm_tarballs]
        if absent:
            raise SystemExit(f"--arm-plugin-tarball 缺少 arm 映射: {absent}")
    identity = {a: arm_identity(a) for a in all_arms}
    # 同一目录不能承载多个不同插件身份（reviewer F2：同一 --plugin-dir + 三个 commit
    # 等于没有 treatment）。只在确实提供了 tarball hash 时检查。
    distinct_sha = {v for v in arm_sha_cache.values() if v}
    if len(distinct_sha) > 1:
        distinct_dirs = {str((identity[a][0] or "").resolve()) for a in all_arms}
        if len(distinct_dirs) == 1:
            raise SystemExit("多个不同 plugin tarball 但只提供一个 plugin dir；"
                             "请用 --arm-plugin-dir 为每个 arm 指定独立目录")
    plan = []
    for i, task in enumerate(manifest["tasks"]):
        if only and task["id"] not in only:
            continue
        # 每次任务轮转启动顺序，避免总是同一 arm 先启动（时间漂移）
        arms = all_arms[i % len(all_arms):] + all_arms[:i % len(all_arms)]
        plan.append({"task": task["id"], "repo": task["repo"], "arms": arms,
                     "image": images.get(task["repo"]),
                     "web_port": args.web_port_base + i * 8,
                     "cdp_port": args.cdp_port_base + i * 8})
        print(f"[plan] {task['id']} order={arms} image={plan[-1]['image'] or 'MISSING'} "
              f"ports={plan[-1]['web_port']}/{plan[-1]['cdp_port']}")
    missing = [p["task"] for p in plan if not p["image"]]
    if missing and args.strict_preflight:
        print("missing --image-map for:", missing, file=sys.stderr)
        return 2
    if args.strict_preflight:
        for arm in all_arms:
            d, t, sha = identity[arm]
            if not d:
                print(f"arm {arm} 缺少 plugin dir（--plugin-dir 或 --arm-plugin-dir）", file=sys.stderr)
                return 2
            if not t:
                print(f"arm {arm} 缺少 --arm-plugin-tarball（strict preflight 要求 hash 绑定）", file=sys.stderr)
                return 2
            bind_errors = run_arm.verify_plugin_dir_matches_tarball(d, t)
            if bind_errors:
                print(f"arm {arm} plugin dir 与 tarball 不绑定:\n"
                      + "\n".join(" - " + e for e in bind_errors), file=sys.stderr)
                return 2
        print(f"[preflight] OK: {len(plan)} tasks, arms={all_arms}, "
              f"plugin_sha={ {a: arm_sha_cache.get(a, '') for a in all_arms} }")
    if not args.execute:
        print("[dry-run] add --execute to actually run the matrix")
        return 0
    if missing:
        print("missing --image-map for:", missing, file=sys.stderr)
        return 2
    missing_dirs = [a for a in all_arms if not identity[a][0]]
    if missing_dirs:
        print("missing plugin dir for arms:", missing_dirs, file=sys.stderr)
        return 2

    # --retry-failed 会复用同一个 runs root；必须先载入已有 matrix ledger，否则本次
    # 只包含补跑的 run，会把之前的 attempted-run 证据与 token 账本整体覆盖成空。
    prior_matrix_path = runs_root / "matrix.json"
    prior_matrix = load_json(prior_matrix_path) if prior_matrix_path.exists() else {}
    summary = {"started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
               "manifest": str(manifest_path.resolve()),
               "runs": list(prior_matrix.get("runs") or []),
               "total_tokens": int(prior_matrix.get("total_tokens") or 0),
               "stopped_for_budget": False}
    if prior_matrix:
        summary["resumed"] = True
        summary["resumed_from_total_tokens"] = int(prior_matrix.get("total_tokens") or 0)
    lock = threading.Lock()
    # 预算耗尽是“全局停止条件”，必须在启动任何新 run 之前检查；否则 --parallel-tasks>1 时
    # ThreadPoolExecutor.map 会把整个 plan 都排进队列，单个 worker 的局部 over_budget
    # 阻止不了其他 worker 继续启动剩余任务（实测 1 token 预算仍会跑完 8 个任务）。
    stop_event = threading.Event()

    def budget_exhausted() -> bool:
        if not budget:
            return False
        with lock:
            return summary["total_tokens"] > budget

    def run_task(item: dict) -> str:
        """跑一个任务的所有 arm（并发）。返回 stop / ok / infra。"""
        if stop_event.is_set() or budget_exhausted():
            stop_event.set()
            return "stop"
        # 用完整 instance_id 做目录：同 repo 的多个任务不能共用一个 arm 目录，
        # 否则后跑的会覆盖先跑的 meta/patch（实验②踩过，数据作废重跑）。
        task_dir = runs_root / item["task"]
        over_budget = False
        arm_parallel = args.arm_parallel or len(item["arms"])
        for batch_start in range(0, len(item["arms"]), arm_parallel):
            if stop_event.is_set() or budget_exhausted():
                stop_event.set()
                return "stop"
            batch = list(enumerate(item["arms"]))[batch_start:batch_start + arm_parallel]
            procs = []
            for slot, arm in batch:
                if stop_event.is_set() or budget_exhausted():
                    stop_event.set()
                    over_budget = True
                    break
                out = task_dir / arm
                if args.retry_failed and (out / "meta.json").exists():
                    try:
                        prev = json.loads((out / "meta.json").read_text(encoding="utf-8"))
                        # 只补跑基础设施失败（turn_error/driver_error/未完成）；
                        # timeout/over_budget 是预注册策略下的合法结果，不重试，
                        # 否则等于按结果挑样本。
                        failure = prev.get("agent_failure")
                        policy_outcome = failure in ("timeout", "over_budget")
                        ok = (policy_outcome
                              or (prev.get("agent_completed") is True and not failure))
                        if ok:
                            print(f"[skip] task={item['task']} arm={arm} already succeeded")
                            continue
                    except Exception:
                        pass
                plugin_dir, plugin_tarball, plugin_sha = identity[arm]
                cmd = arm_cmd(args, manifest_path, item["task"], arm, item["image"], out,
                              plugin_dir=plugin_dir, plugin_tarball=plugin_tarball,
                              expected_sha=plugin_sha)
                cmd += ["--web-port", str(item["web_port"] + slot),
                        "--cdp-port", str(item["cdp_port"] + slot)]
                print(f"[run] task={item['task']} arm={arm} start={time.strftime('%H:%M:%S')}")
                procs.append((slot, arm, out, subprocess.Popen(cmd)))
                time.sleep(5)  # 错开启动，避免同时抢镜像/Chrome
            for slot, arm, out, proc in procs:
                code = proc.wait()
                # 重试会复用/覆盖同一个输出目录的 meta.json；每次尝试的 token 必须在被覆盖前
                # 记账，否则只有最后一次尝试进入共享预算与成本汇总。
                attempt_metas = [snapshot_meta(out)]
                charged = 0
                for attempt in range(infra_retries):
                    if code != 2:
                        break
                    prev_tokens = int((attempt_metas[-1] or {}).get("token_usage") or 0)
                    if prev_tokens:
                        with lock:
                            summary["total_tokens"] += prev_tokens
                            charged += prev_tokens
                            (runs_root / "matrix.json").write_text(
                                json.dumps(summary, ensure_ascii=False, indent=2))
                            if budget and summary["total_tokens"] > budget:
                                over_budget = True
                                stop_event.set()
                    if stop_event.is_set():
                        break
                    print(f"[retry] task={item['task']} arm={arm} infra error, attempt {attempt + 2}")
                    cmd = arm_cmd(args, manifest_path, item["task"], arm, item["image"], out,
                                  plugin_dir=plugin_dir, plugin_tarball=plugin_tarball,
                                  expected_sha=plugin_sha)
                    cmd += ["--web-port", str(item["web_port"] + slot),
                            "--cdp-port", str(item["cdp_port"] + slot)]
                    code = subprocess.run(cmd).returncode
                    attempt_metas.append(snapshot_meta(out))
                record = {"task": item["task"], "arm": arm, "image": item["image"],
                          "exit": code, "attempts": len(attempt_metas),
                          "attempt_usage": [
                              (m or {}).get("token_usage") for m in attempt_metas
                          ]}
                collect(out, record)
                usage = [(m or {}).get("token_usage") for m in attempt_metas]
                if any(t is not None for t in usage):
                    record["tokens"] = sum(int(t or 0) for t in usage)
                with lock:
                    # 补跑同一个 (task, arm)：保留旧记录里的尝试证据，再用本次结果替换；
                    # 旧 token 已在 resumed_from_total_tokens 里计入，不重复加。
                    prior_record = next(
                        (r for r in summary["runs"]
                         if r.get("task") == item["task"] and r.get("arm") == arm), None)
                    if prior_record is not None:
                        summary["runs"].remove(prior_record)
                        record["prior_attempts"] = prior_record.get("attempts")
                        record["prior_attempt_usage"] = prior_record.get("attempt_usage")
                        record["prior_tokens"] = prior_record.get("tokens")
                    summary["runs"].append(record)
                    summary["total_tokens"] += max(0, int(record.get("tokens") or 0) - charged)
                    (runs_root / "matrix.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
                    if budget and summary["total_tokens"] > budget:
                        over_budget = True
                        stop_event.set()
        return "stop" if over_budget else "ok"

    if args.parallel_tasks <= 1:
        for item in plan:
            if run_task(item) == "stop":
                summary["stopped_for_budget"] = True
                return 4
    else:
        with ThreadPoolExecutor(max_workers=args.parallel_tasks) as ex:
            futures = [ex.submit(run_task, item) for item in plan]
            for fut in as_completed(futures):
                if fut.result() == "stop":
                    summary["stopped_for_budget"] = True
                    stop_event.set()
                    (runs_root / "matrix.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
                    return 4
    summary["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    (runs_root / "matrix.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print("[done]", json.dumps(summary, ensure_ascii=False)[:800])
    return 0


if __name__ == "__main__":
    sys.exit(main())
