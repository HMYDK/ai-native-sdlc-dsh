#!/usr/bin/env python3
"""Post-call check: the Verifier's recorded snapshot must be the frozen one.

Reads the latest `.ai/rsi/runs/*/code.json` produced in the actual workspace,
requires its `head` to equal the plan call's `head_commit`, and re-checks the
workspace Git HEAD/diff. Missing code.json or any mismatch exits non-zero so the
runner records the call as invalid instead of trusting the driver exit code.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml


def latest_code(workspace: Path) -> Path | None:
    runs = list((workspace / ".ai" / "rsi" / "runs").glob("*/code.json"))
    return max(runs, key=lambda p: p.stat().st_mtime) if runs else None


def code_head_error(code: Path | None, expected: str) -> str | None:
    if code is None or not code.is_file():
        return "missing code.json"
    try:
        d = json.loads(code.read_text(encoding="utf-8"))
    except Exception as exc:
        return f"cannot read code.json: {exc}"
    actual = d.get("head")
    if actual != expected:
        return f"verifier head {actual} != expected {expected}"
    return None


def check(call: str, workspace: Path, plan_path: Path) -> int:
    plan = yaml.safe_load(plan_path.read_text(encoding="utf-8"))
    c = next((x for x in plan["calls"] if x["id"] == call), None)
    if c is None:
        print(f"POSTCHECK_FAIL unknown call {call}", file=sys.stderr)
        return 2
    code = latest_code(workspace)
    err = code_head_error(code, c["head_commit"])
    if err is not None:
        print(f"POSTCHECK_FAIL {err}", file=sys.stderr)
        return 3
    try:
        head = subprocess.check_output(["git", "-C", str(workspace), "rev-parse", "HEAD"]).decode().strip()
        base = subprocess.check_output(["git", "-C", str(workspace), "rev-parse", "HEAD~1"]).decode().strip()
        diff = subprocess.check_output(["git", "-C", str(workspace), "diff", "HEAD~1..HEAD"])
    except subprocess.CalledProcessError as exc:
        print(f"POSTCHECK_FAIL git: {exc}", file=sys.stderr)
        return 6
    if (base, head, hashlib.sha256(diff).hexdigest()) != (c["base_commit"], c["head_commit"], c["diff_sha256"]):
        print("POSTCHECK_FAIL workspace Git base/head/diff mismatch", file=sys.stderr)
        return 7
    print(f"POSTCHECK OK: {call} verifier/workspace head={head} rsi={code}")
    return 0


def self_test() -> int:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        valid = root / "valid" / ".ai" / "rsi" / "runs" / "x"
        valid.mkdir(parents=True)
        (valid / "code.json").write_text(json.dumps({"head": "abc"}), encoding="utf-8")
        got = latest_code(root / "valid")
        if got is None or json.loads(got.read_text())["head"] != "abc":
            print("SELF-TEST FAIL valid code.json not found/read", file=sys.stderr)
            return 1
        if latest_code(root / "missing") is not None:
            print("SELF-TEST FAIL missing code.json not detected", file=sys.stderr)
            return 1
        bad = root / "bad" / ".ai" / "rsi" / "runs" / "x"
        bad.mkdir(parents=True)
        bad_code = bad / "code.json"
        bad_code.write_text(json.dumps({"head": "def"}), encoding="utf-8")
        if code_head_error(bad_code, "abc") is None:
            print("SELF-TEST FAIL wrong head not detected", file=sys.stderr)
            return 1
        if code_head_error(root / "missing" / "code.json", "abc") is None:
            print("SELF-TEST FAIL missing code.json not detected", file=sys.stderr)
            return 1
        if code_head_error(valid / "code.json", "abc") is not None:
            print("SELF-TEST FAIL valid code.json rejected", file=sys.stderr)
            return 1
    print("VERIFIER SNAPSHOT SELF-TEST OK: missing and wrong code.json are rejected")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--call")
    ap.add_argument("--workspace", type=Path)
    ap.add_argument("--plan", type=Path)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    if not (args.call and args.workspace and args.plan):
        ap.error("--call --workspace --plan required")
    return check(args.call, args.workspace, args.plan)


if __name__ == "__main__":
    sys.exit(main())
