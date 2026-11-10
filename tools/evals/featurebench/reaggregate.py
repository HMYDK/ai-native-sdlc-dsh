#!/usr/bin/env python3
"""离线复算：只读已提交的机读数据快照，重算 FeatureBench A/B 指标并与已提交结果对账。

为什么要有这个脚本（issue #12 / AC-003 / AC-008）：报告里的每个数字都应该能由
仓库内已提交的机读数据复算出来，且不依赖原始 runs、Docker、模型或网络。本脚本读
`docs/evals/*-data.json`（不含原始 run 目录）与预注册 manifest，重算：

1. 每个实验每个 arm 的 attempted / scoreable / resolved、ITT 与 PP resolved rate、
   token / elapsed 分布、失败分类；
2. 配对 W/L/T（以 A=standard 为参照）与净差；
3. 跨实验可比配对面板（口径见下）+ 与 issue #8 评论数字对账 + 两个敏感性变体；
4. 验证者裁决混淆矩阵（复用 analyze_verifier 口径，合并所有 B 组运行，V1/V2 分开）；
5. 版本回归（V2 plugin 0.6.1/DSH 0.2.2 的 10 runs vs V1 基线 10 runs）；
6. V2 已预注册但未执行的 5 份 regression manifest（not_run，含 sha256/计划运行数）。

「可比配对面板」口径（避免按结果挑 arm）：
- 只取 V1 runtime group（plugin 0.6.0 / DSH 0.2.1-rc.5）内的配对实验；
- B 侧统一取「SDLC preset + manifest 固定 prompt_suffix」这个 treatment：
  MVP / expanded / repeat-sampling 用 arm=`sdlc`（manifest 里该 arm 自带引导文本），
  2×2 用 arm=`sdlc_guidance`（2×2 的裸 `sdlc` 是纯 preset、无引导，不是主 treatment）；
- 主面板只算「两臂都有官方评分」的 scoreable 配对（per-protocol）；ITT 变体把缺官方
  评分的一侧按 unresolved 计入（敏感性，不替代主口径）；
- version-regression 的 old 10 行是 MVP 基线运行复用（重复样本，不重复计入）；
  verifier-calibration / verifier-stress 只有 B 臂，不能配对，另行报告混淆矩阵。

用法（仅标准库 + pyyaml；不联网、不调模型）：
    python3 tools/evals/featurebench/reaggregate.py            # 生成 metrics + index
    python3 tools/evals/featurebench/reaggregate.py --check    # 与已提交 metrics 对账
`--check` 会同时用已提交快照重算 2x2 / expanded / verifier / stress / repeat 的
analysis 块，与已提交 analysis 数字逐项对账（浮点容差 1e-9，忽略路径字段）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import yaml

import analyze_2x2
import analyze_expanded
import analyze_repeat
import analyze_verifier

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent.parent
DATA_DIR = REPO / "docs" / "evals"
DEFAULT_METRICS = DATA_DIR / "featurebench-baseline-metrics.json"
DEFAULT_INDEX = DATA_DIR / "featurebench-baseline-index.json"

GROUP_V1 = "v1-0.6.0-0.2.1-rc.5"
GROUP_V2 = "v2-0.6.1-0.2.2-rc.1"

RUNS_JSONL = "docs/evals/featurebench-runs.jsonl"
EVIDENCE_INDEX = "docs/evals/featurebench-evidence-index.json"

# ---------------------------------------------------------------------------
# 只读输入清单：所有路径都是仓库相对路径（CI checkout 即可复算）。
# ---------------------------------------------------------------------------
DATA = {
    "mvp": "docs/evals/featurebench-2026-11-06-data.json",
    "2x2": "docs/evals/featurebench-2026-11-07-2x2-data.json",
    "expanded": "docs/evals/featurebench-2026-11-07-expanded-data.json",
    "verifier": "docs/evals/featurebench-2026-11-07-verifier-data.json",
    "stress": "docs/evals/featurebench-2026-11-07-verifier-stress-data.json",
    "stress_confusion": "docs/evals/featurebench-2026-11-07-verifier-stress-confusion.json",
    "repeat": "docs/evals/featurebench-2026-11-08-repeat-sampling-data.json",
    "version_regression": "docs/evals/featurebench-2026-11-08-version-regression-data.json",
}
MANIFESTS = {
    "base": "tools/evals/featurebench/manifest.yml",
    "2x2": "tools/evals/featurebench/manifests/2x2.yml",
    "expanded": "tools/evals/featurebench/manifests/expanded.yml",
    "verify-calibration": "tools/evals/featurebench/manifests/verify-calibration.yml",
    "verify-stress": "tools/evals/featurebench/manifests/verify-stress.yml",
    "repeat-sampling": "tools/evals/featurebench/manifests/repeat-sampling.yml",
    "regression-mvp": "tools/evals/featurebench/manifests/regression-0.6.1/mvp.yml",
}
REGRESSION_MANIFEST_DIR = "tools/evals/featurebench/manifests/regression-0.6.1"

FAILURE_CLASSES = ("timeout", "over_budget", "turn_error", "infra_error",
                   "agent_error", "empty_patch", "unresolved")

# 每个实验的「侧」（side）：单 runtime group 的实验只有 all 一侧；
# version-regression 拆 new（V2）/ old（V1 基线复用）两侧。
EXPERIMENTS = [
    {
        "id": "mvp-2026-11-06", "experiment": "mvp", "date": "2026-11-06",
        "sides": [{
            "id": "all", "runtime_group": GROUP_V1, "manifest": MANIFESTS["base"],
            "data": [{"doc": "mvp", "path": DATA["mvp"], "role": "report",
                      "extract": "plain", "runs_selector": "runs"}],
            "arms": ["standard", "sdlc"],
            "pairs": [{"pair_id": "standard_vs_sdlc", "A_arm": "standard",
                       "B_arm": "sdlc", "key": "task"}],
            "repeats": 1,
            "notes": ["首批 MVP：5 个 repo 各 1 个 lv1 任务 × {标准, SDLC+引导}。"],
        }],
    },
    {
        "id": "2x2-2026-11-07", "experiment": "2x2", "date": "2026-11-07",
        "sides": [{
            "id": "all", "runtime_group": GROUP_V1, "manifest": MANIFESTS["2x2"],
            "data": [{"doc": "2x2", "path": DATA["2x2"], "role": "report",
                      "extract": "report", "runs_selector": "report.runs"}],
            "arms": ["standard", "standard_guidance", "sdlc", "sdlc_guidance"],
            "pairs": [
                {"pair_id": "standard_vs_sdlc", "A_arm": "standard",
                 "B_arm": "sdlc", "key": "task"},
                {"pair_id": "standard_guidance_vs_sdlc_guidance",
                 "A_arm": "standard_guidance", "B_arm": "sdlc_guidance", "key": "task"},
                {"pair_id": "standard_vs_sdlc_guidance", "A_arm": "standard",
                 "B_arm": "sdlc_guidance", "key": "task"},
                {"pair_id": "standard_guidance_vs_sdlc", "A_arm": "standard_guidance",
                 "B_arm": "sdlc", "key": "task"},
            ],
            "repeats": 1,
            "notes": ["2×2 拆分：preset × 引导；主 treatment 对应 arm=sdlc_guidance。"],
        }],
    },
    {
        "id": "expanded-2026-11-07", "experiment": "expanded", "date": "2026-11-07",
        "sides": [{
            "id": "all", "runtime_group": GROUP_V1, "manifest": MANIFESTS["expanded"],
            "data": [{"doc": "expanded", "path": DATA["expanded"], "role": "report",
                      "extract": "report", "runs_selector": "report.runs"}],
            "arms": ["standard", "sdlc"],
            "pairs": [{"pair_id": "standard_vs_sdlc", "A_arm": "standard",
                       "B_arm": "sdlc", "key": "task"}],
            "repeats": 1,
            "notes": ["12 个未用过的 lv1 任务 × {标准, SDLC+引导}；"
                      "standard 臂有 1 条运行缺官方评分（seaborn test_regression），"
                      "该对不计入 PP 配对，只在 ITT 敏感性里按 unresolved 计入。"],
        }],
    },
    {
        "id": "verifier-calibration-2026-11-07", "experiment": "verifier-calibration",
        "date": "2026-11-07",
        "sides": [{
            "id": "all", "runtime_group": GROUP_V1,
            "manifest": MANIFESTS["verify-calibration"],
            "data": [
                {"doc": "verifier", "path": DATA["verifier"], "role": "report",
                 "extract": "report", "runs_selector": "report.runs"},
                {"doc": "verifier", "path": DATA["verifier"], "role": "confusion",
                 "extract": "report", "runs_selector": "confusion.details"},
            ],
            "arms": ["sdlc"], "pairs": [], "repeats": 1,
            "notes": ["验证者校准：10 个未用过的 lv1 任务 × B 组各 1 次（无 A 臂，不可配对）。"],
        }],
    },
    {
        "id": "verifier-stress-2026-11-07", "experiment": "verifier-stress",
        "date": "2026-11-07",
        "sides": [{
            "id": "all", "runtime_group": GROUP_V1,
            "manifest": MANIFESTS["verify-stress"],
            "data": [
                {"doc": "stress", "path": DATA["stress"], "role": "report",
                 "extract": "plain", "runs_selector": "runs"},
                {"doc": "stress_confusion", "path": DATA["stress_confusion"],
                 "role": "confusion", "extract": "plain",
                 "runs_selector": "details"},
            ],
            "arms": ["sdlc"], "pairs": [], "repeats": 1,
            "notes": ["known-fail 任务重复 3 次（无 A 臂）。"],
        }],
    },
    {
        "id": "repeat-sampling-2026-11-08", "experiment": "repeat-sampling",
        "date": "2026-11-08",
        "sides": [{
            "id": "all", "runtime_group": GROUP_V1,
            "manifest": MANIFESTS["repeat-sampling"],
            "data": [{"doc": "repeat", "path": DATA["repeat"], "role": "report",
                      "extract": "reps", "runs_selector": "reps[].runs"}],
            "arms": ["standard", "sdlc"],
            "pairs": [{"pair_id": "standard_vs_sdlc_by_rep", "A_arm": "standard",
                       "B_arm": "sdlc", "key": "task_rep"}],
            "repeats": 3,
            "notes": ["3 任务 × 2 臂 × 3 rep；配对单位是 (task, rep)，共 9 对。"],
        }],
    },
    {
        "id": "version-regression-2026-11-08", "experiment": "version-regression",
        "date": "2026-11-08",
        "sides": [
            {
                "id": "new", "runtime_group": GROUP_V2,
                "manifest": MANIFESTS["regression-mvp"],
                "data": [{"doc": "version_regression",
                          "path": DATA["version_regression"], "role": "report",
                          "extract": "v2new", "runs_selector": "new.runs"}],
                "arms": ["standard", "sdlc"],
                "pairs": [{"pair_id": "standard_vs_sdlc", "A_arm": "standard",
                           "B_arm": "sdlc", "key": "task"}],
                "repeats": 1,
                "notes": ["V2 新版本最小回归：5 任务 × 2 臂（plugin 0.6.1 / DSH 0.2.2-rc.1）。"],
            },
            {
                "id": "old", "runtime_group": GROUP_V1,
                "manifest": MANIFESTS["base"],
                "data": [{"doc": "version_regression",
                          "path": DATA["version_regression"], "role": "report",
                          "extract": "v2old", "runs_selector": "old.runs"}],
                "arms": ["standard", "sdlc"],
                "pairs": [{"pair_id": "standard_vs_sdlc", "A_arm": "standard",
                           "B_arm": "sdlc", "key": "task"}],
                "repeats": 1,
                "notes": ["旧版基线：复用 MVP 的同一批运行读数（重复样本，不重复计入主面板）。"],
            },
        ],
    },
]

# 跨实验可比配对面板（口径写在 docstring 与 metrics 的 definitions 里）。
PANEL_MEMBERS = [
    {"experiment": "mvp-2026-11-06", "side": "all", "pair_id": "standard_vs_sdlc"},
    {"experiment": "2x2-2026-11-07", "side": "all",
     "pair_id": "standard_vs_sdlc_guidance"},
    {"experiment": "expanded-2026-11-07", "side": "all", "pair_id": "standard_vs_sdlc"},
    {"experiment": "repeat-sampling-2026-11-08", "side": "all",
     "pair_id": "standard_vs_sdlc_by_rep"},
]
# 敏感性变体：2×2 改用纯 sdlc（无引导）arm —— 用来证明主面板的 arm 选择是
# treatment 定义而不是按结果挑选。
PANEL_MEMBERS_VARIANT_2X2_SDLC = [
    {"experiment": "mvp-2026-11-06", "side": "all", "pair_id": "standard_vs_sdlc"},
    {"experiment": "2x2-2026-11-07", "side": "all", "pair_id": "standard_vs_sdlc"},
    {"experiment": "expanded-2026-11-07", "side": "all", "pair_id": "standard_vs_sdlc"},
    {"experiment": "repeat-sampling-2026-11-08", "side": "all",
     "pair_id": "standard_vs_sdlc_by_rep"},
]

ISSUE8_CLAIM = {"n": 30, "A_resolved": 21, "B_resolved": 22}

PATH_KEYS_IGNORED = frozenset({"data", "reps", "manifest", "runs_root"})
REL_TOL = 1e-9
ABS_TOL = 1e-9


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------
def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _load_yaml(rel: str) -> dict:
    return yaml.safe_load((REPO / rel).read_text(encoding="utf-8"))


def _select_rows(doc: dict, selector: str) -> list:
    """按 `a.b[]` 形式从快照里取出 run/detail 行（供 rows 计数与独立校验）。

    支持本项目用到的形式：`runs`、`report.runs`、`reps[].runs`、`new.runs`、
    `old.runs`、`details`、`confusion.details`。
    """
    cur = [doc]
    for part in selector.split("."):
        flatten = part.endswith("[]")
        key = part[:-2] if flatten else part
        nxt = []
        for item in cur:
            if not isinstance(item, dict):
                continue
            val = item.get(key)
            if flatten:
                if isinstance(val, list):
                    nxt.extend(val)
            elif isinstance(val, dict):
                nxt.append(val)
            elif isinstance(val, list):
                nxt.extend(val)
        cur = nxt
    return cur


def _extract_reps(doc: dict) -> list:
    rows = []
    for idx, rep in enumerate(doc.get("reps") or [], start=1):
        for r in rep.get("runs") or []:
            row = dict(r)
            row["_rep"] = idx
            rows.append(row)
    return rows


EXTRACTORS = {
    "plain": lambda doc: list(doc.get("runs") or []),
    "report": lambda doc: list((doc.get("report") or {}).get("runs") or []),
    "reps": _extract_reps,
    "v2new": lambda doc: list((doc.get("new") or {}).get("runs") or []),
    "v2old": lambda doc: list((doc.get("old") or {}).get("runs") or []),
}


def _num(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


def _dist(rows: list, field: str) -> dict:
    vals = [_num(r.get(field)) for r in rows]
    vals = [v for v in vals if v is not None]
    if not vals:
        return {"n": 0, "median": None, "mean": None, "p90": None, "total": None}
    return {
        "n": len(vals),
        "median": analyze_expanded.median(vals),
        "mean": analyze_expanded.mean(vals),
        "p90": analyze_expanded.p90(vals),
        "total": sum(vals),
    }


def _side_rows(side: dict, docs: dict) -> list:
    """取某一侧的 run 行（role=report 的第一个 data 条目）。"""
    for dspec in side["data"]:
        if dspec["role"] == "report":
            return EXTRACTORS[dspec["extract"]](docs[dspec["doc"]])
    raise SystemExit(f"side {side['id']} 没有 role=report 的 data 条目")


def _arm_metrics(rows: list, source: dict) -> dict:
    scoreable = [r for r in rows if "resolved" in r]
    resolved = sum(1 for r in scoreable if r["resolved"])
    tokens = _dist(scoreable, "tokens")
    tokens["sources"] = _count_values(scoreable, "tokens_source")
    elapsed = _dist(scoreable, "elapsed_seconds")
    return {
        "source": source,
        "attempted": len(rows),
        "scoreable": len(scoreable),
        "resolved": resolved,
        "itt_resolved_rate": (resolved / len(rows)) if rows else None,
        "pp_resolved_rate": (resolved / len(scoreable)) if scoreable else None,
        "tokens": tokens,
        "elapsed_seconds": elapsed,
        "failures": _failure_stats(rows),
        "unscoreable": [
            {"task_id": r.get("task_id"), "arm": r.get("arm"),
             "agent_failure": r.get("agent_failure"),
             "reason": "missing_official_result"}
            for r in rows if "resolved" not in r
        ],
    }


def _count_values(rows: list, field: str) -> dict:
    counts = {}
    for r in rows:
        value = r.get(field)
        key = str(value) if value is not None else "null"
        counts[key] = counts.get(key, 0) + 1
    return dict(sorted(counts.items()))


def _failure_stats(rows: list) -> dict:
    counts = {name: 0 for name in FAILURE_CLASSES}
    counts["none"] = 0
    counts["other"] = 0
    details = []
    resolved_with_failure = 0
    for r in rows:
        failure = r.get("agent_failure")
        if failure:
            key = failure if failure in FAILURE_CLASSES else "other"
            counts[key] += 1
            if r.get("resolved"):
                resolved_with_failure += 1
            details.append({"task_id": r.get("task_id"), "arm": r.get("arm"),
                            "failure": failure, "resolved": r.get("resolved")})
        else:
            counts["none"] += 1
    return {
        "counts": counts,
        "runs_with_agent_failure": len(details),
        "resolved_with_failure": resolved_with_failure,
        "details": details,
    }


def _pair_metrics(rows: list, spec: dict) -> dict:
    """配对统计：W/L/T 以 A 为参照；PP 只算两臂都 scoreable 的对，ITT 把缺臂按
    unresolved 计入。"""

    def key_of(r):
        if spec["key"] == "task_rep":
            return (r.get("task_id"), r.get("_rep"))
        return r.get("task_id")

    a_rows, b_rows = {}, {}
    for r in rows:
        if r.get("arm") == spec["A_arm"]:
            a_rows[key_of(r)] = r
        elif r.get("arm") == spec["B_arm"]:
            b_rows[key_of(r)] = r

    attempted_keys = sorted(set(a_rows) | set(b_rows), key=lambda k: str(k))

    def _resolved(row):
        return bool(row.get("resolved")) if row is not None and "resolved" in row else False

    pp = {"both_resolved": 0, "both_failed": 0, "W": 0, "L": 0, "T": 0,
          "A_resolved": 0, "B_resolved": 0, "n": 0}
    itt = {"both_resolved": 0, "both_failed": 0, "W": 0, "L": 0, "T": 0,
           "A_resolved": 0, "B_resolved": 0, "n": len(attempted_keys)}
    for k in attempted_keys:
        a_row, b_row = a_rows.get(k), b_rows.get(k)
        a_ok = _resolved(a_row)
        b_ok = _resolved(b_row)
        if a_ok:
            itt["A_resolved"] += 1
        if b_ok:
            itt["B_resolved"] += 1
        if a_ok and b_ok:
            itt["both_resolved"] += 1
            itt["T"] += 1
        elif a_ok:
            itt["L"] += 1
        elif b_ok:
            itt["W"] += 1
        else:
            itt["both_failed"] += 1
            itt["T"] += 1
        # per-protocol：两臂都有官方评分结果才进入
        if (a_row is not None and "resolved" in a_row
                and b_row is not None and "resolved" in b_row):
            pp["n"] += 1
            if a_ok:
                pp["A_resolved"] += 1
            if b_ok:
                pp["B_resolved"] += 1
            if a_ok and b_ok:
                pp["both_resolved"] += 1
                pp["T"] += 1
            elif a_ok:
                pp["L"] += 1
            elif b_ok:
                pp["W"] += 1
            else:
                pp["both_failed"] += 1
                pp["T"] += 1

    def _rate(numerator, denominator):
        return (numerator / denominator) if denominator else None

    return {
        "pair_id": spec["pair_id"],
        "A_arm": spec["A_arm"],
        "B_arm": spec["B_arm"],
        "source": {
            "file": None,
            "pairs": len(attempted_keys),
            "exclusion": "PP 只统计两臂都带官方 resolved 的对；"
                         "缺臂/缺官方评分只进 ITT 敏感性。",
        },
        "attempted_pairs": len(attempted_keys),
        "scoreable_pairs": pp["n"],
        "unpaired_pairs": len(attempted_keys) - pp["n"],
        "pp": {
            "n": pp["n"],
            "both_resolved": pp["both_resolved"],
            "both_failed": pp["both_failed"],
            "W": pp["W"], "L": pp["L"], "T": pp["T"],
            "A_resolved": pp["A_resolved"],
            "B_resolved": pp["B_resolved"],
            "A_resolved_rate": _rate(pp["A_resolved"], pp["n"]),
            "B_resolved_rate": _rate(pp["B_resolved"], pp["n"]),
            "mean_diff_B_minus_A": _rate(pp["B_resolved"] - pp["A_resolved"], pp["n"]),
        },
        "itt": {
            "n": itt["n"],
            "both_resolved": itt["both_resolved"],
            "both_failed": itt["both_failed"],
            "W": itt["W"], "L": itt["L"], "T": itt["T"],
            "A_resolved": itt["A_resolved"],
            "B_resolved": itt["B_resolved"],
            "A_resolved_rate": _rate(itt["A_resolved"], itt["n"]),
            "B_resolved_rate": _rate(itt["B_resolved"], itt["n"]),
            "mean_diff_B_minus_A": _rate(itt["B_resolved"] - itt["A_resolved"],
                                         itt["n"]),
        },
    }


def _side_metrics(side: dict, docs: dict) -> dict:
    rows = _side_rows(side, docs)
    arms = {}
    for arm in side["arms"]:
        arm_rows = [r for r in rows if r.get("arm") == arm]
        arms[arm] = _arm_metrics(arm_rows, source={
            "file": next(d["path"] for d in side["data"] if d["role"] == "report"),
            "runs": len(arm_rows),
            "exclusion": "token/耗时分布只取 scoreable 行数值；缺官方评分的 run "
                         "计入 attempted 与 unscoreable，不进分布。",
        })
    paired = []
    for spec in side["pairs"]:
        entry = _pair_metrics(rows, spec)
        entry["source"]["file"] = next(
            d["path"] for d in side["data"] if d["role"] == "report")
        paired.append(entry)
    return {
        "runtime_group": side["runtime_group"],
        "source": {
            "file": next(d["path"] for d in side["data"] if d["role"] == "report"),
            "runs": len(rows),
            "exclusion": "只读已提交机读快照；该 side 的 run 全量进入 attempted，"
                         "不静默剔除失败/超时/缺官方评分的 run。",
        },
        "arms": arms,
        "paired": paired,
        "notes": list(side.get("notes") or []),
    }


def _counts_from_rows(rows: list) -> dict:
    scoreable = [r for r in rows if "resolved" in r]
    return {
        "attempted": len(rows),
        "scoreable": len(scoreable),
        "resolved": sum(1 for r in scoreable if r["resolved"]),
        "arms": sorted({str(r.get("arm")) for r in rows}),
    }


# ---------------------------------------------------------------------------
# 跨实验面板
# ---------------------------------------------------------------------------
def _panel(members: list, experiments: dict, use_itt: bool = False) -> dict:
    totals = {"attempted_pairs": 0, "scoreable_pairs": 0, "both_resolved": 0,
              "both_failed": 0, "W": 0, "L": 0, "T": 0,
              "A_resolved": 0, "B_resolved": 0}
    per_member = []
    for member in members:
        side = experiments[member["experiment"]]["sides"][member["side"]]
        pair = next(p for p in side["paired"] if p["pair_id"] == member["pair_id"])
        chunk = pair["itt"] if use_itt else pair["pp"]
        for key in ("both_resolved", "both_failed", "W", "L", "T",
                    "A_resolved", "B_resolved"):
            totals[key] += chunk[key]
        totals["attempted_pairs"] += pair["attempted_pairs"]
        totals["scoreable_pairs"] += pair["scoreable_pairs"]
        per_member.append({
            "experiment": member["experiment"],
            "pair_id": member["pair_id"],
            "A_arm": pair["A_arm"],
            "B_arm": pair["B_arm"],
            "attempted_pairs": pair["attempted_pairs"],
            "scoreable_pairs": pair["scoreable_pairs"],
            "A_resolved": chunk["A_resolved"],
            "B_resolved": chunk["B_resolved"],
            "W": chunk["W"], "L": chunk["L"], "T": chunk["T"],
        })
    denominator = totals["attempted_pairs"] if use_itt else totals["scoreable_pairs"]
    out = {
        "n": denominator,
        "A_resolved": totals["A_resolved"],
        "B_resolved": totals["B_resolved"],
        "A_resolved_rate": (totals["A_resolved"] / denominator) if denominator else None,
        "B_resolved_rate": (totals["B_resolved"] / denominator) if denominator else None,
        "mean_diff_B_minus_A": ((totals["B_resolved"] - totals["A_resolved"]) / denominator)
                               if denominator else None,
        "both_resolved": totals["both_resolved"],
        "both_failed": totals["both_failed"],
        "W": totals["W"], "L": totals["L"], "T": totals["T"],
        "attempted_pairs": totals["attempted_pairs"],
        "scoreable_pairs": totals["scoreable_pairs"],
    }
    return {"counts": out, "members": per_member}


def _comparable_panel(experiments: dict) -> dict:
    main_panel = _panel(PANEL_MEMBERS, experiments)
    variant_2x2_sdlc = _panel(PANEL_MEMBERS_VARIANT_2X2_SDLC, experiments)
    variant_itt = _panel(PANEL_MEMBERS, experiments, use_itt=True)
    main = main_panel["counts"]
    claimed = ISSUE8_CLAIM
    reproduced = {"n": main["n"], "A_resolved": main["A_resolved"],
                  "B_resolved": main["B_resolved"]}
    matches = (reproduced["n"] == claimed["n"]
               and reproduced["A_resolved"] == claimed["A_resolved"]
               and reproduced["B_resolved"] == claimed["B_resolved"])
    source_files = []
    for member in PANEL_MEMBERS:
        exp = next(e for e in EXPERIMENTS if e["id"] == member["experiment"])
        side = next(sd for sd in exp["sides"] if sd["id"] == member["side"])
        source_files.append(next(d["path"] for d in side["data"]
                                 if d["role"] == "report"))
    return {
        "panel_id": "v1-headline-ab-paired",
        "source": {
            "files": sorted(set(source_files)),
            "pairs": main["n"],
            "exclusion": "只聚合 V1 实验里「两臂都有官方评分」的 scoreable 配对；"
                         "version-regression old 是 MVP 复用，不重复计入；"
                         "B-only 实验（验证者校准/压力）不进配对面板。",
        },
        "definition": (
            "V1 runtime group 内 A=「标准模式（无引导）」、B=「AI 原生 SDLC preset + "
            "manifest 固定 prompt_suffix」的可比配对面板。MVP/expanded/repeat-sampling "
            "取 arm=sdlc（该 arm 自带引导），2×2 取 arm=sdlc_guidance（2×2 的裸 sdlc "
            "是纯 preset、无引导）。主口径只算两臂都有官方评分的 scoreable 对（PP）；"
            "version-regression old 是 MVP 复用、不重复计入；B-only 实验不可配对。"),
        "main": main_panel,
        "sensitivity": {
            "variant_2x2_sdlc": {
                "definition": "主面板的变体：2×2 改用纯 sdlc（无引导）arm。"
                              "用于证明 arm 选择来自 treatment 定义而非按结果挑选。",
                **variant_2x2_sdlc,
            },
            "variant_itt": {
                "definition": "主面板的 ITT 变体：expanded 缺官方评分的那条 A 运行"
                              "按 unresolved 计入，n=31（多出一对 B win）。",
                **variant_itt,
            },
        },
        "issue8_reconciliation": {
            "reference": "issue #8 评论（Lead 提供）：n=30 / A 21/30 / B 22/30",
            "claimed": claimed,
            "reproduced": reproduced,
            "matches": matches,
            "notes": [
                "主面板 B 侧必须取 manifest 里自带引导的 arm：MVP/expanded/repeat 的 "
                "sdlc arm 有 prompt_suffix，2×2 中只有 sdlc_guidance 有 suffix；"
                "2×2 的裸 sdlc 是「纯 preset」子实验，不放进主 treatment。",
                "n=30 是两臂都有官方评分的 scoreable 配对；expanded 有 1 条标准臂运行"
                "缺官方评分（seaborn test_regression），PP 面板不计该对，"
                "ITT 敏感性里按 unresolved 计入（n=31，A 21/31、B 23/31）。",
                "variant_2x2_sdlc 敏感性：n=30、A 21/30、B 23/30；"
                "两个变体都从同一批已提交数据可复算。",
            ],
        },
    }


# ---------------------------------------------------------------------------
# 验证者混淆（复用 analyze_verifier 口径）
# ---------------------------------------------------------------------------
def _b_rows_for(docs: dict, experiment: dict) -> list:
    """合并某实验所有 B 臂（SDLC preset）且带官方 resolved 的 run 行。"""
    rows = []
    for side in experiment["sides"]:
        if side["runtime_group"] != GROUP_V1:
            continue
        for r in _side_rows(side, docs):
            if analyze_verifier.is_sdlc_arm(r) and "resolved" in r:
                row = dict(r)
                row["experiment"] = experiment["id"]
                rows.append(row)
    return rows


def _confusion_summary(rows: list) -> dict:
    result = analyze_verifier.confusion_for_rows(rows)
    details = result.pop("details")
    result["notable_runs"] = [
        d for d in details
        if d["bucket"] not in ("agree_approve", "agree_reject")
    ]
    return result


VERIFIER_CONFUSION_CANONICAL = "docs/evals/featurebench-verifier-confusion.json"


def _canonical_b_rows(runs: list, group: str) -> list:
    """从 canonical runs.jsonl 取某 runtime group 的 B 组 run（主会话裁决口径）。"""
    rows = []
    for r in runs or []:
        if r.get("runtime_group") != group:
            continue
        if r.get("arm") not in ("sdlc", "sdlc_guidance"):
            continue
        official = r.get("official")
        if not isinstance(official, dict) or "resolved" not in official:
            continue
        rows.append({
            "task_id": r.get("task_id"),
            "repo": r.get("repo"),
            "resolved": bool(official["resolved"]),
            "pass_rate": official.get("pass_rate"),
            "verify_verdicts": list(r.get("verify_verdicts") or []),
            "experiment": r.get("experiment"),
        })
    return rows


def _legacy_b_rows(docs: dict) -> tuple:
    """从已提交数据快照按 analyze_verifier 的 report-data 口径取 B 组 run。"""
    v1_rows, v2_rows = [], []
    for exp in EXPERIMENTS:
        exp_id = exp["id"]
        if exp_id == "version-regression-2026-11-08":
            continue
        v1_rows.extend(_b_rows_for(docs, exp))
    for exp in EXPERIMENTS:
        if exp["experiment"] != "version-regression":
            continue
        for side in exp["sides"]:
            if side["runtime_group"] != GROUP_V2:
                continue
            for r in _side_rows(side, docs):
                if analyze_verifier.is_sdlc_arm(r) and "resolved" in r:
                    row = dict(r)
                    row["experiment"] = exp["id"]
                    v2_rows.append(row)
    return v1_rows, v2_rows


def _verifier_confusion(docs: dict, runs: list) -> dict:
    v1_legacy, v2_legacy = _legacy_b_rows(docs)
    canonical = None
    if runs is not None:
        v1_canonical = _canonical_b_rows(runs, GROUP_V1)
        v2_canonical = _canonical_b_rows(runs, GROUP_V2)
        canonical = {
            "definition": "canonical runs.jsonl 的 verify_verdicts（主会话口径，"
                          "验证者子会话同名 status JSON 不重复计数）+ 官方 report "
                          "resolved；分桶规则复用 analyze_verifier.confusion_for_rows。",
            "source": {
                "file": RUNS_JSONL,
                "runs": len(v1_canonical) + len(v2_canonical),
                "exclusion": "只取 B（SDLC preset）运行：arm ∈ {sdlc, sdlc_guidance}、"
                             "runtime_group ∈ {V1,V2}；pilot 与非 B arm 不计入。",
            },
            "v1_all_b_runs": _confusion_summary(v1_canonical),
            "v2_all_b_runs": _confusion_summary(v2_canonical),
            "all_b_runs": _confusion_summary(v1_canonical + v2_canonical),
        }
    return {
        "definition": "复用 analyze_verifier.py 的 confusion_for_rows 口径：最终裁决 "
                      "approve/reject/needs_human/none × 官方 resolved/unresolved；"
                      "needs_human 与无裁决不混进 approve/reject 分母。",
        "canonical_main_session_scope": canonical,
        "legacy_report_data_scope": {
            "definition": "旧 summarize_runs.py 产出的 report-data.json 里的 "
                          "verify_verdicts（会扫到验证者子会话的同名 status JSON，"
                          "可能重复计数/裁决序列顺序不同）；保留此列只为解释旧报告"
                          "与 issue #8 数字的来源，不作为 AC-006 权威口径。",
            "source": {
                "files": [DATA["mvp"], DATA["2x2"], DATA["expanded"],
                          DATA["verifier"], DATA["stress"], DATA["repeat"],
                          DATA["version_regression"]],
                "runs": len(v1_legacy) + len(v2_legacy),
                "exclusion": "与 analyze_verifier.py 相同的 report-data 口径；"
                             "缺官方 resolved 的 run 不进入混淆矩阵。",
            },
            "v1_all_b_runs": _confusion_summary(v1_legacy),
            "v2_all_b_runs": _confusion_summary(v2_legacy),
            "all_b_runs": _confusion_summary(v1_legacy + v2_legacy),
        },
        "notes": [
            "同一 task 的重复运行（repeat-sampling 3 rep、verifier-stress 3 次）"
            "按 run 计数，不做去重；这是验证者行为样本，不是任务级正确率。",
            "版本回归（V2）单独一列，不与 V1 混算。",
            "AC-006 权威混淆矩阵见 data-auditor 的 "
            f"{VERIFIER_CONFUSION_CANONICAL}（canonical_main_session_scope 应与它一致，"
            "reaggregate.py --check 会交叉校验）；legacy 列的差异来自旧口径。",
        ],
    }


# ---------------------------------------------------------------------------
# 版本回归
# ---------------------------------------------------------------------------
def _version_regression(docs: dict, experiments: dict) -> dict:
    doc = docs["version_regression"]
    new_side = experiments["version-regression-2026-11-08"]["sides"]["new"]
    old_side = experiments["version-regression-2026-11-08"]["sides"]["old"]

    def _arm(side, arm):
        return side["arms"][arm]

    resolved = {}
    for arm in ("standard", "sdlc"):
        new_val = _arm(new_side, arm)["resolved"]
        old_val = _arm(old_side, arm)["resolved"]
        resolved[arm] = {"new": new_val, "old": old_val,
                         "delta": new_val - old_val}
    tokens = {}
    for arm in ("standard", "sdlc"):
        new_total = _arm(new_side, arm)["tokens"]["total"]
        old_total = _arm(old_side, arm)["tokens"]["total"]
        ratio = None
        if new_total is not None and old_total:
            ratio = new_total / old_total - 1
        tokens[arm] = {"new_total": new_total, "old_total": old_total,
                       "ratio": ratio}
    new_sum = sum((_arm(new_side, arm)["tokens"]["total"] or 0)
                  for arm in ("standard", "sdlc"))
    old_sum = sum((_arm(old_side, arm)["tokens"]["total"] or 0)
                  for arm in ("standard", "sdlc"))
    tokens["total"] = {
        "new_total": new_sum,
        "old_total": old_sum,
        "ratio": (new_sum / old_sum - 1) if old_sum else None,
    }

    def _paired(side):
        pair = next(p for p in side["paired"] if p["pair_id"] == "standard_vs_sdlc")
        return {"W": pair["pp"]["W"], "L": pair["pp"]["L"], "T": pair["pp"]["T"],
                "scoreable_pairs": pair["scoreable_pairs"]}

    new_attempted = (_arm(new_side, "standard")["attempted"]
                     + _arm(new_side, "sdlc")["attempted"])
    old_attempted = (_arm(old_side, "standard")["attempted"]
                     + _arm(old_side, "sdlc")["attempted"])
    return {
        "new_version": doc.get("new_version"),
        "old_version": doc.get("old_version"),
        "new": {"runtime_group": GROUP_V2, "paired": _paired(new_side),
                "attempted": new_attempted,
                "source": {"file": DATA["version_regression"],
                           "runs": new_attempted,
                           "exclusion": "只取 new.runs（V2 新版运行）。"}},
        "old": {"runtime_group": GROUP_V1, "paired": _paired(old_side),
                "attempted": old_attempted,
                "source": {"file": DATA["version_regression"],
                           "runs": old_attempted,
                           "exclusion": "只取 old.runs（复用 MVP 基线读数，不新增样本）。"}},
        "comparison": {
            "resolved": resolved,
            "tokens": tokens,
            "paired_net": {"new": _paired(new_side), "old": _paired(old_side)},
            "notes": [
                "V2 = plugin 0.6.1 / DSH 0.2.2-rc.1，5 任务 × 2 臂最小回归；"
                "old 是 MVP 基线读数复用（不新增样本）。",
                "旧结论：B 组 4/5 无回归；A 少 1 个是 packaging 98.64% 边缘失败；"
                "成本明显上升（UI/session 口径 +77%）。",
            ],
        },
    }


# ---------------------------------------------------------------------------
# not_run 清单 & 快照盘点 & analysis 自洽校验
# ---------------------------------------------------------------------------
def _executed_manifests() -> set:
    executed = set()
    for exp in EXPERIMENTS:
        for side in exp["sides"]:
            executed.add(side["manifest"])
    return executed


def _not_run_manifests() -> list:
    executed = _executed_manifests()
    out = []
    reg_dir = REPO / REGRESSION_MANIFEST_DIR
    for path in sorted(reg_dir.glob("*.yml")):
        rel = str(path.relative_to(REPO))
        if rel in executed:
            continue
        manifest = yaml.safe_load(path.read_text(encoding="utf-8"))
        tasks = manifest.get("tasks") or []
        arms = sorted((manifest.get("arms") or {}).keys())
        reason = ("V2 最小回归只执行了 mvp.yml（5 任务 × 2 臂）；"
                  "其余预注册清单保持 not_run，不补跑。")
        entry = {
            "path": rel,
            "sha256": _sha256(path),
            "date": str(manifest.get("date")),
            "tasks": len(tasks),
            "arms": arms,
            "planned_runs": len(tasks) * len(arms),
            "runtime_group": GROUP_V2,
            "reason": reason,
        }
        if path.name == "2x2.yml":
            entry["pilot_runs"] = 1
            entry["reason"] = (reason + " 2x2.yml 出现过 1 条 pilot 探索 run"
                                       "（status=pilot，不进 V1/V2 分母），不计为已执行。")
        out.append(entry)
    return out


def _snapshot_inventory(docs: dict) -> dict:
    by_experiment = {}
    total = 0
    for exp in EXPERIMENTS:
        count = sum(len(_side_rows(side, docs)) for side in exp["sides"])
        by_experiment[exp["id"]] = count
        total += count

    # version-regression old 侧是否真是 MVP 基线运行的复用（同 task/arm 且证据字段一致）。
    mvp_rows = EXTRACTORS["plain"](docs["mvp"])
    old_rows = EXTRACTORS["v2old"](docs["version_regression"])
    base_by_key = {(r.get("task_id"), r.get("arm")): r for r in mvp_rows}
    dup_fields = ("tokens", "elapsed_seconds", "resolved", "pass_rate",
                  "patch_chars", "image", "image_digest", "agent_failure")
    duplicated = 0
    for r in old_rows:
        base = base_by_key.get((r.get("task_id"), r.get("arm")))
        if base and all(r.get(f) == base.get(f) for f in dup_fields):
            duplicated += 1
    return {
        "source": {
            "files": [spec["path"] for exp in EXPERIMENTS
                      for side in exp["sides"] for spec in side["data"]
                      if spec["role"] == "report"],
            "rows": total,
            "exclusion": "只统计 7 个已提交机读快照里的 run 行；version-regression "
                         "old 与 MVP 重复，duplicate_baseline_rows 单独计数。",
        },
        "total_rows": total,
        "by_experiment": by_experiment,
        "duplicate_baseline_rows": duplicated,
        "duplicate_baseline_detail": {
            "experiment": "version-regression-2026-11-08",
            "side": "old",
            "duplicates_of": "mvp-2026-11-06",
            "fields_compared": list(dup_fields),
        },
        "deduped_rows": total - duplicated,
        "not_in_snapshots": {
            "pilot_runs": 1,
            "note": "V2 pilot 1 run（/tmp 本地目录）未进入已提交快照；"
                    "canonical run 表见 data-auditor 的 featurebench-runs.jsonl。",
        },
        "physical_runs_note": "canonical 行数 ≠ 物理运行次数：pilot 行与 V2 "
                              "packaging/standard 是同一次物理运行；物理运行去重见 "
                              "docs/evals/featurebench-evidence-index.json 的 "
                              "counts.distinct_physical_runs / cross_references。"
                              "本 metrics 不聚合 attempts（runs.jsonl 里部分行的 "
                              "matrix.json 被子集重跑覆盖，口径见 env-identity）。",
        "canonical_expected_rows": (total - duplicated) + 1,
    }


def _diff_json(committed, recomputed, ignore_keys=frozenset(), path="") -> list:
    """逐项比较 JSON 值，返回人类可读的差异列表；浮点用 1e-9 容差。"""
    diffs = []
    if isinstance(committed, bool) or isinstance(recomputed, bool):
        if committed is not recomputed:
            diffs.append(f"{path or '/'}: committed={committed!r} recomputed={recomputed!r}")
        return diffs
    if isinstance(committed, dict) and isinstance(recomputed, dict):
        keys = sorted(set(committed) | set(recomputed))
        for key in keys:
            if key in ignore_keys:
                continue
            child = f"{path}/{key}"
            if key not in committed:
                diffs.append(f"{child}: 已提交缺失，重算有值")
            elif key not in recomputed:
                diffs.append(f"{child}: 重算缺失，已提交有值")
            else:
                diffs.extend(_diff_json(committed[key], recomputed[key],
                                        ignore_keys, child))
        return diffs
    if isinstance(committed, list) and isinstance(recomputed, list):
        if len(committed) != len(recomputed):
            diffs.append(f"{path or '/'}: 列表长度 committed={len(committed)} "
                         f"recomputed={len(recomputed)}")
        for idx, (left, right) in enumerate(zip(committed, recomputed)):
            diffs.extend(_diff_json(left, right, ignore_keys, f"{path}[{idx}]"))
        return diffs
    if isinstance(committed, (int, float)) and isinstance(recomputed, (int, float)):
        if not math.isclose(float(committed), float(recomputed),
                            rel_tol=REL_TOL, abs_tol=ABS_TOL):
            diffs.append(f"{path or '/'}: committed={committed!r} "
                         f"recomputed={recomputed!r}")
        return diffs
    if committed != recomputed:
        diffs.append(f"{path or '/'}: committed={committed!r} recomputed={recomputed!r}")
    return diffs


def _analysis_checks(docs: dict) -> list:
    """用已提交快照重算 4 个 analyze_* 的输出，与已提交 analysis/confusion 对账。"""
    checks = []

    def _as_written(value):
        # 已提交 analysis 是 CLI 写出的 JSON 文件；先做一次 JSON 往返，避免
        # Python dict 的 int key（如 repeat 的 rep_diffs）与 JSON 的 str key 直接不等。
        return json.loads(json.dumps(value, ensure_ascii=False))

    def _record(label, committed, recomputed, ignore_keys):
        diffs = _diff_json(committed, _as_written(recomputed), ignore_keys)
        checks.append({
            "source": label,
            "status": "match" if not diffs else "mismatch",
            "diff_count": len(diffs),
            "diffs": diffs[:10],
        })

    _record(f"{DATA['2x2']}#analysis",
            docs["2x2"]["analysis"],
            analyze_2x2.compute(docs["2x2"]["report"]),
            frozenset({"data"}))
    _record(f"{DATA['expanded']}#analysis",
            docs["expanded"]["analysis"],
            analyze_expanded.compute(docs["expanded"]["report"]),
            frozenset({"data"}))
    _record(f"{DATA['verifier']}#confusion",
            docs["verifier"]["confusion"],
            analyze_verifier.compute(docs["verifier"]["report"]),
            frozenset({"data"}))
    _record(f"{DATA['stress_confusion']}",
            docs["stress_confusion"],
            analyze_verifier.compute({"runs": docs["stress"]["runs"]}),
            frozenset({"data"}))
    _record(f"{DATA['repeat']}#analysis",
            docs["repeat"]["analysis"],
            analyze_repeat.compute(docs["repeat"]["reps"]),
            frozenset({"data", "reps"}))
    return checks


# ---------------------------------------------------------------------------
# metrics 生成
# ---------------------------------------------------------------------------
def compute_metrics(docs: dict) -> dict:
    runs = _load_runs_jsonl()
    experiments = {}
    for exp in EXPERIMENTS:
        sides = {}
        for side in exp["sides"]:
            sides[side["id"]] = _side_metrics(side, docs)
        experiments[exp["id"]] = {
            "experiment": exp["experiment"],
            "date": exp["date"],
            "runtime_groups": sorted({s["runtime_group"] for s in exp["sides"]}),
            "sides": sides,
        }
    return {
        "schema_version": 1,
        "generated_by": "tools/evals/featurebench/reaggregate.py",
        "definitions": {
            "attempted": "快照里出现的 run 行数（含超时/失败/缺官方评分的 run），不静默剔除。",
            "scoreable": "带官方评分结果（resolved 字段）的 run。",
            "itt_resolved_rate": "resolved / attempted：缺官方评分的 run 按未解决计入。",
            "pp_resolved_rate": "resolved / scoreable（per-protocol：只看官方评过分的那部分）。",
            "paired_W_L_T": "A=standard 为参照：W=B resolved 且 A unresolved；"
                            "L=A resolved 且 B unresolved；T=两者相同。PP 只算两臂都 "
                            "scoreable 的对，ITT 把缺臂按 unresolved 计入。",
            "tokens": "只取 scoreable 行的数值；median/mean/p90 复用 analyze_expanded 实现；"
                      "total 为样本和。",
            "failure_classes": "来自快照 agent_failure 字段（timeout/over_budget/"
                               "turn_error 等）；官方 unresolved 属成绩、不属 agent 失败。",
            "comparable_panel": "V1 内可比配对面板，见 tools/evals/featurebench/"
                                "reaggregate.py 的模块 docstring。",
        },
        "experiments": experiments,
        "comparable_pairs": _comparable_panel(experiments),
        "verifier_confusion": _verifier_confusion(docs, runs),
        "version_regression": _version_regression(docs, experiments),
        "not_run": {
            "v2_regression_manifests": _not_run_manifests(),
            "note": "预注册但未执行的 V2 清单只登记、不补跑；执行与否由用户预算决定。",
        },
        "snapshot_inventory": _snapshot_inventory(docs),
    }


# ---------------------------------------------------------------------------
# baseline-index 生成
# ---------------------------------------------------------------------------
def _runtime_group_record(runtime: dict, description: str) -> dict:
    return {
        "plugin_package": runtime.get("plugin_package"),
        "plugin_version": runtime.get("plugin_version"),
        "plugin_tarball_sha256": runtime.get("plugin_tarball_sha256"),
        "dsh_cli": runtime.get("dsh_cli"),
        "provider": runtime.get("provider"),
        "model": runtime.get("model"),
        "reasoning_effort": runtime.get("reasoning_effort"),
        "description": description,
    }


def _load_runs_jsonl():
    path = REPO / RUNS_JSONL
    if not path.exists():
        return None
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def _time_window(exp: dict, side: dict, runs: list) -> dict:
    if runs is None:
        return {"started_at_min": None, "started_at_max": None,
                "source": f"{RUNS_JSONL} 未生成（data-auditor 产出缺失）"}
    matched = []
    if exp["experiment"] == "version-regression" and side["id"] == "new":
        matched = [r for r in runs
                   if r.get("manifest") == MANIFESTS["regression-mvp"]
                   and r.get("runtime_group") == GROUP_V2]
    elif exp["experiment"] in ("mvp", "version-regression"):
        # version-regression 的 old 侧直接复用 MVP 的同一批运行读数（canonical 表里
        # 不重复出行），所以时间窗与 MVP 相同。
        matched = [r for r in runs
                   if r.get("manifest") == MANIFESTS["base"]
                   and r.get("runtime_group") == GROUP_V1]
    else:
        matched = [r for r in runs if r.get("manifest") == side["manifest"]]
    times = [r.get("started_at") for r in matched
             if isinstance(r.get("started_at"), str)]
    if not times:
        return {"started_at_min": None, "started_at_max": None,
                "source": f"{RUNS_JSONL} 中未匹配到 started_at（rows={len(matched)}）"}
    return {"started_at_min": min(times), "started_at_max": max(times),
            "source": f"{RUNS_JSONL}（matched_rows={len(matched)}）"}


def _image_table(docs: dict) -> dict:
    base = _load_yaml(MANIFESTS["base"])
    images = {}
    for task in base["tasks"]:
        images[task["repo"]] = {
            "official_image": task["image"],
            "image_digest": task["image_digest"],
            "derived_images": {},
        }
    seen = {}
    for exp in EXPERIMENTS:
        for side in exp["sides"]:
            group = side["runtime_group"]
            for row in _side_rows(side, docs):
                repo = row.get("repo")
                image = row.get("image")
                digest = row.get("image_digest")
                if repo not in images:
                    raise SystemExit(f"镜像表缺少 repo {repo}（出现在 {exp['id']}）")
                if digest != images[repo]["image_digest"]:
                    raise SystemExit(
                        f"镜像 digest 不一致：{repo} 快照={digest} "
                        f"manifest={images[repo]['image_digest']}")
                key = (repo, group)
                if key in seen and seen[key] != image:
                    raise SystemExit(f"同 repo/group 出现多个镜像名：{repo} {group}")
                seen[key] = image
    for (repo, group), image in sorted(seen.items()):
        images[repo]["derived_images"][group] = image
    return images


def build_index(docs: dict) -> dict:
    base = _load_yaml(MANIFESTS["base"])
    reg_base = _load_yaml(MANIFESTS["regression-mvp"])
    runtime_groups = {
        GROUP_V1: _runtime_group_record(base["runtime"],
                                        "V1：plugin 0.6.0 / DSH 0.2.1-rc.5"),
        GROUP_V2: _runtime_group_record(reg_base["runtime"],
                                        "V2：plugin 0.6.1 / DSH 0.2.2-rc.1"),
    }
    benchmark = base.get("benchmark") or {}
    package = str(benchmark.get("package") or "")
    grader_name, _, grader_version = package.partition("==")
    runs = _load_runs_jsonl()
    manifest_cache = {}

    def _manifest(rel: str) -> dict:
        if rel not in manifest_cache:
            manifest_cache[rel] = _load_yaml(rel)
        return manifest_cache[rel]

    experiments = []
    for exp in EXPERIMENTS:
        sides = []
        for side in exp["sides"]:
            rows = _side_rows(side, docs)
            manifest = _manifest(side["manifest"])
            data_entries = []
            for dspec in side["data"]:
                selected = _select_rows(docs[dspec["doc"]], dspec["runs_selector"])
                data_entries.append({
                    "path": dspec["path"],
                    "sha256": _sha256(REPO / dspec["path"]),
                    "role": dspec["role"],
                    "runs_selector": dspec["runs_selector"],
                    "rows": len(selected),
                })
            sides.append({
                "id": side["id"],
                "runtime_group": side["runtime_group"],
                "manifest": {
                    "path": side["manifest"],
                    "sha256": _sha256(REPO / side["manifest"]),
                },
                "data": data_entries,
                "manifest_task_ids": [str(t.get("id")) for t in manifest["tasks"]],
                "observed_task_ids": sorted({str(r.get("task_id")) for r in rows}),
                "counts": {**_counts_from_rows(rows), "repeats": side["repeats"]},
                "time_window": _time_window(exp, side, runs),
                "notes": list(side.get("notes") or []),
            })
        experiments.append({
            "id": exp["id"],
            "experiment": exp["experiment"],
            "date": exp["date"],
            "runtime_groups": sorted({s["runtime_group"] for s in exp["sides"]}),
            "sides": sides,
        })

    artifacts = {"runs_jsonl": None, "evidence_index": None}
    if runs is not None:
        artifacts["runs_jsonl"] = {
            "path": RUNS_JSONL,
            "sha256": _sha256(REPO / RUNS_JSONL),
            "rows": len(runs),
        }
    evidence_path = REPO / EVIDENCE_INDEX
    if evidence_path.exists():
        artifacts["evidence_index"] = {
            "path": EVIDENCE_INDEX,
            "sha256": _sha256(evidence_path),
        }

    return {
        "schema_version": 1,
        "generated_by": "tools/evals/featurebench/reaggregate.py",
        "benchmark": {
            "name": benchmark.get("name"),
            "grader": {"package": grader_name, "version": grader_version},
            "dataset": {
                "repo": benchmark.get("dataset"),
                "revision": benchmark.get("revision"),
                "split": benchmark.get("split"),
            },
        },
        "runtime_groups": runtime_groups,
        "images": _image_table(docs),
        "experiments": experiments,
        "not_run_manifests": _not_run_manifests(),
        "artifacts": artifacts,
        "audit_level": {
            "level": "L2",
            "definition": "已提交汇总数据 + 机读推导指标 + 文件 sha256 索引；"
                          "本机原始 evidence（runs.jsonl / evidence-index.json）"
                          "只提交 hash 与汇总，原始 patch/session 不公开。",
        },
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")


def _verifier_confusion_crosscheck(metrics: dict) -> dict:
    """把 canonical 主会话口径的混淆矩阵与 data-auditor 的审计文件交叉校验。

    两者独立生成（不同脚本、不同解析路径）但必须给出同样的数字；不一致说明
    runs.jsonl 或某一侧的裁决解析坏了。对方文件缺失时 skip（CI 里 audit_runs 步骤
    会保证它存在）。
    """
    result = {"source": VERIFIER_CONFUSION_CANONICAL, "status": "match",
              "diffs": [], "reason": None}
    missing = []
    canonical = ((metrics.get("verifier_confusion") or {})
                 .get("canonical_main_session_scope"))
    if canonical is None:
        result["status"] = "skipped"
        result["reason"] = "runs.jsonl 缺失，无法构造 canonical 口径"
        return result
    path = REPO / VERIFIER_CONFUSION_CANONICAL
    if not path.exists():
        result["status"] = "skipped"
        result["reason"] = "data-auditor 的 verifier-confusion.json 缺失"
        return result
    data = json.loads(path.read_text(encoding="utf-8"))
    conf = data.get("confusion") or {}
    for scope, key in (("v1_b_runs", "v1_all_b_runs"),
                       ("v2_b_runs", "v2_all_b_runs"),
                       ("all_b_runs", "all_b_runs")):
        theirs = conf.get(scope) or {}
        counts = theirs.get("counts") or {}
        denom = theirs.get("denominators") or {}
        mine = canonical[key]
        expected = {
            "sdlc_runs": denom.get("all_b_runs"),
            "official_resolved": theirs.get("official_resolved"),
            "approve_resolved": counts.get("approve_resolved"),
            "approve_unresolved_false_positive":
                counts.get("approve_unresolved_false_positive"),
            "reject_unresolved": counts.get("reject_unresolved"),
            "reject_resolved_false_negative":
                counts.get("reject_resolved_false_negative"),
            "needs_human": counts.get("needs_human"),
            "no_verdict": counts.get("no_verdict"),
        }
        actual = {"sdlc_runs": mine["sdlc_runs"],
                  "official_resolved": mine["official_resolved"],
                  **mine["confusion"]}
        for field, value in expected.items():
            if value is None:
                missing.append(f"{scope}.{field}")
            elif actual.get(field) != value:
                result["diffs"].append(
                    f"{scope}.{field}: data-auditor={value} "
                    f"reaggregate={actual.get(field)}")
    if result["diffs"]:
        result["status"] = "mismatch"
        result["diffs"] = result["diffs"][:10]
    elif missing:
        # 对方文件是审计线产物、允许小幅调整 schema；字段缺失时降级为 skip，
        # 数值不一致仍然 fail（避免把「字段改名」误报成数据不一致）。
        result["status"] = "skipped"
        result["reason"] = ("data-auditor 文件缺少预期字段（schema 微调中），"
                            f"跳过交叉校验: {missing[:6]}")
    return result


def _run_checks(docs: dict, metrics_path: Path) -> int:
    if not metrics_path.exists():
        print(f"[reaggregate] 缺少已提交 metrics：{metrics_path}", file=sys.stderr)
        return 2
    committed = json.loads(metrics_path.read_text(encoding="utf-8"))
    recomputed = compute_metrics(docs)
    diffs = _diff_json(committed, recomputed)
    checks = _analysis_checks(docs)
    bad_checks = [c for c in checks if c["status"] != "match"]
    crosscheck = _verifier_confusion_crosscheck(recomputed)

    ok = not diffs and not bad_checks and crosscheck["status"] != "mismatch"
    if diffs:
        print(f"[reaggregate] metrics 与重算不一致：{len(diffs)} 处", file=sys.stderr)
        for line in diffs[:20]:
            print(f"  - {line}", file=sys.stderr)
        if len(diffs) > 20:
            print(f"  ... 其余 {len(diffs) - 20} 处省略", file=sys.stderr)
    else:
        print("[reaggregate] metrics: 与已提交 baseline-metrics 逐项一致 "
              f"（{len(recomputed['experiments'])} experiments）")
    for check in checks:
        print(f"[reaggregate] analysis {check['status']}: {check['source']} "
              f"(diff={check['diff_count']})")
        if check["status"] != "match":
            for line in check["diffs"][:5]:
                print(f"  - {line}", file=sys.stderr)
    print(f"[reaggregate] verifier-confusion crosscheck {crosscheck['status']}: "
          f"{crosscheck['source']}")
    if crosscheck["status"] == "skipped":
        print(f"  - skipped: {crosscheck['reason']}")
    for line in crosscheck["diffs"]:
        print(f"  - {line}", file=sys.stderr)
    if ok:
        print("[reaggregate] check OK")
        return 0
    print("[reaggregate] check FAILED", file=sys.stderr)
    return 1


def main() -> int:
    ap = argparse.ArgumentParser(
        description="FeatureBench 离线复算（只读已提交快照；不联网、不调模型）")
    ap.add_argument("--out", default=str(DEFAULT_METRICS),
                    help="baseline metrics 输出/比对路径")
    ap.add_argument("--index", default=str(DEFAULT_INDEX),
                    help="baseline index 输出路径")
    ap.add_argument("--check", action="store_true",
                    help="只对账不写文件：与已提交 metrics 逐项比对并重算 analysis")
    args = ap.parse_args()

    docs = {}
    for key, rel in DATA.items():
        path = REPO / rel
        if not path.exists():
            print(f"[reaggregate] 缺少数据快照：{rel}", file=sys.stderr)
            return 2
        docs[key] = json.loads(path.read_text(encoding="utf-8"))

    metrics_path = Path(args.out)
    index_path = Path(args.index)

    if args.check:
        return _run_checks(docs, metrics_path)

    # 生成前先自检：已提交 analysis 必须能被对应的 analyze_* 纯函数精确重算，且
    # canonical 混淆矩阵必须与 data-auditor 的审计文件一致，否则拒绝写出。
    metrics = compute_metrics(docs)
    checks = _analysis_checks(docs)
    bad = [c for c in checks if c["status"] != "match"]
    crosscheck = _verifier_confusion_crosscheck(metrics)
    if crosscheck["status"] == "mismatch":
        bad = bad + [{"source": crosscheck["source"], "diff_count":
                      len(crosscheck["diffs"]), "diffs": crosscheck["diffs"]}]
    if bad:
        print("[reaggregate] 自检失败，拒绝生成 metrics：", file=sys.stderr)
        for c in bad:
            print(f"  - {c['source']}: {c['diff_count']} 处差异", file=sys.stderr)
            for line in c["diffs"][:10]:
                print(f"    {line}", file=sys.stderr)
        return 1

    index = build_index(docs)
    _write_json(metrics_path, metrics)
    _write_json(index_path, index)
    print(f"[reaggregate] wrote {metrics_path} "
          f"({len(metrics['experiments'])} experiments, "
          f"{metrics['snapshot_inventory']['total_rows']} snapshot rows)")
    print(f"[reaggregate] wrote {index_path} "
          f"({len(index['experiments'])} experiments, "
          f"{len(index['not_run_manifests'])} not-run manifests)")
    for check in checks:
        print(f"[reaggregate] analysis {check['status']}: {check['source']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
