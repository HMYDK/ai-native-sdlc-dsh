#!/usr/bin/env python3
"""AC-VALIDITY-1C deterministic preflight (no Docker, no model, no network).

This is not an evaluation Runner. It only checks the two pre-registered manifests
and the offline plugin artifacts so a plan cannot silently turn into the wrong number
of runs, the wrong arm, or the wrong plugin build.

Usage:
    python3 check_ac_validity_1c.py --self-test
    python3 check_ac_validity_1c.py --artifact-root /tmp/ac1c/artifacts
    python3 check_ac_validity_1c.py --self-test --artifact-root /tmp/ac1c/artifacts

Exit 0 only when all checks pass (or all self-test mutations are rejected).
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import sanity_check as s  # noqa: E402
import run_arm  # noqa: E402

MAIN_MANIFEST = HERE / "manifests" / "ac-validity-1c" / "ac-validity-1c.yml"
B1_MANIFEST = HERE / "manifests" / "ac-validity-1c" / "ac-validity-1c-b1.yml"

SYMPY = [
    "sympy__sympy.c1097516.test_inverse.c240ffe7.lv1",
    "sympy__sympy.c1097516.test_nullspace.f14fc970.lv1",
    "sympy__sympy.c1097516.test_puiseux.cd575f09.lv1",
]
SPHINX = [
    "sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1",
    "sphinx-doc__sphinx.e347e59c.test_ext_doctest.530dec5f.lv1",
]
COMMITS = {"A": "920b0eb", "B2": "5ee68cd", "B1": "085c8fd"}
HASHES = {
    "A": "40172ed2067b36e07fb2791a57a091240fbc8519140574f2b707d33aed87b0c1",
    "B2": "8bb74f3a8bc20be10b2b2cd704cdf6f081e64fa70a812c6d124c4823faedb404",
    "B1": "106247171248772794bd0ac99fa20ea9e2ff42d29d04a79e3032241158d27784",
}


def _ids(manifest: dict) -> list[str]:
    return [str(t.get("id")) for t in (manifest.get("tasks") or [])]


def _add(errors: list[str], cond: bool, msg: str) -> None:
    if not cond:
        errors.append(msg)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def validate(main: dict, b1: dict, manifest_paths: bool = True) -> list[str]:
    errors: list[str] = []

    # ---- structural checks via the existing sanity_check.check_manifest ----
    if manifest_paths:
        # Only the runtime version constants differ from the V1 group. We do not
        # change any other check; this is the same function used by CI.
        old_v1 = dict(s.V1_VERSIONS)
        s.V1_VERSIONS = {"dsh_cli": "0.2.2-rc.3", "plugin_version": "0.6.2"}
        try:
            errors += s.check_manifest(
                MAIN_MANIFEST, base=None, runtime_ref=None,
                expected_group=s.GROUP_V1, base_image_map=None,
                allowed_arms=("A", "B2"),
            )
            errors += s.check_manifest(
                B1_MANIFEST, base=None, runtime_ref=None,
                expected_group=s.GROUP_V1, base_image_map=None,
                allowed_arms=("B1",),
            )
        finally:
            s.V1_VERSIONS = old_v1

    # ---- main experiment: 5 tasks x A/B2 = 10 ----
    main_ids = _ids(main)
    _add(errors, len(main_ids) == len(set(main_ids)), "main: task id 有重复")
    _add(errors, set(main_ids) == set(SYMPY + SPHINX),
         f"main: task 集合不符合预注册: {sorted(main_ids)}")
    _add(errors, len(main_ids) == 5, f"main: 应有 5 个任务，实际 {len(main_ids)}")
    _add(errors, set(main.get("arms") or {}) == {"A", "B2"},
         f"main: arms 必须恰好是 A/B2，实际 {sorted((main.get('arms') or {}))}")
    roles = [str(t.get("role") or "") for t in (main.get("tasks") or [])]
    _add(errors, roles.count("independent") == 3 and roles.count("diagnostic_regression") == 2,
         f"main: 角色计数错误: {roles}")
    plan = main.get("plan") or {}
    _add(errors, plan.get("tasks") == 5 and plan.get("runs") == 10
         and plan.get("arms") == ["A", "B2"],
         f"main: plan 必须是 5 tasks / 10 runs / [A,B2]，实际 {plan}")
    _add(errors, (main.get("run_policy") or {}).get("total_token_budget") == 120_000_000,
         "main: total_token_budget 必须是 120M")
    _add(errors, (main.get("run_policy") or {}).get("wall_clock_budget_seconds") == 28800,
         "main: wall_clock_budget_seconds 必须是 8h")
    _add(errors, (main.get("run_policy") or {}).get("timeout_seconds") == 2700,
         "main: timeout_seconds 必须是 2700")
    _add(errors, (main.get("run_policy") or {}).get("max_tokens_per_run") == 40_000_000,
         "main: max_tokens_per_run 必须是 40M")
    _add(errors, (main.get("run_policy") or {}).get("reps_per_arm") == 1,
         "main: reps_per_arm 必须是 1")
    _add(errors, (main.get("run_policy") or {}).get("agent_retries") == 0,
         "main: agent_retries 必须是 0")

    # ---- B1: 3 independent sympy tasks x B1 = 3, no sphinx ----
    b1_ids = _ids(b1)
    _add(errors, b1_ids == SYMPY, f"B1: task 必须恰好是 3 个 sympy 且顺序固定: {b1_ids}")
    _add(errors, set(b1.get("arms") or {}) == {"B1"},
         f"B1: arms 必须恰好是 B1，实际 {sorted((b1.get('arms') or {}))}")
    b1_roles = [str(t.get("role") or "") for t in (b1.get("tasks") or [])]
    _add(errors, b1_roles == ["independent"] * 3, f"B1: 角色必须是 3 个 independent: {b1_roles}")
    b1_plan = b1.get("plan") or {}
    _add(errors, b1_plan.get("tasks") == 3 and b1_plan.get("runs") == 3
         and b1_plan.get("arms") == ["B1"],
         f"B1: plan 必须是 3 tasks / 3 runs / [B1]，实际 {b1_plan}")
    _add(errors, (b1.get("run_policy") or {}).get("total_token_budget") == 30_000_000,
         "B1: total_token_budget 必须是 30M")
    _add(errors, (b1.get("run_policy") or {}).get("wall_clock_budget_seconds") == 7200,
         "B1: wall_clock_budget_seconds 必须是 2h")
    _add(errors, (b1.get("run_policy") or {}).get("max_tokens_per_run") == 10_000_000,
         "B1: max_tokens_per_run 必须是 10M")
    _add(errors, not any("sphinx" in x for x in b1_ids), "B1: 不得包含 sphinx 诊断任务")

    # ---- main -> B1 pointer ----
    ptr = main.get("b1_ablation") or {}
    _add(errors, ptr.get("manifest") == "ac-validity-1c-b1.yml",
         "main.b1_ablation.manifest 必须指向 ac-validity-1c-b1.yml")
    _add(errors, ptr.get("arm_key") == "B1", "main.b1_ablation.arm_key 必须是 B1")
    _add(errors, ptr.get("commit") == COMMITS["B1"],
         "main.b1_ablation.commit 必须是 085c8fd")
    _add(errors, set(ptr.get("tasks") or []) == set(SYMPY),
         "main.b1_ablation.tasks 必须恰好是 3 个 sympy")
    _add(errors, ptr.get("runs") == 3, "main.b1_ablation.runs 必须是 3")
    _add(errors, ptr.get("total_token_budget") == 30_000_000,
         "main.b1_ablation.total_token_budget 必须是 30M")
    _add(errors, ptr.get("wall_clock_budget_seconds") == 7200,
         "main.b1_ablation.wall_clock_budget_seconds 必须是 2h")

    # ---- arm identity: commit -> tarball hash -> dir -> version ----
    for name, m, allowed in (("main", main, {"A", "B2"}), ("b1", b1, {"B1"})):
        arms = m.get("arms") or {}
        _add(errors, set(arms) == allowed, f"{name}: arms 集合错误 {sorted(arms)}")
        for arm, cfg in arms.items():
            _add(errors, cfg.get("preset") == "AI 原生 SDLC",
                 f"{name}.{arm}: preset 必须是 AI 原生 SDLC")
            _add(errors, cfg.get("commit") == COMMITS.get(arm),
                 f"{name}.{arm}: commit 必须是 {COMMITS.get(arm)}")
            _add(errors, cfg.get("dsh_cli") == "0.2.2-rc.3",
                 f"{name}.{arm}: dsh_cli 必须是 0.2.2-rc.3")
            _add(errors, cfg.get("plugin_version") == "0.6.2",
                 f"{name}.{arm}: plugin_version 必须是 0.6.2")
            _add(errors, cfg.get("plugin_tarball_sha256") == HASHES.get(arm),
                 f"{name}.{arm}: plugin_tarball_sha256 与预注册 hash 不一致")
            _add(errors, str(cfg.get("plugin_tarball_sha256") or "").__len__() == 64,
                 f"{name}.{arm}: plugin_tarball_sha256 必须固定为 64-hex（不能是 TBD）")
            _add(errors, bool(cfg.get("plugin_dir")), f"{name}.{arm}: 缺少 plugin_dir")
            _add(errors, bool(cfg.get("plugin_tarball")), f"{name}.{arm}: 缺少 plugin_tarball")
    _add(errors, len(set(HASHES.values())) == 3, "A/B2/B1 的 tarball hash 必须互不相同")
    _add(errors, (main.get("runtime") or {}).get("plugin_tarball_sha256") == HASHES["A"],
         "main.runtime.plugin_tarball_sha256 必须是 A 的 hash")
    _add(errors, (b1.get("runtime") or {}).get("plugin_tarball_sha256") == HASHES["B1"],
         "b1.runtime.plugin_tarball_sha256 必须是 B1 的 hash")
    _add(errors, ptr.get("plugin_tarball_sha256") == HASHES["B1"],
         "main.b1_ablation.plugin_tarball_sha256 必须是 B1 的 hash")

    # ---- image maps ----
    for name, m, expected in (("main", main, set(SYMPY + SPHINX)), ("b1", b1, set(SYMPY))):
        image_map = m.get("image_map") or {}
        repo_images = {str(t.get("repo")): str(t.get("derived_image")) for t in (m.get("tasks") or [])}
        for repo, derived in repo_images.items():
            _add(errors, image_map.get(repo) == derived,
                 f"{name}: image_map[{repo}] 必须是 {derived!r}，实际 {image_map.get(repo)!r}")
        _add(errors, set(_ids(m)) == expected, f"{name}: 任务集合与预期不符")
    _add(errors, set((main.get("image_map") or {})) == {"sphinx-doc/sphinx", "sympy/sympy"},
         "main: image_map 必须覆盖 sphinx/sympy")
    _add(errors, set((b1.get("image_map") or {})) == {"sympy/sympy"},
         "b1: image_map 只应包含 sympy")

    # ---- Phase 1 ----
    p1 = main.get("phase1") or {}
    _add(errors, p1.get("scenarios") == [1, 2, 3], "phase1.scenarios 必须是 [1,2,3]")
    _add(errors, p1.get("calls") == 6, "phase1.calls 必须是 6")
    _add(errors, p1.get("max_tokens_per_call") == 2_000_000,
         "phase1.max_tokens_per_call 必须是 2M")
    _add(errors, p1.get("total_token_budget") == 8_000_000,
         "phase1.total_token_budget 必须是 8M")
    _add(errors, p1.get("wall_clock_budget_seconds") == 7200,
         "phase1.wall_clock_budget_seconds 必须是 2h")
    p1_arms = p1.get("arms") or {}
    _add(errors, (p1_arms.get("A_phase1") or {}).get("commit") == "085c8fd",
         "phase1.A_phase1 commit 必须是 085c8fd")
    _add(errors, (p1_arms.get("B_phase1") or {}).get("commit") == "5ee68cd",
         "phase1.B_phase1 commit 必须是 5ee68cd")

    return errors


def validate_artifacts(errors: list[str], main: dict, b1: dict, root: Path) -> None:
    for name, m in (("main", main), ("b1", b1)):
        for arm, cfg in (m.get("arms") or {}).items():
            pdir = root / str(cfg.get("plugin_dir") or "")
            pkg = pdir / "dsh-sdlc" / "package.json"
            if not pkg.exists():
                errors.append(f"{name}.{arm}: plugin dir 缺少 dsh-sdlc/package.json: {pkg}")
            else:
                try:
                    got = json.loads(pkg.read_text(encoding="utf-8")).get("version")
                except Exception as exc:
                    errors.append(f"{name}.{arm}: 读取 package.json 失败: {exc}")
                else:
                    if got != cfg.get("plugin_version"):
                        errors.append(f"{name}.{arm}: plugin dir version={got!r}，"
                                      f"manifest={cfg.get('plugin_version')!r}")
            tpath = root / str(cfg.get("plugin_tarball") or "")
            if not tpath.exists():
                errors.append(f"{name}.{arm}: tarball 不存在: {tpath}")
                continue
            got_sha = _sha256(tpath)
            if got_sha != cfg.get("plugin_tarball_sha256"):
                errors.append(f"{name}.{arm}: tarball sha256={got_sha!r}，"
                              f"manifest={cfg.get('plugin_tarball_sha256')!r}")
            bind_errors = run_arm.verify_plugin_dir_matches_tarball(pdir, tpath)
            for err in bind_errors:
                errors.append(f"{name}.{arm}: {err}")


def self_test() -> int:
    main = yaml.safe_load(MAIN_MANIFEST.read_text(encoding="utf-8"))
    b1 = yaml.safe_load(B1_MANIFEST.read_text(encoding="utf-8"))
    base = validate(main, b1)
    if base:
        print("SELF-TEST FAIL: base manifests are not valid:", file=sys.stderr)
        print("\n".join(" - " + e for e in base), file=sys.stderr)
        return 1
    print("[ok] base manifests: main 5x2=10, B1 3x1=3, all identities fixed")

    def mutate_add_b1_arm(m, b):
        m["arms"]["B1"] = {"preset": "AI 原生 SDLC", "role": "ablation",
                           "commit": "085c8fd", "plugin_tarball_sha256": HASHES["B1"],
                           "plugin_dir": "plugins/B1", "plugin_tarball": "pkgs/B1/x.tgz"}

    def mutate_drop_b1_task(m, b):
        b["tasks"] = b["tasks"][:-1]

    def mutate_b1_budget(m, b):
        b["run_policy"]["total_token_budget"] = 31_000_000

    def mutate_drop_sphinx_map(m, b):
        del m["image_map"]["sphinx-doc/sphinx"]

    def mutate_same_hash(m, b):
        m["arms"]["B2"]["plugin_tarball_sha256"] = HASHES["A"]

    def mutate_a_commit(m, b):
        m["arms"]["A"]["commit"] = "deadbeef"

    def mutate_drop_b1_arm(m, b):
        del b["arms"]["B1"]

    def mutate_phase1_calls(m, b):
        m["phase1"]["calls"] = 5

    def mutate_b1_sphinx(m, b):
        b["tasks"][-1]["id"] = SPHINX[0]
        b["tasks"][-1]["repo"] = "sphinx-doc/sphinx"

    def mutate_b1_hash_tbd(m, b):
        b["arms"]["B1"]["plugin_tarball_sha256"] = "TBD"

    mutations = [
        ("B1 added to main arms", mutate_add_b1_arm, "arms"),
        ("B1 task removed", mutate_drop_b1_task, "task"),
        ("B1 budget changed", mutate_b1_budget, "30M"),
        ("main image_map missing sphinx", mutate_drop_sphinx_map, "image_map"),
        ("A/B2 share a tarball hash", mutate_same_hash, "plugin_tarball_sha256"),
        ("A commit changed", mutate_a_commit, "commit"),
        ("B1 arm removed", mutate_drop_b1_arm, "arms"),
        ("phase1 calls changed", mutate_phase1_calls, "phase1.calls"),
        ("B1 contains sphinx", mutate_b1_sphinx, "sphinx"),
        ("B1 hash left TBD", mutate_b1_hash_tbd, "64-hex"),
    ]
    failed = 0
    for label, fn, needle in mutations:
        mm, bb = copy.deepcopy(main), copy.deepcopy(b1)
        fn(mm, bb)
        errs = validate(mm, bb, manifest_paths=False)
        hit = any(needle.lower() in e.lower() for e in errs)
        if not errs:
            failed += 1
            print(f"[FAIL] mutation not rejected: {label}", file=sys.stderr)
        elif not hit:
            failed += 1
            print(f"[FAIL] mutation rejected for wrong reason: {label}: {errs[:2]}", file=sys.stderr)
        else:
            print(f"[ok] rejected: {label}")
    # Plugin dir must be bound to the tarball, not just package.json version.
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        pkg = root / "package"
        pkg.mkdir(parents=True)
        (pkg / "package.json").write_text('{"version":"0.6.2"}', encoding="utf-8")
        tarball = root / "plugin.tgz"
        with tarfile.open(tarball, "w:gz") as tf:
            tf.add(pkg, arcname="package")
        good = root / "good"
        (good / "dsh-sdlc").mkdir(parents=True)
        shutil.copy2(pkg / "package.json", good / "dsh-sdlc" / "package.json")
        bad = root / "bad"
        (bad / "dsh-sdlc").mkdir(parents=True)
        (bad / "dsh-sdlc" / "package.json").write_text('{"version":"0.6.2","extra":1}', encoding="utf-8")
        good_ok = not run_arm.verify_plugin_dir_matches_tarball(good, tarball)
        bad_rejected = bool(run_arm.verify_plugin_dir_matches_tarball(bad, tarball))
        if not (good_ok and bad_rejected):
            failed += 1
            print("[FAIL] plugin dir/tarball binding: good_ok=%s bad_rejected=%s"
                  % (good_ok, bad_rejected), file=sys.stderr)
        else:
            print("[ok] rejected: plugin dir not matching tarball contents")

    # Empty/unknown --only-arm selection must fail closed, not ZeroDivisionError.
    with tempfile.TemporaryDirectory() as td:
        cp = subprocess.run(
            [sys.executable, str(HERE / "run_matrix.py"),
             "--manifest", str(MAIN_MANIFEST),
             "--runs-root", td,
             "--credentials", str(Path(td) / "creds.yaml"),
             "--only-arm", "B1"],
            capture_output=True, text=True,
        )
        text = cp.stdout + cp.stderr
        if cp.returncode == 0 or "no arms selected" not in text:
            failed += 1
            print(f"[FAIL] empty --only-arm selection not rejected: rc={cp.returncode} text={text[-300:]}",
                  file=sys.stderr)
        else:
            print("[ok] rejected: unknown --only-arm selection")

    if failed:
        return 1
    print("SELF-TEST OK: all negative mutations fail closed")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true",
                    help="run the base validation plus negative mutations")
    ap.add_argument("--artifact-root", help="root containing plugin dirs/tarballs for identity checks")
    ap.add_argument("--json", action="store_true", help="print a machine-readable summary")
    args = ap.parse_args()

    if args.self_test:
        return self_test()

    main = yaml.safe_load(MAIN_MANIFEST.read_text(encoding="utf-8"))
    b1 = yaml.safe_load(B1_MANIFEST.read_text(encoding="utf-8"))
    errors = validate(main, b1)
    if args.artifact_root:
        validate_artifacts(errors, main, b1, Path(args.artifact_root))
    if args.json:
        print(json.dumps({
            "ok": not errors,
            "main_runs": (main.get("plan") or {}).get("runs"),
            "b1_runs": (b1.get("plan") or {}).get("runs"),
            "errors": errors,
        }, ensure_ascii=False, indent=2))
    if errors:
        print("\n".join("ERROR " + e for e in errors), file=sys.stderr)
        return 1
    print("AC-VALIDITY-1C preflight OK: main 5 tasks x A/B2 = 10; B1 3 tasks x B1 = 3")
    return 0


if __name__ == "__main__":
    sys.exit(main())
