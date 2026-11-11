#!/usr/bin/env python3
"""VERIFY-01 Step 1: attribute the sdlc_verify verdict / official-result mismatches.

Read-only extraction from the local raw evaluation archive (GitHub issue
HMYDK/ai-native-sdlc-dsh#16, AC-001/AC-002 evidence).  Reproduces, for every
case, the real ``sdlc_verify`` verdict source (tool-call id paired with its
tool result in the *main* session), the official FeatureBench grading result,
the spec/acceptance criteria the author registered, and what the verifier
sub-session actually executed.

Method (deliberately narrow, see issue #15):
  * only ``tool/call`` events whose ``data.name == "sdlc_verify"`` are counted;
  * the matching ``tool/result`` is found by ``callId`` == ``message.toolCallId``;
  * a call with no result (timeout truncation) becomes ``no_result`` and never
    contributes a verdict;
  * a result with ``isError`` becomes ``error`` and never contributes a verdict;
  * the final verdict is the last *structured* verdict.text ``status`` found in
    a main-session sdlc_verify result (``raw_status`` only used if ``status``
    is absent).  Verifier sub-session JSON is never counted.

Defaults:
  --archive-root  $DSH_EVAL_ARCHIVE_ROOT or ~/.dsh-eval-archive/2026-11-08
  stdout is JSON; use --out to write docs/evals/verify-01-attribution-data.json.

Dependencies: Python 3.9+ stdlib + ``zstandard`` (the archive ships .zstd
JSONL session logs).  No network, no model calls, no writes outside --out.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import sys
from typing import Any

try:
    import zstandard
except ImportError:  # pragma: no cover - explicit message beats a traceback
    sys.exit(
        "error: the zstandard package is required to read session.v4.jsonl.zstd "
        "(use the project's eval python env, e.g. "
        "~/.local/share/uv/tools/featurebench/bin/python)."
    )

# ---------------------------------------------------------------------------
# Case table.  Verbatim from canonical docs/evals/featurebench-runs.jsonl +
# docs/evals/featurebench-verifier-confusion.json (2026-11-08 data), with the
# archive directory mapping verified against meta.json/prompt.txt/patch.diff.
# Groups: v1_fp (issue #16 scope), v2_fp (reference only), fn (censored).
# NOTE: for verify-stress and repeat-sampling, repN <-> rN was verified by the
# main-session verdict sequence matching the canonical `verify_verdicts`.
# ---------------------------------------------------------------------------
GETTEXT_TASK = "sphinx-doc__sphinx.e347e59c.test_build_gettext.2721e644.lv1"
DOCTEST_TASK = "sphinx-doc__sphinx.e347e59c.test_ext_doctest.530dec5f.lv1"
SEABORN_TASK = "mwaskom__seaborn.7001ebe7.test_algorithms.1f0181c2.lv1"
PACKAGING_TASK = "pypa__packaging.013f3b03.test_metadata.e00b5801.lv1"

CASES: list[dict[str, Any]] = [
    {
        "case_key": "V1-1",
        "group": "v1_fp",
        "experiment": "mvp",
        "arm": "sdlc",
        "repeat": 1,
        "run_id": f"mvp:{GETTEXT_TASK}:sdlc:r1",
        "task_id": GETTEXT_TASK,
        "archive_rel": "fb-runs/sphinx-doc__sphinx/sdlc",
        "canonical_bucket": "approve_unresolved_false_positive",
        "canonical_verify_verdicts": ["approve"],
        "required_symbols": ["add_uids", "extract_messages"],
        "signature_needles": ["add_uids"],
        "f2p_test_file": "tests/test_builders/test_build_gettext.py",
    },
    {
        "case_key": "V1-2",
        "group": "v1_fp",
        "experiment": "2x2",
        "arm": "sdlc_guidance",
        "repeat": 1,
        "run_id": f"2x2:{GETTEXT_TASK}:sdlc_guidance:r1",
        "task_id": GETTEXT_TASK,
        "archive_rel": (
            "fb-runs-2x2/sphinx-doc__sphinx.e347e59c.test_build_gettext."
            "2721e644.lv1/sdlc_guidance"
        ),
        "canonical_bucket": "approve_unresolved_false_positive",
        "canonical_verify_verdicts": ["approve", "approve"],
        "required_symbols": ["add_uids", "extract_messages"],
        "signature_needles": ["add_uids"],
        "f2p_test_file": "tests/test_builders/test_build_gettext.py",
    },
    {
        "case_key": "V1-3",
        "group": "v1_fp",
        "experiment": "expanded",
        "arm": "sdlc",
        "repeat": 1,
        "run_id": f"expanded:{DOCTEST_TASK}:sdlc:r1",
        "task_id": DOCTEST_TASK,
        "archive_rel": (
            "fb-runs-expanded/sphinx-doc__sphinx.e347e59c.test_ext_doctest."
            "530dec5f.lv1/sdlc"
        ),
        "canonical_bucket": "approve_unresolved_false_positive",
        "canonical_verify_verdicts": ["approve"],
        "required_symbols": ["DocTestBuilder", "compile"],
        "signature_needles": [
            "DocTestBuilder' object has no attribute 'compile'",
        ],
        "f2p_test_file": "tests/test_extensions/test_ext_doctest.py",
    },
    {
        "case_key": "V1-4",
        "group": "v1_fp",
        "experiment": "verify-stress",
        "arm": "sdlc",
        "repeat": 1,
        "run_id": f"verify-stress:{GETTEXT_TASK}:sdlc:r1",
        "task_id": GETTEXT_TASK,
        "archive_rel": (
            "fb-runs-stress/rep1/sphinx-doc__sphinx.e347e59c."
            "test_build_gettext.2721e644.lv1/sdlc"
        ),
        "canonical_bucket": "approve_unresolved_false_positive",
        "canonical_verify_verdicts": ["approve", "approve"],
        "required_symbols": ["add_uids", "extract_messages"],
        "signature_needles": ["add_uids"],
        "f2p_test_file": "tests/test_builders/test_build_gettext.py",
    },
    {
        "case_key": "V1-5",
        "group": "v1_fp",
        "experiment": "repeat-sampling",
        "arm": "sdlc",
        "repeat": 1,
        "run_id": f"repeat-sampling:{GETTEXT_TASK}:sdlc:r1",
        "task_id": GETTEXT_TASK,
        "archive_rel": (
            "fb-runs-repeat/rep1/sphinx-doc__sphinx.e347e59c."
            "test_build_gettext.2721e644.lv1/sdlc"
        ),
        "canonical_bucket": "approve_unresolved_false_positive",
        "canonical_verify_verdicts": ["approve"],
        "required_symbols": ["add_uids", "extract_messages"],
        "signature_needles": ["add_uids"],
        "f2p_test_file": "tests/test_builders/test_build_gettext.py",
    },
    {
        "case_key": "V1-6",
        "group": "v1_fp",
        "experiment": "repeat-sampling",
        "arm": "sdlc",
        "repeat": 2,
        "run_id": f"repeat-sampling:{GETTEXT_TASK}:sdlc:r2",
        "task_id": GETTEXT_TASK,
        "archive_rel": (
            "fb-runs-repeat/rep2/sphinx-doc__sphinx.e347e59c."
            "test_build_gettext.2721e644.lv1/sdlc"
        ),
        "canonical_bucket": "approve_unresolved_false_positive",
        "canonical_verify_verdicts": ["approve", "approve"],
        "required_symbols": ["add_uids", "extract_messages"],
        "signature_needles": ["add_uids"],
        "f2p_test_file": "tests/test_builders/test_build_gettext.py",
    },
    {
        "case_key": "V1-7",
        "group": "v1_fp",
        "experiment": "repeat-sampling",
        "arm": "sdlc",
        "repeat": 3,
        "run_id": f"repeat-sampling:{GETTEXT_TASK}:sdlc:r3",
        "task_id": GETTEXT_TASK,
        "archive_rel": (
            "fb-runs-repeat/rep3/sphinx-doc__sphinx.e347e59c."
            "test_build_gettext.2721e644.lv1/sdlc"
        ),
        "canonical_bucket": "approve_unresolved_false_positive",
        "canonical_verify_verdicts": ["approve"],
        "required_symbols": ["add_uids", "extract_messages"],
        "signature_needles": ["add_uids"],
        "f2p_test_file": "tests/test_builders/test_build_gettext.py",
    },
    {
        "case_key": "V2",
        "group": "v2_fp",
        "experiment": "version-regression-mvp",
        "arm": "sdlc",
        "repeat": 1,
        "run_id": f"version-regression-mvp:{GETTEXT_TASK}:sdlc:r1",
        "task_id": GETTEXT_TASK,
        "archive_rel": (
            "fb-runs-regression-mvp/sphinx-doc__sphinx.e347e59c."
            "test_build_gettext.2721e644.lv1/sdlc"
        ),
        "canonical_bucket": "approve_unresolved_false_positive",
        "canonical_verify_verdicts": ["approve", "approve"],
        "required_symbols": ["add_uids", "extract_messages"],
        "signature_needles": ["add_uids"],
        "f2p_test_file": "tests/test_builders/test_build_gettext.py",
    },
    {
        "case_key": "FN-1",
        "group": "fn",
        "experiment": "version-regression-mvp",
        "arm": "sdlc",
        "repeat": 1,
        "run_id": f"version-regression-mvp:{SEABORN_TASK}:sdlc:r1",
        "task_id": SEABORN_TASK,
        "archive_rel": (
            "fb-runs-regression-mvp/mwaskom__seaborn.7001ebe7."
            "test_algorithms.1f0181c2.lv1/sdlc"
        ),
        "canonical_bucket": "reject_resolved_false_negative",
        "canonical_verify_verdicts": ["reject"],
        "required_symbols": [],
        "signature_needles": [],
        "f2p_test_file": "tests/test_algorithms.py",
    },
    {
        "case_key": "FN-2",
        "group": "fn",
        "experiment": "version-regression-mvp",
        "arm": "sdlc",
        "repeat": 1,
        "run_id": f"version-regression-mvp:{PACKAGING_TASK}:sdlc:r1",
        "task_id": PACKAGING_TASK,
        "archive_rel": (
            "fb-runs-regression-mvp/pypa__packaging.013f3b03."
            "test_metadata.e00b5801.lv1/sdlc"
        ),
        "canonical_bucket": "reject_resolved_false_negative",
        "canonical_verify_verdicts": ["approve", "reject"],
        "required_symbols": [],
        "signature_needles": [],
        "f2p_test_file": "tests/test_metadata.py",
    },
    {
        "case_key": "FN-3",
        "group": "fn",
        "experiment": "repeat-sampling",
        "arm": "sdlc",
        "repeat": 2,
        "run_id": f"repeat-sampling:{SEABORN_TASK}:sdlc:r2",
        "task_id": SEABORN_TASK,
        "archive_rel": (
            "fb-runs-repeat/rep2/mwaskom__seaborn.7001ebe7."
            "test_algorithms.1f0181c2.lv1/sdlc"
        ),
        "canonical_bucket": "reject_resolved_false_negative",
        "canonical_verify_verdicts": ["reject"],
        "required_symbols": [],
        "signature_needles": [],
        "f2p_test_file": "tests/test_algorithms.py",
    },
]


# ---------------------------------------------------------------------------
# Session reading / sdlc_verify pairing
# ---------------------------------------------------------------------------
def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_session(path: str) -> list[dict[str, Any]]:
    """Decompress a session.v4.jsonl.zstd into a list of events."""
    raw = open(path, "rb").read()
    dctx = zstandard.ZstdDecompressor()
    with dctx.stream_reader(io.BytesIO(raw)) as reader:
        text = reader.read().decode("utf-8", errors="replace")
    # NB: split on "\n" only.  str.splitlines() also splits on U+0085/U+001C...
    # which can appear inside a session tool result and corrupt the JSONL.
    return [json.loads(line) for line in text.split("\n") if line.strip()]


def header(events: list[dict[str, Any]]) -> dict[str, Any]:
    return events[0] if events and events[0].get("type") == "session" else {}


def result_text(message: dict[str, Any]) -> str:
    parts = []
    for item in message.get("content") or []:
        if isinstance(item, dict) and item.get("type") == "text":
            parts.append(item.get("text") or "")
    return "\n".join(parts)


def parse_structured_payload(text: str) -> dict[str, Any] | None:
    """Find the structured verdict JSON in a tool result text.

    sdlc_verify results are the JSON verdict object itself or a short prefix +
    JSON.  We try, in order: whole text, fenced block, then the first complete
    balanced object that parses and looks like a verdict (has status/summary).
    """
    stripped = text.strip()
    candidates: list[str] = []
    if stripped:
        candidates.append(stripped)
    candidates.extend(m.group(1) for m in re.finditer(r"```(?:json)?\s*(\{.*?\})\s*```", stripped, re.S))
    # scan every '{' but keep the search bounded to the first half of the text
    for match in re.finditer(r"\{", stripped):
        if match.start() > max(64, len(stripped) // 2):
            break
        depth = 0
        in_str = False
        esc = False
        for i in range(match.start(), len(stripped)):
            ch = stripped[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    candidates.append(stripped[match.start() : i + 1])
                    break
    for cand in candidates:
        try:
            obj = json.loads(cand)
        except Exception:
            continue
        if isinstance(obj, dict) and ("status" in obj or "criteria_results" in obj):
            return obj
    return None


def normalize_criteria(payload: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for item in payload.get("criteria_results") or []:
        if not isinstance(item, dict):
            continue
        out.append(
            {
                "id": item.get("criterion_id") or item.get("id"),
                "result": item.get("result"),
            }
        )
    return out


def normalize_findings(payload: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for finding in payload.get("findings") or []:
        if not isinstance(finding, dict):
            continue
        out.append(
            {
                "severity": finding.get("severity"),
                "category": finding.get("category"),
                "reason": (finding.get("reason") or "")[:400],
            }
        )
    return out


def extract_verify_calls(
    events: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], int, int]:
    """Pair sdlc_verify tool/call + tool/result by callId.

    Returns (calls, n_unmatched_results, n_calls_without_result).  Calls without
    a result are kept in the list with has_result=False so the raw invocation
    count is visible, but they carry no verdict.
    """
    calls: list[dict[str, Any]] = []
    index_by_call_id: dict[str, int] = {}
    for pos, event in enumerate(events):
        if event.get("type") != "tool/call":
            continue
        data = event.get("data") or {}
        if data.get("name") != "sdlc_verify":
            continue
        index_by_call_id[data.get("callId")] = len(calls)
        calls.append(
            {
                "call_id": data.get("callId"),
                "call_event_index": pos,
                "arguments": data.get("arguments"),
                "result": None,
                "result_event_index": None,
            }
        )

    matched: set[str] = set()
    for pos, event in enumerate(events):
        if event.get("type") != "tool/result":
            continue
        message = (event.get("data") or {}).get("message") or {}
        call_id = message.get("toolCallId")
        if call_id not in index_by_call_id:
            continue
        matched.add(call_id)
        calls[index_by_call_id[call_id]]["result"] = message
        calls[index_by_call_id[call_id]]["result_event_index"] = pos

    normalized = []
    unmatched_results = 0
    for call in calls:
        message = call["result"]
        entry: dict[str, Any] = {
            "call_id": call["call_id"],
            "result_event_index": call["result_event_index"],
            "has_result": message is not None,
            "is_error": bool(message.get("isError")) if message else None,
            "status": None,
            "raw_status": None,
            "verification_complete": None,
            "criteria_results": [],
            "findings_count": None,
            "findings": [],
            "findings_summary": None,
            "unverified": [],
            "payload_parsed": False,
        }
        if message is not None:
            text = result_text(message)
            payload = None if message.get("isError") else parse_structured_payload(text)
            if isinstance(payload, dict):
                entry["payload_parsed"] = True
                entry["status"] = payload.get("status")
                entry["raw_status"] = payload.get("raw_status")
                entry["verification_complete"] = payload.get("verification_complete")
                entry["criteria_results"] = normalize_criteria(payload)
                findings = normalize_findings(payload)
                entry["findings"] = findings
                entry["findings_count"] = len(payload.get("findings") or [])
                entry["findings_summary"] = " | ".join(
                    f"[{f.get('severity') or '?'}/{f.get('category') or '?'}] "
                    f"{(f.get('reason') or '')[:180]}"
                    for f in findings
                ) or None
                entry["unverified"] = [
                    str(x)[:240] for x in (payload.get("unverified") or [])
                ]
        normalized.append(entry)
    calls_without_result = sum(1 for c in normalized if not c["has_result"])
    return normalized, unmatched_results, calls_without_result


def verdict_sequence(calls: list[dict[str, Any]]) -> list[str]:
    """Canonical-style sequence: completed structured verdicts only.

    'error' results (isError) and calls without a result are dropped, exactly
    like docs/evals/featurebench-runs.jsonl's verify_verdicts口径.
    """
    seq = []
    for call in calls:
        if call["has_result"] and not call["is_error"] and call["payload_parsed"]:
            status = call["status"] or call["raw_status"]
            if status:
                seq.append(status)
    return seq


def final_verdict(calls: list[dict[str, Any]]) -> str | None:
    seq = verdict_sequence(calls)
    return seq[-1] if seq else None


# ---------------------------------------------------------------------------
# spec / acceptance criteria extraction (from sdlc_artifact_write)
# ---------------------------------------------------------------------------
AC_RE = re.compile(r"^\s*[-*]?\s*(AC-\d+)\s*[:：]\s*(.+?)\s*$", re.MULTILINE)


def extract_spec(events: list[dict[str, Any]]) -> dict[str, Any]:
    last: dict[str, str] = {}
    writes = 0
    for event in events:
        if event.get("type") != "tool/call":
            continue
        data = event.get("data") or {}
        if data.get("name") != "sdlc_artifact_write":
            continue
        writes += 1
        try:
            args = json.loads(data.get("arguments") or "{}")
        except Exception:
            continue
        kind = args.get("kind")
        if kind in ("intent", "spec", "plan"):
            last[kind] = args.get("content") or ""
    spec = last.get("spec") or ""
    acs = [{"id": m.group(1), "text": m.group(2).strip()} for m in AC_RE.finditer(spec)]
    return {
        "artifact_writes": writes,
        "spec_sha256": hashlib.sha256(spec.encode()).hexdigest() if spec else None,
        "spec_acs": acs,
    }


# ---------------------------------------------------------------------------
# shell-command classification for the verifier sub-sessions
# ---------------------------------------------------------------------------
REAL_BUILD_RE = re.compile(r"\bpython3?\s+-m\s+sphinx\b|\bsphinx-build\b")
PYTEST_RE = re.compile(r"\bpython3?\s+-m\s+pytest\b|(?:^|[;&|\s])pytest\b")
OWN_PROBE_RE = re.compile(
    r"(?:^|[;&|\s])python3?\s+/tmp/|cat\s*>\s*/tmp/|mkdir[^\n]*/tmp/(?:verify|iverify)"
)
AUTHOR_EVIDENCE_RE = re.compile(r"\.ai/rsi|\.ai/tasks/")


def iter_bash_calls(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    call_args: dict[str, str] = {}
    for event in events:
        if event.get("type") != "tool/call":
            continue
        data = event.get("data") or {}
        if data.get("name") != "bash":
            continue
        try:
            args = json.loads(data.get("arguments") or "{}")
        except Exception:
            args = {}
        call_args[data.get("callId")] = args.get("command") or ""
    out = []
    for event in events:
        if event.get("type") != "tool/result":
            continue
        message = (event.get("data") or {}).get("message") or {}
        call_id = message.get("toolCallId")
        if call_id not in call_args:
            continue
        out.append(
            {
                "command": call_args[call_id],
                "is_error": bool(message.get("isError")),
                "text": result_text(message),
            }
        )
    return out


def classify_verifier_actions(
    sessions: list[dict[str, Any]],
    f2p_test_file: str,
    signature_needles: list[str],
) -> dict[str, Any]:
    """Classify what the verifier sub-sessions actually executed.

    `sessions` is a list of (dir_name, events, role) with role in
    {"main", "child"}; only child (verifier) sessions feed ran_* flags, while
    both are searched for the F2P test-file evidence and failure signatures.
    """
    real_build: list[str] = []
    project_tests: list[str] = []
    own_probe: list[str] = []
    author_evidence: list[str] = []
    signature_hits: list[str] = []
    hidden_test_events: list[dict[str, Any]] = []
    executed_test_targets: set[str] = set()

    f2p_needles = [n for n in (f2p_test_file, os.path.splitext(os.path.basename(f2p_test_file))[0]) if n]
    for dir_name, events, role in sessions:
        for call in iter_bash_calls(events):
            cmd = " ".join(call["command"].split())
            text = call["text"]
            if any(needle in cmd for needle in f2p_needles):
                hidden_test_events.append(
                    {
                        "role": role,
                        "session": dir_name,
                        "command": cmd[:300],
                        "result_head": " ".join(text.split())[:300],
                        "result_is_error": call["is_error"],
                    }
                )
            for symbol in signature_needles:
                if symbol and symbol in text:
                    signature_hits.append(
                        {
                            "role": role,
                            "session": dir_name,
                            "symbol": symbol,
                            "command": cmd[:240],
                            "context": " ".join(
                                text[
                                    max(0, text.find(symbol) - 120) : text.find(symbol) + 160
                                ].split()
                            )[:300],
                        }
                    )
            if role != "child":
                continue
            if REAL_BUILD_RE.search(cmd):
                real_build.append(cmd[:300])
            if PYTEST_RE.search(cmd):
                project_tests.append(cmd[:300])
            for target in re.findall(r"[\w./-]+\.py", cmd):
                if "test" in target:
                    executed_test_targets.add(target)
            if OWN_PROBE_RE.search(cmd):
                own_probe.append(cmd[:300])
            if AUTHOR_EVIDENCE_RE.search(cmd):
                author_evidence.append(cmd[:300])

    return {
        "ran_real_build": bool(real_build),
        "ran_project_tests": bool(project_tests),
        "ran_own_probe": bool(own_probe),
        "read_author_evidence": bool(author_evidence),
        "observed_official_failure_signature": bool(signature_hits),
        "f2p_test_file_referenced": bool(hidden_test_events),
        "executed_test_targets": sorted(executed_test_targets),
        "evidence": {
            "real_build_commands": real_build[:6],
            "project_test_commands": project_tests[:6],
            "own_probe_commands": own_probe[:6],
            "author_evidence_commands": author_evidence[:6],
            "failure_signature_hits": signature_hits[:6],
            "f2p_test_file_events": hidden_test_events[:6],
        },
    }


# ---------------------------------------------------------------------------
# official grading result
# ---------------------------------------------------------------------------
def extract_official(
    arm_dir: str, task_id: str, rel
) -> dict[str, Any]:
    eval_dir = os.path.join(arm_dir, "eval_outputs", task_id, "attempt-1")
    report_path = os.path.join(eval_dir, "report.json")
    test_output_path = os.path.join(eval_dir, "test_output.txt")
    official: dict[str, Any] = {
        "report_rel": rel(report_path) if os.path.exists(report_path) else None,
        "test_output_rel": rel(test_output_path) if os.path.exists(test_output_path) else None,
        "resolved": None,
        "pass_rate": None,
        "f2p_success": [],
        "f2p_failed": [],
        "p2p_success_count": None,
        "p2p_failed": [],
        "failure_signatures": [],
        "test_output_sha256": None,
        "report_sha256": None,
    }
    if os.path.exists(report_path):
        instance = json.load(open(report_path)).get(task_id, {})
        tests = instance.get("tests_status") or {}
        f2p = tests.get("FAIL_TO_PASS") or {}
        p2p = tests.get("PASS_TO_PASS") or {}
        official.update(
            {
                "resolved": instance.get("resolved"),
                "pass_rate": instance.get("pass_rate"),
                "f2p_success": f2p.get("success") or [],
                "f2p_failed": f2p.get("failure") or [],
                "p2p_success_count": len(p2p.get("success") or []),
                "p2p_failed": p2p.get("failure") or [],
                "report_sha256": sha256_file(report_path),
            }
        )
    if os.path.exists(test_output_path):
        text = open(test_output_path, errors="replace").read()
        signatures = []
        for match in re.finditer(
            r"^E\s+((?:\w+\.)*\w*(?:Error|Exception|Warning)[^\n]*)", text, re.MULTILINE
        ):
            sig = match.group(1).strip()
            if sig not in signatures:
                signatures.append(sig)
        official["failure_signatures"] = signatures[:8]
        official["test_output_sha256"] = sha256_file(test_output_path)
        official["test_output_chars"] = len(text)
    return official


# ---------------------------------------------------------------------------
# patch
# ---------------------------------------------------------------------------
def extract_patch(arm_dir: str, required_symbols: list[str]) -> dict[str, Any]:
    patch_path = os.path.join(arm_dir, "patch.diff")
    if not os.path.exists(patch_path):
        return {"files": [], "files_count": 0, "sha256": None,
                "restores_required_symbols": False,
                "matches_required_symbols": []}
    text = open(patch_path, errors="replace").read()
    files = re.findall(r"^diff --git a/(\S+)", text, re.MULTILINE)
    hits = []
    for symbol in required_symbols:
        simple = symbol.split(".")[-1]
        if re.search(rf"^\+\s*(?:def|class)\s+{re.escape(simple)}\b", text, re.MULTILINE):
            hits.append(symbol)
    return {
        "files": files,
        "files_count": len(files),
        "sha256": sha256_file(patch_path),
        "restores_required_symbols": bool(hits),
        "matches_required_symbols": hits,
    }


# ---------------------------------------------------------------------------
# task statement symbol coverage
# ---------------------------------------------------------------------------
def extract_task_statement(arm_dir: str, required_symbols: list[str]) -> dict[str, Any]:
    prompt_path = os.path.join(arm_dir, "prompt.txt")
    prompt = open(prompt_path, errors="replace").read() if os.path.exists(prompt_path) else ""
    mentions = {}
    for symbol in required_symbols:
        simple = symbol.split(".")[-1]
        mentions[symbol] = (simple in prompt) or (symbol in prompt)
    scope = None
    for pattern in (
        r"[^\n]*outside (?:these|this)[^\n]*",
        r"[^\n]*only [`\w]+[^\n]*",
    ):
        match = re.search(pattern, prompt)
        if match:
            scope = " ".join(match.group(0).split())
            break
    return {
        "mentions_required_symbols": mentions,
        "mentions_any_required_symbol": any(mentions.values()),
        "scope_exclusion_statement": scope,
        "prompt_sha256": sha256_file(prompt_path) if os.path.exists(prompt_path) else None,
    }


# ---------------------------------------------------------------------------
# per-case extraction
# ---------------------------------------------------------------------------
def session_paths(arm_dir: str) -> tuple[str | None, list[tuple[str, str]]]:
    base = os.path.join(arm_dir, "sessions", "sessions", "--testbed--")
    if not os.path.isdir(base):
        return None, []
    main = None
    children = []
    for name in sorted(os.listdir(base)):
        path = os.path.join(base, name, "session.v4.jsonl.zstd")
        if not os.path.exists(path):
            continue
        if name.startswith("session-"):
            main = path
        else:
            children.append((name, path))
    return main, children


def case_record(case: dict[str, Any], archive_root: str) -> dict[str, Any]:
    arm_dir = os.path.join(archive_root, case["archive_rel"])
    rel = lambda p: "archive:" + os.path.relpath(p, archive_root)  # noqa: E731

    main_path, child_paths = session_paths(arm_dir)
    sessions: list[tuple[str, list[dict[str, Any]], str]] = []
    main_events: list[dict[str, Any]] = []
    main_meta: dict[str, Any] = {}
    if main_path:
        main_events = read_session(main_path)
        main_meta = header(main_events)
        sessions.append((os.path.basename(os.path.dirname(main_path)), main_events, "main"))
    child_records = []
    for name, path in child_paths:
        events = read_session(path)
        meta = header(events)
        child_records.append(
            {
                "session_dir": name,
                "preset": meta.get("agentPreset"),
                "origin": meta.get("origin"),
                "parent_session": meta.get("parentSession"),
                "event_count": len(events),
                "path": rel(path),
                "sha256": sha256_file(path),
            }
        )
        sessions.append((name, events, "child"))

    calls, _, no_result = extract_verify_calls(main_events)
    seq = verdict_sequence(calls)
    final = seq[-1] if seq else None
    spec = extract_spec(main_events)
    actions = classify_verifier_actions(
        sessions, case["f2p_test_file"], case["signature_needles"]
    )
    official = extract_official(arm_dir, case["task_id"], rel)
    patch = extract_patch(arm_dir, case["required_symbols"])
    task_statement = extract_task_statement(arm_dir, case["required_symbols"])
    ac_text = " ".join(ac["text"] for ac in spec["spec_acs"])
    spec_ac_mentions = {
        symbol: (symbol in ac_text) or (symbol.split(".")[-1] in ac_text)
        for symbol in case["required_symbols"]
    }
    spec["mentions_required_symbols"] = spec_ac_mentions
    spec["mentions_any_required_symbol"] = any(spec_ac_mentions.values())
    meta_path = os.path.join(arm_dir, "meta.json")
    meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}

    evidence = []
    if main_path:
        evidence.append(
            {
                "what": "main session (author + sdlc_verify tool calls/results)",
                "path": rel(main_path),
                "sha256": sha256_file(main_path),
            }
        )
    for child in child_records:
        evidence.append(
            {
                "what": f"verifier sub-session preset={child['preset']} events={child['event_count']}",
                "path": child["path"],
                "sha256": child["sha256"],
            }
        )
    for what, name in (
        ("official per-task report", "eval_outputs/{task}/attempt-1/report.json"),
        ("official pytest output / failure stack", "eval_outputs/{task}/attempt-1/test_output.txt"),
        ("agent patch", "patch.diff"),
        ("task statement prompt", "prompt.txt"),
        ("run metadata", "meta.json"),
    ):
        path = os.path.join(arm_dir, name.replace("{task}", case["task_id"]))
        if os.path.exists(path):
            evidence.append({"what": what, "path": rel(path), "sha256": sha256_file(path)})

    call_records = []
    for call in calls:
        call_records.append(
            {
                "call_id": call["call_id"],
                "has_result": call["has_result"],
                "is_error": call["is_error"],
                "status": call["status"],
                "raw_status": call["raw_status"],
                "verification_complete": call["verification_complete"],
                "criteria_results": call["criteria_results"],
                "findings_count": call["findings_count"],
                "findings_summary": call["findings_summary"],
                "unverified_count": len(call["unverified"]),
            }
        )

    return {
        "case_key": case["case_key"],
        "group": case["group"],
        "run_id": case["run_id"],
        "experiment": case["experiment"],
        "task_id": case["task_id"],
        "arm": case["arm"],
        "repeat": case["repeat"],
        "agent_failure": meta.get("agent_failure"),
        "agent_completed": meta.get("agent_completed"),
        "plugin_version": meta.get("plugin_version"),
        "dsh_cli": meta.get("dsh_cli"),
        "main_session": rel(main_path) if main_path else None,
        "main_session_agent_preset": main_meta.get("agentPreset"),
        "verifier_sessions": child_records,
        "main_verify_calls": call_records,
        "main_verify_call_count": len(calls),
        "main_verify_calls_without_result": no_result,
        "main_verify_status_sequence": seq,
        "final_verdict": final,
        "canonical_bucket": case["canonical_bucket"],
        "canonical_verify_verdicts": case["canonical_verify_verdicts"],
        "canonical_consistency": {
            "verdict_sequence_matches_canonical": seq == case["canonical_verify_verdicts"],
            "note": (
                "canonical verdicts match: completed main-session structured "
                "verdicts only; error results and calls without a result are "
                "excluded in both extractions"
                if seq == case["canonical_verify_verdicts"]
                else "MISMATCH vs canonical verify_verdicts - investigate"
            ),
        },
        "official": official,
        "task_statement": task_statement,
        "patch": patch,
        "spec": spec,
        "required_symbols": case["required_symbols"],
        "f2p_test_file": case["f2p_test_file"],
        "verifier_actions": actions,
        "evidence_paths": evidence,
    }


# ---------------------------------------------------------------------------
# curated attribution (analyst judgment layered on the extracted facts)
# ---------------------------------------------------------------------------
LABELS: dict[str, list[dict[str, Any]]] = {
    "V1-1": [
        {
            "id": "1",
            "name": "缺少/无法执行关键测试",
            "confidence": "high",
            "evidence": (
                "官方 F2P 测试文件 tests/test_builders/test_build_gettext.py 不在 testbed 中"
                "（verifier 列 tests/test_builders/ 无此文件、main session grep 无输出），"
                "作者与验证者都没有执行 python -m sphinx -b gettext 这条真实入口，"
                "因此官方失败签名 NameError: name 'add_uids' is not defined 在提交前从未出现。"
            ),
        },
        {
            "id": "2",
            "name": "测试有运行但覆盖不足",
            "confidence": "high",
            "evidence": (
                "验证者实际运行的是自写 probe（9 项 Catalog.add/GettextRenderer 行为断言）、"
                "tests/test_util/test_util_fileutil.py 与 test_util_template.py 等周边单测，"
                "加上 pristine HEAD 对照；没有覆盖 gettext builder 端到端路径，"
                "所以只证明了接口行为，没有证明官方测试文件能跑。"
            ),
        },
        {
            "id": "4",
            "name": "Spec/AC 未覆盖外部评分要求",
            "confidence": "high",
            "evidence": (
                "任务说明（prompt.txt 0 次提及 add_uids/extract_messages/versioning）"
                "与 spec 的 AC-001..AC-010 只覆盖 Catalog.add、GettextRenderer.__init__/render、"
                "BaseRenderer.render；官方 F2P 12/13 失败在 sphinx/versioning.py:172 的 "
                "add_uids（同批被剥离代码还包括 i18n 路径的 extract_messages，验证者在 "
                "tests/test_intl 上观测到）——这些都不在任何 AC 中。"
            ),
        },
        {
            "id": "5",
            "name": "评分/环境/数据提取问题",
            "confidence": "high",
            "evidence": (
                "官方评分要求恢复的代码超出 prompt 声明的实现范围：prompt 只列 4 个接口，"
                "把 i18n builder 等明确写成 out of scope（'the complete internationalization "
                "builder are outside these listed implementations'），而 add_uids 甚至未出现在"
                "prompt 里。同 task 的 2x2 standard 对照臂恢复 21 个文件后"
                "官方 resolved=1.0 / F2P 12/12，而本 task 只改 2 个文件时 6 次独立运行"
                "（mvp/2x2/stress/repeat×3）得到完全相同的 1/13 + add_uids 签名。"
                "F2P 测试文件在 testbed 中不可见（隐藏测试），本地无法复跑官方评分。"
            ),
        },
    ],
    "V1-2": [
        {
            "id": "3",
            "name": "Verifier 漏看代码缺陷或错误解释证据",
            "confidence": "high",
            "evidence": (
                "验证者从 raw.githubusercontent 取回上游 tests/test_builders/test_build_gettext.py，"
                "在 /tmp/runpristine 与 /testbed 分别运行，得到 '12 failed' / '11 failed, 1 passed'，"
                "并明确记录 root cause 为 11x NameError: name 'add_uids' is not defined 与 "
                "i18n.py:412 extract_messages；最终仍以 'stripped out of scope' 解释并 approve。"
                "它已经拿到与官方评分同构的失败证据，却按任务说明的 scope 把它归为不阻塞。"
            ),
        },
        {
            "id": "4",
            "name": "Spec/AC 未覆盖外部评分要求",
            "confidence": "high",
            "evidence": (
                "同 V1-1；官方 F2P 第一层失败是 sphinx/versioning.py:172 的 add_uids"
                "（同批被剥离代码还有 extract_messages），prompt/AC 均未覆盖。"
            ),
        },
        {
            "id": "5",
            "name": "评分/环境/数据提取问题",
            "confidence": "high",
            "evidence": (
                "同 V1-1；官方失败签名与 2x2 standard 对照臂（21 文件恢复后 resolved=1.0）"
                "共同证明：按任务说明的接口范围实现无法通过官方评分。"
            ),
        },
    ],
    "V1-3": [
        {
            "id": "1",
            "name": "缺少/无法执行关键测试",
            "confidence": "high",
            "evidence": (
                "官方 F2P tests/test_extensions/test_ext_doctest.py 不在 testbed："
                "verifier 的 find / -name 'test_ext_doctest*' 无输出、git ls-files 无匹配，"
                "pyproject.toml 却列出 tests.test_extensions.test_ext_doctest；"
                "也没有执行 python -m sphinx -b doctest 的真实入口，"
                "因此官方失败签名 AttributeError: 'DocTestBuilder' object has no attribute "
                "'compile' 在提交前从未出现。"
            ),
        },
        {
            "id": "2",
            "name": "测试有运行但覆盖不足",
            "confidence": "high",
            "evidence": (
                "验证者 53 条 bash 命令中只执行了自写 /tmp/verify_doctest_version.py"
                "（13 个布尔用例 + 异常传播 + 签名/import）与作者证据复跑；"
                "没有任何项目测试或 doctest builder 构建。"
            ),
        },
        {
            "id": "4",
            "name": "Spec/AC 未覆盖外部评分要求",
            "confidence": "high",
            "evidence": (
                "任务说明首句 'Restore only `is_allowed_version(spec, version)` ... "
                "Directive execution and the rest of the doctest extension are outside "
                "this interface'；spec AC-012 还明确写 'no other stripped helpers are "
                "restored'。官方 F2P 11 项中只有 test_is_allowed_version 通过，"
                "其余 10 项失败在 DocTestBuilder.compile / NotImplementedError run()。"
            ),
        },
        {
            "id": "5",
            "name": "评分/环境/数据提取问题",
            "confidence": "high",
            "evidence": (
                "同任务的 expanded standard 对照臂同样只恢复 is_allowed_version，"
                "官方结果同样是 resolved=False / pass_rate=0.0909 / 同一失败签名——"
                "按任务说明做正确实现也无法达到官方评分要求。"
            ),
        },
    ],
    "V1-4": [
        {
            "id": "1",
            "name": "缺少/无法执行关键测试",
            "confidence": "high",
            "evidence": (
                "验证者第二次子会话显式执行 'python -m pytest tests/test_builders/"
                "test_build_gettext.py -q'，返回 'ERROR: file or directory not found'；"
                "没有 python -m sphinx -b gettext 真实构建。官方 add_uids 签名从未出现。"
            ),
        },
        {
            "id": "2",
            "name": "测试有运行但覆盖不足",
            "confidence": "high",
            "evidence": (
                "验证者跑了作者新增的 tests/test_builders/test_gettext_interfaces.py、"
                "tests/test_quickstart.py、自写 /tmp/vfy_probe_gxt.py 与 mutation 检查，"
                "都是接口级/周边级覆盖，没有 gettext 端到端构建。"
            ),
        },
        {
            "id": "4",
            "name": "Spec/AC 未覆盖外部评分要求",
            "confidence": "high",
            "evidence": "同 V1-1：AC-001..AC-012 只覆盖接口，官方失败在 add_uids/extract_messages。",
        },
        {
            "id": "5",
            "name": "评分/环境/数据提取问题",
            "confidence": "high",
            "evidence": (
                "同 V1-1；两次 sdlc_verify 都 approve（第一次 1 条 minor finding、第二次 0 条），"
                "官方仍是 1/13 + add_uids。"
            ),
        },
    ],
    "V1-5": [
        {
            "id": "1",
            "name": "缺少/无法执行关键测试",
            "confidence": "high",
            "evidence": (
                "官方 F2P 文件不在树中（main/verifier 对 tests/test_builders/"
                "test_build_gettext.py 的 grep 均无输出），也没有执行真实 gettext 构建。"
            ),
        },
        {
            "id": "2",
            "name": "测试有运行但覆盖不足",
            "confidence": "high",
            "evidence": (
                "验证者只跑了 /tmp/verify_gettext.py（接口级 probe）、作者 "
                ".ai/tasks/GETTEXT-CATALOG-RENDER/proof_check.py 与 tests/test_util/"
                "test_util_template.py，没有端到端覆盖。"
            ),
        },
        {
            "id": "4",
            "name": "Spec/AC 未覆盖外部评分要求",
            "confidence": "high",
            "evidence": "同 V1-1：spec 的 9 条 AC 无 add_uids/extract_messages，官方失败正是它们。",
        },
        {
            "id": "5",
            "name": "评分/环境/数据提取问题",
            "confidence": "high",
            "evidence": "同 V1-1；与 V1-1/2x2/stress/repeat r2/r3 相同的 1/13 + add_uids 签名。",
        },
    ],
    "V1-6": [
        {
            "id": "3",
            "name": "Verifier 漏看代码缺陷或错误解释证据",
            "confidence": "high",
            "evidence": (
                "验证者子会话实际执行 'python -m sphinx -b gettext'，复现了与官方评分完全一致的 "
                "`NameError: name 'add_uids' is not defined`（sphinx/versioning.py:172），"
                "并在 /tmp/verify/baseline_repo 确认 pristine HEAD 同样失败，"
                "随后把这条写成 'E7. End-to-end gettext build impossible in this repo "
                "(pre-existing, out of scope)'，最终 verdict=approve、findings=0。"
                "这是本批中最直接的『看到评分失败证据却按 scope 解释掉』。"
            ),
        },
        {
            "id": "4",
            "name": "Spec/AC 未覆盖外部评分要求",
            "confidence": "high",
            "evidence": (
                "同 V1-1：AC 只覆盖接口；官方 F2P 第一层失败是 add_uids（同批被剥离代码还有 "
                "extract_messages），均无 AC 覆盖。"
            ),
        },
        {
            "id": "5",
            "name": "评分/环境/数据提取问题",
            "confidence": "high",
            "evidence": (
                "同 V1-1；但本案例 verifier 实际跑过真实入口——问题不是『没跑』，"
                "而是『官方真实入口在 pristine 上就坏』时验收口径如何取舍，"
                "属任务数据/评分口径问题。"
            ),
        },
    ],
    "V1-7": [
        {
            "id": "1",
            "name": "缺少/无法执行关键测试",
            "confidence": "medium",
            "evidence": (
                "官方 F2P 文件不在树中（main/verifier grep 无输出）；验证者取回上游 sdist "
                "的 test_build_gettext.py 后只抽出 test_Catalog_duplicated_message 单独跑，"
                "没有跑整份官方测试，也没有 python -m sphinx -b gettext 构建。"
            ),
        },
        {
            "id": "2",
            "name": "测试有运行但覆盖不足",
            "confidence": "high",
            "evidence": (
                "验证者跑了 /tmp/verify_gettext_restore.py（AC-001..AC-010 自写 probe）、"
                ".ai/tasks/GETTEXT-RESTORE/probe_gettext.py、tests/test_util/"
                "test_util_template.py 与 tests/test_extensions/test_ext_apidoc.py 的 HEAD 对照；"
                "没有官方 F2P 端到端覆盖。"
            ),
        },
        {
            "id": "4",
            "name": "Spec/AC 未覆盖外部评分要求",
            "confidence": "high",
            "evidence": "同 V1-1：spec 10 条 AC 无 add_uids/extract_messages。",
        },
        {
            "id": "5",
            "name": "评分/环境/数据提取问题",
            "confidence": "high",
            "evidence": "同 V1-1；同签名 1/13 + add_uids。",
        },
    ],
    "V2": [
        {
            "id": "1",
            "name": "缺少/无法执行关键测试",
            "confidence": "high",
            "evidence": (
                "V2（0.6.1/0.2.2-rc.1）同一 task：验证者没有执行真实 gettext 构建，"
                "也没有运行官方 F2P 测试文件；只做了代码与上游 Sphinx master/v8.2.3 的一致性比对。"
            ),
        },
        {
            "id": "2",
            "name": "测试有运行但覆盖不足",
            "confidence": "high",
            "evidence": (
                "验证者跑了 /tmp/verify_acs.py、作者 proof/test_gettext_restore.py 的 17 个测试"
                "（并在 clean HEAD 上验证全部失败）、mutation 13/13，以及周边 test_util 测试；"
                "缺少 gettext builder 真实入口覆盖。"
            ),
        },
        {
            "id": "4",
            "name": "Spec/AC 未覆盖外部评分要求",
            "confidence": "high",
            "evidence": (
                "同 V1-1 的 task statement/spec；V2 仍有 1/3 approve→unresolved，"
                "官方失败签名同样是 add_uids。"
            ),
        },
        {
            "id": "5",
            "name": "评分/环境/数据提取问题",
            "confidence": "high",
            "evidence": (
                "同 V1-1 的任务数据问题；V2 说明该失败模式不是 0.6.0 特有，"
                "在 0.6.1 + DSH 0.2.2-rc.1 上仍复现。"
            ),
        },
    ],
    "FN-1": [
        {
            "id": "6",
            "name": "证据不足",
            "confidence": "high",
            "evidence": (
                "agent_failure=timeout（删失）：第 1 次 sdlc_verify 给出 reject（依据自重建的 "
                "base-commit tests/test_algorithms.py 3/14 失败）；作者随后修复，第 2 次 "
                "sdlc_verify 的子验证者已跑出 /tmp/sb7001_test_algorithms.py 13 passed，"
                "但第二次调用没有 result（超时截断），最终裁决仍取 reject。"
                "官方 resolved=1.0（F2P 13/13，含 test_bootstrap_reproducibility、"
                "test_nanaware_func_warning）与 reject 矛盾；因删失不能判定为验证者误判。"
            ),
        },
    ],
    "FN-2": [
        {
            "id": "6",
            "name": "证据不足",
            "confidence": "high",
            "evidence": (
                "agent_failure=timeout（删失）：第 1 次 approve；第 2 次因『验证后代码/制品又改』"
                "被插件拒绝（plugin error）；第 3 次 reject，依据是 packaging 26.3 才修复的边界"
                "（CR/U+2028 summary、malformed content-type），而任务 AC 与官方评分基于 "
                "packaging 26.0。官方 resolved=1.0（F2P 294/294）。reject 的规范依据超出"
                "任务说明/官方 oracle，但删除样本+隐藏测试使归因不可定。"
            ),
        },
    ],
    "FN-3": [
        {
            "id": "6",
            "name": "证据不足",
            "confidence": "high",
            "evidence": (
                "agent_failure=timeout（删失）：第 1 次 reject 依据自重建上游 7001ebe 的 "
                "tests/test_algorithms.py（2 failed, 11 passed：FutureWarning vs UserWarning、"
                "warning 文本不匹配）；第 2 次调用 plugin error；第 3 次调用无 result（超时）。"
                "官方 resolved=1.0（F2P 13/13 含 test_bootstrap_reproducibility 与 "
                "test_nanaware_func_warning），与 reject 矛盾；删失+隐藏测试使归因不可定。"
            ),
        },
    ],
}

FN_NOTES: dict[str, str] = {
    "FN-1": (
        "官方 F2P 明确包含 verifier 声称失败的 test_bootstrap_reproducibility 与 "
        "test_nanaware_func_warning；官方 resolved=1.0。第 2 次 sdlc_verify 无 result，"
        "属于 timeout 截断，不能把最终 reject 当作验证者最终判断。"
    ),
    "FN-2": (
        "verifier 自己在第 1 次给了 approve；第 3 次 reject 的 4 条 'important' finding "
        "全部基于 packaging 26.3 的上游后续修复，而任务/官方 oracle 是 26.0 套件"
        "（官方 F2P 294/294 pass）。"
    ),
    "FN-3": (
        "与 FN-1 同类：reject 的依据是从上游/相邻 commit 重建的 tests/test_algorithms.py，"
        "其期望与官方 F2P 文件不一致（官方对应的 2 个测试通过）；第 3 次 sdlc_verify 超时。"
    ),
}

CASE_CONFIDENCE = {
    "V1-1": ("high", True, None, True),
    "V1-2": ("high", True, None, True),
    "V1-3": ("high", True, None, True),
    "V1-4": ("high", True, None, True),
    "V1-5": ("high", True, None, True),
    "V1-6": ("high", True, None, True),
    "V1-7": ("high", True, None, True),
    "V2": ("high", True, None, True),
    "FN-1": (
        "high",
        False,
        "agent_failure=timeout（删失）：最后一次 sdlc_verify 无 result（超时截断），"
        "官方 resolved=1.0 与 reject 矛盾，无法区分删失与误判",
        False,
    ),
    "FN-2": (
        "high",
        False,
        "agent_failure=timeout（删失）：最终 reject 依据 packaging 26.3 后置修复而非任务/官方 26.0 oracle，"
        "且第 2 次验证被插件拒绝；删失使归因不可定",
        False,
    ),
    "FN-3": (
        "high",
        False,
        "agent_failure=timeout（删失）：第 3 次 sdlc_verify 无 result（超时截断），"
        "官方 resolved=1.0 与 reject 矛盾，无法区分删失与误判",
        False,
    ),
}


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def build_output(archive_root: str) -> dict[str, Any]:
    cases = []
    for case in CASES:
        record = case_record(case, archive_root)
        confidence, confirmed, reason, reproducible = CASE_CONFIDENCE[case["case_key"]]
        record["verdict_vs_official"] = (
            "false_positive"
            if record["final_verdict"] == "approve" and record["official"]["resolved"] is False
            else "false_negative"
            if record["final_verdict"] == "reject" and record["official"]["resolved"] is True
            else "match"
            if record["official"]["resolved"] is not None
            else "unknown"
        )
        record["attribution_labels"] = LABELS[case["case_key"]]
        record["attribution_label_ids"] = [
            label["id"] for label in record["attribution_labels"]
        ]
        record["confidence"] = confidence
        record["confirmed"] = confirmed
        record["unconfirmed_reason"] = reason
        record["reproducible"] = reproducible
        if case["group"] == "fn":
            record["censored_note"] = FN_NOTES[case["case_key"]]
        cases.append(record)

    repo_root = os.path.dirname(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    )
    canonical_sources = []
    for rel_path in (
        "docs/evals/featurebench-runs.jsonl",
        "docs/evals/featurebench-verifier-confusion.json",
        "docs/evals/featurebench-baseline.md",
    ):
        path = os.path.join(repo_root, rel_path)
        if os.path.exists(path):
            canonical_sources.append({"path": rel_path, "sha256": sha256_file(path)})

    return {
        "schema": "verify-01-attribution-data",
        "schema_version": 1,
        "generated_by": "tools/evals/verify01/attribute_cases.py",
        "source_of_truth": (
            "本机只读原始归档（相对路径见 evidence_paths 的 archive: 前缀）；"
            "canonical 口径见 docs/evals/featurebench-runs.jsonl 与 "
            "docs/evals/featurebench-verifier-confusion.json"
        ),
        "method": {
            "verdict_source": (
                "主会话 session-*.jsonl.zstd 中 name=sdlc_verify 的 tool/call，"
                "按 callId==tool/result.message.toolCallId 配对；最终裁决 = 最后一个"
                "有结构化 payload 且非 error 的 status（缺失 status 时回退 raw_status）"
            ),
            "no_double_count_checks": [
                "验证者子会话（origin=subagent, agentPreset=sdlc-verifier）中的结构化裁决 JSON 不参与提取",
                "isError=true 的 result 不产生裁决（记为 error）",
                "无 tool/result 的 sdlc_verify 调用（timeout 截断）记为 no_result，不产生裁决",
                "提取结果与 canonical verify_verdicts 逐案例比对（canonical_consistency 字段）",
            ],
            "spec_extraction": (
                "主会话最后一次 kind=spec 的 sdlc_artifact_write 的 content；"
                "AC 以 '- AC-xxx:' 行解析"
            ),
            "verifier_actions": (
                "bash tool/call 的 command 分类：real_build=python -m sphinx/sphinx-build；"
                "project_tests=python -m pytest/pytest；own_probe=执行/写入 /tmp 下自写脚本；"
                "author_evidence=读取 .ai/rsi 或 .ai/tasks；"
                "observed_official_failure_signature=子会话 tool/result 文本中出现 required_symbols"
            ),
        },
        "canonical_sources": canonical_sources,
        "case_count": len(cases),
        "groups": {
            "v1_fp": sum(1 for c in cases if c["group"] == "v1_fp"),
            "v2_fp": sum(1 for c in cases if c["group"] == "v2_fp"),
            "fn": sum(1 for c in cases if c["group"] == "fn"),
        },
        "cases": cases,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Extract VERIFY-01 sdlc_verify/official-result attribution data "
        "from the local read-only eval archive."
    )
    parser.add_argument(
        "--archive-root",
        default=os.environ.get(
            "DSH_EVAL_ARCHIVE_ROOT", os.path.expanduser("~/.dsh-eval-archive/2026-11-08")
        ),
        help="archive root containing fb-runs*/ (default: $DSH_EVAL_ARCHIVE_ROOT "
        "or ~/.dsh-eval-archive/2026-11-08)",
    )
    parser.add_argument("--out", help="write JSON here instead of stdout")
    parser.add_argument("--pretty", action="store_true", help="indent JSON output")
    args = parser.parse_args(argv)

    if not os.path.isdir(args.archive_root):
        print(f"error: archive root not found: {args.archive_root}", file=sys.stderr)
        return 2

    output = build_output(args.archive_root)
    text = json.dumps(
        output, ensure_ascii=False, indent=2 if args.pretty else None, sort_keys=False
    )
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
        print(f"wrote {args.out}", file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
