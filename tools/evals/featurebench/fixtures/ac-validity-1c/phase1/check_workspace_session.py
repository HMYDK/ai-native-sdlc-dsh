#!/usr/bin/env python3
"""Verify the DSH-selected workspace for a Phase 1 call *before* sending a prompt.

Reads the active composer/session ID from the driver gate and the persisted
`session.header.identity.cwd` from `DSH_HOME/storages/session_projcache`, then
checks that workspace's Git HEAD/HEAD~1/diff against plan.yml. Dashboard
candidate roots are explicitly not used. No model call.

Exit 0 only on exact match; any API/workspace/Git mismatch is fail-closed.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
PLAN = HERE / "plan.yml"


def normalize(p: str | Path) -> Path:
    return Path(p).resolve()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsh-home", type=Path, required=True)
    ap.add_argument("--session-id", required=True)
    ap.add_argument("--call", required=True, help="e.g. S2-A")
    ap.add_argument("--expected", help="override expected workspace (negative test)")
    args = ap.parse_args()

    plan = yaml.safe_load(PLAN.read_text(encoding="utf-8"))
    call = next((c for c in plan["calls"] if c["id"] == args.call), None)
    if not call:
        print(f"ERROR unknown call {args.call}", file=sys.stderr)
        return 2
    expected = normalize(args.expected or call["workspace"])
    # The active composer/session ID comes from the DOM; the persisted session
    # header's identity.cwd is the same value tools read from
    # exec.agent.session.header.cwd. Dashboard candidate roots are NOT used.
    cache = args.dsh_home / "storages" / "session_projcache" / "sessions" / f"{args.session_id}.json"
    if not cache.is_file():
        print(f"ERROR active session cache missing: {cache}", file=sys.stderr)
        return 3
    try:
        record = json.loads(cache.read_text(encoding="utf-8"))
        actual = normalize(record["record"]["identity"]["cwd"])
    except Exception as exc:
        print(f"ERROR cannot read session cwd: {exc}", file=sys.stderr)
        return 3
    if actual != expected:
        print(f"ERROR active session cwd {actual} != frozen {expected}", file=sys.stderr)
        return 4
    if not expected.is_dir():
        print(f"ERROR expected workspace missing: {expected}", file=sys.stderr)
        return 5
    head = subprocess.check_output(["git", "-C", str(expected), "rev-parse", "HEAD"]).decode().strip()
    base = subprocess.check_output(["git", "-C", str(expected), "rev-parse", "HEAD~1"]).decode().strip()
    diff = subprocess.check_output(["git", "-C", str(expected), "diff", "HEAD~1..HEAD"])
    if (base, head, __import__("hashlib").sha256(diff).hexdigest()) != (
        call["base_commit"], call["head_commit"], call["diff_sha256"]
    ):
        print("ERROR workspace Git base/head/diff differs from plan", file=sys.stderr)
        return 6
    dirty = subprocess.check_output(
        ["git", "-C", str(expected), "status", "--porcelain", "--untracked-files=all"], text=True
    ).splitlines()
    bad = [x for x in dirty if not (x.startswith("?? ") and (x[3:].strip() == "out.csv" or "__pycache__" in x or x.endswith(".pyc")))]
    if bad:
        print("ERROR workspace tracked/untracked drift: " + "; ".join(bad[:3]), file=sys.stderr)
        return 7
    print(f"WORKSPACE SESSION OK: {args.call} session={args.session_id} cwd={actual} (head {head[:8]})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
