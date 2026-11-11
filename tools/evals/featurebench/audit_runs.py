#!/usr/bin/env python3
"""EVAL-01 的 CI 数据一致性校验（AC-004 核心脚本）。

只读仓库里已提交的文件，**不联网、不调模型、不读 /tmp 原始 runs**，因此可以在
GitHub Actions 的 evals-check job 里跑；需要 pyyaml（与既有 sanity_check.py 一致）。

校验内容（对应 issue #12 AC-004 / AC-002 / AC-005 / AC-006 的机器可读部分）：

(a) 唯一性：canonical run 身份 (experiment, task_id, arm, repeat) 与 run_id 唯一，
    行数/分组数是预注册的固定值（96 = V1 85 + V2 10 + pilot 1）。
(b) 必填字段与类型；status 枚举；included/unscoreable/pilot 的互斥规则；
    attempts 与 matrix.json 口径的来源字段一致。
(c) 版本混用：每行的 runtime_group、dsh/plugin recorded 值必须等于该实验 manifest 的
    runtime；同实验内 actual 版本只能有一个值（或 mvp 的已知 null 缺口）；
    V1/V2/pilot 不允许交叉。
(d) image_digest 格式，且等于 manifest 里该 task 的官方镜像 digest；image tag 与
    runtime group 对应（V1: fb-eval-base:*；V2/pilot: fb-eval-base-061:*）。
(e) V1/V2 计数与分母对账：attempted / scoreable / resolved / unscoreable，
    pilot 排除理由，缺官方评分那条显式保留（status + exclusion_reason）。
(f) 已提交 105 条机读数据快照 → 96 行 canonical 的映射：多/缺都报告；10 条
    version-regression `old` 行必须是 duplicate_baseline；105 行里的数值与
    canonical 逐项一致（tokens/patch/耗时/官方成绩/泄漏计数）。
(g) leakage 命中不静默丢弃：runs.jsonl ↔ leak-audit.json 逐 run 计数一致、
    汇总一致、gold patch 比对覆盖全部 run；A/B 补丁同一性列表可复核。
    另校验 evidence-index（96 run、575 artifact、归档锚点）、env-identity
    （版本分组、时间窗、attempts 对账）与 verifier-confusion（54 次 B 运行）的内部一致性。

用法：
    python3 tools/evals/featurebench/audit_runs.py --check

退出码：0 = 全部通过（打印对账摘要）；1 = 有失败项（逐条打印）；2 = 输入缺失/不可解析。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve()
REPO_ROOT = HERE.parents[3]
DOCS = REPO_ROOT / "docs" / "evals"

RUNS = DOCS / "featurebench-runs.jsonl"
EVIDENCE = DOCS / "featurebench-evidence-index.json"
ENV_IDENTITY = DOCS / "featurebench-env-identity.json"
LEAK = DOCS / "featurebench-leak-audit.json"
VERIFIER = DOCS / "featurebench-verifier-confusion.json"

RUNTIME_GROUP_IDS = {
    "v1-0.6.0-0.2.1-rc.5",
    "v2-0.6.1-0.2.2-rc.1",
    "pilot",
}
STATUSES = {"included", "duplicate_baseline", "pilot", "unscoreable_missing_official_result"}
ARMS = {"standard", "standard_guidance", "sdlc", "sdlc_guidance"}
ARM_ORDER = {"standard": 0, "standard_guidance": 1, "sdlc": 2, "sdlc_guidance": 3}
A_ARMS = {"standard", "standard_guidance"}
B_ARMS = {"sdlc", "sdlc_guidance"}
VERDICTS = {"approve", "reject", "needs_human"}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
STARTED_AT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$")

DATASET = {
    "name": "LiberCoders/FeatureBench",
    "revision": "76b4a4566e04f4bcc13c35125d4f301791efa736",
    "split": "fast",
    "instances_in_split": 100,
    "grader": "featurebench==0.3.0",
}

EXPERIMENTS = {
    "mvp": {
        "group": "v1-0.6.0-0.2.1-rc.5",
        "manifest": "tools/evals/featurebench/manifest.yml",
        "counts": (10, 10, 8),
    },
    "2x2": {
        "group": "v1-0.6.0-0.2.1-rc.5",
        "manifest": "tools/evals/featurebench/manifests/2x2.yml",
        "counts": (20, 20, 15),
    },
    "expanded": {
        "group": "v1-0.6.0-0.2.1-rc.5",
        "manifest": "tools/evals/featurebench/manifests/expanded.yml",
        "counts": (24, 23, 17),
    },
    "verify-calibration": {
        "group": "v1-0.6.0-0.2.1-rc.5",
        "manifest": "tools/evals/featurebench/manifests/verify-calibration.yml",
        "counts": (10, 10, 8),
    },
    "verify-stress": {
        "group": "v1-0.6.0-0.2.1-rc.5",
        "manifest": "tools/evals/featurebench/manifests/verify-stress.yml",
        "counts": (3, 3, 1),
    },
    "repeat-sampling": {
        "group": "v1-0.6.0-0.2.1-rc.5",
        "manifest": "tools/evals/featurebench/manifests/repeat-sampling.yml",
        "counts": (18, 18, 12),
    },
    "version-regression-mvp": {
        "group": "v2-0.6.1-0.2.2-rc.1",
        "manifest": "tools/evals/featurebench/manifests/regression-0.6.1/mvp.yml",
        "counts": (10, 10, 7),
    },
    "pilot": {
        "group": "pilot",
        "manifest": "tools/evals/featurebench/manifests/regression-0.6.1/2x2.yml",
        "counts": (1, 1, 0),
    },
}
EXPERIMENT_ORDER = {name: i for i, name in enumerate(EXPERIMENTS)}

EXPECTED = {
    "canonical_runs": 96,
    "v1_runs": 85,
    "v2_runs": 10,
    "pilot_runs": 1,
    "runs_with_official": 95,
    "runs_missing_official": 1,
    "resolved_total": 68,
    "v1_attempted": 85,
    "v1_scoreable": 84,
    "v1_resolved": 61,
    "v2_scoreable": 10,
    "status_counts": {"included": 94, "pilot": 1,
                      "unscoreable_missing_official_result": 1},
    "snapshot_rows": 105,
    "snapshot_duplicates": 10,
    "canonical_without_snapshot": 1,
    "artifact_entries": 575,
    "b_runs": 54,
    "v1_b_runs": 49,
    "v2_b_runs": 5,
    "leak_runs_with_hits": 15,
    "leak_hits_total": 135,
    "gold_exact_matches": 0,
    "gold_normalized_matches": 0,
    "confusion": {
        "approve_resolved": 31,
        "approve_unresolved_false_positive": 8,
        "reject_resolved_false_negative": 3,
        "reject_unresolved": 1,
        "needs_human": 0,
        "no_verdict": 11,
        "official_missing": 0,
    },
    "unscoreable_run_id": (
        "expanded:mwaskom__seaborn.7001ebe7.test_regression.ce8c62e2.lv1:standard:r1"
    ),
    "pilot_run_id": (
        "pilot:pypa__packaging.013f3b03.test_metadata.e00b5801.lv1:standard:r1"
    ),
    # canonical 96 个身份只对应 95 次物理运行：pilot 与 V2 packaging/standard 是
    # 同一次运行（复用/落盘副本，artifact 与 session sha256 全同）。
    "distinct_physical_runs": 95,
    "cross_reference_run_ids": [
        "pilot:pypa__packaging.013f3b03.test_metadata.e00b5801.lv1:standard:r1",
        "version-regression-mvp:pypa__packaging.013f3b03.test_metadata.e00b5801.lv1:standard:r1",
    ],
}

SNAPSHOT_SPECS = [
    {
        "path": "docs/evals/featurebench-2026-11-06-data.json",
        "sections": [{"keys": ("runs",), "experiment": "mvp", "rows": 10,
                      "relation": "primary"}],
    },
    {
        "path": "docs/evals/featurebench-2026-11-07-2x2-data.json",
        "sections": [{"keys": ("report", "runs"), "experiment": "2x2", "rows": 20,
                      "relation": "primary"}],
    },
    {
        "path": "docs/evals/featurebench-2026-11-07-expanded-data.json",
        "sections": [{"keys": ("report", "runs"), "experiment": "expanded", "rows": 24,
                      "relation": "primary"}],
    },
    {
        "path": "docs/evals/featurebench-2026-11-07-verifier-data.json",
        "sections": [{"keys": ("report", "runs"), "experiment": "verify-calibration",
                      "rows": 10, "relation": "primary"}],
    },
    {
        "path": "docs/evals/featurebench-2026-11-07-verifier-stress-data.json",
        "sections": [{"keys": ("runs",), "experiment": "verify-stress", "rows": 3,
                      "relation": "primary", "repeat_from_row": True}],
    },
    {
        "path": "docs/evals/featurebench-2026-11-08-repeat-sampling-data.json",
        "sections": [{"keys": ("reps",), "experiment": "repeat-sampling", "rows": 18,
                      "relation": "primary", "reps": True}],
    },
    {
        "path": "docs/evals/featurebench-2026-11-08-version-regression-data.json",
        "sections": [
            {"keys": ("new", "runs"), "experiment": "version-regression-mvp", "rows": 10,
             "relation": "primary"},
            {"keys": ("old", "runs"), "experiment": "mvp", "rows": 10,
             "relation": "duplicate_baseline"},
        ],
    },
]

OFFICIAL_KEYS = ("resolved", "pass_rate", "resolved_rate", "errors",
                 "not_applied_empty", "report_sha256")
REQUIRED_FIELDS = (
    "run_id", "experiment", "manifest", "runtime_group", "task_id", "repo", "arm",
    "repeat", "started_at", "attempts", "attempts_source", "tokens", "tokens_source",
    "elapsed_seconds", "agent_completed", "agent_failure", "dsh_cli", "dsh_cli_actual",
    "plugin_version", "plugin_version_actual", "image", "image_digest", "patch_chars",
    "patch_sha256", "official", "status", "exclusion_reason", "leak_scan_hits",
    "sdlc_tool_calls", "verify_verdicts",
)


# --------------------------------------------------------------------------- 工具


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_json(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        raise SystemExit(f"无法解析 {p}: {e}")


def load_manifest(rel: str) -> dict:
    return yaml.safe_load((REPO_ROOT / rel).read_text(encoding="utf-8"))


def is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


class Checker:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.notes: list[str] = []

    def fail(self, msg: str) -> None:
        self.errors.append(msg)

    def note(self, msg: str) -> None:
        self.notes.append(msg)


# --------------------------------------------------------------------------- 载入


def load_runs() -> list[dict]:
    if not RUNS.exists():
        raise SystemExit(f"缺少 {RUNS.relative_to(REPO_ROOT)}；先运行 collect_runs.py")
    rows = []
    for i, line in enumerate(RUNS.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except Exception as e:  # noqa: BLE001
            raise SystemExit(f"runs.jsonl 第 {i} 行不是合法 JSON: {e}")
    return rows


def load_snapshots() -> list[dict]:
    """展开 105 条机读数据快照行（结构同 collect_runs.py，但独立实现以便交叉校验）。"""
    out = []
    for spec in SNAPSHOT_SPECS:
        d = load_json(REPO_ROOT / spec["path"])
        for section in spec["sections"]:
            node = d
            for k in section["keys"]:
                node = node[k]
            if section.get("reps"):
                flattened = []
                for idx, rep in enumerate(node, start=1):
                    for row in rep.get("runs") or []:
                        flattened.append((idx, row))
            else:
                flattened = [(None, row) for row in node]
            for rep_idx, row in flattened:
                repeat = (
                    int(row.get("repeat") or 1) if section.get("repeat_from_row")
                    else (rep_idx or 1)
                )
                out.append(
                    {
                        "snapshot": Path(spec["path"]).name,
                        "section": ".".join(section["keys"]),
                        "experiment": section["experiment"],
                        "repeat": repeat,
                        "relation": section["relation"],
                        "row": row,
                    }
                )
    return out


# --------------------------------------------------------------------------- (a)(b)


def check_unique_and_fields(rows: list[dict], ck: Checker) -> None:
    if len(rows) != EXPECTED["canonical_runs"]:
        ck.fail(f"canonical run 行数 {len(rows)} != {EXPECTED['canonical_runs']}")
    seen_key = {}
    seen_rid = {}
    for i, r in enumerate(rows, start=1):
        tag = f"第 {i} 行"
        missing = [f for f in REQUIRED_FIELDS if f not in r]
        if missing:
            ck.fail(f"{tag} 缺字段: {missing}")
            continue
        key = (r["experiment"], r["task_id"], r["arm"], r["repeat"])
        if key in seen_key:
            ck.fail(f"run 身份重复: {key}（{seen_key[key]} / {tag}）")
        seen_key[key] = tag
        if r["run_id"] in seen_rid:
            ck.fail(f"run_id 重复: {r['run_id']}")
        seen_rid[r["run_id"]] = tag
        rid = r["run_id"]
        if not isinstance(r["experiment"], str) or r["experiment"] not in EXPERIMENTS:
            ck.fail(f"{rid}: experiment 非法 {r['experiment']!r}")
        if not isinstance(r["runtime_group"], str) or r["runtime_group"] not in RUNTIME_GROUP_IDS:
            ck.fail(f"{rid}: runtime_group 非法 {r['runtime_group']!r}")
        if not isinstance(r["task_id"], str) or r["task_id"].count(".") < 3:
            ck.fail(f"{rid}: task_id 形态异常 {r['task_id']!r}")
        if r["arm"] not in ARMS:
            ck.fail(f"{rid}: 未知 arm {r['arm']!r}")
        if not is_int(r["repeat"]) or r["repeat"] < 1:
            ck.fail(f"{rid}: repeat 必须是 >=1 的整数")
        if not isinstance(r["started_at"], str) or not STARTED_AT_RE.match(r["started_at"]):
            ck.fail(f"{rid}: started_at 不是 YYYY-MM-DDTHH:MM:SS: {r['started_at']!r}")
        if not isinstance(r["repo"], str) or "/" not in r["repo"]:
            ck.fail(f"{rid}: repo 形态异常")
        # attempts / tokens 口径
        if r["attempts"] is not None:
            if not is_int(r["attempts"]) or r["attempts"] < 1:
                ck.fail(f"{rid}: attempts 必须是 null 或 >=1 的整数")
            if r["attempts_source"] != "matrix.json":
                ck.fail(f"{rid}: attempts 非 null 时 attempts_source 必须是 matrix.json")
        elif r["attempts_source"] is not None:
            ck.fail(f"{rid}: attempts 为 null 时 attempts_source 必须为 null")
        if r["tokens"] is not None:
            if not is_int(r["tokens"]) or r["tokens"] < 0:
                ck.fail(f"{rid}: tokens 非法 {r['tokens']!r}")
            if r["tokens_source"] not in ("ui", "session"):
                ck.fail(f"{rid}: tokens_source 必须是 ui/session")
        elif r["tokens_source"] is not None:
            ck.fail(f"{rid}: tokens 为 null 时 tokens_source 必须为 null")
        if r["elapsed_seconds"] is not None and (
            not is_int(r["elapsed_seconds"]) or r["elapsed_seconds"] < 0
        ):
            ck.fail(f"{rid}: elapsed_seconds 非法")
        if not isinstance(r["agent_completed"], bool):
            ck.fail(f"{rid}: agent_completed 必须是 bool")
        if r["agent_failure"] is not None and not isinstance(r["agent_failure"], str):
            ck.fail(f"{rid}: agent_failure 必须是 null 或字符串")
        if not is_int(r["patch_chars"]) or r["patch_chars"] < 0:
            ck.fail(f"{rid}: patch_chars 非法")
        if not isinstance(r["patch_sha256"], str) or not SHA256_RE.match(r["patch_sha256"]):
            ck.fail(f"{rid}: patch_sha256 不是 64 位 hex")
        if not is_int(r["leak_scan_hits"]) or r["leak_scan_hits"] < 0:
            ck.fail(f"{rid}: leak_scan_hits 必须是 >=0 的整数")
        if not isinstance(r["sdlc_tool_calls"], dict) or not all(
            isinstance(k, str) and is_int(v) for k, v in r["sdlc_tool_calls"].items()
        ):
            ck.fail(f"{rid}: sdlc_tool_calls 必须是 str->int 字典")
        if not isinstance(r["verify_verdicts"], list) or not all(
            v in VERDICTS for v in r["verify_verdicts"]
        ):
            ck.fail(f"{rid}: verify_verdicts 必须是 approve/reject/needs_human 列表")
        if r["status"] not in STATUSES:
            ck.fail(f"{rid}: status 非法 {r['status']!r}")
        if r["status"] == "included":
            if r["official"] is None:
                ck.fail(f"{rid}: included 但 official 为 null")
            if r["exclusion_reason"] is not None:
                ck.fail(f"{rid}: included 不应有 exclusion_reason")
        else:
            if not isinstance(r["exclusion_reason"], str) or not r["exclusion_reason"]:
                ck.fail(f"{rid}: status={r['status']} 必须写 exclusion_reason")
        if r["status"] == "pilot" and r["experiment"] != "pilot":
            ck.fail(f"{rid}: 只有 experiment=pilot 可以是 status=pilot")
        if r["status"] == "duplicate_baseline":
            ck.fail(f"{rid}: canonical 表不应出现 duplicate_baseline 行（old 10 行只进映射）")
        off = r["official"]
        if off is not None:
            if not isinstance(off, dict) or set(off) != set(OFFICIAL_KEYS):
                ck.fail(f"{rid}: official 字段集必须恰好是 {OFFICIAL_KEYS}")
            else:
                if not isinstance(off["resolved"], bool):
                    ck.fail(f"{rid}: official.resolved 必须是 bool")
                for k in ("pass_rate", "resolved_rate"):
                    if off[k] is not None and not isinstance(off[k], (int, float)):
                        ck.fail(f"{rid}: official.{k} 必须是数字或 null")
                for k in ("errors", "not_applied_empty"):
                    if not is_int(off[k]):
                        ck.fail(f"{rid}: official.{k} 必须是整数")
                if not isinstance(off["report_sha256"], str) or not SHA256_RE.match(
                    off["report_sha256"]
                ):
                    ck.fail(f"{rid}: official.report_sha256 不是 64 位 hex")
    # status 计数是预注册的固定值
    counts = {s: sum(1 for r in rows if r["status"] == s) for s in STATUSES}
    for s, want in EXPECTED["status_counts"].items():
        if counts.get(s, 0) != want:
            ck.fail(f"status 计数 {s}={counts.get(s, 0)} != 预注册 {want}")
    ck.note(f"status 计数: {counts}")
    # (a2) 行序必须确定（与 collect_runs.py 的排序一致），保证重跑逐字节一致
    order = [
        (EXPERIMENT_ORDER[r["experiment"]], r["task_id"], ARM_ORDER[r["arm"]], r["repeat"])
        for r in rows
    ]
    if order != sorted(order):
        ck.fail("runs.jsonl 行序不是确定性排序（experiment/task/arm/repeat）")
    if RUNS.read_bytes()[-1:] != b"\n":
        ck.fail("runs.jsonl 末尾缺少换行")


# --------------------------------------------------------------------------- (c)(d)


def check_versions_and_images(rows: list[dict], ck: Checker) -> None:
    manifests = {}
    for exp, cfg in EXPERIMENTS.items():
        manifests[exp] = load_manifest(cfg["manifest"])
    for exp, cfg in EXPERIMENTS.items():
        runtime = manifests[exp]["runtime"]
        want_dsh = runtime["dsh_cli"]
        want_plug = runtime["plugin_version"]
        # 同实验内 actual 版本集合（null 只允许出现在 mvp 的首批 10 条）
        actual_dsh = set()
        actual_plug = set()
        for r in rows:
            if r["experiment"] != exp:
                continue
            rid = r["run_id"]
            gkey = f"{exp}/{r['task_id']}"
            if r["manifest"] != cfg["manifest"]:
                ck.fail(f"{rid}: manifest {r['manifest']!r} != {cfg['manifest']}")
            if r["runtime_group"] != cfg["group"]:
                ck.fail(f"{rid}: runtime_group {r['runtime_group']!r} != {cfg['group']}")
            if r["dsh_cli"] != want_dsh:
                ck.fail(f"{rid}: dsh_cli {r['dsh_cli']!r} != manifest {want_dsh!r}")
            if r["plugin_version"] != want_plug:
                ck.fail(
                    f"{rid}: plugin_version {r['plugin_version']!r} != manifest {want_plug!r}"
                )
            if r["dsh_cli_actual"] is not None and r["dsh_cli_actual"] != want_dsh:
                ck.fail(f"{rid}: dsh_cli_actual 与 manifest 不一致: {r['dsh_cli_actual']!r}")
            if r["plugin_version_actual"] is not None and (
                r["plugin_version_actual"] != want_plug
            ):
                ck.fail(
                    f"{rid}: plugin_version_actual 与 manifest 不一致: "
                    f"{r['plugin_version_actual']!r}"
                )
            actual_dsh.add(r["dsh_cli_actual"])
            actual_plug.add(r["plugin_version_actual"])
            # (d) 镜像 digest 与 manifest
            task = next((t for t in manifests[exp]["tasks"] if t["id"] == r["task_id"]), None)
            if task is None:
                ck.fail(f"{rid}: task 不在实验 manifest 里")
            else:
                if not IMAGE_DIGEST_RE.match(str(r["image_digest"])):
                    ck.fail(f"{rid}: image_digest 格式非法 {r['image_digest']!r}")
                elif r["image_digest"] != task["image_digest"]:
                    ck.fail(
                        f"{rid}: image_digest 与 manifest 不一致 "
                        f"({r['image_digest']} != {task['image_digest']})"
                    )
                if not isinstance(r["image"], str) or not r["image"]:
                    ck.fail(f"{rid}: image 为空")
            # image tag 与 runtime group 对应
            if cfg["group"].startswith("v1-") and not r["image"].startswith("fb-eval-base:"):
                ck.fail(f"{rid}: V1 的派生镜像 tag 应为 fb-eval-base:*，实际 {r['image']!r}")
            if not cfg["group"].startswith("v1-") and not r["image"].startswith(
                "fb-eval-base-061:"
            ):
                ck.fail(f"{rid}: V2/pilot 的派生镜像 tag 应为 fb-eval-base-061:*，"
                        f"实际 {r['image']!r}")
        null_actual = {None} & actual_dsh
        if null_actual and exp != "mvp":
            ck.fail(f"{exp}: 只有 mvp 允许 dsh_cli_actual 为 null（已知缺口），"
                    f"实际 {sorted(actual_dsh, key=str)}")
        non_null = {v for v in actual_dsh if v is not None}
        if len(non_null) > 1:
            ck.fail(f"{exp}: 同实验内 dsh_cli_actual 混用: {sorted(non_null)}")
        non_null = {v for v in actual_plug if v is not None}
        if len(non_null) > 1:
            ck.fail(f"{exp}: 同实验内 plugin_version_actual 混用: {sorted(non_null)}")
    # 跨 group 不允许混用：用 runtime_group 字段把 V1/V2/pilot 分开后，行内版本必须配组
    for r in rows:
        rid = r["run_id"]
        if r["runtime_group"].startswith("v1-"):
            if r["plugin_version"] != "0.6.0" or r["dsh_cli"] != "0.2.1-rc.5":
                ck.fail(f"{rid}: V1 runtime_group 与版本记录不符")
        elif r["runtime_group"].startswith("v2-") or r["runtime_group"] == "pilot":
            if r["plugin_version"] != "0.6.1" or r["dsh_cli"] != "0.2.2-rc.1":
                ck.fail(f"{rid}: V2/pilot runtime_group 与版本记录不符")


# --------------------------------------------------------------------------- (e)


def check_denominators(rows: list[dict], ck: Checker) -> dict:
    per_exp = {}
    for exp, cfg in EXPERIMENTS.items():
        rs = [r for r in rows if r["experiment"] == exp]
        attempted = len(rs)
        scoreable = sum(1 for r in rs if r["official"] is not None)
        resolved = sum(1 for r in rs if r["official"] and r["official"]["resolved"])
        want = cfg["counts"]
        if (attempted, scoreable, resolved) != want:
            ck.fail(
                f"{exp}: (attempted, scoreable, resolved)="
                f"{(attempted, scoreable, resolved)} != 预注册 {want}"
            )
        per_exp[exp] = {
            "attempted": attempted,
            "scoreable": scoreable,
            "resolved": resolved,
            "itt_rate": (resolved / attempted) if attempted else None,
            "scoreable_rate": (resolved / scoreable) if scoreable else None,
        }
    v1 = [r for r in rows if r["runtime_group"].startswith("v1-")]
    v2 = [r for r in rows if r["runtime_group"].startswith("v2-")]
    pilot = [r for r in rows if r["status"] == "pilot"]
    totals = {
        "v1_attempted": len(v1),
        "v1_scoreable": sum(1 for r in v1 if r["official"] is not None),
        "v1_resolved": sum(1 for r in v1 if r["official"] and r["official"]["resolved"]),
        "v2_attempted": len(v2),
        "v2_scoreable": sum(1 for r in v2 if r["official"] is not None),
        "v2_resolved": sum(1 for r in v2 if r["official"] and r["official"]["resolved"]),
        "pilot_attempted": len(pilot),
        "resolved_total": sum(1 for r in rows if r["official"] and r["official"]["resolved"]),
        "official_reports": sum(1 for r in rows if r["official"] is not None),
    }
    for k in ("v1_attempted", "v1_scoreable", "v1_resolved", "v2_scoreable",
              "resolved_total", "official_reports"):
        want = {"v1_attempted": EXPECTED["v1_attempted"],
                "v1_scoreable": EXPECTED["v1_scoreable"],
                "v1_resolved": EXPECTED["v1_resolved"],
                "v2_scoreable": EXPECTED["v2_scoreable"],
                "resolved_total": EXPECTED["resolved_total"],
                "official_reports": EXPECTED["runs_with_official"]}[k]
        if totals[k] != want:
            ck.fail(f"{k}={totals[k]} != 预注册 {want}")
    # pilot 排除理由：不进 V1/V2、必须写明理由
    if len(pilot) != EXPECTED["pilot_runs"]:
        ck.fail(f"pilot 行数 {len(pilot)} != {EXPECTED['pilot_runs']}")
    for r in pilot:
        if r["runtime_group"] != "pilot":
            ck.fail(f"{r['run_id']}: pilot 行 runtime_group 必须是 pilot")
        if "pilot" not in (r["exclusion_reason"] or ""):
            ck.fail(f"{r['run_id']}: pilot exclusion_reason 未说明 pilot 排除理由")
    # 缺官方评分那条必须显式保留（不能静默删除），且原因写明
    unscoreable = [r for r in rows if r["official"] is None]
    if [r["run_id"] for r in unscoreable] != [EXPECTED["unscoreable_run_id"]]:
        ck.fail(
            f"缺官方评分的行应恰好是 {EXPECTED['unscoreable_run_id']}，"
            f"实际 {[r['run_id'] for r in unscoreable]}"
        )
    for r in unscoreable:
        if r["status"] != "unscoreable_missing_official_result":
            ck.fail(f"{r['run_id']}: 缺官方评分但 status={r['status']}")
        reason = r["exclusion_reason"] or ""
        if "HF" not in reason and "revision" not in reason:
            ck.fail(f"{r['run_id']}: 缺官方评分原因未写明（应提到 HF revision 解析失败）")
    per_exp["_totals"] = totals
    return per_exp


# --------------------------------------------------------------------------- (f)


def check_snapshot_mapping(rows: list[dict], ck: Checker) -> dict:
    snaps = load_snapshots()
    if len(snaps) != EXPECTED["snapshot_rows"]:
        ck.fail(f"机读数据快照行数 {len(snaps)} != {EXPECTED['snapshot_rows']}")
    by_file: dict = {}
    for s in snaps:
        by_file[s["snapshot"]] = by_file.get(s["snapshot"], 0) + 1
    for spec in SNAPSHOT_SPECS:
        want = sum(s["rows"] for s in spec["sections"])
        got = by_file.get(Path(spec["path"]).name, 0)
        if got != want:
            ck.fail(f"快照 {Path(spec['path']).name} 行数 {got} != 预注册 {want}")
    idx = {(r["experiment"], r["task_id"], r["arm"], r["repeat"]): r for r in rows}
    refs: dict = {}
    unmatched = []
    numeric_mismatch = []
    relation_counts = {"primary": 0, "duplicate_baseline": 0}
    match_fields = ("tokens", "tokens_source", "patch_chars", "elapsed_seconds",
                    "agent_completed", "agent_failure")
    for s in snaps:
        row = s["row"]
        key = (s["experiment"], row["task_id"], row["arm"], s["repeat"])
        c = idx.get(key)
        if c is None:
            unmatched.append((s["snapshot"], s["section"], key))
            continue
        refs.setdefault(key, []).append((s["snapshot"], s["section"], s["relation"]))
        relation_counts[s["relation"]] = relation_counts.get(s["relation"], 0) + 1
        for f in match_fields:
            if row.get(f) != c.get(f):
                numeric_mismatch.append(
                    (s["snapshot"], c["run_id"], f, row.get(f), c.get(f))
                )
        off = c["official"]
        for f in ("resolved", "pass_rate", "resolved_rate", "errors", "not_applied_empty"):
            if f in row:
                want = off[f] if off else None
                if row[f] != want:
                    numeric_mismatch.append(
                        (s["snapshot"], c["run_id"], f, row[f], want)
                    )
        if "leak_scan_hits" in row:
            if len(row["leak_scan_hits"]) != c["leak_scan_hits"]:
                numeric_mismatch.append(
                    (s["snapshot"], c["run_id"], "leak_scan_hits",
                     len(row["leak_scan_hits"]), c["leak_scan_hits"])
                )
    if unmatched:
        ck.fail(f"有 {len(unmatched)} 条快照行找不到 canonical run: {unmatched[:5]}")
    dup_rows = [k for k, v in refs.items() if len(v) > 1]
    dup_count = sum(len(v) - 1 for v in refs.values())
    if dup_count != EXPECTED["snapshot_duplicates"]:
        ck.fail(f"重复映射行数 {dup_count} != 预注册 {EXPECTED['snapshot_duplicates']}")
    for k in dup_rows:
        relations = [rel for _, _, rel in refs[k]]
        if relations.count("duplicate_baseline") != 1 or relations.count("primary") != 1:
            ck.fail(f"{k}: 重复映射关系异常 {relations}")
        if k[0] != "mvp":
            ck.fail(f"{k}: duplicate_baseline 只允许复用 mvp 首批数据")
    missing = [k for k in idx if k not in refs]
    if len(missing) != EXPECTED["canonical_without_snapshot"]:
        ck.fail(f"未被快照引用的 canonical 行数 {len(missing)} != "
                f"{EXPECTED['canonical_without_snapshot']}: {missing[:5]}")
    for k in missing:
        if idx[k]["run_id"] != EXPECTED["pilot_run_id"]:
            ck.fail(f"{idx[k]['run_id']}: 只有 pilot 可以没有已提交快照行")
    if numeric_mismatch:
        for m in numeric_mismatch[:10]:
            ck.fail(f"快照与 canonical 数值不一致: {m}")
        if len(numeric_mismatch) > 10:
            ck.fail(f"... 另有 {len(numeric_mismatch) - 10} 条数值不一致")
    # evidence-index 里记录的 snapshot sha256 / rows 必须与当前文件一致（数据变更显式失败）
    ev = load_json(EVIDENCE)
    ev_snaps = {s["path"]: s for s in ev["sources"]["snapshots"]}
    for spec in SNAPSHOT_SPECS:
        rel = spec["path"]
        p = REPO_ROOT / rel
        want_sha = sha256_file(p)
        got = ev_snaps.get(rel)
        if got is None:
            ck.fail(f"evidence-index 缺快照 {rel}")
        elif got["sha256"] != want_sha:
            ck.fail(f"evidence-index 中 {rel} 的 sha256 过期（数据快照被改过）")
        want_rows = sum(s["rows"] for s in spec["sections"])
        if got is not None and got.get("rows") != want_rows:
            ck.fail(f"evidence-index 中 {rel} 行数 {got.get('rows')} != {want_rows}")
    return {
        "snapshot_rows": len(snaps),
        "mapped_unique_runs": len(refs),
        "duplicate_rows": dup_count,
        "canonical_without_snapshot": len(missing),
        "relations": relation_counts,
        "numeric_mismatches": len(numeric_mismatch),
    }


# --------------------------------------------------------------------------- (g)


def check_evidence(rows: list[dict], ck: Checker) -> dict:
    ev = load_json(EVIDENCE)
    counts = ev["counts"]
    if counts["canonical_runs"] != EXPECTED["canonical_runs"]:
        ck.fail(f"evidence-index canonical_runs={counts['canonical_runs']}")
    if counts["v1_runs"] != EXPECTED["v1_runs"] or counts["v2_runs"] != EXPECTED["v2_runs"]:
        ck.fail("evidence-index V1/V2 行数不对")
    if counts["pilot_runs"] != EXPECTED["pilot_runs"]:
        ck.fail("evidence-index pilot 行数不对")
    if counts["runs_with_official"] != EXPECTED["runs_with_official"]:
        ck.fail("evidence-index runs_with_official 不对")
    if counts["artifact_entries"] != EXPECTED["artifact_entries"]:
        ck.fail(f"artifact 条目数 {counts['artifact_entries']} != "
                f"{EXPECTED['artifact_entries']}")
    if counts["archive_artifact_mismatches"] != 0:
        ck.fail(f"archive artifact mismatch {counts['archive_artifact_mismatches']} != 0")
    if counts["archive_artifact_not_in_sums"] != 0:
        ck.fail(f"有 {counts['archive_artifact_not_in_sums']} 个 artifact 不在归档 SHA256SUMS")
    if counts.get("distinct_physical_runs") != EXPECTED["distinct_physical_runs"]:
        ck.fail(f"distinct_physical_runs={counts.get('distinct_physical_runs')} != "
                f"{EXPECTED['distinct_physical_runs']}（pilot 与 V2 复用同一次运行）")
    cross = ev.get("cross_references") or []
    want_ids = sorted(EXPECTED["cross_reference_run_ids"])
    if len(cross) != 1 or sorted(cross[0].get("run_ids") or []) != want_ids:
        ck.fail(f"evidence-index.cross_references 应恰好记录 pilot↔V2 复用一次，实际 {cross}")
    else:
        ids = cross[0]["run_ids"]
        ev_by_id = {r["run_id"]: r for r in ev["runs"]}
        ref_meta = {
            rid: (ev_by_id.get(rid, {}).get("artifacts", {}).get("meta.json", {}).get("sha256"))
            for rid in ids
        }
        if len(set(ref_meta.values())) != 1 or None in ref_meta.values():
            ck.fail(f"cross_references 指向的两行 meta.json 证据不相同: {ref_meta}")
        ref_patch = {
            rid: (ev_by_id.get(rid, {}).get("artifacts", {}).get("patch.diff", {}).get("sha256"))
            for rid in ids
        }
        if len(set(ref_patch.values())) != 1:
            ck.fail(f"cross_references 指向的两行 patch.diff 证据不相同: {ref_patch}")
    archive = ev["sources"]["archive"]
    anchor = archive.get("sha256sums_sha256")
    if not isinstance(anchor, str) or not SHA256_RE.match(anchor):
        ck.fail("evidence-index 缺归档 SHA256SUMS 的 sha256 锚点")
    if not archive.get("sha256sums_entries"):
        ck.fail("evidence-index 缺归档 SHA256SUMS 条目数")
    ev_runs = {r["run_id"]: r for r in ev["runs"]}
    if set(ev_runs) != {r["run_id"] for r in rows}:
        ck.fail("evidence-index 的 run 集合与 runs.jsonl 不一致")
    required_artifacts = {"meta.json", "patch.diff", "leak_scan.txt", "eval.log"}
    for r in rows:
        e = ev_runs.get(r["run_id"])
        if e is None:
            continue
        arts = e["artifacts"]
        missing = required_artifacts - set(arts)
        if missing:
            ck.fail(f"{r['run_id']}: evidence-index 缺 artifacts {sorted(missing)}")
        for a in arts.values():
            if not SHA256_RE.match(a["sha256"]):
                ck.fail(f"{r['run_id']}: artifact sha256 非法")
        if "predictions.jsonl" not in arts:
            ck.fail(f"{r['run_id']}: 缺 predictions.jsonl 的 hash 证据")
        if r["official"] is not None:
            if "eval_report" not in arts:
                ck.fail(f"{r['run_id']}: 有官方评分但 evidence-index 缺 eval_report")
            else:
                if arts["eval_report"]["sha256"] != r["official"]["report_sha256"]:
                    ck.fail(f"{r['run_id']}: official.report_sha256 与 evidence-index 不一致")
        elif "eval_report" in arts:
            ck.fail(f"{r['run_id']}: 无官方评分但 evidence-index 记录了 eval_report")
    # 归档锚点必须在各 artifact 的 archive_check 中体现（true 或 null 都允许，null 已由上面拦截）
    return {
        "runs": len(ev_runs),
        "artifacts": counts["artifact_entries"],
        "distinct_physical_runs": counts.get("distinct_physical_runs"),
        "archive_sha256sums_sha256": anchor,
        "archive_entries": archive.get("sha256sums_entries"),
        "archive_mismatches": counts["archive_artifact_mismatches"],
    }


def check_leak(rows: list[dict], ck: Checker) -> dict:
    la = load_json(LEAK)
    per_run = {r["run_id"]: r for r in la["per_run"]}
    if set(per_run) != {r["run_id"] for r in rows}:
        ck.fail("leak-audit.per_run 的 run 集合与 runs.jsonl 不一致")
    # isolation check 未完成/失败是硬失败：不能用「没有泄漏命中」掩盖「没做隔离检查」。
    isolation_missing = la.get("totals", {}).get("isolation_check_missing_or_failed") or []
    if isolation_missing:
        ck.fail(f"leak-audit: {len(isolation_missing)} 个 run 的 isolation check 未完成: "
                f"{isolation_missing[:5]}")
    if la.get("totals", {}).get("leak_scan_txt_mismatches"):
        ck.fail("leak-audit: totals.leak_scan_txt_mismatches 非空")
    for item in per_run.values():
        if item.get("isolation_check_done") is not True:
            ck.fail(f"{item.get('run_id')}: isolation check 未完成（isolation_check_done != true）")
    recomputed_hits = 0
    hits_runs = 0
    for r in rows:
        item = per_run.get(r["run_id"])
        if item is None:
            continue
        if item["leak_scan_hits"] != r["leak_scan_hits"]:
            ck.fail(f"{r['run_id']}: leak-audit 计数 {item['leak_scan_hits']} != "
                    f"runs.jsonl {r['leak_scan_hits']}")
        if item["experiment"] != r["experiment"] or item["task_id"] != r["task_id"]:
            ck.fail(f"{r['run_id']}: leak-audit 身份字段不一致")
        if item["leak_scan_txt_consistent"] is False:
            ck.fail(f"{r['run_id']}: leak_scan.txt 与 meta.leak_scan_hits 不一致")
        if item.get("official_resolved") is not None:
            ck.fail(f"{r['run_id']}: leak-audit 不应记录官方成绩字段")
        recomputed_hits += item["leak_scan_hits"]
        if item["leak_scan_hits"]:
            hits_runs += 1
    totals = la["totals"]
    if totals["runs"] != EXPECTED["canonical_runs"]:
        ck.fail("leak-audit.totals.runs 不对")
    if totals["runs_with_hits"] != hits_runs:
        ck.fail(f"leak-audit.runs_with_hits {totals['runs_with_hits']} != 重算 {hits_runs}")
    if totals["hits_total"] != recomputed_hits:
        ck.fail(f"leak-audit.hits_total {totals['hits_total']} != 重算 {recomputed_hits}")
    if totals["runs_with_hits"] != EXPECTED["leak_runs_with_hits"]:
        ck.fail(f"泄漏命中 run 数 {totals['runs_with_hits']} != "
                f"{EXPECTED['leak_runs_with_hits']}")
    if totals["hits_total"] != EXPECTED["leak_hits_total"]:
        ck.fail(f"泄漏命中总数 {totals['hits_total']} != {EXPECTED['leak_hits_total']}")
    if totals["leak_scan_txt_mismatches"]:
        ck.fail(f"leak_scan.txt 与 meta 不一致 {len(totals['leak_scan_txt_mismatches'])} 条")
    # 逐镜像/任务汇总必须能由 per_run 重算
    by_image = {}
    for r in rows:
        img = by_image.setdefault(r["repo"], {"runs": 0, "runs_with_hits": 0,
                                              "hits_total": 0, "hit_paths": set()})
        img["runs"] += 1
        item = per_run.get(r["run_id"])
        if item is None:
            continue
        img["runs_with_hits"] += 1 if item["leak_scan_hits"] else 0
        img["hits_total"] += item["leak_scan_hits"]
        img["hit_paths"].update(item["hit_paths"])
    for repo, got in by_image.items():
        reported = la["by_image"].get(repo)
        if reported is None:
            ck.fail(f"leak-audit 缺镜像 {repo} 汇总")
            continue
        for f in ("runs", "runs_with_hits", "hits_total"):
            if reported[f] != got[f]:
                ck.fail(f"leak-audit.by_image[{repo}].{f} {reported[f]} != 重算 {got[f]}")
        if sorted(reported["hit_paths"]) != sorted(got["hit_paths"]):
            ck.fail(f"leak-audit.by_image[{repo}].hit_paths 与 per_run 不一致")
    # 逐任务/arm 汇总必须能由 per_run 重算
    by_task: dict = {}
    for r in rows:
        item = per_run.get(r["run_id"])
        t = by_task.setdefault(r["task_id"], {"runs": 0, "runs_with_hits": 0, "hits_total": 0,
                                              "by_arm": {}})
        a = t["by_arm"].setdefault(r["arm"], {"runs": 0, "runs_with_hits": 0, "hits_total": 0})
        t["runs"] += 1
        a["runs"] += 1
        if item is not None and item["leak_scan_hits"]:
            t["runs_with_hits"] += 1
            a["runs_with_hits"] += 1
        if item is not None:
            t["hits_total"] += item["leak_scan_hits"]
            a["hits_total"] += item["leak_scan_hits"]
    reported_tasks = {t["task_id"]: t for t in la["by_task"]}
    for task_id, got in by_task.items():
        rep = reported_tasks.get(task_id)
        if rep is None:
            ck.fail(f"leak-audit.by_task 缺 task {task_id}")
            continue
        for f in ("runs", "runs_with_hits", "hits_total"):
            if rep[f] != got[f]:
                ck.fail(f"leak-audit.by_task[{task_id}].{f} {rep[f]} != 重算 {got[f]}")
        for arm, ga in got["by_arm"].items():
            ra = (rep.get("by_arm") or {}).get(arm)
            if ra is None:
                ck.fail(f"leak-audit.by_task[{task_id}].by_arm 缺 {arm}")
                continue
            for f in ("runs", "runs_with_hits", "hits_total"):
                if ra[f] != ga[f]:
                    ck.fail(
                        f"leak-audit.by_task[{task_id}].by_arm[{arm}].{f} "
                        f"{ra[f]} != 重算 {ga[f]}"
                    )
    # gold patch 比对：覆盖全部 run，且所有 run 都显式给出 equals_gold_patch
    gold = la["gold_comparison"]
    if not gold["available"]:
        ck.fail("gold_comparison.available=false（正式产物必须用带 pyarrow 的 python 生成）")
    tasks_with_gold = set(gold["per_task_gold_sha256"])
    for r in rows:
        if r["task_id"] not in tasks_with_gold:
            ck.fail(f"{r['run_id']}: gold patch 表缺 task")
        if r["task_id"] in tasks_with_gold:
            g = gold["per_task_gold_sha256"][r["task_id"]]["sha256"]
            if r["patch_sha256"] == g:
                ck.fail(f"{r['run_id']}: patch 与 gold 逐字节相同（泄漏信号）")
        item = per_run.get(r["run_id"])
        if item is not None and item.get("equals_gold_patch") is not False:
            ck.fail(f"{r['run_id']}: gold 比对结果必须是显式 false（不是 missing）")
    if gold["exact_sha256_matches"] != EXPECTED["gold_exact_matches"]:
        ck.fail(f"gold exact matches {gold['exact_sha256_matches']} != "
                f"{EXPECTED['gold_exact_matches']}")
    if gold["normalized_sha256_matches"] != EXPECTED["gold_normalized_matches"]:
        ck.fail(f"gold normalized matches {gold['normalized_sha256_matches']} != "
                f"{EXPECTED['gold_normalized_matches']}")
    # A/B 补丁同一性：列表里的 sha 必须真的在两臂 patch_sha256 里
    ident = la["identical_cross_arm_patches"]
    if not isinstance(ident["primary_ab_pairs"], list):
        ck.fail("identical_cross_arm_patches.primary_ab_pairs 必须是列表")
    else:
        for p in ident["primary_ab_pairs"]:
            ra = next(
                (r for r in rows if r["experiment"] == p["experiment"]
                 and r["task_id"] == p["task_id"] and r["repeat"] == p["repeat"]
                 and r["arm"] == p["arm_a"]), None)
            rb = next(
                (r for r in rows if r["experiment"] == p["experiment"]
                 and r["task_id"] == p["task_id"] and r["repeat"] == p["repeat"]
                 and r["arm"] == p["arm_b"]), None)
            if ra is None or rb is None:
                ck.fail(f"补丁同一性记录指向不存在的 run: {p}")
            elif ra["patch_sha256"] != rb["patch_sha256"] or ra["patch_sha256"] != p["patch_sha256"]:
                ck.fail(f"补丁同一性记录与 runs.jsonl 不符: {p}")
    # 敏感性分析：主表必须只含 V1；V2 不能混进 V1 对象
    sens = la["packaging_sensitivity"]
    v1s = sens.get("v1", {})
    v2s = sens.get("v2", {})
    if not v1s or not v2s:
        ck.fail("packaging_sensitivity 必须分别给 v1 / v2 子对象")
    else:
        if v1s["all_pairs"]["pairs_attempted"] != 31 or \
                v1s["all_pairs"]["pairs_scoreable"] != 30:
            ck.fail("packaging_sensitivity.v1 主表分母应为 31 attempted / 30 scoreable")
        if v2s["all_pairs"]["pairs_attempted"] != 5:
            ck.fail("packaging_sensitivity.v2 应为 5 个 pair（不与 V1 合并）")
        wp = v1s["packaging_pairs"]
        if wp["pairs_attempted"] != 5:
            ck.fail("packaging_sensitivity.v1.packaging_pairs 应为 5")
        if wp["paired_wlt"]["b_wins"] - wp["paired_wlt"]["a_wins"] != 1:
            ck.fail("packaging 敏感性结论异常：V1 packaging 净差应为 +1")
        np_ = v1s["non_packaging_pairs"]
        if np_["net_b_minus_a_scoreable"] != 0:
            ck.fail("packaging 敏感性结论异常：V1 不含 packaging 的 scoreable 净差应为 0")
    return {
        "runs_with_hits": totals["runs_with_hits"],
        "hits_total": totals["hits_total"],
        "repos_with_hits": sorted(k for k, v in la["by_image"].items() if v["runs_with_hits"]),
        "gold_exact_matches": gold["exact_sha256_matches"],
        "normalized_matches": gold["normalized_sha256_matches"],
        "identical_ab_pairs": len(ident["primary_ab_pairs"]),
        "identical_all_pairs": len(ident["all_cross_arm_pairs"]),
        "packaging_v1_net": v1s["packaging_pairs"]["net_b_minus_a_scoreable"],
        "non_packaging_v1_net": np_["net_b_minus_a_scoreable"],
    }


# --------------------------------------------------------------------------- 环境 / 验证者


def check_env_identity(rows: list[dict], ck: Checker) -> dict:
    env = load_json(ENV_IDENTITY)
    dataset = env["dataset"]
    for k, v in DATASET.items():
        if dataset.get(k) != v:
            ck.fail(f"env-identity.dataset.{k}={dataset.get(k)!r} != {v!r}")
    groups = env["runtime_groups"]
    if set(groups) != {"v1", "v2", "pilot"}:
        ck.fail("env-identity.runtime_groups 必须恰好是 v1/v2/pilot")
    group_of = {"v1": [r for r in rows if r["runtime_group"].startswith("v1-")],
                "v2": [r for r in rows if r["runtime_group"].startswith("v2-")],
                "pilot": [r for r in rows if r["status"] == "pilot"]}
    for gkey, rs in group_of.items():
        got = groups[gkey]
        if got["counts"]["runs"] != len(rs):
            ck.fail(f"env-identity {gkey}.counts.runs {got['counts']['runs']} != {len(rs)}")
        times = [r["started_at"] for r in rs]
        if times:
            if got["time_window"]["started_at_min"] != min(times) or \
                    got["time_window"]["started_at_max"] != max(times):
                ck.fail(f"env-identity {gkey} 时间窗与 runs.jsonl 不一致")
        scoreable = sum(1 for r in rs if r["official"] is not None)
        resolved = sum(1 for r in rs if r["official"] and r["official"]["resolved"])
        if got["counts"]["scoreable"] != scoreable:
            ck.fail(f"env-identity {gkey} scoreable 不一致")
        if got["counts"]["resolved"] != resolved:
            ck.fail(f"env-identity {gkey} resolved 不一致")
    per_exp = env["per_experiment"]
    if set(per_exp) != set(EXPERIMENTS):
        ck.fail("env-identity.per_experiment 实验集合不对")
    for exp, cfg in EXPERIMENTS.items():
        if per_exp.get(exp, {}).get("manifest") != cfg["manifest"]:
            ck.fail(f"env-identity {exp} manifest 不对")
        rs = [r for r in rows if r["experiment"] == exp]
        if per_exp.get(exp, {}).get("counts", {}).get("runs") != len(rs):
            ck.fail(f"env-identity {exp} run 数不一致")
        times = [r["started_at"] for r in rs]
        tw = per_exp.get(exp, {}).get("time_window", {})
        if tw.get("started_at_min") != min(times) or tw.get("started_at_max") != max(times):
            ck.fail(f"env-identity {exp} 时间窗不一致")
        policy = per_exp.get(exp, {}).get("run_policy", {})
        if policy.get("timeout_seconds") != 2700 or policy.get("max_tokens_per_run") != 40000000:
            ck.fail(f"env-identity {exp} run_policy 与预注册上限不一致")
        if not is_int(policy.get("total_token_budget")):
            ck.fail(f"env-identity {exp} 缺 total_token_budget")
    # attempts 对账：env-identity 的数字必须与 runs.jsonl 重算一致
    ar = env["attempts_reconciliation"]
    known = sum(1 for r in rows if r["attempts"] is not None)
    known_sum = sum(r["attempts"] or 0 for r in rows)
    if ar["runs_with_matrix_attempts"] != known:
        ck.fail(f"attempts_reconciliation 覆盖行数 {ar['runs_with_matrix_attempts']} != {known}")
    if ar["attempts_sum_known"] != known_sum:
        ck.fail(f"attempts_reconciliation 合计 {ar['attempts_sum_known']} != {known_sum}")
    i8 = env["issue_8_reconciliation"]["claims"]
    v1 = group_of["v1"]
    v1_off = sum(1 for r in v1 if r["official"] is not None)
    if i8["85 次有效官方评分运行"]["v1_runs"] != len(v1) or \
            i8["85 次有效官方评分运行"]["v1_with_official_report"] != v1_off:
        ck.fail("#8 对账节里的 V1 运行数/官方报告数与 runs.jsonl 不一致")
    if i8["含重跑约 164 次尝试"]["matrix_json_attempts_sum"] != known_sum:
        ck.fail("#8 对账节里的 attempts 合计与 runs.jsonl 不一致")
    if "known_gaps" not in env or len(env["known_gaps"]) < 5:
        ck.fail("env-identity.known_gaps 太少，AC-002 要求明确缺口清单")
    return {
        "v1_window": groups["v1"]["time_window"],
        "v2_window": groups["v2"]["time_window"],
        "pilot_window": groups["pilot"]["time_window"],
        "attempts_known": known_sum,
        "attempts_rows": known,
        "v1_official": v1_off,
    }


def check_verifier(rows: list[dict], ck: Checker) -> dict:
    vc = load_json(VERIFIER)
    b_runs = [r for r in rows if r["experiment"] != "pilot" and r["arm"] in B_ARMS]
    if vc["totals"]["b_runs"] != len(b_runs):
        ck.fail(f"verifier-confusion b_runs {vc['totals']['b_runs']} != {len(b_runs)}")
    if len(b_runs) != EXPECTED["b_runs"]:
        ck.fail(f"B 运行数 {len(b_runs)} != 预注册 {EXPECTED['b_runs']}")
    v1_b = [r for r in b_runs if r["experiment"] != "version-regression-mvp"]
    v2_b = [r for r in b_runs if r["experiment"] == "version-regression-mvp"]
    if len(v1_b) != EXPECTED["v1_b_runs"] or len(v2_b) != EXPECTED["v2_b_runs"]:
        ck.fail("V1/V2 B 运行数不对")
    details = {d["run_id"]: d for d in vc["runs"]}
    if set(details) != {r["run_id"] for r in b_runs}:
        ck.fail("verifier-confusion.runs 的 run 集合与 canonical B 运行不一致")
    conf = vc["confusion"]["all_b_runs"]
    for k, want in EXPECTED["confusion"].items():
        if conf["counts"].get(k, 0) != want:
            ck.fail(f"verifier confusion {k}={conf['counts'].get(k, 0)} != {want}")
    # 每个 run 的裁决序列/最终裁决/官方结果必须与 runs.jsonl 一致
    for r in b_runs:
        d = details.get(r["run_id"])
        if d is None:
            continue
        vs = d["verdicts"]
        if vs != r["verify_verdicts"]:
            ck.fail(f"{r['run_id']}: verifier-confusion verdicts 与 runs.jsonl 不一致")
        final = vs[-1] if vs else None
        if d["final_verdict"] != final:
            ck.fail(f"{r['run_id']}: final_verdict 与裁决序列最后一项不一致")
        want_off = r["official"]["resolved"] if r["official"] else None
        if d["official_resolved"] != want_off:
            ck.fail(f"{r['run_id']}: verifier-confusion official_resolved 与 runs.jsonl 不一致")
        # bucket 规则必须可重算
        if want_off is None:
            want_bucket = "official_missing"
        elif final is None:
            want_bucket = "no_verdict"
        elif final == "needs_human":
            want_bucket = "needs_human"
        elif final == "approve":
            want_bucket = ("approve_resolved" if want_off
                           else "approve_unresolved_false_positive")
        else:
            want_bucket = ("reject_unresolved" if not want_off
                           else "reject_resolved_false_negative")
        if d["bucket"] != want_bucket:
            ck.fail(f"{r['run_id']}: bucket {d['bucket']} != 重算 {want_bucket}")
    # v2 单列
    v2_conf = vc["confusion"]["v2_b_runs"]
    if v2_conf["runs"] != len(v2_b):
        ck.fail("verifier-confusion.v2_b_runs.runs 不对")
    # agent 提前失败必须单独列出且只含真实提前失败
    premature = {p["run_id"] for p in vc["agent_premature_failure"]["runs"]}
    want_premature = {
        r["run_id"] for r in b_runs
        if r["agent_completed"] is not True or r["agent_failure"] is not None
    }
    if premature != want_premature:
        ck.fail("agent_premature_failure.runs 与 runs.jsonl 的提前失败集合不一致")
    return {
        "b_runs": len(b_runs),
        "v1_b_runs": len(v1_b),
        "v2_b_runs": len(v2_b),
        "confusion": conf["counts"],
        "false_positive_rate": conf["rates"]["false_positive_rate"],
        "false_negative_rate": conf["rates"]["false_negative_rate"],
        "no_verdict": conf["counts"]["no_verdict"],
        "premature_failures": len(premature),
    }


# --------------------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser(description="EVAL-01 canonical 数据一致性校验")
    ap.add_argument("--check", action="store_true",
                    help="校验模式（CI 使用）；失败非零退出")
    args = ap.parse_args()  # noqa: F841  （--check 与默认行为相同，仅为 CI 语义显式）
    ck = Checker()
    rows = load_runs()
    check_unique_and_fields(rows, ck)
    check_versions_and_images(rows, ck)
    per_exp = check_denominators(rows, ck)
    mapping = check_snapshot_mapping(rows, ck)
    evidence = check_evidence(rows, ck)
    leak = check_leak(rows, ck)
    env = check_env_identity(rows, ck)
    verifier = check_verifier(rows, ck)

    totals = per_exp.pop("_totals")
    print("== audit_runs: FeatureBench canonical 数据对账 ==")
    print(f"canonical runs: {len(rows)}  (V1 {totals['v1_attempted']} / "
          f"V2 {totals['v2_attempted']} / pilot {totals['pilot_attempted']})")
    print(f"official report: {totals['official_reports']} 条；resolved 合计 "
          f"{totals['resolved_total']}（缺官方评分 {len(rows) - totals['official_reports']}，"
          f"按 ITT 保留在分母）")
    print(f"V1: attempted {totals['v1_attempted']}, scoreable {totals['v1_scoreable']} "
          f"({totals['v1_scoreable']}/{totals['v1_attempted']}), resolved "
          f"{totals['v1_resolved']}；V2: attempted {totals['v2_attempted']}, "
          f"scoreable {totals['v2_scoreable']}, resolved {totals['v2_resolved']}")
    for exp in EXPERIMENTS:
        pe = per_exp[exp]
        print(f"  {exp:23s} attempted {pe['attempted']:2d}  scoreable {pe['scoreable']:2d}  "
              f"resolved {pe['resolved']:2d}  ITT {pe['itt_rate']:.3f}  "
              f"scoreable {pe['scoreable_rate']:.3f}")
    print(f"snapshot mapping: {mapping['snapshot_rows']} 行 → "
          f"{mapping['mapped_unique_runs']} 个 canonical run；重复 "
          f"{mapping['duplicate_rows']}（duplicate_baseline）；无快照 canonical "
          f"{mapping['canonical_without_snapshot']}（pilot）；数值差异 "
          f"{mapping['numeric_mismatches']}")
    print(f"attempts: {env['attempts_known']} 次（{env['attempts_rows']}/{len(rows)} 行有 "
          f"matrix.json 记录；其余 null 并在 env-identity 说明）")
    print(f"leak: {leak['runs_with_hits']}/{len(rows)} run 有命中，共 {leak['hits_total']} 条；"
          f"镜像 {leak['repos_with_hits']}；patch==gold exact {leak['gold_exact_matches']}"
          f" / normalized {leak['normalized_matches']}；A/B 同补丁 primary "
          f"{leak['identical_ab_pairs']} 对（all {leak['identical_all_pairs']}）")
    print(f"      packaging 敏感性（V1）：含 packaging 净 "
          f"{leak['packaging_v1_net']:+d}，不含 packaging 净 "
          f"{leak['non_packaging_v1_net']:+d}（V2 单列，见 leak-audit.json）")
    print(f"verifier: {verifier['b_runs']} 次 B 运行（V1 {verifier['v1_b_runs']} / V2 "
          f"{verifier['v2_b_runs']}）；approve {conf_sum(verifier['confusion'], 'approve')}"
          f"（FP {verifier['confusion']['approve_unresolved_false_positive']}）、"
          f"reject {conf_sum(verifier['confusion'], 'reject')}"
          f"（FN {verifier['confusion']['reject_resolved_false_negative']}）、"
          f"needs_human {verifier['confusion']['needs_human']}、"
          f"no_verdict {verifier['no_verdict']}；agent 提前失败 "
          f"{verifier['premature_failures']}")
    print(f"evidence: {evidence['runs']} canonical 行 / "
          f"{evidence['distinct_physical_runs']} 次物理运行 / "
          f"{evidence['artifacts']} artifact；归档 "
          f"SHA256SUMS sha256 {evidence['archive_sha256sums_sha256']}"
          f"（{evidence['archive_entries']} 条，artifact mismatch "
          f"{evidence['archive_mismatches']}）")
    print(f"env identity: V1 {env['v1_window']['started_at_min']} ~ "
          f"{env['v1_window']['started_at_max']}；V2 {env['v2_window']['started_at_min']} ~ "
          f"{env['v2_window']['started_at_max']}；pilot {env['pilot_window']['started_at_min']}")
    if ck.errors:
        print(f"\nFAIL：{len(ck.errors)} 项校验失败")
        for e in ck.errors:
            print(f"  - {e}")
        return 1
    print("\nOK：全部校验通过（字段/唯一性/版本/镜像/分母/快照映射/泄漏/证据/验证者）")
    return 0


def conf_sum(counts: dict, kind: str) -> int:
    if kind == "approve":
        return counts["approve_resolved"] + counts["approve_unresolved_false_positive"]
    return counts["reject_unresolved"] + counts["reject_resolved_false_negative"]


if __name__ == "__main__":
    sys.exit(main())
