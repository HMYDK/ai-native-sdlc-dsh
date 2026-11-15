#!/usr/bin/env python3
"""Deterministic consistency check for the Phase 1 DSH commands and doc links.

This is not a Runner and never starts DSH/Chrome/Docker. It checks that:
  - A/B use the same install and run DSH_HOME, isolated from each other;
  - eval-root / log parents are created and the plugin hashes/commits match;
  - markdown links and #anchors resolve to real files/sections.

Usage:
    python3 check_phase1_docs.py
    python3 check_phase1_docs.py --self-test

Exit 0 only when all checks pass (or all negative self-tests are rejected).
"""
from __future__ import annotations

import argparse
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]
DOCS = ROOT / "docs" / "evals"
FIXTURES_DOC = DOCS / "ac-validity-1c-offline-fixtures.md"
HANDOFF_DOC = DOCS / "ac-validity-1c-handoff.md"
README = ROOT / "tools" / "evals" / "featurebench" / "fixtures" / "ac-validity-1c" / "README.md"

HOMES = {
    "A": {"commit": "085c8fd", "sha": "106247171248772794bd0ac99fa20ea9e2ff42d29d04a79e3032241158d27784"},
    "B": {"commit": "5ee68cd", "sha": "8bb74f3a8bc20be10b2b2cd704cdf6f081e64fa70a812c6d124c4823faedb404"},
}


def check_dsh_text(name: str, text: str) -> list[str]:
    errs: list[str] = []
    if "dsh-home" in text:
        errs.append(f"{name}: 仍含不一致的 home 变量（与 dsh/A|B 约定不一致）")
    for arm, meta in HOMES.items():
        home = f"/tmp/phase1/dsh/{arm}"
        plugin = f"/tmp/phase1/plugins/{arm}"
        eval_root = f"/tmp/phase1/eval-root-{arm}"
        if f"install_profile {plugin} {eval_root}" not in text:
            errs.append(f"{name}: 缺少 install_profile {plugin} {eval_root}")
        if text.count(f"export DSH_HOME={home}") < 2:
            errs.append(f"{name}: 安装与运行应各设置一次 DSH_HOME={home}")
        if f"/tmp/phase1/eval-root-{arm}/deepseek-harness" not in text:
            errs.append(f"{name}: 缺少 eval-root-{arm}/deepseek-harness 的 mkdir")
        if f"ln -sfn /tmp/validity-1c-fixtures/S2_gap {eval_root}/deepseek-harness/default-workspace" not in text:
            errs.append(f"{name}: 缺少 {arm} 的 ln -sfn workspace")
        if f"> {home}/web.log" not in text:
            errs.append(f"{name}: 缺少 {arm} 的 web.log 于 {home}")
        if meta["sha"] not in text or meta["commit"] not in text:
            errs.append(f"{name}: 缺少 {arm} 的 commit/tarball hash 映射")
    for arm in ("A", "B"):
        eval_root = f"/tmp/phase1/eval-root-{arm}/deepseek-harness"
        ln = f"ln -sfn /tmp/validity-1c-fixtures/S2_gap {eval_root}/deepseek-harness"  # unused placeholder
        # parent mkdir must precede the ln command
        mk = text.find(f"mkdir -p /tmp/phase1/dsh/A")
        if mk == -1:
            errs.append(f"{name}: 缺少统一 mkdir -p 前置块")
        if eval_root not in text.split("ln -sfn", 1)[0]:
            errs.append(f"{name}: eval-root-{arm} 的 mkdir 不在 ln 之前")
    return errs


def _slug(text: str) -> str:
    text = text.strip().lower()
    text = re.sub(r"[^\w\u4e00-\u9fff\- ]", "", text)
    return text.replace(" ", "-")


def _ids(text: str) -> set[str]:
    ids = set(re.findall(r'<a id="([^"]+)"></a>', text))
    for line in text.splitlines():
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            ids.add(_slug(m.group(2)))
    return ids


def check_links_file(path: Path, text: str) -> list[str]:
    errs: list[str] = []
    try:
        label = path.relative_to(ROOT).as_posix()
    except ValueError:
        label = str(path)
    for m in re.finditer(r"\]\(([^)]+)\)", text):
        target = m.group(1).strip()
        if target.startswith(("http://", "https://", "mailto:")):
            continue
        file_part, _, anchor = target.partition("#")
        target_path = (path.parent / file_part).resolve() if file_part else path
        if file_part and not target_path.exists():
            errs.append(f"{label}: 链接目标不存在: {target}")
            continue
        if anchor and target_path.suffix == ".md":
            target_text = target_path.read_text(encoding="utf-8")
            if anchor not in _ids(target_text):
                errs.append(f"{label}: 锚点不存在: {target}")
    return errs


def check_all() -> list[str]:
    errs: list[str] = []
    for path in (FIXTURES_DOC, HANDOFF_DOC):
        text = path.read_text(encoding="utf-8")
        errs += check_dsh_text(path.relative_to(ROOT).as_posix(), text)
        errs += check_links_file(path, text)
    errs += check_links_file(README, README.read_text(encoding="utf-8"))
    # case table links point at the fixtures doc
    case_table = DOCS / "ac-validity-1c-case-table.md"
    errs += check_links_file(case_table, case_table.read_text(encoding="utf-8"))
    return errs


def self_test() -> int:
    text = FIXTURES_DOC.read_text(encoding="utf-8")
    base_errs = check_dsh_text("fixtures", text)
    if base_errs:
        print("SELF-TEST FAIL: base fixtures doc is not consistent:", file=sys.stderr)
        print("\n".join(" - " + e for e in base_errs), file=sys.stderr)
        return 1

    bad_home = text.replace("export DSH_HOME=/tmp/phase1/dsh/A",
                            "export DSH_HOME=/tmp/phase1/dsh-A-bad", 1)
    if not check_dsh_text("fixtures", bad_home):
        print("SELF-TEST FAIL: inconsistent home mutation was not rejected", file=sys.stderr)
        return 1
    bad_mkdir = text.replace("/tmp/phase1/eval-root-A/deepseek-harness", "/tmp/phase1/eval-root-A-missing/deepseek-harness")
    if not check_dsh_text("fixtures", bad_mkdir):
        print("SELF-TEST FAIL: missing mkdir mutation was not rejected", file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "x.md"
        p.write_text("[missing](no-such-file.md)\n[x](#no-such-anchor)\n", encoding="utf-8")
        link_errs = check_links_file(p, p.read_text(encoding="utf-8"))
        if len(link_errs) < 2:
            print("SELF-TEST FAIL: broken link mutations were not rejected", file=sys.stderr)
            return 1
    print("PHASE1 DOCS SELF-TEST OK: inconsistent home, missing mkdir, broken links are rejected")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    errors = check_all()
    if errors:
        print("\n".join("ERROR " + e for e in errors), file=sys.stderr)
        return 1
    print("PHASE1 DOCS OK: A/B DSH_HOME, mkdir, logs, hashes and links/anchors consistent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
