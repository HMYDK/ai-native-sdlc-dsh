#!/usr/bin/env python3
"""Offline validator for the frozen Phase 1 6-call plan.

Checks the fixed order, A/B identity, per-scenario input identity, input/prompt/
diff hashes, gold labels and per-call monitoring settings. It never starts DSH,
Chrome, Docker or a model; it only reads files and the deterministic fixture
repos (when --fixtures-root is available).

Usage:
    python3 check_phase1_plan.py [--fixtures-root /tmp/ac-validity-1c-fixtures]
    python3 check_phase1_plan.py --self-test
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[5]
PLAN = HERE / "plan.yml"
DOC = ROOT / "docs" / "evals" / "ac-validity-1c-offline-fixtures.md"
GOLD_LABELS = {"S1": "approve", "S2": "reject", "S3": "approve"}
GOLD_DOC = HERE / "gold-labels.md"
ORDER = [("S1", "A"), ("S1", "B"), ("S2", "A"), ("S2", "B"), ("S3", "A"), ("S3", "B")]
ARMS = {
    "A": {"commit": "085c8fd", "sha": "106247171248772794bd0ac99fa20ea9e2ff42d29d04a79e3032241158d27784"},
    "B": {"commit": "5ee68cd", "sha": "8bb74f3a8bc20be10b2b2cd704cdf6f081e64fa70a812c6d124c4823faedb404"},
}
FIXTURES = {"S1": "S1_positive", "S2": "S2_gap", "S3": "S3_out_of_scope"}
GOLD_SOURCE = "6898799392"
ARM_SPECIFIC = {"arm", "commit", "tarball_sha256", "plugin_dir", "dsh_home", "web_port",
                "cdp_port", "output", "driver_log", "web_log", "eval_root"}


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def canonical_input(call: dict) -> str:
    payload = {
        "fixture": call["scenario_name"],
        "base_commit": call["base_commit"],
        "head_commit": call["head_commit"],
        "diff_sha256": call["diff_sha256"],
        "inputs": call["inputs"],
    }
    return sha(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode())


def doc_inputs() -> dict:
    text = DOC.read_text(encoding="utf-8")
    spans = {
        "S1": ("### 3.1 S1（positive）", "### 3.2 S2（gap）"),
        "S2": ("### 3.2 S2（gap）", "### 3.3 S3（out-of-scope）"),
        "S3": ("### 3.3 S3（out-of-scope）", "## 4. Phase 1 运行面"),
    }
    out = {}
    for key, (start, end) in spans.items():
        seg = text[text.index(start):text.index(end)]
        m = re.search(r"```json\n(.*?)\n```", seg, re.S)
        if not m:
            raise ValueError(f"docs missing JSON for {key}")
        out[key] = json.loads(m.group(1))
    return out


def validate(plan: dict, fixtures_root: Path | None = None) -> list[str]:
    errs: list[str] = []
    calls = plan.get("calls") or []
    cons = plan.get("constraints") or {}
    if len(calls) != 6:
        errs.append(f"calls must be 6, got {len(calls)}")
    expected_ids = [f"{s}-{a}" for s, a in ORDER]
    if [c.get("id") for c in calls] != expected_ids:
        errs.append(f"call order/ids must be {expected_ids}, got {[c.get('id') for c in calls]}")
    if [c.get("order") for c in calls] != list(range(1, 7)):
        errs.append("calls[].order must be 1..6")
    if plan.get("status") != "frozen_for_phase1_approval":
        errs.append("status must be frozen_for_phase1_approval")
    if GOLD_SOURCE not in str(plan.get("gold_label_source", "")):
        errs.append("gold_label_source must cite issue comment 6898799392")
    if cons.get("max_calls") != 6:
        errs.append("constraints.max_calls must be 6")
    if cons.get("max_tokens_per_call") != 2_000_000 or cons.get("max_wall_s_per_call") != 1200:
        errs.append("per-call monitoring must be 2,000,000 tokens / 1,200 s")
    if cons.get("total_token_target") != 8_000_000 or cons.get("total_wall_target_s") != 7200:
        errs.append("total targets must be 8,000,000 tokens / 7,200 s")
    if cons.get("retry") is not False or cons.get("no_auto_retry") is not True:
        errs.append("retry must be false / no_auto_retry true")
    if cons.get("dsh_cli_env") != "DSH_CLI":
        errs.append("dsh_cli_env must be DSH_CLI (not PATH-dependent)")
    if plan.get("gold_labels") != {k: {"label": v, "reason": plan["gold_labels"][k]["reason"]}
                                   for k, v in GOLD_LABELS.items()}:
        # only compare labels; reasons are non-empty below
        got = {k: v.get("label") for k, v in (plan.get("gold_labels") or {}).items()}
        if got != GOLD_LABELS:
            errs.append(f"gold labels must be {GOLD_LABELS}, got {got}")
    for k in GOLD_LABELS:
        r = (plan.get("gold_labels") or {}).get(k, {}).get("reason", "")
        if not r.strip():
            errs.append(f"gold label {k} has no reason")
    if not GOLD_DOC.is_file():
        errs.append("gold-labels.md is missing")
    else:
        gd = GOLD_DOC.read_text(encoding="utf-8")
        if GOLD_SOURCE not in gd:
            errs.append("gold-labels.md does not cite issue comment 6898799392")
        for k, label in GOLD_LABELS.items():
            if f"| {k} | `{label}` |" not in gd:
                errs.append(f"gold-labels.md missing {k}={label}")

    inputs_doc = doc_inputs()
    per_scenario: dict[str, list[dict]] = {}
    for c in calls:
        sid, arm = c.get("scenario"), c.get("arm")
        if (sid, arm) not in ORDER:
            errs.append(f"unexpected call {c.get('id')} ({sid}/{arm})")
            continue
        per_scenario.setdefault(sid, []).append(c)
        expected = ARMS.get(arm, {})
        if c.get("commit") != expected.get("commit") or c.get("tarball_sha256") != expected.get("sha"):
            errs.append(f"{c.get('id')}: arm commit/hash mismatch")
        if c.get("scenario_name") != FIXTURES[sid]:
            errs.append(f"{c.get('id')}: scenario_name mismatch")
        if c.get("gold_label") != GOLD_LABELS[sid]:
            errs.append(f"{c.get('id')}: gold label mismatch")
        if c.get("inputs") != inputs_doc[sid]:
            errs.append(f"{c.get('id')}: inputs do not match docs §3.{sid[-1]}")
        if c.get("input_sha256") != canonical_input(c):
            errs.append(f"{c.get('id')}: input_sha256 mismatch")
        pp = HERE / c.get("prompt", "")
        if not pp.is_file():
            errs.append(f"{c.get('id')}: prompt missing {pp}")
        else:
            ptext = pp.read_text(encoding="utf-8")
            if c.get("prompt_sha256") != sha(ptext.encode()):
                errs.append(f"{c.get('id')}: prompt_sha256 mismatch")
            if json.dumps(c["inputs"], ensure_ascii=False, indent=2) not in ptext:
                errs.append(f"{c.get('id')}: prompt does not embed the frozen inputs verbatim")
        if c.get("max_tokens") != 2_000_000 or c.get("max_wall_s") != 1200:
            errs.append(f"{c.get('id')}: per-call monitor must be 2M / 1200 s")
        if c.get("retry") is not False:
            errs.append(f"{c.get('id')}: retry must be false")
        if c.get("dsh_home") not in (f"/tmp/phase1/dsh/{arm}",):
            errs.append(f"{c.get('id')}: dsh_home must be isolated per arm")
        if not c.get("output") or not c.get("driver_log") or not c.get("web_log"):
            errs.append(f"{c.get('id')}: output/log paths required")
        if fixtures_root:
            repo = fixtures_root / FIXTURES[sid]
            if not repo.is_dir():
                errs.append(f"{c.get('id')}: fixture repo missing {repo}")
            else:
                head = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"]).decode().strip()
                base = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD~1"]).decode().strip()
                diff = subprocess.check_output(["git", "-C", str(repo), "diff", "HEAD~1..HEAD"])
                if (c.get("base_commit"), c.get("head_commit"), c.get("diff_sha256")) != (base, head, sha(diff)):
                    errs.append(f"{c.get('id')}: fixture base/head/diff hash mismatch")
    for sid in GOLD_LABELS:
        group = per_scenario.get(sid, [])
        if len(group) != 2 or {x.get("arm") for x in group} != {"A", "B"}:
            errs.append(f"{sid}: need exactly one A and one B")
            continue
        a, b = sorted(group, key=lambda x: x["arm"])
        for key in set(a) - ARM_SPECIFIC:
            if key in ("id", "order"):
                continue
            if a.get(key) != b.get(key):
                errs.append(f"{sid}: A/B differ on frozen field {key}")
    # unique outputs/logs
    for field in ("output", "driver_log", "web_log"):
        vals = [c.get(field) for c in calls]
        if len(vals) != len(set(vals)):
            errs.append(f"{field} paths must be unique")
    return errs


def self_test() -> int:
    plan = yaml.safe_load(PLAN.read_text(encoding="utf-8"))
    base = validate(plan, fixtures_root=None)
    if base:
        print("SELF-TEST FAIL: base plan is invalid:", file=sys.stderr)
        print("\n".join(" - " + e for e in base), file=sys.stderr)
        return 1
    mutations = []
    m = copy.deepcopy(plan); m["calls"][0], m["calls"][1] = m["calls"][1], m["calls"][0]; mutations.append(("order", m))
    m = copy.deepcopy(plan); m["calls"][1]["id"] = m["calls"][0]["id"]; mutations.append(("duplicate id", m))
    m = copy.deepcopy(plan); m["gold_labels"]["S2"]["label"] = "approve"; mutations.append(("gold label", m))
    m = copy.deepcopy(plan); m["calls"][2]["input_sha256"] = "0" * 64; mutations.append(("input hash", m))
    m = copy.deepcopy(plan); m["calls"][3]["inputs"]["intent_of_change"] += " "; mutations.append(("S2 input drift", m))
    m = copy.deepcopy(plan); m["calls"][4]["prompt_sha256"] = "0" * 64; mutations.append(("prompt hash", m))
    m = copy.deepcopy(plan); m["calls"].pop(); mutations.append(("missing call", m))
    m = copy.deepcopy(plan); m["calls"][0]["commit"] = "0000000"; mutations.append(("arm commit", m))
    for name, mutated in mutations:
        if not validate(mutated, fixtures_root=None):
            print(f"SELF-TEST FAIL: mutation '{name}' was not rejected", file=sys.stderr)
            return 1
    print("PHASE1 PLAN SELF-TEST OK: order/id/label/hash/input/prompt/arm mutations are rejected")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixtures-root", type=Path, default=Path("/tmp/ac-validity-1c-fixtures"))
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    plan = yaml.safe_load(PLAN.read_text(encoding="utf-8"))
    errs = validate(plan, args.fixtures_root)
    if errs:
        print("\n".join("ERROR " + e for e in errs), file=sys.stderr)
        return 1
    print("PHASE1 PLAN OK: 6 calls fixed order; A/B inputs identical; input/prompt/diff hashes; gold labels frozen")
    return 0


if __name__ == "__main__":
    sys.exit(main())
