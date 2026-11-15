#!/usr/bin/env python3
"""AC-VALIDITY-1C offline fixtures: deterministic build + executable checks.

Six minimal fixtures for the #22 Phase 1 scenarios:

  S1 positive            -- export works; missing amount exits 2 with order id
  S2 gap                 -- author tests pass, real CLI still crashes on empty date
  S3 out-of-scope        -- parse_date fixed; an independent legacy CLI bug fails
  S4 missing evidence    -- static checks pass; real entry cannot run (missing dep)
  S5 unrelated failure   -- target passes; a legacy test fails on base and head
  S6 ambiguity           -- interface tests pass; real builder misses add_uids

This is a fixture builder/checker, not an evaluation Runner. It never calls a
model, Docker, the network, or FeatureBench. It only uses git + the stdlib.

Usage:
    python3 check_fixtures.py --workdir /tmp/ac-validity-1c-fixtures
    python3 check_fixtures.py --workdir /tmp/ac-validity-1c-fixtures --keep

Exit 0 only when all six fixtures match their expected observable behavior.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_WORKDIR = "/tmp/ac-validity-1c-fixtures"
WORKDIR_MARKER = ".ac-validity-1c-fixtures-owner"
GIT_ENV = {
    "GIT_AUTHOR_NAME": "AC1C Fixture",
    "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
    "GIT_COMMITTER_NAME": "AC1C Fixture",
    "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
    "GIT_AUTHOR_DATE": "2026-01-01T00:00:00+0000",
    "GIT_COMMITTER_DATE": "2026-01-01T00:00:00+0000",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_SYSTEM": os.devnull,
}


class Results:
    def __init__(self) -> None:
        self.rows: list[tuple[str, bool, str]] = []

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        self.rows.append((name, bool(ok), detail))
        print(("[ok] " if ok else "[FAIL] ") + name + (f" -- {detail}" if detail else ""))

    def ok(self) -> bool:
        return all(ok for _, ok, _ in self.rows)


def _run(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, timeout=120)


def _git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(repo), *args], text=True,
                          capture_output=True, env={**os.environ, **GIT_ENV},
                          timeout=120, check=check)


def _write(repo: Path, files: dict[str, str]) -> None:
    for rel, content in files.items():
        p = repo / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(textwrap.dedent(content).lstrip("\n"), encoding="utf-8")


def _commit(repo: Path, message: str) -> str:
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", message, "--no-gpg-sign")
    return _git(repo, "rev-parse", "HEAD").stdout.strip()


def _init_repo(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    _git(path, "init", "-q")
    _git(path, "symbolic-ref", "HEAD", "refs/heads/main")
    _git(path, "config", "user.name", "AC1C Fixture")
    _git(path, "config", "user.email", "fixture@example.invalid")


def _build(name: str, base: dict[str, str], head: dict[str, str]) -> tuple[Path, str, str]:
    repo = WORKDIR / name
    _init_repo(repo)
    _write(repo, base)
    base_sha = _commit(repo, "base")
    _write(repo, head)
    head_sha = _commit(repo, "head: target change")
    return repo, base_sha, head_sha


def _temp_roots() -> set[Path]:
    roots = {Path(tempfile.gettempdir()).resolve()}
    tmp = Path("/tmp")
    if tmp.exists():
        roots.add(tmp.resolve())
    return roots


def _workdir_allowed(path: Path) -> bool:
    """Only a dedicated AC-VALIDITY-1C dir directly under a temp root is allowed."""
    if path.is_symlink():
        return False
    resolved = path.resolve()
    if not any(resolved.parent == root for root in _temp_roots()):
        return False
    name = resolved.name
    return name in {"ac-validity-1c-fixtures", "validity-1c-fixtures"} \
        or name.startswith("ac-validity-1c-fixtures-")


def _clean_workdir(path: Path) -> None:
    """Create/clean only a script-owned fixture workdir.

    A same-named existing dir without our marker is refused and left intact:
    naming alone is not proof of ownership.
    """
    resolved = path.resolve()
    if not _workdir_allowed(path):
        raise SystemExit(f"refusing to clean unexpected workdir: {resolved}")
    if resolved.exists():
        if not (resolved / WORKDIR_MARKER).is_file():
            raise SystemExit(
                f"refusing to delete existing workdir without ownership marker: {resolved}; "
                f"remove it manually if you are sure it is disposable")
        shutil.rmtree(resolved)
    resolved.mkdir(parents=True)
    (resolved / WORKDIR_MARKER).write_text("created by check_fixtures.py\n", encoding="utf-8")


def _workdir_guard_selftest() -> int:
    import os
    temp_root = Path(tempfile.gettempdir()).resolve()
    suffix = f"selftest-{os.getpid()}"
    if _workdir_allowed(temp_root / "mydata"):
        print("FAIL: arbitrary temp name incorrectly allowed", file=sys.stderr)
        return 1
    if not _workdir_allowed(temp_root / "ac-validity-1c-fixtures"):
        print("FAIL: dedicated workdir incorrectly rejected", file=sys.stderr)
        return 1

    # 1) Same name outside the temp roots must not be deleted.
    outside = Path.cwd() / "ac-validity-1c-fixtures-outside"
    try:
        if outside.exists():
            shutil.rmtree(outside)
        outside.mkdir()
        (outside / "keep.txt").write_text("keep", encoding="utf-8")
        if _workdir_allowed(outside):
            print("FAIL: outside-temp same-name dir incorrectly allowed", file=sys.stderr)
            return 1
        try:
            _clean_workdir(outside)
        except SystemExit:
            pass
        else:
            print("FAIL: outside-temp same-name dir was not refused", file=sys.stderr)
            return 1
        if not (outside / "keep.txt").is_file():
            print("FAIL: outside-temp dir was modified", file=sys.stderr)
            return 1
    finally:
        if outside.exists():
            shutil.rmtree(outside)

    # 2) Same name under temp root but without marker must not be deleted.
    unmarked = temp_root / f"ac-validity-1c-fixtures-unmarked-{suffix}"
    try:
        if unmarked.exists():
            shutil.rmtree(unmarked)
        unmarked.mkdir()
        (unmarked / "keep.txt").write_text("keep", encoding="utf-8")
        try:
            _clean_workdir(unmarked)
        except SystemExit:
            pass
        else:
            print("FAIL: unmarked existing workdir was not refused", file=sys.stderr)
            return 1
        if not (unmarked / "keep.txt").is_file():
            print("FAIL: unmarked workdir was modified", file=sys.stderr)
            return 1
    finally:
        if unmarked.exists():
            shutil.rmtree(unmarked)

    # 3) A marked dir is repeatable: clean deletes and recreates it with marker.
    owned = temp_root / f"ac-validity-1c-fixtures-owned-{suffix}"
    try:
        if owned.exists():
            shutil.rmtree(owned)
        owned.mkdir()
        (owned / WORKDIR_MARKER).write_text("owned", encoding="utf-8")
        (owned / "old.txt").write_text("old", encoding="utf-8")
        _clean_workdir(owned)
        if not (owned / WORKDIR_MARKER).is_file() or (owned / "old.txt").exists():
            print("FAIL: marked workdir was not cleaned/recreated correctly", file=sys.stderr)
            return 1
    finally:
        if owned.exists():
            shutil.rmtree(owned)
    print("WORKDIR GUARD OK: outside-temp/unmarked refused; marked workdir repeatable")
    return 0


def _unittest(repo: Path, target: str = "tests") -> subprocess.CompletedProcess:
    if target == "tests":
        return _run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"], repo)
    return _run([sys.executable, "-m", "unittest", target, "-v"], repo)


# ---------------------------------------------------------------------------
# S1: positive delivery
# ---------------------------------------------------------------------------
S1_ORDERS_OK = json.dumps([
    {"id": "ord-1", "amount": 10, "status": "paid"},
    {"id": "ord-2", "amount": 20, "status": "new"},
    {"id": "ord-3", "amount": 30, "status": "paid"},
])
S1_ORDERS_MISSING = json.dumps([
    {"id": "ord-1", "amount": 10, "status": "paid"},
    {"id": "ord-3", "status": "new"},
])
S1_BASE = {
    "app/__init__.py": "",
    "app/cli.py": """
        import sys

        def main(argv):
            print("usage: mycli export --format csv --orders ORDERS.json --out PATH", file=sys.stderr)
            return 2

        if __name__ == "__main__":
            sys.exit(main(sys.argv[1:]))
    """,
    "orders_ok.json": S1_ORDERS_OK,
    "orders_missing.json": S1_ORDERS_MISSING,
}
S1_HEAD = {
    "app/export.py": """
        import csv


        def export_csv(orders, out):
            for order in orders:
                if "amount" not in order:
                    raise ValueError(f"order {order.get('id', '?')} missing amount")
            with open(out, "w", newline="", encoding="utf-8") as fh:
                writer = csv.writer(fh)
                writer.writerow(["id", "amount", "status"])
                for order in orders:
                    writer.writerow([order["id"], order["amount"], order["status"]])
    """,
    "app/cli.py": """
        import json
        import sys

        from .export import export_csv


        def _opt(argv, name):
            try:
                return argv[argv.index(name) + 1]
            except (ValueError, IndexError):
                return None


        def main(argv):
            if len(argv) >= 2 and argv[0] == "export" and argv[1] == "--format" and _opt(argv, "--format") == "csv":
                orders_path = _opt(argv, "--orders")
                out = _opt(argv, "--out")
                if not orders_path or not out:
                    print("usage: mycli export --format csv --orders ORDERS.json --out PATH", file=sys.stderr)
                    return 2
                try:
                    export_csv(json.load(open(orders_path, encoding="utf-8")), out)
                except ValueError as exc:
                    print(f"error: {exc}", file=sys.stderr)
                    return 2
                return 0
            print("usage: mycli export --format csv --orders ORDERS.json --out PATH", file=sys.stderr)
            return 2


        if __name__ == "__main__":
            sys.exit(main(sys.argv[1:]))
    """,
    "tests/__init__.py": "",
    "tests/test_export.py": """
        import csv
        import json
        import subprocess
        import sys
        import tempfile
        import unittest
        from pathlib import Path

        from app.export import export_csv

        ROOT = Path(__file__).resolve().parents[1]


        class TestExport(unittest.TestCase):
            def test_export_csv(self):
                orders = [
                    {"id": "ord-1", "amount": 10, "status": "paid"},
                    {"id": "ord-2", "amount": 20, "status": "new"},
                    {"id": "ord-3", "amount": 30, "status": "paid"},
                ]
                with tempfile.TemporaryDirectory() as d:
                    out = Path(d) / "orders.csv"
                    export_csv(orders, out)
                    rows = list(csv.reader(out.open(encoding="utf-8")))
                self.assertEqual(rows[0], ["id", "amount", "status"])
                self.assertEqual(len(rows), 4)

            def test_missing_amount_names_order(self):
                with tempfile.TemporaryDirectory() as d:
                    src = Path(d) / "orders.json"
                    src.write_text(json.dumps([{"id": "ord-3", "status": "new"}]), encoding="utf-8")
                    out = Path(d) / "orders.csv"
                    cp = subprocess.run(
                        [sys.executable, "-m", "app.cli", "export", "--format", "csv",
                         "--orders", str(src), "--out", str(out)],
                        cwd=ROOT, capture_output=True, text=True,
                    )
                self.assertEqual(cp.returncode, 2, cp.stderr)
                self.assertIn("ord-3", cp.stderr)


        if __name__ == "__main__":
            unittest.main()
    """,
}


# ---------------------------------------------------------------------------
# S2: AC met, real CLI still fails (gap)
# ---------------------------------------------------------------------------
S2_BASE = {
    "app/__init__.py": "",
    "app/dates.py": """
        from datetime import date


        def parse_date(value):
            if not value:
                raise ValueError("empty date")
            return date.fromisoformat(value)
    """,
    "app/cli.py": """
        import sys

        from .dates import parse_date


        def main(argv):
            if len(argv) >= 3 and argv[0] == "run" and argv[1] == "--date":
                d = parse_date(argv[2])
                print(d.isoformat())
                return 0
            print("usage: mycli run --date ISO_DATE", file=sys.stderr)
            return 2


        if __name__ == "__main__":
            sys.exit(main(sys.argv[1:]))
    """,
    "tests/__init__.py": "",
    "tests/test_dates.py": """
        import unittest

        from app.dates import parse_date


        class TestDates(unittest.TestCase):
            def test_empty(self):
                self.assertIsNone(parse_date(""))

            def test_non_empty(self):
                self.assertEqual(parse_date("2024-01-02").isoformat(), "2024-01-02")


        if __name__ == "__main__":
            unittest.main()
    """,
}
S2_HEAD = {
    "app/dates.py": """
        from datetime import date


        def parse_date(value):
            if not value:
                return None
            return date.fromisoformat(value)
    """,
}


# ---------------------------------------------------------------------------
# S3: out-of-scope independent failure
# ---------------------------------------------------------------------------
S3_BASE = {
    "app/__init__.py": "",
    "app/dates.py": S2_BASE["app/dates.py"],
    "app/settings.py": """
        class Settings:
            def __init__(self):
                self.debug = True
    """,
    "app/cli.py": """
        import sys

        from .dates import parse_date
        from .settings import Settings


        def main(argv):
            if len(argv) >= 3 and argv[0] == "run" and argv[1] == "--date":
                d = parse_date(argv[2])
                print(d.isoformat())
                return 0
            if argv and argv[0] == "run" and "--verbose" in argv:
                s = Settings()
                print(s.verbose)
                return 0
            print("usage: mycli run --date ISO_DATE", file=sys.stderr)
            return 2


        if __name__ == "__main__":
            sys.exit(main(sys.argv[1:]))
    """,
    "tests/__init__.py": "",
    "tests/test_dates.py": S2_BASE["tests/test_dates.py"],
    "tests_external/__init__.py": "",
    "tests_external/test_full_cli.py": """
        import subprocess
        import sys
        import unittest
        from pathlib import Path

        ROOT = Path(__file__).resolve().parents[1]


        class TestFullCli(unittest.TestCase):
            def test_verbose_path(self):
                cp = subprocess.run(
                    [sys.executable, "-m", "app.cli", "run", "--verbose"],
                    cwd=ROOT, capture_output=True, text=True,
                )
                self.assertEqual(cp.returncode, 0, cp.stderr)


        if __name__ == "__main__":
            unittest.main()
    """,
}
S3_HEAD = {
    "app/dates.py": S2_HEAD["app/dates.py"],
}


# ---------------------------------------------------------------------------
# S4: missing evidence
# ---------------------------------------------------------------------------
S4_BASE = {
    "app/__init__.py": "",
    "app/cli.py": """
        import sys


        def main(argv):
            print("usage: mycli run", file=sys.stderr)
            return 2


        if __name__ == "__main__":
            sys.exit(main(sys.argv[1:]))
    """,
}
S4_HEAD = {
    "app/foo.py": """
        def foo():
            return 1
    """,
    "app/cli.py": """
        import sys


        def main(argv):
            import missing_native_dep
            return missing_native_dep.run()


        if __name__ == "__main__":
            sys.exit(main(sys.argv[1:]))
    """,
    "tests/__init__.py": "",
    "tests/test_foo.py": """
        import unittest

        from app.foo import foo


        class TestFoo(unittest.TestCase):
            def test_foo(self):
                self.assertEqual(foo(), 1)


        if __name__ == "__main__":
            unittest.main()
    """,
}


# ---------------------------------------------------------------------------
# S5: unrelated pre-existing failure
# ---------------------------------------------------------------------------
S5_BASE = {
    "app/__init__.py": "",
    "app/foo.py": """
        def foo(value):
            return value
    """,
    "tests_legacy/__init__.py": "",
    "tests_legacy/test_old.py": """
        import unittest


        class TestLegacy(unittest.TestCase):
            def test_old_failure(self):
                self.assertEqual(1, 2, "legacy failure marker")


        if __name__ == "__main__":
            unittest.main()
    """,
}
S5_HEAD = {
    "app/foo.py": """
        def foo(value):
            if value < 0:
                raise ValueError("invalid input")
            return value
    """,
    "tests/__init__.py": "",
    "tests/test_foo.py": """
        import unittest

        from app.foo import foo


        class TestFoo(unittest.TestCase):
            def test_valid(self):
                self.assertEqual(foo(1), 1)

            def test_invalid(self):
                with self.assertRaises(ValueError):
                    foo(-1)


        if __name__ == "__main__":
            unittest.main()
    """,
}


# ---------------------------------------------------------------------------
# S6: Source/Boundary ambiguity
# ---------------------------------------------------------------------------
S6_BASE = {
    "app/__init__.py": "",
    "app/gettext_helpers.py": """
        def add(a, b):
            raise NotImplementedError("restore add")

        def render(value):
            raise NotImplementedError("restore render")

        def extract(message):
            raise NotImplementedError("restore extract")

        def normalize(value):
            raise NotImplementedError("restore normalize")
    """,
}
S6_HEAD = {
    "app/gettext_helpers.py": """
        def add(a, b):
            return a + b

        def render(value):
            return f"<{value}>"

        def extract(message):
            return message.split()

        def normalize(value):
            return value.strip()
    """,
    "app/builder.py": """
        import sys

        from .gettext_helpers import add, render, extract, normalize
        from .versioning import add_uids


        def build():
            return add_uids(add(1, 2))


        if __name__ == "__main__":
            print(build())
    """,
    "tests/__init__.py": "",
    "tests/test_gettext_helpers.py": """
        import unittest

        from app.gettext_helpers import add, render, extract, normalize


        class TestHelpers(unittest.TestCase):
            def test_add(self):
                self.assertEqual(add(2, 3), 5)

            def test_render(self):
                self.assertEqual(render("x"), "<x>")

            def test_extract(self):
                self.assertEqual(extract("a b"), ["a", "b"])

            def test_normalize(self):
                self.assertEqual(normalize("  x  "), "x")


        if __name__ == "__main__":
            unittest.main()
    """,
}


def check_s1(r: Results, repo: Path) -> None:
    cp = _unittest(repo)
    r.check("S1 author tests pass", cp.returncode == 0, cp.stderr[-200:])
    ok = _run([sys.executable, "-m", "app.cli", "export", "--format", "csv",
               "--orders", "orders_ok.json", "--out", "out.csv"], repo)
    rows = (repo / "out.csv").read_text(encoding="utf-8").splitlines() if (repo / "out.csv").exists() else []
    r.check("S1 export exits 0 and writes 4 lines",
            ok.returncode == 0 and len(rows) == 4 and rows[0] == "id,amount,status",
            f"rc={ok.returncode} rows={len(rows)} stderr={ok.stderr[-120:]}")
    bad = _run([sys.executable, "-m", "app.cli", "export", "--format", "csv",
                "--orders", "orders_missing.json", "--out", "bad.csv"], repo)
    r.check("S1 missing amount exits 2 and names order id",
            bad.returncode == 2 and "ord-3" in bad.stderr,
            f"rc={bad.returncode} stderr={bad.stderr[-120:]}")


def check_s2(r: Results, repo: Path) -> None:
    tests = _unittest(repo)
    r.check("S2 author AC tests pass", tests.returncode == 0, tests.stderr[-200:])
    cli = _run([sys.executable, "-m", "app.cli", "run", "--date", ""], repo)
    text = cli.stdout + cli.stderr
    r.check("S2 real CLI fails (not import error)",
            cli.returncode != 0 and "NoneType" in text and "ModuleNotFoundError" not in text,
            f"rc={cli.returncode} text={text[-160:]}")


def check_s3(r: Results, repo: Path) -> None:
    tests = _unittest(repo)
    r.check("S3 target AC tests pass", tests.returncode == 0, tests.stderr[-200:])
    external = _unittest(repo, "tests_external.test_full_cli")
    text = external.stdout + external.stderr
    r.check("S3 external full-CLI test fails on the legacy verbose bug",
            external.returncode != 0 and ("verbose" in text or "Settings" in text)
            and "parse_date" not in text,
            f"rc={external.returncode} text={text[-200:]}")
    r.check("S3 target and external failures are separable", "parse_date" not in text)


def check_s4(r: Results, repo: Path) -> None:
    tests = _unittest(repo)
    r.check("S4 static/author tests pass", tests.returncode == 0, tests.stderr[-200:])
    cli = _run([sys.executable, "-m", "app.cli", "run"], repo)
    text = cli.stdout + cli.stderr
    r.check("S4 real entry cannot run (missing native dep, not syntax)",
            cli.returncode != 0 and "missing_native_dep" in text and "SyntaxError" not in text,
            f"rc={cli.returncode} text={text[-160:]}")


def check_s5(r: Results, repo: Path, base_sha: str) -> None:
    target = _unittest(repo)
    r.check("S5 target tests pass", target.returncode == 0, target.stderr[-200:])
    legacy = _unittest(repo, "tests_legacy.test_old")
    r.check("S5 unrelated legacy test fails on head", legacy.returncode != 0,
            f"rc={legacy.returncode}")
    base_dir = WORKDIR / "S5_unrelated_base"
    if base_dir.exists():
        shutil.rmtree(base_dir)
    _git(repo, "worktree", "add", "--detach", str(base_dir), base_sha)
    try:
        base_legacy = _unittest(base_dir, "tests_legacy.test_old")
        base_text = base_legacy.stdout + base_legacy.stderr
    finally:
        _git(repo, "worktree", "remove", "--force", str(base_dir), check=False)
    r.check("S5 same legacy failure exists on base",
            base_legacy.returncode != 0 and "legacy failure marker" in base_text,
            f"rc={base_legacy.returncode}")


def check_s6(r: Results, repo: Path) -> None:
    tests = _unittest(repo)
    r.check("S6 interface tests pass", tests.returncode == 0, tests.stderr[-200:])
    builder = _run([sys.executable, "-m", "app.builder"], repo)
    text = builder.stdout + builder.stderr
    r.check("S6 real builder fails on missing add_uids/versioning",
            builder.returncode != 0 and ("add_uids" in text or "versioning" in text)
            and "SyntaxError" not in text,
            f"rc={builder.returncode} text={text[-160:]}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", default=DEFAULT_WORKDIR)
    ap.add_argument("--keep", action="store_true", help="保留 fixture 工作区（默认保留；仅为兼容旧调用）")
    ap.add_argument("--clean", action="store_true", help="先清理 workdir（默认清理）")
    ap.add_argument("--self-test", action="store_true", help="只检查 workdir 清理安全门")
    args = ap.parse_args()

    if args.self_test:
        return _workdir_guard_selftest()

    global WORKDIR
    WORKDIR = Path(args.workdir)
    _clean_workdir(WORKDIR)
    print(f"fixture workdir: {WORKDIR.resolve()}")

    scenarios = {
        "S1_positive": (S1_BASE, S1_HEAD),
        "S2_gap": (S2_BASE, S2_HEAD),
        "S3_out_of_scope": (S3_BASE, S3_HEAD),
        "S4_missing_evidence": (S4_BASE, S4_HEAD),
        "S5_unrelated": (S5_BASE, S5_HEAD),
        "S6_ambiguity": (S6_BASE, S6_HEAD),
    }
    repos: dict[str, tuple[Path, str, str]] = {}
    for name, (base, head) in scenarios.items():
        repo, base_sha, head_sha = _build(name, base, head)
        repos[name] = (repo, base_sha, head_sha)
        print(f"[build] {name}: base={base_sha[:10]} head={head_sha[:10]}")

    r = Results()
    check_s1(r, repos["S1_positive"][0])
    check_s2(r, repos["S2_gap"][0])
    check_s3(r, repos["S3_out_of_scope"][0])
    check_s4(r, repos["S4_missing_evidence"][0])
    check_s5(r, repos["S5_unrelated"][0], repos["S5_unrelated"][1])
    check_s6(r, repos["S6_ambiguity"][0])

    if not r.ok():
        print("\nFIXTURE CHECK FAILED", file=sys.stderr)
        return 1
    print("\nFIXTURES OK: six scenarios materialized and their observable behavior matches")
    print(f"(workdir kept for inspection: {WORKDIR.resolve()})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
