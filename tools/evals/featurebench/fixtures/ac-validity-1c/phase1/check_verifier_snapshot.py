#!/usr/bin/env python3
"""Post-call check: the Verifier's recorded snapshot must be the frozen one.

Reads the latest `.ai/rsi/runs/*/code.json` produced in the actual workspace.
`captureCode()` records committed HEAD *plus* the working-tree `diff` and
`untracked` files; checking only HEAD cannot detect a post-prompt source edit.
This validator requires:

  - complete=true and issues=[] (the snapshot was actually captured);
  - diff == "" (no tracked uncommitted changes);
  - every untracked path is in the explicit allowed generated set
    (`out.csv`, Python caches); no unexpected source/test files;
  - head == the plan call's `head_commit`;
  - the workspace's committed base/head/diff also match the plan.

Any missing code.json or mismatch exits non-zero; the runner turns that into
exit 40 / invalid and preserves evidence. No model call.
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


def allowed_untracked(path: str) -> bool:
    return (
        path == "out.csv"
        or path.startswith("__pycache__/")
        or "/__pycache__/" in path
        or path.endswith(".pyc")
    )


def code_snapshot_errors(code: Path | None, expected_head: str) -> list[str]:
    if code is None or not code.is_file():
        return ["missing code.json"]
    try:
        d = json.loads(code.read_text(encoding="utf-8"))
    except Exception as exc:
        return [f"cannot read code.json: {exc}"]
    errs: list[str] = []
    if d.get("complete") is not True:
        errs.append("code.json complete is not true")
    issues = d.get("issues")
    if issues != []:
        errs.append(f"code.json issues is not explicitly []: {issues!r}")
    if d.get("diff") != "":
        errs.append("code.json diff is not explicitly empty string")
    for item in d.get("untracked") or []:
        path = item.get("path") if isinstance(item, dict) else None
        if not isinstance(path, str) or not allowed_untracked(path):
            errs.append(f"unexpected untracked input: {path!r}")
    actual = d.get("head")
    if actual != expected_head:
        errs.append(f"verifier head {actual} != expected {expected_head}")
    return errs


def check(call: str, workspace: Path, plan_path: Path) -> int:
    plan = yaml.safe_load(plan_path.read_text(encoding="utf-8"))
    c = next((x for x in plan["calls"] if x["id"] == call), None)
    if c is None:
        print(f"POSTCHECK_FAIL unknown call {call}", file=sys.stderr)
        return 2
    code = latest_code(workspace)
    errs = code_snapshot_errors(code, c["head_commit"])
    if errs:
        print("POSTCHECK_FAIL " + "; ".join(errs), file=sys.stderr)
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
        valid_code = valid / "code.json"
        base = {"complete": True, "issues": [], "diff": "", "head": "abc",
                "untracked": [{"path": "out.csv", "sha256": "x"}]}
        valid_code.write_text(json.dumps(base), encoding="utf-8")
        if code_snapshot_errors(valid_code, "abc"):
            print("SELF-TEST FAIL valid frozen snapshot rejected", file=sys.stderr)
            return 1
        cases = {
            "missing": (root / "missing" / "code.json", "missing code.json"),
            "diff": (None, "diff is not explicitly empty string"),
            "untracked": (None, "unexpected untracked"),
            "incomplete": (None, "complete is not true"),
            "issues": (None, "issues is not explicitly []"),
            "head": (None, "verifier head def"),
            "issues_none": (None, "issues is not explicitly []"),
            "diff_none": (None, "diff is not explicitly empty string"),
        }
        for name, (_, needle) in cases.items():
            p = root / name / "code.json"
            p.parent.mkdir(parents=True)
            if name == "missing":
                pass
            else:
                d = dict(base)
                if name == "diff": d["diff"] = "diff --git a/app.py b/app.py"
                if name == "untracked": d["untracked"] = [{"path": "app/evil.py"}]
                if name == "incomplete": d["complete"] = False
                if name == "issues": d["issues"] = ["capture failed"]
                if name == "issues_none": d["issues"] = None
                if name == "diff_none": d["diff"] = None
                if name == "head": d["head"] = "def"
                p.write_text(json.dumps(d), encoding="utf-8")
            errs = code_snapshot_errors(p if name != "missing" else p, "abc")
            if not any(needle in e for e in errs):
                print(f"SELF-TEST FAIL {name} not detected: {errs}", file=sys.stderr)
                return 1
    print("VERIFIER SNAPSHOT SELF-TEST OK: diff/untracked/incomplete/issues/head/missing are rejected")
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
