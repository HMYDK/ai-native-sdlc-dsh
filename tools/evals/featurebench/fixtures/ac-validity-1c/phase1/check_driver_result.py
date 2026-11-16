#!/usr/bin/env python3
"""Classify a Phase 1 driver-result.json without contacting a model.

Exit codes:
  0  driver completed normally AND a readable Verifier verdict exists
  10 driver completed but no readable verdict (no_verdict; still attempted/ITT)
  11 missing/corrupt result or done != true
  12 aborted=timeout/over_budget
  13 turn_error=true (stream/agent error)

The status JSON preserves done/aborted/turn_error/usage/elapsed/verdict so a
failed attempt is not mistaken for success and no retry happens silently.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
from pathlib import Path

VERDICT_RE = re.compile(r'"status"\s*:\s*"(approve|reject|needs_human)"')


def classify(path: Path) -> tuple[int, str, dict]:
    if not path.is_file():
        return 11, "incomplete", {"driver_result": str(path), "error": "missing driver-result.json"}
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return 11, "incomplete", {"driver_result": str(path), "error": f"unreadable: {exc}"}
    body = d.get("body") if isinstance(d.get("body"), str) else ""
    matches = VERDICT_RE.findall(body)
    verdict = matches[-1] if matches else None
    info = {
        "driver_result": str(path),
        "done": d.get("done"),
        "aborted": d.get("aborted"),
        "turn_error": d.get("turn_error"),
        "usage_tokens": d.get("usage_tokens"),
        "elapsed_s": d.get("elapsed_s"),
        "verdict": verdict,
    }
    if d.get("aborted") not in (None, ""):
        return 12, "aborted", info
    if d.get("turn_error") is True:
        return 13, "turn_error", info
    if d.get("done") is not True:
        return 11, "incomplete", info
    if verdict is None:
        return 10, "no_verdict", info
    return 0, "completed", info


def self_test() -> int:
    cases = {
        "complete": ({"done": True, "aborted": None, "turn_error": False, "usage_tokens": 1, "elapsed_s": 2,
                      "body": '{"status": "approve"}'}, 0, "completed"),
        "no_verdict": ({"done": True, "aborted": None, "turn_error": False, "body": "done without verdict"}, 10, "no_verdict"),
        "incomplete": ({"done": False, "aborted": None, "turn_error": False, "body": ""}, 11, "incomplete"),
        "aborted_timeout": ({"done": True, "aborted": "timeout", "turn_error": False, "body": ""}, 12, "aborted"),
        "aborted_budget": ({"done": True, "aborted": "over_budget", "turn_error": False, "body": ""}, 12, "aborted"),
        "turn_error": ({"done": True, "aborted": None, "turn_error": True, "body": '{"status": "reject"}'}, 13, "turn_error"),
    }
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        for name, (payload, want_rc, want_status) in cases.items():
            p = root / f"{name}.json"
            p.write_text(json.dumps(payload), encoding="utf-8")
            rc, status, _ = classify(p)
            if (rc, status) != (want_rc, want_status):
                print(f"SELF-TEST FAIL {name}: got {(rc, status)} want {(want_rc, want_status)}", file=sys.stderr)
                return 1
        rc, status, _ = classify(root / "missing.json")
        if (rc, status) != (11, "incomplete"):
            print(f"SELF-TEST FAIL missing: got {(rc, status)}", file=sys.stderr)
            return 1
    print("DRIVER RESULT SELF-TEST OK: complete/no_verdict/incomplete/aborted/turn_error/missing classified")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--result", type=Path)
    ap.add_argument("--status", type=Path)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    if args.result is None:
        ap.error("--result required")
    rc, status, info = classify(args.result)
    info["status"] = status
    if args.status:
        args.status.parent.mkdir(parents=True, exist_ok=True)
        args.status.write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"DRIVER RESULT {status}: rc={rc} verdict={info.get('verdict')} usage={info.get('usage_tokens')} elapsed={info.get('elapsed_s')}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
