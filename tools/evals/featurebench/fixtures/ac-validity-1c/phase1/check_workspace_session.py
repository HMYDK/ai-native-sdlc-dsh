#!/usr/bin/env python3
"""Verify the DSH-selected workspace for a Phase 1 call *before* sending a prompt.

Queries the live DSH web server's authenticated `/api/sdlc-ui.tasks` endpoint,
requires its first searched workspace to resolve to the frozen fixture, then
checks that fixture's Git HEAD/HEAD~1/diff against plan.yml. No model call.

Exit 0 only on exact match; any API/workspace/Git mismatch is fail-closed.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
PLAN = HERE / "plan.yml"


def normalize(p: str | Path) -> Path:
    return Path(p).resolve()


def get_tasks(port: int, token: str) -> dict:
    jar = CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    login = f"http://127.0.0.1:{port}/?token={urllib.parse.quote(token)}"
    with opener.open(login, timeout=10) as r:
        r.read()
    with opener.open(f"http://127.0.0.1:{port}/api/sdlc-ui.tasks", timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--call", required=True, help="e.g. S2-A")
    ap.add_argument("--expected", help="override expected workspace (negative test)")
    args = ap.parse_args()

    plan = yaml.safe_load(PLAN.read_text(encoding="utf-8"))
    call = next((c for c in plan["calls"] if c["id"] == args.call), None)
    if not call:
        print(f"ERROR unknown call {args.call}", file=sys.stderr)
        return 2
    expected = normalize(args.expected or call["workspace"])
    data = get_tasks(args.port, args.token)
    searched = [normalize(x) for x in data.get("searched") or []]
    if not searched:
        print("ERROR API returned no searched workspace", file=sys.stderr)
        return 3
    # /api/sdlc-ui.tasks returns "<workspace>/.ai/tasks"; its parent is the workspace.
    actual = searched[0].parent.parent
    if actual != expected:
        print(f"ERROR selected workspace {actual} != frozen {expected}", file=sys.stderr)
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
    print(f"WORKSPACE SESSION OK: {args.call} -> {actual} (head {head[:8]}, searched[0]={searched[0]})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
