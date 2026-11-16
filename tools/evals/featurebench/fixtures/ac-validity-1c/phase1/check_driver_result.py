#!/usr/bin/env python3
"""Classify a Phase 1 driver-result.json together with the real Verifier recording.

Exit codes:
  0  driver completed normally AND the .ai/rsi Verifier recording contains a
     real structured verdict (approve/reject/needs_human)
  10 driver completed but no real structured verdict (no_verdict / fallback)
  11 missing/corrupt result or done != true
  12 aborted=timeout/over_budget
  13 turn_error=true (stream/agent error)

The main Agent's body text is NOT proof. The plugin synthesizes a fallback
`needs_human` when the verifier produced no structured verdict; that fallback
has no `verification_complete: true` / `raw_status` / `verification_run_id`.
Only a recording `000005.json` finished result with those real fields counts.
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

STATUSES = {"approve", "reject", "needs_human"}


def load_verifier_result(rsi_root: Path | None) -> dict | None:
    if rsi_root is None or not (rsi_root / "runs").is_dir():
        return None
    run_dirs = [d for d in (rsi_root / "runs").iterdir() if d.is_dir()]
    if not run_dirs:
        return None
    # The current call is the most recently created run. Do not fall back to an
    # older run if this one produced only a fallback: that would cross calls.
    latest = max(run_dirs, key=lambda d: d.stat().st_mtime_ns)
    for path in sorted(latest.glob("*.json")):
        try:
            d = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if d.get("kind") != "finished":
            continue
        result = (d.get("data") or {}).get("result")
        if not isinstance(result, dict):
            continue
        # Real verdicts carry all three; the fallback lacks verification_complete
        # (standalone) or has it false (task path).
        if (
            result.get("verification_complete") is True
            and result.get("raw_status") in STATUSES
            and result.get("verification_run_id")
            and result.get("status") in STATUSES
        ):
            result["_record_path"] = str(path)
            return result
    return None


def classify(path: Path, rsi_root: Path | None) -> tuple[int, str, dict]:
    if not path.is_file():
        return 11, "incomplete", {"driver_result": str(path), "error": "missing driver-result.json"}
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return 11, "incomplete", {"driver_result": str(path), "error": f"unreadable: {exc}"}
    info = {
        "driver_result": str(path),
        "done": d.get("done"),
        "aborted": d.get("aborted"),
        "turn_error": d.get("turn_error"),
        "usage_tokens": d.get("usage_tokens"),
        "elapsed_s": d.get("elapsed_s"),
        "verdict": None,
        "verification_complete": None,
        "verification_run_id": None,
    }
    # Preserve a real Verifier-only result even when the Driver turn failed:
    # these are separate facts (dual-dimension accounting), while the exit code
    # still reports the Driver/generation failure.
    result = load_verifier_result(rsi_root)
    if result is not None:
        info.update(
            verdict=result.get("status"),
            verification_complete=result.get("verification_complete"),
            verification_run_id=result.get("verification_run_id"),
            verifier_session=result.get("verifier_session"),
            verifier_record=result.get("_record_path"),
            verifier_summary_head=(result.get("summary") or "")[:160],
        )
    if d.get("aborted") not in (None, ""):
        return 12, "aborted", info
    if d.get("turn_error") is True:
        return 13, "turn_error", info
    if d.get("done") is not True:
        return 11, "incomplete", info
    if result is None:
        return 10, "no_verdict", info
    return 0, "completed", info


def _write_finished(root: Path, result: dict, run: str = "run", name: str = "000008.json") -> Path:
    p = root / "runs" / run / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"kind": "finished", "data": {"outcome": "completed", "result": result}}), encoding="utf-8")
    return p


def self_test() -> int:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        driver_complete = root / "driver-complete.json"
        driver_complete.write_text(json.dumps({"done": True, "aborted": None, "turn_error": False,
                                               "usage_tokens": 1, "elapsed_s": 2,
                                               "body": '{"status": "approve"}'}), encoding="utf-8")
        real = {"status": "needs_human", "verification_complete": True, "raw_status": "needs_human",
                "verification_run_id": "r-real", "verifier_session": "s-real", "summary": "real structured"}
        fallback = {"status": "needs_human", "verification_complete": False,
                    "summary": "验证者未产出结构化裁决，无法据此判断。"}
        cases = {
            "real_needs_human": (real, 0, "completed", "needs_human"),
            "fallback_needs_human": (fallback, 10, "no_verdict", None),
            "real_approve": ({"status": "approve", "verification_complete": True, "raw_status": "approve",
                              "verification_run_id": "r-a", "verifier_session": "s-a"}, 0, "completed", "approve"),
            "real_reject": ({"status": "reject", "verification_complete": True, "raw_status": "reject",
                             "verification_run_id": "r-r", "verifier_session": "s-r"}, 0, "completed", "reject"),
        }
        for name, (result, want_rc, want_status, want_verdict) in cases.items():
            rsi = root / name / ".ai" / "rsi"
            _write_finished(rsi, result)
            rc, status, info = classify(driver_complete, rsi)
            if (rc, status, info.get("verdict")) != (want_rc, want_status, want_verdict):
                print(f"SELF-TEST FAIL {name}: {(rc,status,info.get('verdict'))}", file=sys.stderr)
                return 1
        # A successful second attempt may be at 000008; do not require 000005.
        retry_rsi = root / "retry" / ".ai" / "rsi"
        (retry_rsi / "runs" / "run").mkdir(parents=True)
        (retry_rsi / "runs" / "run" / "000005.json").write_text(
            json.dumps({"kind": "attempt_started", "data": {}}), encoding="utf-8")
        _write_finished(retry_rsi, real, run="run", name="000008.json")
        rc, status, info = classify(driver_complete, retry_rsi)
        if (rc, status, info.get("verdict")) != (0, "completed", "needs_human"):
            print(f"SELF-TEST FAIL retry event: {(rc,status,info.get('verdict'))}", file=sys.stderr)
            return 1
        # Old run with real result must not leak into the latest failed run.
        old_rsi = root / "old-real" / ".ai" / "rsi"
        _write_finished(old_rsi, real, run="old", name="000005.json")
        _write_finished(old_rsi, fallback, run="new", name="000005.json")
        rc, status, _ = classify(driver_complete, old_rsi)
        if (rc, status) != (10, "no_verdict"):
            print(f"SELF-TEST FAIL old-run leak: {(rc,status)}", file=sys.stderr)
            return 1
        # Body-only status with no real recording must not count.
        rc, status, info = classify(driver_complete, root / "empty" / ".ai" / "rsi")
        if (rc, status) != (10, "no_verdict"):
            print(f"SELF-TEST FAIL body-only: {(rc,status)}", file=sys.stderr)
            return 1
        # turn_error keeps the real Verifier verdict as a separate fact.
        rsi_turn_error = root / "turn-error-real" / ".ai" / "rsi"
        _write_finished(rsi_turn_error, {"status": "approve", "verification_complete": True,
                                         "raw_status": "approve", "verification_run_id": "r-t",
                                         "verifier_session": "s-t"})
        p_turn = root / "turn-error-real.json"
        p_turn.write_text(json.dumps({"done": True, "aborted": None, "turn_error": True}), encoding="utf-8")
        rc, status, info = classify(p_turn, rsi_turn_error)
        if (rc, status, info.get("verdict")) != (13, "turn_error", "approve"):
            print(f"SELF-TEST FAIL turn_error dual: {(rc,status,info.get('verdict'))}", file=sys.stderr)
            return 1
        for name, payload, want_rc, want_status in [
            ("incomplete", {"done": False, "aborted": None, "turn_error": False}, 11, "incomplete"),
            ("timeout", {"done": True, "aborted": "timeout", "turn_error": False}, 12, "aborted"),
            ("over_budget", {"done": True, "aborted": "over_budget", "turn_error": False}, 12, "aborted"),
            ("turn_error", {"done": True, "aborted": None, "turn_error": True}, 13, "turn_error"),
        ]:
            p = root / f"{name}.json"
            p.write_text(json.dumps(payload), encoding="utf-8")
            rc, status, _ = classify(p, None)
            if (rc, status) != (want_rc, want_status):
                print(f"SELF-TEST FAIL {name}: {(rc,status)}", file=sys.stderr)
                return 1
        rc, status, _ = classify(root / "missing.json", None)
        if (rc, status) != (11, "incomplete"):
            print(f"SELF-TEST FAIL missing: {(rc,status)}", file=sys.stderr)
            return 1
    print("DRIVER RESULT SELF-TEST OK: real/fallback needs_human, approve/reject, no_verdict, aborted, turn_error, missing")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--result", type=Path)
    ap.add_argument("--rsi-root", type=Path)
    ap.add_argument("--status", type=Path)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    if args.result is None:
        ap.error("--result required")
    rc, status, info = classify(args.result, args.rsi_root)
    info["status"] = status
    if args.status:
        args.status.parent.mkdir(parents=True, exist_ok=True)
        args.status.write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"DRIVER RESULT {status}: rc={rc} verdict={info.get('verdict')} usage={info.get('usage_tokens')} elapsed={info.get('elapsed_s')} verifier_run={info.get('verification_run_id')}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
