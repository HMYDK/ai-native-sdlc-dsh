#!/usr/bin/env python3
"""把本地 FeatureBench runs 汇总成 EVAL-01 的 canonical run 表与审计数据。

为什么需要这个脚本：issue #12 的 AC-002/AC-004/AC-005/AC-006 要求把历史评测从
「作者口头汇总」变成「逐 run 可追溯、可程序化校验」的数据。原始 runs（约 2.3GB，
含 prompt/session）不提交；本脚本在**本机**读原始产物，生成提交到仓库的：

  docs/evals/featurebench-runs.jsonl              canonical run 表（96 行）
  docs/evals/featurebench-evidence-index.json     逐 run artifact sha256 + 归档锚点
  docs/evals/featurebench-env-identity.json       环境身份（版本/镜像/预算/时间窗）
  docs/evals/featurebench-leak-audit.json         泄漏扫描 + patch vs gold + A/B 补丁同一性
  docs/evals/featurebench-verifier-confusion.json 验证者裁决 vs 官方评分

特点是**本地一次性、离线、确定性**：不联网、不调模型、不 docker run；不写任何生成
时间戳；输出顺序与 key 全部固定，同一输入重跑逐字节一致。

运行环境（重要）：建议用本机 featurebench 的 uv python 运行，因为它自带
`pyarrow`（读 HF dataset 缓存里的 gold patch）与 `zstandard`（从 session 解出
UI 缺失时的 token、以及 sdlc_verify 裁决）。路径可用
`uv tool dir featurebench` 定位，示例：

    <featurebench-venv>/bin/python tools/evals/featurebench/collect_runs.py

缺少 pyarrow/zstandard 时会降级并写清缺口（见各 JSON 的 known_gaps /
gold_comparison.available），但正式产物需用上述 python 生成。

口径（与 docs/evals/featurebench-review-guide.md 一致）：
- V1 = plugin 0.6.0 + DSH CLI 0.2.1-rc.5，85 个 run；V2 = plugin 0.6.1 +
  DSH 0.2.2-rc.1，仅 `regression-0.6.1/mvp.yml` 的 10 个 run；pilot = 1 个探索 run。
  三者不混算。
- `attempts` 只取 matrix.json 里记录的每 run 尝试数；matrix.json 被子集重跑覆盖时
  该字段为 null（不猜）。详见 env-identity.json 的 attempts_reconciliation。
- `verify_verdicts` 取**主会话**（session-*.jsonl.zstd）里 sdlc_verify 工具结果中的
  raw_status 序列；验证者子会话里的同名 JSON 不重复计数（否则一次调用会被数两遍）。
- `official` 只来自官方 `fb eval` 的 report.json，不用 agent 的 DONE/approve。
- run 身份 = (experiment, task_id, arm, repeat)。version-regression 的 `old` 10 行
  是复用首批数据，作为 snapshot 映射里的 duplicate_baseline，不在 canonical 表里
  重复出现。
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

DEFAULT_RUNS_BASE = Path("/tmp")
DEFAULT_ARCHIVE = Path.home() / ".dsh-eval-archive" / "2026-11-08"
ARCHIVE_LABEL = "~/.dsh-eval-archive/2026-11-08"
DEFAULT_DATASET_CACHE = (
    Path.home()
    / ".cache/huggingface/datasets/LiberCoders___feature_bench/default/0.0.0/"
    "76b4a4566e04f4bcc13c35125d4f301791efa736"
)
DATASET_CACHE_LABEL = (
    "~/.cache/huggingface/datasets/LiberCoders___feature_bench/default/0.0.0/"
    "76b4a4566e04f4bcc13c35125d4f301791efa736"
)

DATASET = {
    "name": "LiberCoders/FeatureBench",
    "revision": "76b4a4566e04f4bcc13c35125d4f301791efa736",
    "split": "fast",
    "instances_in_split": 100,
    "grader": "featurebench==0.3.0",
}
MODEL = {
    "provider": "deepseek-account",
    "model": "deepseek-flash",
    "reasoning_effort": "max",
    "note": "只记录请求参数；模型实际服务的 version/build 不可观测，UI 品牌串不可作为版本证据",
}

RUNTIME_GROUPS = {
    "v1": {
        "id": "v1-0.6.0-0.2.1-rc.5",
        "label": "V1: plugin 0.6.0 + DSH CLI 0.2.1-rc.5",
        "dsh_cli": "0.2.1-rc.5",
        "plugin_version": "0.6.0",
        "plugin_tarball_sha256": "bac39b42037ea09747fbf5924d7d2cda1381ca31d7b039843fc4f46d8ee6dc88",
    },
    "v2": {
        "id": "v2-0.6.1-0.2.2-rc.1",
        "label": "V2: plugin 0.6.1 + DSH 0.2.2-rc.1",
        "dsh_cli": "0.2.2-rc.1",
        "plugin_version": "0.6.1",
        "plugin_tarball_sha256": "da201253cd412beed5e49f1e1830171a608c39d1ea37140b755f0c780203e0b7",
    },
    "pilot": {
        "id": "pilot",
        "label": "Pilot: plugin 0.6.1 + DSH 0.2.2-rc.1（探索性单 run，独立分组，不进 V1/V2 分母）",
        "dsh_cli": "0.2.2-rc.1",
        "plugin_version": "0.6.1",
        "plugin_tarball_sha256": "da201253cd412beed5e49f1e1830171a608c39d1ea37140b755f0c780203e0b7",
    },
}

# 实验定义。root_rel 相对 runs base（默认 /tmp）；layout:
#   flat      —— root/<task_id>/<arm>/
#   legacy    —— root/<repo__name>/<arm>/（首批 5 个 repo 目录，且同时存在 pypa__packaging）
#   rep       —— root/rep<N>/<task_id>/<arm>/
# b_arm: 该实验里与 A(standard) 配对的 treatment arm（进入 #8 的 paired 口径）
EXPERIMENTS = [
    {
        "name": "mvp",
        "group": "v1",
        "manifest_rel": "tools/evals/featurebench/manifest.yml",
        "root_rel": "fb-runs",
        "layout": "legacy",
        "b_arm": "sdlc",
    },
    {
        "name": "2x2",
        "group": "v1",
        "manifest_rel": "tools/evals/featurebench/manifests/2x2.yml",
        "root_rel": "fb-runs-2x2",
        "layout": "flat",
        "b_arm": "sdlc_guidance",
    },
    {
        "name": "expanded",
        "group": "v1",
        "manifest_rel": "tools/evals/featurebench/manifests/expanded.yml",
        "root_rel": "fb-runs-expanded",
        "layout": "flat",
        "b_arm": "sdlc",
    },
    {
        "name": "verify-calibration",
        "group": "v1",
        "manifest_rel": "tools/evals/featurebench/manifests/verify-calibration.yml",
        "root_rel": "fb-runs-verify",
        "layout": "flat",
        "b_arm": "sdlc",
    },
    {
        "name": "verify-stress",
        "group": "v1",
        "manifest_rel": "tools/evals/featurebench/manifests/verify-stress.yml",
        "root_rel": "fb-runs-stress",
        "layout": "rep",
        "b_arm": "sdlc",
    },
    {
        "name": "repeat-sampling",
        "group": "v1",
        "manifest_rel": "tools/evals/featurebench/manifests/repeat-sampling.yml",
        "root_rel": "fb-runs-repeat",
        "layout": "rep",
        "b_arm": "sdlc",
    },
    {
        "name": "version-regression-mvp",
        "group": "v2",
        "manifest_rel": "tools/evals/featurebench/manifests/regression-0.6.1/mvp.yml",
        "root_rel": "fb-runs-regression-mvp",
        "layout": "flat",
        "b_arm": "sdlc",
    },
    {
        "name": "pilot",
        "group": "pilot",
        "manifest_rel": "tools/evals/featurebench/manifests/regression-0.6.1/2x2.yml",
        "root_rel": "fb-runs-regression-pilot",
        "layout": "flat",
        "b_arm": None,
        "allow_partial": True,
    },
]
EXPERIMENT_ORDER = {e["name"]: i for i, e in enumerate(EXPERIMENTS)}
ARM_ORDER = {"standard": 0, "standard_guidance": 1, "sdlc": 2, "sdlc_guidance": 3}
A_ARMS = ("standard", "standard_guidance")
B_ARMS = ("sdlc", "sdlc_guidance")

# 已提交机读数据快照 → canonical 行映射。covers 105 个 snapshot 行：
# 其中 version-regression 的 old 10 行 → mvp（duplicate_baseline，不重复出 canonical 行）。
SNAPSHOTS = [
    {
        "path": "docs/evals/featurebench-2026-11-06-data.json",
        "sections": [{"keys": ("runs",), "experiment": "mvp", "relation": "primary"}],
    },
    {
        "path": "docs/evals/featurebench-2026-11-07-2x2-data.json",
        "sections": [{"keys": ("report", "runs"), "experiment": "2x2", "relation": "primary"}],
    },
    {
        "path": "docs/evals/featurebench-2026-11-07-expanded-data.json",
        "sections": [{"keys": ("report", "runs"), "experiment": "expanded", "relation": "primary"}],
    },
    {
        "path": "docs/evals/featurebench-2026-11-07-verifier-data.json",
        "sections": [{"keys": ("report", "runs"), "experiment": "verify-calibration",
                      "relation": "primary"}],
    },
    {
        "path": "docs/evals/featurebench-2026-11-07-verifier-stress-data.json",
        "sections": [{"keys": ("runs",), "experiment": "verify-stress", "relation": "primary",
                      "repeat_from_row": True}],
    },
    {
        "path": "docs/evals/featurebench-2026-11-08-repeat-sampling-data.json",
        "sections": [{"keys": ("reps",), "experiment": "repeat-sampling", "relation": "primary",
                      "reps": True}],
    },
    {
        "path": "docs/evals/featurebench-2026-11-08-version-regression-data.json",
        "sections": [
            {"keys": ("new", "runs"), "experiment": "version-regression-mvp",
             "relation": "primary"},
            {"keys": ("old", "runs"), "experiment": "mvp", "relation": "duplicate_baseline"},
        ],
    },
]

STATUSES = ("included", "duplicate_baseline", "pilot", "unscoreable_missing_official_result")

CANON_FIELDS = (
    "run_id", "experiment", "manifest", "runtime_group", "task_id", "repo", "arm", "repeat",
    "started_at", "attempts", "attempts_source", "tokens", "tokens_source", "elapsed_seconds",
    "agent_completed", "agent_failure", "dsh_cli", "dsh_cli_actual", "plugin_version",
    "plugin_version_actual", "image", "image_digest", "patch_chars", "patch_sha256",
    "official", "status", "exclusion_reason", "leak_scan_hits", "sdlc_tool_calls",
    "verify_verdicts",
)

RUN_POLICY_KEYS = (
    "timeout_seconds", "max_tokens_per_run", "total_token_budget", "infra_retries",
    "agent_retries", "order", "failure_classes",
)


# --------------------------------------------------------------------------- 工具函数


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_json(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def dump_json(p: Path, obj) -> None:
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                 encoding="utf-8")


def rel_to_repo(p: Path) -> str:
    return p.resolve().relative_to(REPO_ROOT).as_posix()


def manifest_sha256(rel: str) -> str:
    return sha256_file(REPO_ROOT / rel)


def load_manifest(rel: str) -> dict:
    return yaml.safe_load((REPO_ROOT / rel).read_text(encoding="utf-8"))


# --------------------------------------------------------------------------- zstandard


def _zstd_module():
    try:
        import zstandard  # type: ignore

        return zstandard
    except Exception:
        return None


def _walk_patch_strings(obj, verdicts: list, calls: dict) -> None:
    if isinstance(obj, dict):
        if obj.get("type") == "tool-call" and isinstance(obj.get("name"), str):
            calls[obj["name"]] = calls.get(obj["name"], 0) + 1
        for v in obj.values():
            _walk_patch_strings(v, verdicts, calls)
    elif isinstance(obj, list):
        for v in obj:
            _walk_patch_strings(v, verdicts, calls)
    elif isinstance(obj, str):
        for k in ("approve", "reject", "needs_human"):
            if f'"raw_status": "{k}"' in obj:
                verdicts.append(k)
                break


def parse_session_stats(arm_dir: Path) -> dict:
    """从会话日志统计 sdlc_* 工具调用与 sdlc_verify 裁决。

    裁决只取主会话（目录名以 session- 开头）——一次 sdlc_verify 调用在子验证者会话
    里也会留下 status JSON，全部文件都扫会把同一次调用数两遍。
    """
    zstandard = _zstd_module()
    zstd_files = sorted(arm_dir.rglob("*.zstd")) if arm_dir.exists() else []
    main = [p for p in zstd_files if p.parent.name.startswith("session-")]
    out = {
        "zstandard_available": zstandard is not None,
        "session_files": len(zstd_files),
        "main_session_files": [p.as_posix() for p in main],
        "main_sdlc_tool_calls": {},
        "verify_verdicts": [],
        "all_session_verify_verdicts": [],
    }
    if zstandard is None:
        return out
    for label, files in (("main", main), ("all", zstd_files)):
        calls: dict = {}
        verdicts: list = []
        for f in files:
            try:
                raw = zstandard.ZstdDecompressor().stream_reader(open(f, "rb")).read()
            except Exception:
                continue
            for line in raw.splitlines():
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                _walk_patch_strings(obj, verdicts, calls)
        if label == "main":
            out["main_sdlc_tool_calls"] = {
                k: v for k, v in sorted(calls.items()) if k.startswith("sdlc_")
            }
            out["verify_verdicts"] = verdicts
        else:
            out["all_session_verify_verdicts"] = verdicts
    return out


def session_tokens(arm_dir: Path):
    zstandard = _zstd_module()
    if zstandard is None:
        return None
    total = 0
    for f in sorted(arm_dir.rglob("*.zstd")):
        try:
            raw = zstandard.ZstdDecompressor().stream_reader(open(f, "rb")).read()
        except Exception:
            continue
        for line in raw.splitlines():
            try:
                obj = json.loads(line)
            except Exception:
                continue
            data = obj.get("data") or {}
            msg = data.get("message") if isinstance(data.get("message"), dict) else {}
            usage = msg.get("usage") or data.get("usage")
            if isinstance(usage, dict) and isinstance(usage.get("totalTokens"), int):
                total += usage["totalTokens"]
    return total or None


# --------------------------------------------------------------------------- 官方评分


def find_report(arm_dir: Path) -> tuple[Path | None, Path | None]:
    """返回 (task_dir, report.json)；fb eval 的 report 可能落在 task/eval-<arm>/ 或 arm/。"""
    arm = arm_dir.name
    task_dir = arm_dir.parent
    candidates = (
        task_dir / f"eval-{arm}" / "report.json",
        arm_dir / f"eval-{arm}" / "report.json",
        arm_dir / "report.json",
    )
    for c in candidates:
        if c.exists():
            return task_dir, c
    return task_dir, None


def official_metrics(report_path: Path | None) -> dict | None:
    if report_path is None:
        return None
    d = load_json(report_path)
    if not d or "attempt_1" not in d:
        return None
    a = d["attempt_1"]
    return {
        "resolved": bool(a.get("resolved_instances")),
        "pass_rate": a.get("pass_rate"),
        "resolved_rate": a.get("resolved_rate"),
        "errors": a.get("error_instances"),
        "not_applied_empty": a.get("not_applied_patch_empty_instances"),
        "report_sha256": sha256_file(report_path),
    }


# --------------------------------------------------------------------------- matrix.json


def load_attempts(exp: dict, runs_base: Path) -> dict:
    """matrix.json 的 (task, arm, repeat) -> attempts。文件被后来的 --retry-failed 子集
    覆盖时，未覆盖的 run 不在表里（上游返回 None，不猜）。

    rep-layout 必须把 repeat 放进 key：rep1/rep2/rep3 是三次独立尝试，不能把三个
    matrix.json 按 (task, arm) 合并取 max 再分给每一 rep（那会把一次重试复制成三次，
    伪造 provenance）。
    """
    root = runs_base / exp["root_rel"]
    paths: list[tuple[int, Path]] = []
    if exp["layout"] == "rep":
        for rep in (1, 2, 3):
            p = root / f"rep{rep}" / "matrix.json"
            if p.exists():
                paths.append((rep, p))
    else:
        p = root / "matrix.json"
        if p.exists():
            paths.append((1, p))
    out = {}
    for rep, p in paths:
        d = load_json(p) or {}
        for r in d.get("runs") or []:
            key = (r.get("task"), r.get("arm"), rep)
            val = r.get("attempts")
            if isinstance(val, int):
                out[key] = max(out.get(key, 0), val)
    return out


# --------------------------------------------------------------------------- snapshot


def snapshot_rows() -> tuple[list[dict], dict]:
    """展开已提交的 105 条机读数据快照行 → 与 canonical 的唯一身份对应。"""
    rows: list[dict] = []
    files = {}
    for spec in SNAPSHOTS:
        p = REPO_ROOT / spec["path"]
        d = load_json(p)
        if d is None:
            raise SystemExit(f"数据快照不存在或不可解析: {spec['path']}")
        files[spec["path"]] = {"sha256": sha256_file(p)}
        n_before = len(rows)
        for section in spec["sections"]:
            node = d
            for k in section["keys"]:
                node = node[k]
            items = node
            if section.get("reps"):
                flattened = []
                for idx, rep in enumerate(items, start=1):
                    for row in rep.get("runs") or []:
                        flattened.append((idx, row))
            else:
                flattened = [(None, row) for row in items]
            for rep_idx, row in flattened:
                exp = section["experiment"]
                if section.get("repeat_from_row"):
                    repeat = int(row.get("repeat") or 1)
                elif rep_idx is not None:
                    repeat = rep_idx
                else:
                    repeat = 1
                item = {
                    "snapshot": spec["path"].split("/")[-1],
                    "section": ".".join(section["keys"]),
                    "experiment": exp,
                    "repeat": repeat,
                    "relation": section["relation"],
                    "task_id": row["task_id"],
                    "arm": row["arm"],
                    "tokens": row.get("tokens"),
                    "tokens_source": row.get("tokens_source"),
                    "resolved": row.get("resolved"),
                    "patch_chars": row.get("patch_chars"),
                    "elapsed_seconds": row.get("elapsed_seconds"),
                    "agent_completed": row.get("agent_completed"),
                    "agent_failure": row.get("agent_failure"),
                    "leak_scan_hits": len(row.get("leak_scan_hits") or []),
                }
                rows.append(item)
        files[spec["path"]]["rows"] = len(rows) - n_before
    return rows, files


# --------------------------------------------------------------------------- 主收集


def collect_runs(runs_base: Path) -> tuple[list[dict], dict, dict, dict]:
    """返回 (canonical rows, per-experiment manifests, snapshot files info, meta extras)。"""
    snap_rows, snap_files = snapshot_rows()
    canonical: list[dict] = []
    manifests = {}
    extras = {}

    for exp in EXPERIMENTS:
        name = exp["name"]
        group = RUNTIME_GROUPS[exp["group"]]
        manifest = load_manifest(exp["manifest_rel"])
        manifests[name] = {
            "path": exp["manifest_rel"],
            "sha256": manifest_sha256(exp["manifest_rel"]),
            "experiment": name,
            "group": exp["group"],
        }
        tasks = {t["id"]: t for t in manifest["tasks"]}
        arms = list(manifest["arms"].keys())
        root = runs_base / exp["root_rel"]
        if not root.exists():
            raise SystemExit(f"runs root 不存在: {root}")
        attempts = load_attempts(exp, runs_base)
        extras[name] = {"attempts_map": attempts, "matrix_runs": len(attempts)}
        verdicts_by_key = load_report_data_verdicts(exp, root)
        expected = 0
        missing = []
        for task_id, task in tasks.items():
            rep_dirs = []
            if exp["layout"] == "rep":
                rep_dirs = [(rep, root / f"rep{rep}" / task_id) for rep in (1, 2, 3)]
            elif exp["layout"] == "legacy":
                task_dir = root / task["repo"].replace("/", "__")
                rep_dirs = [(1, task_dir)]
            else:
                rep_dirs = [(1, root / task_id)]
            for repeat, task_dir in rep_dirs:
                if not task_dir.exists():
                    if exp.get("allow_partial"):
                        continue
                    missing.append(str(task_dir))
                    continue
                for arm in arms:
                    expected += 1
                    arm_dir = task_dir / arm
                    if not (arm_dir / "meta.json").exists():
                        if exp.get("allow_partial"):
                            continue
                        missing.append(str(arm_dir))
                        continue
                    meta = load_json(arm_dir / "meta.json") or {}
                    if meta.get("task_id") != task_id or meta.get("arm") != arm:
                        raise SystemExit(f"meta.json 身份不符: {arm_dir}")
                    _, report_path = find_report(arm_dir)
                    official = official_metrics(report_path)
                    sess = parse_session_stats(arm_dir)
                    tokens = meta.get("token_usage")
                    tokens_source = "ui" if tokens is not None else None
                    if tokens is None:
                        tokens = session_tokens(arm_dir)
                        tokens_source = "session" if tokens is not None else None
                    attempts_val = attempts.get((task_id, arm, repeat))
                    verify_verdicts = sess["verify_verdicts"]
                    if not sess["zstandard_available"]:
                        verify_verdicts = verdicts_by_key.get((task_id, arm), [])
                    status = "included"
                    exclusion_reason = None
                    if exp["group"] == "pilot":
                        status = "pilot"
                        exclusion_reason = "pilot：探索性单 run，不进 V1/V2 分母"
                    elif official is None:
                        status = "unscoreable_missing_official_result"
                        exclusion_reason = (
                            "官方评分缺失：fb eval 因 HF dataset revision 'v1.1' 解析失败未产出 "
                            "report.json（环境失败，非 agent 失败；见 eval.log）"
                        )
                    row = {
                        "run_id": f"{name}:{task_id}:{arm}:r{repeat}",
                        "experiment": name,
                        "manifest": exp["manifest_rel"],
                        "runtime_group": group["id"],
                        "task_id": task_id,
                        "repo": task["repo"],
                        "arm": arm,
                        "repeat": repeat,
                        "started_at": meta.get("started_at"),
                        "attempts": attempts_val,
                        "attempts_source": "matrix.json" if attempts_val is not None else None,
                        "tokens": tokens,
                        "tokens_source": tokens_source,
                        "elapsed_seconds": meta.get("elapsed_seconds"),
                        "agent_completed": meta.get("agent_completed"),
                        "agent_failure": meta.get("agent_failure"),
                        "dsh_cli": meta.get("dsh_cli"),
                        "dsh_cli_actual": meta.get("dsh_cli_actual"),
                        "plugin_version": meta.get("plugin_version"),
                        "plugin_version_actual": meta.get("plugin_version_actual"),
                        "image": meta.get("image"),
                        "image_digest": meta.get("image_digest"),
                        "patch_chars": meta.get("patch_chars"),
                        "patch_sha256": meta.get("patch_sha256"),
                        "official": official,
                        "status": status,
                        "exclusion_reason": exclusion_reason,
                        "leak_scan_hits": len(meta.get("leak_scan_hits") or []),
                        "sdlc_tool_calls": meta.get("sdlc_tool_calls") or {},
                        "verify_verdicts": verify_verdicts,
                    }
                    extras.setdefault(name, {}).setdefault("runs", {})[
                        f"{task_id}:{arm}:r{repeat}"
                    ] = {
                        "arm_dir": arm_dir,
                        "report_path": report_path,
                        "session_stats": sess,
                        "verify_verdicts_report_data": verdicts_by_key.get((task_id, arm, repeat)),
                        "manifest_arm": arm,
                    }
                    canonical.append(row)
        if missing:
            raise SystemExit(
                f"{name}: 预注册 run 缺失 {len(missing)} 个（不允许静默跳过）: {missing[:5]}"
            )
        extras[name]["expected_runs"] = expected

    canonical.sort(
        key=lambda r: (
            EXPERIMENT_ORDER[r["experiment"]],
            r["task_id"],
            ARM_ORDER.get(r["arm"], 99),
            r["repeat"],
        )
    )
    return canonical, manifests, snap_files, extras


def load_report_data_verdicts(exp: dict, root: Path) -> dict:
    """summarize_runs.py 生成的 report-data.json → (task, arm, repeat) -> verify_verdicts。

    兜底用途（zstandard 缺失时）与 build_legacy_confusion 都依赖它。rep-layout 必须把
    repeat 放进 key：三个 rep 的 report-data 是独立运行，按 (task, arm) 会互相覆盖，
    导致 legacy 混淆矩阵把三个 rep 都算成最后一个 rep 的裁决。
    """
    paths: list[tuple[int, Path]] = []
    if exp["layout"] == "rep":
        paths = [(rep, root / f"rep{rep}" / "report-data.json") for rep in (1, 2, 3)]
    else:
        paths = [(1, root / "report-data.json")]
    out: dict = {}
    for rep, p in paths:
        d = load_json(p)
        if not d:
            continue
        for row in d.get("runs") or []:
            if "verify_verdicts" in row:
                out[(row["task_id"], row["arm"], rep)] = row["verify_verdicts"]
    return out


# --------------------------------------------------------------------------- 证据索引


def load_archive_sums(archive: Path) -> tuple[dict, dict]:
    sums_path = archive / "SHA256SUMS.txt"
    if not sums_path.exists():
        return {}, {"available": False}
    entries = {}
    for line in sums_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        digest, sep, path = line.partition("  ")
        if not sep:
            continue
        entries[path] = digest
    info = {
        "available": True,
        "sha256sums_sha256": sha256_file(sums_path),
        "sha256sums_entries": len(entries),
        "sha256sums_sha256_definition": "SHA256SUMS.txt 文件本身的 sha256（归档锚点）",
    }
    return entries, info


def build_evidence_index(
    canonical: list[dict],
    extras: dict,
    runs_base: Path,
    archive: Path,
    snap_files: dict,
) -> dict:
    archive_sums, archive_info = load_archive_sums(archive)
    archive_info["label"] = ARCHIVE_LABEL
    archive_info["scope"] = (
        "本机持久归档：8 个 runs root 的完整文件树（含 session 原件）+ SHA256SUMS.txt；"
        "原始内容不提交，仓库只提交逐 artifact hash 与该锚点"
    )
    runs = []
    artifact_count = 0
    archive_checked = 0
    archive_mismatch = 0
    archive_missing = []
    for row in canonical:
        name = row["experiment"]
        arm = row["arm"]
        key = f"{row['task_id']}:{arm}:r{row['repeat']}"
        info = extras[name]["runs"][key]
        arm_dir: Path = info["arm_dir"]
        task_dir, _ = find_report(arm_dir)
        artifacts = {}
        for fname in ("meta.json", "patch.diff", "predictions.jsonl", "leak_scan.txt"):
            p = arm_dir / fname
            if p.exists():
                artifacts[fname] = {"path": rel_artifact(p, runs_base),
                                    "sha256": sha256_file(p)}
        _, report_path = find_report(arm_dir)
        if report_path is not None:
            artifacts["eval_report"] = {
                "path": rel_artifact(report_path, runs_base),
                "sha256": sha256_file(report_path),
            }
        # task_dir 已由上面的 find_report 取得
        eval_log = task_dir / f"eval-{arm}" / "eval.log"
        if eval_log.exists():
            artifacts["eval.log"] = {"path": rel_artifact(eval_log, runs_base),
                                     "sha256": sha256_file(eval_log)}
        session_paths = sorted(arm_dir.rglob("*.zstd"))
        sessions = [
            {"path": rel_artifact(p, runs_base), "sha256": sha256_file(p)}
            for p in session_paths
        ]
        artifact_count += len(artifacts)
        verified = []
        for aname, meta in artifacts.items():
            archive_checked += 1
            akey = "./" + meta["path"]
            want = archive_sums.get(akey)
            if want is None:
                archive_missing.append(akey)
                verified.append({"artifact": aname, "archive_match": None})
            elif want == meta["sha256"]:
                verified.append({"artifact": aname, "archive_match": True})
            else:
                archive_mismatch += 1
                verified.append({"artifact": aname, "archive_match": False,
                                 "archive_sha256": want})
        for s in sessions:
            akey = "./" + s["path"]
            want = archive_sums.get(akey)
            if want is not None and want != s["sha256"]:
                archive_mismatch += 1
        runs.append(
            {
                "run_id": row["run_id"],
                "experiment": name,
                "task_id": row["task_id"],
                "arm": arm,
                "repeat": row["repeat"],
                "artifacts": artifacts,
                "artifacts_archive_check": verified,
                "session_logs": sessions,
            }
        )
    snapshots = []
    for path, info in sorted(snap_files.items()):
        snapshots.append({"path": path, "sha256": info["sha256"], "rows": info.get("rows")})
    # 物理运行去重：pilot 的 packaging/standard 与 version-regression-mvp 的同 task/arm
    # 是同一次运行（pilot 是复用/落盘副本，artifact 与 session 的 sha256 全同）。
    # 96 行 canonical 身份对应 95 次物理运行；这里显式记录 cross-reference，避免被读成
    # 两次独立实验/额外样本。
    meta_groups: dict = {}
    for r in runs:
        meta_sha = r["artifacts"].get("meta.json", {}).get("sha256")
        if meta_sha:
            meta_groups.setdefault(meta_sha, []).append(r["run_id"])
    cross_references = [
        {
            "reason": "pilot run 与 version-regression-mvp run 复用同一次物理运行"
                      "（meta.json / patch.diff / predictions.jsonl / session 的 sha256 全同）",
            "artifact": "meta.json",
            "sha256": sha,
            "run_ids": sorted(ids),
            "interpretation": "canonical 按预注册分组分别引用；pilot 不进 V1/V2 分母，"
                              "也不能被当成额外独立样本；物理运行数为 95。",
        }
        for sha, ids in sorted(meta_groups.items()) if len(ids) > 1
    ]
    distinct_physical = len(meta_groups) + sum(
        1 for r in runs if not r["artifacts"].get("meta.json")
    )
    return {
        "schema_version": 1,
        "audit_level": "L2",
        "audit_level_definition": (
            "L2 = 已提交汇总/数据表 + 本机原始证据的逐 artifact sha256；原始 runs（含 "
            "prompt/session）不公开、不提交，因此不能宣称完全可复现，也不是严格盲评。"
            "reviewer 可校验已提交数据的内部一致性，并在持有本机归档时校验 hash 锚点。"
        ),
        "generated_by": "tools/evals/featurebench/collect_runs.py（本地离线，无生成时间戳）",
        "sources": {
            "canonical_runs": "docs/evals/featurebench-runs.jsonl",
            "runs_roots": {e["name"]: f"/tmp/{e['root_rel']}" for e in EXPERIMENTS},
            "archive": archive_info,
            "dataset": {
                "name": DATASET["name"],
                "revision": DATASET["revision"],
                "split": DATASET["split"],
                "cache": DATASET_CACHE_LABEL,
            },
            "snapshots": snapshots,
        },
        "counts": {
            "canonical_runs": len(canonical),
            "v1_runs": sum(1 for r in canonical if r["runtime_group"].startswith("v1-")),
            "v2_runs": sum(1 for r in canonical if r["runtime_group"].startswith("v2-")),
            "pilot_runs": sum(1 for r in canonical if r["status"] == "pilot"),
            "runs_with_official": sum(1 for r in canonical if r["official"] is not None),
            "runs_missing_official": sum(1 for r in canonical if r["official"] is None),
            "runs_with_artifacts": sum(1 for r in runs if r["artifacts"]),
            "artifact_entries": artifact_count,
            "session_log_entries": sum(len(r["session_logs"]) for r in runs),
            "archive_artifact_checks": archive_checked,
            "archive_artifact_mismatches": archive_mismatch,
            "archive_artifact_not_in_sums": len(archive_missing),
            "distinct_physical_runs": distinct_physical,
        },
        "cross_references": cross_references,
        "schema_notes": {
            "artifact_sha256": "sha256(file bytes)，路径相对于本机 runs base（/tmp）",
            "eval_report": "优先 task_dir/eval-<arm>/report.json（fb eval 产出）",
            "session_logs": "session 原件不提交；列 hash 以支持验证者裁决的可追溯性",
            "archive_check": (
                "artifacts_archive_check[*].archive_match 为 true 表示 /tmp 中该 artifact 的 "
                "sha256 与归档 SHA256SUMS 中 './<runs root>/...' 条目一致"
            ),
        },
        "runs": runs,
    }


def rel_artifact(p: Path, runs_base: Path) -> str:
    """artifact 相对路径（相对 runs base，默认 /tmp）。

    两个路径都先 resolve：macOS 上临时目录是符号链接，不 resolve 会得到带 private
    前缀的真实路径，与归档 SHA256SUMS 的条目对不上。
    """
    return p.resolve().relative_to(runs_base.resolve()).as_posix()


# --------------------------------------------------------------------------- 环境身份


def build_env_identity(canonical: list[dict], manifests: dict, extras: dict,
                       runs_base: Path) -> dict:
    groups = {}
    for gkey, g in RUNTIME_GROUPS.items():
        groups[gkey] = {
            "id": g["id"],
            "label": g["label"],
            "runner": {
                "dsh_cli_recorded": g["dsh_cli"],
                "plugin_version_recorded": g["plugin_version"],
                "plugin_tarball_sha256": g["plugin_tarball_sha256"],
                "model": MODEL,
            },
            "experiments": [],
            "counts": {"runs": 0, "scoreable": 0, "resolved": 0},
            "tokens": {"ui_sum": 0, "session_sum": 0, "ui_runs": 0, "session_runs": 0},
            "dsh_cli_actual": {},
            "plugin_version_actual": {},
            "image_tags_used": [],
            "official_image_digests": {},
            "time_window": {"started_at_min": None, "started_at_max": None},
            "official_reports": 0,
            "run_policy_common": {
                "timeout_seconds": 2700,
                "max_tokens_per_run": 40000000,
                "infra_retries": 1,
                "agent_retries": 0,
                "order": "alternating",
                "failure_classes": [
                    "timeout", "over_budget", "infra_error", "empty_patch",
                    "agent_error", "unresolved",
                ],
                "note": "timeout/单 run token/重试/顺序在组内各实验 manifest 完全一致；"
                        "total_token_budget 逐实验不同，见 per_experiment[exp].run_policy",
            },
        }
    per_experiment = {}
    for exp in EXPERIMENTS:
        name = exp["name"]
        rows = [r for r in canonical if r["experiment"] == name]
        if not rows:
            continue
        g = groups[exp["group"]]
        g["experiments"].append(name)
        manifest = load_manifest(exp["manifest_rel"])
        policy = {k: manifest["run_policy"].get(k) for k in RUN_POLICY_KEYS}
        times = [r["started_at"] for r in rows if r["started_at"]]
        exp_info = {
            "manifest": exp["manifest_rel"],
            "manifest_sha256": manifests[name]["sha256"],
            "runtime_group": g["id"],
            "benchmark": {
                "name": manifest["benchmark"]["name"],
                "package": manifest["benchmark"]["package"],
                "revision": manifest["benchmark"]["revision"],
                "split": manifest["benchmark"]["split"],
            },
            "arms": list(manifest["arms"].keys()),
            "run_policy": policy,
            "counts": {
                "runs": len(rows),
                "scoreable": sum(1 for r in rows if r["official"] is not None),
                "resolved": sum(1 for r in rows if r["official"] and r["official"]["resolved"]),
                "agent_failures": sum(
                    1 for r in rows if r["agent_completed"] is not True or r["agent_failure"]
                ),
                "attempts_known": sum(1 for r in rows if r["attempts"] is not None),
                "attempts_sum_known": sum(r["attempts"] or 0 for r in rows),
            },
            "time_window": {"started_at_min": min(times) if times else None,
                            "started_at_max": max(times) if times else None},
            "images": [
                {
                    "task_id": t["id"],
                    "repo": t["repo"],
                    "official_image": t["image"],
                    "image_digest": t["image_digest"],
                }
                for t in manifest["tasks"]
            ],
            "image_tags_used": sorted({r["image"] for r in rows if r["image"]}),
            "run_manifest_sha256": sha256_file(REPO_ROOT / exp["manifest_rel"]),
        }
        per_experiment[name] = exp_info
        g["counts"]["runs"] += len(rows)
        g["counts"]["scoreable"] += sum(1 for r in rows if r["official"] is not None)
        g["counts"]["resolved"] += sum(
            1 for r in rows if r["official"] and r["official"]["resolved"]
        )
        g["official_reports"] += sum(1 for r in rows if r["official"] is not None)
        for r in rows:
            if r["tokens"] is not None:
                g["tokens"][f"{r['tokens_source']}_sum"] = (
                    g["tokens"].get(f"{r['tokens_source']}_sum", 0) + r["tokens"]
                )
                g["tokens"][f"{r['tokens_source']}_runs"] += 1
            key = r["dsh_cli_actual"] or "null(未记录)"
            g["dsh_cli_actual"][key] = g["dsh_cli_actual"].get(key, 0) + 1
            key = r["plugin_version_actual"] or "null(未记录)"
            g["plugin_version_actual"][key] = g["plugin_version_actual"].get(key, 0) + 1
            if r["started_at"]:
                if g["time_window"]["started_at_min"] is None or (
                    r["started_at"] < g["time_window"]["started_at_min"]
                ):
                    g["time_window"]["started_at_min"] = r["started_at"]
                if g["time_window"]["started_at_max"] is None or (
                    r["started_at"] > g["time_window"]["started_at_max"]
                ):
                    g["time_window"]["started_at_max"] = r["started_at"]
        for img in exp_info["images"]:
            g["official_image_digests"][img["official_image"]] = img["image_digest"]
        g["image_tags_used"] = sorted(set(g["image_tags_used"]) | set(exp_info["image_tags_used"]))
    groups["v1"]["actual_version_evidence"] = (
        "5 个 V1 实验的 meta 记录 dsh_cli_actual/plugin_version_actual；首批 mvp 的 10 条"
        "运行在 driver 加版本探测之前执行，字段为 null（dsh_cli/plugin_version 记录的是"
        "manifest 钉死值），见 known_gaps"
    )
    groups["v2"]["actual_version_evidence"] = (
        "V2 全部 10 条运行均记录 dsh_cli_actual=0.2.2-rc.1 / plugin_version_actual=0.6.1"
    )
    groups["pilot"]["actual_version_evidence"] = (
        "pilot 单 run 记录 dsh_cli_actual=0.2.2-rc.1 / plugin_version_actual=0.6.1"
    )

    attempts_block = build_attempts_reconciliation(canonical, extras, runs_base)
    return {
        "schema_version": 1,
        "generated_by": "tools/evals/featurebench/collect_runs.py（本地离线，无生成时间戳）",
        "purpose": (
            "AC-002：固定并追踪评测环境身份。V1（0.6.0/0.2.1-rc.5）与 V2（0.6.1/0.2.2-rc.1）"
            "分列，不混用；pilot 单列。数据来源：预注册 manifest + 每 run meta.json。"
        ),
        "dataset": DATASET,
        "model": MODEL,
        "runtime_groups": groups,
        "per_experiment": per_experiment,
        "attempts_reconciliation": attempts_block,
        "issue_8_reconciliation": build_issue8_reconciliation(canonical, groups, attempts_block),
        "known_gaps": [
            "模型实际服务版本/构建不可得：只记录 request 参数（deepseek-account / "
            "deepseek-flash / reasoning_effort=max）；UI 展示的品牌串不能当作服务版本证据。",
            "无随机种子：模型采样不可控；manifest 固定了运行顺序（alternating），但逐 run "
            "启动顺序除日志时间外没有单独记录。",
            "权限/网络策略未逐 run 落盘：所有 run 统一容器内 danger-full-access + unset "
            "HTTP(S)_PROXY（见 tools/evals/featurebench/README.md），meta.json 只记录 "
            "timeout/max_tokens；无法从逐 run 制品证明每 run 的权限面完全一致。",
            "V1 首批 mvp 的 10 个 run 未记录 dsh_cli_actual / plugin_version_actual"
            "（driver 后期才加版本探测）；V1 其余实验与 V2/pilot 有 actual 字段。",
            "attempts 账本不完整：matrix.json 会被后续 --retry-failed 子集运行覆盖，"
            "仅 60/96 行有可追溯 attempts；见 attempts_reconciliation。",
            "canonical 的 96 行身份只对应 95 次物理运行：pilot 的 "
            "pypa__packaging.013f3b03.test_metadata.e00b5801.lv1/standard 与 "
            "version-regression-mvp 的同 task/arm 是**同一次运行**（pilot 是复用/落盘"
            "副本；meta.json/patch.diff/predictions.jsonl/session 的 sha256 全同，见 "
            "evidence-index.cross_references）。pilot 行按预注册分组单列、不进 V1/V2 "
            "分母，也不能被当成额外独立样本。",
            "/tmp/fb-runs-2x2-probe（1 个 pydantic standard 探针 run，无官方评分）不在任何"
            "预注册实验内，未进入 canonical 表，也未计入 V1/V2/pilot。",
            "原始 runs（约 2.3GB，含 prompt/session）不提交；本机归档在 "
            f"{ARCHIVE_LABEL}，仓库只提交逐 artifact hash（审计级别 L2）。",
            "容器内镜像是 fb-eval-base(-061):<repo> 派生镜像；meta.image_digest 记录的是"
            "其官方基础镜像（libercoders/featurebench-specs_*）的 manifest digest，"
            "派生镜像本身没有独立 digest 记录。",
        ],
        "excluded_artifacts": [
            {
                "path": "/tmp/fb-runs-2x2-probe",
                "reason": "2026-11-07 17:47 的 2x2 前置探针 run（pydantic standard），"
                          "不属预注册实验批次、无官方评分，未计入 canonical",
            }
        ],
    }


def build_attempts_reconciliation(canonical: list[dict], extras: dict,
                                   runs_base: Path) -> dict:
    matrix_covered = sum(1 for r in canonical if r["attempts"] is not None)
    matrix_sum = sum(r["attempts"] or 0 for r in canonical)
    per_exp = {}
    for exp in EXPERIMENTS:
        rows = [r for r in canonical if r["experiment"] == exp["name"]]
        known = [r for r in rows if r["attempts"] is not None]
        per_exp[exp["name"]] = {
            "runs": len(rows),
            "attempts_known_rows": len(known),
            "attempts_known_sum": sum(r["attempts"] for r in known),
            "runs_without_matrix_entry": len(rows) - len(known),
        }
    # 日志侧的重试/启动证据（只作为「存在更多未入账尝试」的旁证，不当成逐 run 归属）
    retry_events = 0
    run_events = 0
    for exp in EXPERIMENTS:
        # 必须用调用方选定的 runs base：归档被恢复到非 /tmp 路径时，读 DEFAULT_RUNS_BASE
        # 会得到 0 条日志事件（或混入无关旧日志），让 --check 对同一份归档误报漂移。
        root = runs_base / exp["root_rel"]
        patterns = "*.log"
        for p in sorted(root.glob(patterns)):
            try:
                text = p.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            for line in text.splitlines():
                if line.startswith("[retry]"):
                    retry_events += 1
                elif line.startswith("[run]"):
                    run_events += 1
    return {
        "definition": (
            "attempts = matrix.json 中该 (task, arm) 记录的尝试次数（1 = 无 infra 重试；"
            "2 = 发生 1 次 infra 重试）。matrix.json 不存在/未覆盖该 run 时为 null，不猜。"
        ),
        "canonical_runs": len(canonical),
        "runs_with_matrix_attempts": matrix_covered,
        "runs_without_matrix_attempts": len(canonical) - matrix_covered,
        "attempts_sum_known": matrix_sum,
        "per_experiment": per_exp,
        "log_evidence": {
            "run_launch_lines_in_surviving_logs": run_events,
            "retry_lines_in_surviving_logs": retry_events,
            "note": (
                "日志里可见 [run]/[retry] 事件（每个 [run] = 一次 run_arm 启动，[retry] = "
                "同一 run_matrix 进程内的 infra 重试），但这些日志本身不完整（分批/重定向/"
                "被覆盖），无法把历史启动逐条归属到 canonical run。"
            ),
        },
        "why_not_164": (
            "issue #8 评论称『含重跑约 164 次尝试』。用现存制品只能逐 run 追溯 "
            f"{matrix_sum} 次（{matrix_covered}/{len(canonical)} 行有 matrix 记录）；"
            "其余尝试发生在被 --retry-failed 覆盖的批次汇总、driver 层重试与已删除的临时 "
            "runs 中，没有逐 run 账本，无法复算 164。本表只报告可审计数字，不把估计值当记录。"
        ),
    }


def build_issue8_reconciliation(canonical: list[dict], groups: dict, attempts: dict) -> dict:
    v1 = [r for r in canonical if r["runtime_group"].startswith("v1-")]
    v2 = [r for r in canonical if r["runtime_group"].startswith("v2-")]
    pilot = [r for r in canonical if r["status"] == "pilot"]
    v1_off = sum(1 for r in v1 if r["official"] is not None)
    distinct_tasks = sorted({r["task_id"] for r in canonical})
    tokens_v1_ui = sum(
        r["tokens"] for r in v1 if r["tokens"] is not None and r["tokens_source"] == "ui"
    )
    tokens_v1_session = sum(
        r["tokens"] for r in v1 if r["tokens"] is not None and r["tokens_source"] == "session"
    )
    tokens_v1 = tokens_v1_ui + tokens_v1_session
    return {
        "source": "issue #8 comment 2026-11-08（FeatureBench A/B 实验汇报）",
        "claims": {
            "27 个不同 FeatureBench 任务": {
                "canonical_recomputed": len(distinct_tasks),
                "match": len(distinct_tasks) == 27,
                "note": "canonical 96 行去重后 task_id 数；V1/V2/pilot 的任务集合相同（5 repo lv1）",
            },
            "85 次有效官方评分运行": {
                "v1_runs": len(v1),
                "v1_with_official_report": v1_off,
                "difference": v1_off - len(v1),
                "explanation": (
                    "V1 共 85 个 run；84 个有官方 report。expanded 的 seaborn "
                    "test_regression / standard 因 fb eval 的 HF revision 解析失败没有 "
                    "report.json（环境失败），所以『85 次官方评分』多算了 1 次；ITT 分母仍"
                    "保留 85（该条按未解决计入）。"
                ),
            },
            "含重跑约 164 次尝试": {
                "matrix_json_attempts_sum": attempts["attempts_sum_known"],
                "matrix_json_coverage": f"{attempts['runs_with_matrix_attempts']}/"
                                        f"{attempts['canonical_runs']}",
                "match": False,
                "explanation": attempts["why_not_164"],
            },
            "总消耗约 787M / 1B token": {
                "v1_tokens_ui_sum": tokens_v1_ui,
                "v1_tokens_session_fallback_sum": tokens_v1_session,
                "v1_tokens_total": tokens_v1,
                "explanation": (
                    "#8 的 787M 是当时的 UI 口径累计（首批预算表还包含 2 个重复目录，"
                    "多算 packaging 两臂约 17.2M）。canonical 以每 run UI 值优先、12 个 UI "
                    "缺失的 run 用 session 汇总补全（+"
                    f"{tokens_v1_session}），所以总量更高；两套口径都保留说明。"
                ),
            },
        },
        "not_recomputed_here": (
            "issue #8 的 paired 汇总（n=30 / A 21/30 / B 22/30 / W3 L2 T25）由 "
            "reaggregate.py + baseline-metrics.json 负责；本文件只固定 env/attempt 口径。"
        ),
        "notes": (
            f"V2 只有 {len(v2)} 个 run（regression-0.6.1/mvp.yml），pilot {len(pilot)} 个；"
            "其余 5 份 regression-0.6.1 清单预注册未执行（not_run）。0.6.0 与 0.6.1 结论不混用。"
        ),
    }


# --------------------------------------------------------------------------- 泄漏审计


def load_gold_patches(cache: Path) -> tuple[dict, dict]:
    """从 HF dataset 缓存读 gold patch（dataset 的 `patch` 字段 = 官方参考补丁）。

    返回 ({task_id: {sha256, sha256_normalized, chars}}, info)。
    """
    info = {"available": False}
    arrow = cache / "feature_bench-fast.arrow"
    if not arrow.exists():
        info["reason"] = f"dataset 缓存不存在: {arrow}"
        return {}, info
    try:
        import pyarrow as pa  # type: ignore
    except Exception:
        info["reason"] = "pyarrow 不可用（请用 featurebench 的 uv python 运行）"
        return {}, info
    with pa.memory_map(str(arrow), "r") as source:
        table = pa.ipc.open_stream(source).read_all()
    out = {}
    for row in table.to_pylist():
        patch = row["patch"]
        out[row["instance_id"]] = {
            "sha256": sha256_bytes(patch.encode("utf-8")),
            "sha256_normalized": sha256_bytes(normalize_patch(patch).encode("utf-8")),
            "chars": len(patch),
        }
    info = {
        "available": True,
        "arrow_file": "feature_bench-fast.arrow",
        "arrow_sha256": sha256_file(arrow),
        "instances": len(out),
        "field": "patch（官方 dataset 的参考补丁；test_patch 为隐藏测试补丁，另存不比对）",
    }
    return out, info


def normalize_patch(text: str) -> str:
    """规范化：CRLF→LF、行尾空白去掉、末尾恰好一个换行。用于比 byte 更宽松的二次比对。"""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [ln.rstrip() for ln in text.split("\n")]
    return "\n".join(lines).rstrip("\n") + "\n"


def build_leak_audit(canonical: list[dict], extras: dict, runs_base: Path,
                     dataset_cache: Path) -> dict:
    gold, gold_info = load_gold_patches(dataset_cache)
    by_image: dict = {}
    by_task: dict = {}
    per_run = []
    runs_with_hits = 0
    hits_total = 0
    isolation_failures = []
    leak_txt_mismatch = []
    for row in canonical:
        key = f"{row['task_id']}:{row['arm']}:r{row['repeat']}"
        info = extras[row["experiment"]]["runs"][key]
        arm_dir: Path = info["arm_dir"]
        meta = load_json(arm_dir / "meta.json") or {}
        hits = meta.get("leak_scan_hits") or []
        hits_total += len(hits)
        if hits:
            runs_with_hits += 1
        leak_txt = arm_dir / "leak_scan.txt"
        txt_hits = None
        isolation_ok = None
        if leak_txt.exists():
            lines = leak_txt.read_text(encoding="utf-8", errors="replace").splitlines()
            isolation_ok = "CHECK_DONE" in lines
            if "hits:" in lines:
                idx = lines.index("hits:")
                txt_hits = [ln for ln in lines[idx + 1:] if ln.strip()]
            if txt_hits is not None and sorted(txt_hits) != sorted(hits):
                leak_txt_mismatch.append(
                    {"run_id": row["run_id"], "meta_hits": len(hits),
                     "leak_scan_txt_hits": len(txt_hits)}
                )
        if isolation_ok is False:
            isolation_failures.append(row["run_id"])
        img = row["repo"]
        img_info = by_image.setdefault(
            img,
            {
                "repo": img,
                "official_image": None,
                "image_digest": None,
                "runs": 0,
                "runs_with_hits": 0,
                "hits_total": 0,
                "hit_paths": set(),
                "experiments": set(),
            },
        )
        img_info["runs"] += 1
        img_info["runs_with_hits"] += 1 if hits else 0
        img_info["hits_total"] += len(hits)
        img_info["hit_paths"].update(hits)
        img_info["experiments"].add(row["experiment"])
        if img_info["official_image"] is None and row["image_digest"]:
            manifest = load_manifest(
                next(e for e in EXPERIMENTS if e["name"] == row["experiment"])["manifest_rel"]
            )
            for t in manifest["tasks"]:
                if t["id"] == row["task_id"]:
                    img_info["official_image"] = t["image"]
                    img_info["image_digest"] = t["image_digest"]
                    break
        task_info = by_task.setdefault(row["task_id"], {"repo": row["repo"], "runs": 0,
                                                        "runs_with_hits": 0, "hits_total": 0,
                                                        "by_arm": {}})
        task_info["runs"] += 1
        task_info["runs_with_hits"] += 1 if hits else 0
        task_info["hits_total"] += len(hits)
        arm_info = task_info["by_arm"].setdefault(
            row["arm"], {"runs": 0, "runs_with_hits": 0, "hits_total": 0}
        )
        arm_info["runs"] += 1
        arm_info["runs_with_hits"] += 1 if hits else 0
        arm_info["hits_total"] += len(hits)
        task_gold = gold.get(row["task_id"])
        per_run.append(
            {
                "run_id": row["run_id"],
                "experiment": row["experiment"],
                "task_id": row["task_id"],
                "repo": row["repo"],
                "arm": row["arm"],
                "repeat": row["repeat"],
                "leak_scan_hits": len(hits),
                "hit_paths": sorted(hits),
                "leak_scan_txt_consistent": (
                    None if txt_hits is None else sorted(txt_hits) == sorted(hits)
                ),
                "isolation_check_done": isolation_ok,
                "patch_sha256": row["patch_sha256"],
                "gold_patch_sha256": task_gold["sha256"] if task_gold else None,
                "equals_gold_patch": (
                    None if not task_gold else row["patch_sha256"] == task_gold["sha256"]
                ),
            }
        )
    for img_info in by_image.values():
        img_info["hit_paths"] = sorted(img_info["hit_paths"])
        img_info["experiments"] = sorted(img_info["experiments"])
        img_info["known_cause"] = (
            "官方镜像内 pip/setuptools/wheel vendored packaging 副本（两臂都可见，未修改"
            "官方镜像；敏感度分析见 packaging_sensitivity）"
            if img_info["runs_with_hits"] else None
        )
    by_task_list = [
        {"task_id": tid, **{k: v for k, v in info.items()}} for tid, info in sorted(by_task.items())
    ]

    identical_pairs = collect_identical_cross_arm_patches(canonical)
    gold_equal = sum(1 for r in per_run if r["equals_gold_patch"] is True)
    gold_norm_equal = 0
    for row in canonical:
        task_gold = gold.get(row["task_id"])
        if not task_gold:
            continue
        if row["patch_sha256"] == task_gold["sha256"]:
            continue
        key = f"{row['task_id']}:{row['arm']}:r{row['repeat']}"
        arm_dir: Path = extras[row["experiment"]]["runs"][key]["arm_dir"]
        patch_file = arm_dir / "patch.diff"
        if patch_file.exists():
            text = patch_file.read_text(encoding="utf-8", errors="replace")
            if sha256_bytes(normalize_patch(text).encode("utf-8")) == task_gold[
                "sha256_normalized"
            ]:
                gold_norm_equal += 1
    return {
        "schema_version": 1,
        "generated_by": "tools/evals/featurebench/collect_runs.py（本地离线，无生成时间戳）",
        "purpose": (
            "AC-005：隔离与泄漏审计。逐镜像/任务/arm 汇总 leak_scan_hits，标记已知参考实现"
            "泄漏；用官方 dataset gold patch 做 sha256 比对；packaging 泄漏的敏感性分析；"
            "A/B 补丁同一性作为独立性线索（不据此宣称严格盲评/抄袭）。"
        ),
        "method": {
            "leak_scan": "run_arm.py 在初始化后 grep gold 补丁中的函数签名扫描容器（排除 "
                         "/testbed 与 /proc /sys），命中写 leak_scan.txt 与 meta.leak_scan_hits",
            "gold_compare": "dataset `patch` 字段的 UTF-8 sha256 vs meta.patch_sha256（= "
                            "patch.diff 字节 sha256）",
            "normalized_compare": (
                "规范化（CRLF→LF、去行尾空白、末尾恰好一个换行）后再比对，作为 byte 比对"
                "的更宽松二次检查；仍不处理 diff 顺序/上下文差异"
            ),
            "isolation": "leak_scan.txt 的 'isolation check:' CHECK_DONE 表示该 run 的隔离"
                         "检查完成",
        },
        "totals": {
            "runs": len(canonical),
            "runs_with_hits": runs_with_hits,
            "hits_total": hits_total,
            "isolation_check_missing_or_failed": isolation_failures,
            "leak_scan_txt_mismatches": leak_txt_mismatch,
        },
        "by_image": {k: v for k, v in sorted(by_image.items())},
        "by_task": by_task_list,
        "per_run": per_run,
        "gold_comparison": {
            "available": gold_info["available"],
            "dataset": {
                "name": DATASET["name"],
                "revision": DATASET["revision"],
                "cache": DATASET_CACHE_LABEL,
                "arrow": gold_info,
            },
            "tasks_with_gold": len(gold),
            "exact_sha256_matches": gold_equal,
            "normalized_sha256_matches": gold_norm_equal,
            "per_task_gold_sha256": {
                tid: gold[tid] for tid in sorted(gold)
                if tid in {r["task_id"] for r in canonical}
            },
            "limitations": [
                "byte 比对是**单向**证据：相等 ⇒ 与官方参考补丁逐字节相同（强泄漏信号）；"
                "不等 ⇏ 独立实现，模型可能收敛到语义相同的实现。",
                "gold patch 是 dataset 的 `patch` 字段（feature commit diff）；agent 的 "
                "patch.diff 是 mask/restore 初始化后 git diff 的产物，header/index/顺序/"
                "上下文可能天然不同，因此归一化比对仍只能当线索。",
                "本轮 96 个 run 没有任何一条与 gold patch 逐字节相同（exact=0，"
                "normalized=0），与 README 记录的『第一版挂载 /eval 事故作废后零宿主挂载』"
                "一致；这不等于任务绝对无泄漏，见 packaging 已知参考副本。",
                "test_patch（隐藏测试）单独存在于 dataset，不参与本比对。",
            ],
        },
        "identical_cross_arm_patches": identical_pairs,
        "identical_cross_arm_limitations": (
            "同一 task 两臂补丁字节相同是**独立性线索**，不能直接判定抄袭：同一模型 + "
            "同一任务 + 精确 Interface Description 下收敛到相同修改（尤其小修复/恢复型"
            "任务）是可能的。如果同一补丁在不同 run 得到不同官方评分，那是评分/环境"
            "稳定性的线索，需单独复核。"
        ),
        "packaging_sensitivity": build_packaging_sensitivity(canonical),
    }


def collect_identical_cross_arm_patches(canonical: list[dict]) -> dict:
    """同一 (experiment, task, repeat) 内 A 臂 vs B 臂 patch_sha256 相同的情况。

    A 臂 = standard；B 臂 = 该实验的 b_arm（mvp/expanded/repeat/v2= sdlc，
    2x2=sdlc_guidance），与 #8 的 paired 口径一致；额外列出所有跨臂相同组合。
    """
    cells: dict = {}
    for row in canonical:
        cells.setdefault((row["experiment"], row["task_id"], row["repeat"]), []).append(row)
    b_arm = {e["name"]: e["b_arm"] for e in EXPERIMENTS}
    primaries = []
    all_pairs = []
    for (exp, task, repeat), rows in sorted(cells.items()):
        by_arm = {r["arm"]: r for r in rows}
        target_b = b_arm.get(exp)
        if target_b and "standard" in by_arm and target_b in by_arm:
            a, b = by_arm["standard"], by_arm[target_b]
            if a["patch_sha256"] and a["patch_sha256"] == b["patch_sha256"]:
                primaries.append(
                    {
                        "experiment": exp,
                        "task_id": task,
                        "repeat": repeat,
                        "arm_a": "standard",
                        "arm_b": target_b,
                        "patch_sha256": a["patch_sha256"],
                        "patch_chars_a": a["patch_chars"],
                        "patch_chars_b": b["patch_chars"],
                        "timeout_truncated_a": a["agent_failure"] == "timeout",
                        "timeout_truncated_b": b["agent_failure"] == "timeout",
                        "official_resolved_a": a["official"]["resolved"] if a["official"] else None,
                        "official_resolved_b": b["official"]["resolved"] if b["official"] else None,
                    }
                )
        for i, a in enumerate(rows):
            for b in rows[i + 1:]:
                if a["patch_sha256"] and a["patch_sha256"] == b["patch_sha256"]:
                    all_pairs.append(
                        {
                            "experiment": exp,
                            "task_id": task,
                            "repeat": repeat,
                            "arms": sorted([a["arm"], b["arm"]]),
                            "patch_sha256": a["patch_sha256"],
                            "patch_chars": a["patch_chars"],
                            "official_resolved": [
                                a["official"]["resolved"] if a["official"] else None,
                                b["official"]["resolved"] if b["official"] else None,
                            ],
                        }
                    )
    return {
        "definition": "A 臂 = standard；B 臂 = 该实验的 treatment 臂（见 b_arm）。",
        "primary_ab_pairs": primaries,
        "primary_ab_pair_count": len(primaries),
        "all_cross_arm_pairs": all_pairs,
        "all_cross_arm_pair_count": len(all_pairs),
        "resolved_outcome_inconsistencies": [
            p for p in all_pairs
            if p["official_resolved"][0] is not None
            and p["official_resolved"][1] is not None
            and p["official_resolved"][0] != p["official_resolved"][1]
        ],
    }


def build_packaging_sensitivity(canonical: list[dict]) -> dict:
    """packaging（已知 vendored 参考副本镜像）敏感性分析。

    配对口径与 issue #8 的 paired 汇总一致：A=standard，B=该实验 treatment arm，
    只取两侧都有官方评分的 pair 计算 W/L/T（scoreable）；ITT 分母不删。
    **V1 与 V2 分开**：主表只用 V1（plugin 0.6.0 / DSH 0.2.1-rc.5）的 30 个 scoreable
    pair，V2（0.6.1 / 0.2.2-rc.1）只有 5 个 pair，单独放进 `v2` 子对象，不与 V1 合并。
    """
    group_of = {e["name"]: e["group"] for e in EXPERIMENTS}
    b_arm = {e["name"]: e["b_arm"] for e in EXPERIMENTS}
    cells: dict = {}
    for row in canonical:
        if row["status"] == "pilot":
            continue
        cells.setdefault((row["experiment"], row["task_id"], row["repeat"]), []).append(row)
    all_pairs = []
    for (exp, task, repeat), rows in sorted(cells.items()):
        by_arm = {r["arm"]: r for r in rows}
        target_b = b_arm.get(exp)
        if not target_b or "standard" not in by_arm or target_b not in by_arm:
            continue
        a, b = by_arm["standard"], by_arm[target_b]
        a_res = a["official"]["resolved"] if a["official"] else None
        b_res = b["official"]["resolved"] if b["official"] else None
        all_pairs.append(
            {
                "experiment": exp,
                "group": group_of[exp],
                "task_id": task,
                "repeat": repeat,
                "repo": a["repo"],
                "a_resolved": a_res,
                "b_resolved": b_res,
                "scoreable": a_res is not None and b_res is not None,
            }
        )

    def summarize(ps: list[dict]) -> dict:
        sc = [p for p in ps if p["scoreable"]]
        w = sum(1 for p in sc if p["b_resolved"] is True and p["a_resolved"] is False)
        loss = sum(1 for p in sc if p["a_resolved"] is True and p["b_resolved"] is False)
        both_res = sum(1 for p in sc if p["a_resolved"] and p["b_resolved"])
        both_fail = sum(1 for p in sc if p["a_resolved"] is False and p["b_resolved"] is False)
        return {
            "pairs_attempted": len(ps),
            "pairs_scoreable": len(sc),
            "a_resolved_itt": sum(1 for p in ps if p["a_resolved"] is True),
            "b_resolved_itt": sum(1 for p in ps if p["b_resolved"] is True),
            "a_resolved_scoreable": sum(1 for p in sc if p["a_resolved"] is True),
            "b_resolved_scoreable": sum(1 for p in sc if p["b_resolved"] is True),
            "paired_wlt": {
                "b_wins": w,
                "a_wins": loss,
                "ties": len(sc) - w - loss,
                "ties_both_resolved": both_res,
                "ties_both_failed": both_fail,
            },
            "net_b_minus_a_itt": (
                sum(1 for p in ps if p["b_resolved"] is True)
                - sum(1 for p in ps if p["a_resolved"] is True)
            ),
            "net_b_minus_a_scoreable": (
                sum(1 for p in sc if p["b_resolved"] is True)
                - sum(1 for p in sc if p["a_resolved"] is True)
            ),
        }

    v1_pairs = [p for p in all_pairs if p["group"] == "v1"]
    v2_pairs = [p for p in all_pairs if p["group"] == "v2"]
    v1_pack = [p for p in v1_pairs if p["repo"] == "pypa/packaging"]
    v1_non = [p for p in v1_pairs if p["repo"] != "pypa/packaging"]
    v2_pack = [p for p in v2_pairs if p["repo"] == "pypa/packaging"]
    v2_non = [p for p in v2_pairs if p["repo"] != "pypa/packaging"]
    return {
        "definition": (
            "packaging = repo pypa/packaging 的任务（唯一已知镜像内含 pip/Setuptools/wheel "
            "vendored packaging 参考实现的 repo，两臂均可见）。paired 口径：A=standard，"
            "B=该实验 treatment arm（mvp/expanded/repeat 的 sdlc，2x2 的 sdlc_guidance）。"
            "scoreable pair 才进 W/L/T；ITT 分母不删。主表只用 V1（与 #8 的 comparable "
            "paired 主面板同口径：V1 31 attempted / 30 scoreable）；V2 单独列，不合并。"
        ),
        "v1": {
            "note": "plugin 0.6.0 + DSH CLI 0.2.1-rc.5；#8 comparable_pairs 主面板口径",
            "all_pairs": summarize(v1_pairs),
            "packaging_pairs": summarize(v1_pack),
            "non_packaging_pairs": summarize(v1_non),
        },
        "v2": {
            "note": (
                "plugin 0.6.1 + DSH 0.2.2-rc.1；只有 regression-0.6.1/mvp.yml 的 5 个 "
                "paired cell。**不与 V1 合并统计**，只作版本回归的泄漏敏感性附注。"
            ),
            "all_pairs": summarize(v2_pairs),
            "packaging_pairs": summarize(v2_pack),
            "non_packaging_pairs": summarize(v2_non),
        },
        "interpretation": (
            "V1（30 个 scoreable pair）：含 packaging 时 A 4/5 vs B 5/5、W1 L0 T4，"
            "净 B−A=+1；不含 packaging 时 A 17/25 vs B 17/25、W2 L2 T21，完全打平。"
            "即 V1 的净 +1 对完全由 packaging 这 1 个 pair 贡献，与『参考副本泄漏只抬高"
            "天花板/增加方差、不制造 A/B 差异』的 caveat 一致。"
            "注意 ITT 口径（31 attempted）不含 packaging 时 A 17/26 vs B 18/26 仍差 1："
            "那 1 条是 expanded 的 A 侧官方评分环境缺失（按 ITT 记未解决），不是胜负。"
            "V2 的 5 个 pair 里 packaging 也是同一个『A98.64% 边缘失败 / B 通过』个案；"
            "V2 单独列，不并入 V1 结论。"
        ),
        "caveat": (
            "样本量很小；packaging 的 vendored 副本对所有臂机会均等，泄漏本身不制造 A/B "
            "差异，但会抬高天花板/增加方差。结论不删除任何分母，含/不含并列给出。"
        ),
    }


# --------------------------------------------------------------------------- 验证者混淆


def build_verifier_confusion(canonical: list[dict], extras: dict) -> dict:
    """验证者最终裁决 × 官方 resolved；合并所有 B 运行，V2 单列。

    B 运行 = treatment arm（SDLC preset；arm 名 sdlc / sdlc_guidance）。裁决取自
    主会话的 sdlc_verify 结果序列，最终裁决 = 序列最后一个。
    """
    b_arm = {e["name"]: e["b_arm"] for e in EXPERIMENTS}
    b_modes = {e["name"]: e["b_arm"] for e in EXPERIMENTS}
    b_rows = [r for r in canonical
              if r["experiment"] != "pilot" and r["arm"] in B_ARMS]
    # 只保留该实验的 treatment 臂（校验 B 语义）；2x2 两个 SDLC 臂都算 B 运行，
    # 但 paired 口径只用 sdlc_guidance（b_arm）。
    _ = b_modes

    def bucket(r: dict) -> dict:
        vs = r["verify_verdicts"]
        final = vs[-1] if vs else None
        off = r["official"]["resolved"] if r["official"] else None
        used = bool(r["sdlc_tool_calls"])
        if final is None and used:
            reason = "no_verdict_with_workflow" if r["agent_completed"] is not True else \
                "no_verdict_workflow_used"
        elif final is None:
            reason = "workflow_not_used"
        else:
            reason = None
        if off is None:
            bucket_name = "official_missing"
        elif final is None:
            bucket_name = "no_verdict"
        elif final == "needs_human":
            bucket_name = "needs_human"
        elif final == "approve":
            bucket_name = "approve_resolved" if off else "approve_unresolved_false_positive"
        else:  # reject
            bucket_name = "reject_unresolved" if not off else "reject_resolved_false_negative"
        return {
            "run_id": r["run_id"],
            "experiment": r["experiment"],
            "task_id": r["task_id"],
            "repo": r["repo"],
            "arm": r["arm"],
            "repeat": r["repeat"],
            "official_resolved": off,
            "final_verdict": final,
            "verdicts": vs,
            "agent_completed": r["agent_completed"],
            "agent_failure": r["agent_failure"],
            "agent_premature_failure": (
                r["agent_completed"] is not True or r["agent_failure"] is not None
            ),
            "workflow_used": used,
            "no_verdict_reason": reason,
            "bucket": bucket_name,
        }

    details = [bucket(r) for r in b_rows]
    v1 = [d for d in details if d["experiment"] != "version-regression-mvp"]
    v2 = [d for d in details if d["experiment"] == "version-regression-mvp"]

    def confusion(ds: list[dict]) -> dict:
        c = {
            "approve_resolved": 0,
            "approve_unresolved_false_positive": 0,
            "reject_resolved_false_negative": 0,
            "reject_unresolved": 0,
            "needs_human": 0,
            "needs_human_resolved": 0,
            "needs_human_unresolved": 0,
            "no_verdict": 0,
            "no_verdict_resolved": 0,
            "no_verdict_unresolved": 0,
            "official_missing": 0,
        }
        for d in ds:
            c[d["bucket"]] = c.get(d["bucket"], 0) + 1
            if d["final_verdict"] == "needs_human" and d["official_resolved"] is True:
                c["needs_human_resolved"] += 1
            if d["final_verdict"] == "needs_human" and d["official_resolved"] is False:
                c["needs_human_unresolved"] += 1
            if d["final_verdict"] is None and d["official_resolved"] is True:
                c["no_verdict_resolved"] += 1
            if d["final_verdict"] is None and d["official_resolved"] is False:
                c["no_verdict_unresolved"] += 1
        approve = c["approve_resolved"] + c["approve_unresolved_false_positive"]
        reject = c["reject_unresolved"] + c["reject_resolved_false_negative"]
        decided = approve + reject
        return {
            "runs": len(ds),
            "runs_with_official": sum(1 for d in ds if d["official_resolved"] is not None),
            "official_resolved": sum(1 for d in ds if d["official_resolved"] is True),
            "runs_with_final_verdict": sum(1 for d in ds if d["final_verdict"] is not None),
            "workflow_used_runs": sum(1 for d in ds if d["workflow_used"]),
            "counts": c,
            "denominators": {
                "approve": approve,
                "reject": reject,
                "decided": decided,
                "all_b_runs": len(ds),
            },
            "rates": {
                "false_positive_rate": (
                    c["approve_unresolved_false_positive"] / approve if approve else None
                ),
                "false_negative_rate": (
                    c["reject_resolved_false_negative"] / reject if reject else None
                ),
                "verdict_accuracy_on_decided": (
                    (c["approve_resolved"] + c["reject_unresolved"]) / decided
                    if decided else None
                ),
                "coverage_on_all_b_runs": (
                    sum(1 for d in ds if d["final_verdict"] is not None) / len(ds)
                    if ds else None
                ),
            },
        }

    by_experiment = {}
    for exp in EXPERIMENTS:
        ds = [d for d in details if d["experiment"] == exp["name"]]
        if ds:
            by_experiment[exp["name"]] = confusion(ds)

    premature = [d for d in details if d["agent_premature_failure"]]
    legacy = build_legacy_confusion(extras, b_rows)

    return {
        "schema_version": 1,
        "generated_by": "tools/evals/featurebench/collect_runs.py（本地离线，无生成时间戳）",
        "purpose": (
            "AC-006：Verifier 的 approve 与官方 resolved 分开保存/展示，可核对错误放行"
            "（false positive）、错误拒绝（false negative）、无裁决与 Agent 提前失败；"
            "证据不足处明确标注不可判断。"
        ),
        "method": {
            "scope": "所有 B（treatment/SDLC preset）运行；2x2 的 sdlc 与 sdlc_guidance "
                     "都算 B 运行（arm 名如实记录），paired 口径另由 reaggregate 处理",
            "verdict_source": (
                "主会话文件 session-*.jsonl.zstd 中 sdlc_verify 工具结果文本里的 "
                "'\"raw_status\": \"<approve|reject|needs_human>\"' 序列；最终裁决 = 最后一个。"
                "子验证者会话内的同名 JSON 不重复计入（否则一次调用被数两遍）"
            ),
            "official_source": "官方 fb eval 的 report.json（resolved_instances），不采用 "
                               "agent 自报 DONE/approve 作为成绩",
            "no_verdict_reason": (
                "workflow_not_used = 该 run 未调用任何 sdlc_* 工具（2x2 无引导 sdlc 臂常见）；"
                "no_verdict_with_workflow = 用了流程但没有裁决（多为 timeout/over_budget/"
                "turn_error 截断）。两者都是删失，不能当通过或失败"
            ),
        },
        "totals": {
            "b_runs": len(details),
            "by_experiment": {k: len([d for d in details if d["experiment"] == k])
                              for k in sorted(by_experiment)},
            "v1_b_runs": len(v1),
            "v2_b_runs": len(v2),
        },
        "confusion": {
            "all_b_runs": confusion(details),
            "v1_b_runs": confusion(v1),
            "v2_b_runs": confusion(v2),
        },
        "by_experiment": by_experiment,
        "agent_premature_failure": {
            "definition": "agent_completed != True 或 agent_failure != null（含 timeout/"
                          "over_budget/turn_error）；这些 run 的官方评分与裁决仍如实列出，"
                          "但作为删失样本单独标注",
            "count": len(premature),
            "runs": [
                {
                    "run_id": d["run_id"],
                    "experiment": d["experiment"],
                    "official_resolved": d["official_resolved"],
                    "final_verdict": d["final_verdict"],
                    "agent_failure": d["agent_failure"],
                    "bucket": d["bucket"],
                }
                for d in premature
            ],
        },
        "undecidable_notes": [
            "没有裁决的 run 里，一部分是流程未被触发（2x2 无引导 sdlc 臂），一部分是 "
            "timeout/over_budget/turn_error 把验证截断；两类都在 runs[] 里给出原因。",
            "needs_human 是显式的『验证者无法判断』，不进 2×2 分母，单独按官方结果拆分。",
            "样本量小 + 单次采样：假阳性率/假阴性率只描述观测，不做显著性宣称。",
        ],
        "legacy_report_data_scope": legacy,
        "runs": details,
    }


def build_legacy_confusion(extras: dict, b_rows: list[dict]) -> dict:
    """report-data.json 口径（扫全部 session 文件，analize_verifier.py 的旧算法）对照。

    用于解释 #8 评论里的合并假阳性率 15.4% 与主口径（主会话）的差异来源。
    """
    out = {"definition": "report-data.json 的 verify_verdicts（summarize_runs.py 扫全部 "
                         "session 文件，包含验证者子会话中的同名 status JSON）",
           "experiments": {}}
    for exp in ("mvp", "verify-calibration", "verify-stress"):
        rows = [r for r in b_rows if r["experiment"] == exp]
        merged = {}
        for r in rows:
            key = f"{r['task_id']}:{r['arm']}:r{r['repeat']}"
            rd = extras[exp]["runs"][key]["verify_verdicts_report_data"]
            vs = rd if rd is not None else []
            final = vs[-1] if vs else None
            off = r["official"]["resolved"] if r["official"] else None
            merged.setdefault((final, off), []).append(r["run_id"])
        out["experiments"][exp] = {
            "runs": len(rows),
            "final_verdict_x_official": {
                f"{k[0]}|{k[1]}": len(v) for k, v in sorted(merged.items(), key=lambda x: str(x))
            },
        }
    # 合并 mvp + verify-calibration + verify-stress（#8 的 18 次 B 运行口径）
    combined = {"runs": 0, "with_verdict": 0, "approve": 0,
                "approve_unresolved": 0, "reject": 0, "reject_resolved": 0}
    for exp in ("mvp", "verify-calibration", "verify-stress"):
        for r in b_rows:
            if r["experiment"] != exp:
                continue
            key = f"{r['task_id']}:{r['arm']}:r{r['repeat']}"
            rd = extras[exp]["runs"][key]["verify_verdicts_report_data"] or []
            combined["runs"] += 1
            if not rd:
                continue
            combined["with_verdict"] += 1
            final = rd[-1]
            off = r["official"]["resolved"] if r["official"] else None
            if final == "approve":
                combined["approve"] += 1
                if off is False:
                    combined["approve_unresolved"] += 1
            elif final == "reject":
                combined["reject"] += 1
                if off is True:
                    combined["reject_resolved"] += 1
    approve = combined["approve"]
    out["combined_mvp_verify_stress"] = {
        **combined,
        "false_positive_rate": (
            combined["approve_unresolved"] / approve if approve else None
        ),
        "issue_8_claim": (
            "#8 评论：18 次 B 运行、15 次有裁决、approve 13 次中 2 次官方 unresolved"
            "（约 15.4%）。按 report-data 旧口径复算见左侧数字；主口径（只取主会话）"
            "的差异来自子会话同名 JSON 被重复计数/裁决序列顺序不同，详见 confusion 一节。"
        ),
    }
    return out


# --------------------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser(description="生成 EVAL-01 canonical run 表与审计数据")
    ap.add_argument("--runs-base", default=str(DEFAULT_RUNS_BASE),
                    help="runs root 的父目录（默认 /tmp）")
    ap.add_argument("--archive", default=str(DEFAULT_ARCHIVE),
                    help="持久归档目录（含 SHA256SUMS.txt）")
    ap.add_argument("--dataset-cache", default=str(DEFAULT_DATASET_CACHE),
                    help="HF dataset 缓存目录（含 feature_bench-fast.arrow）")
    ap.add_argument("--out-dir", default=str(DOCS), help="输出目录（默认 docs/evals）")
    ap.add_argument("--check", action="store_true",
                    help="只做一致性检查并打印摘要，不写文件")
    ap.add_argument("--allow-degraded", action="store_true",
                    help="允许在缺 pyarrow/zstandard 的环境下生成降级产物（会写缺口，"
                         "正式产物不要用）")
    args = ap.parse_args()
    if not args.allow_degraded:
        missing = []
        if _zstd_module() is None:
            missing.append("zstandard")
        try:
            import pyarrow  # type: ignore  # noqa: F401
        except Exception:
            missing.append("pyarrow")
        if missing:
            print(
                "错误：缺少可选依赖 " + "/".join(missing) + "。正式产物需要它们"
                "（session token 补全、sdlc_verify 裁决、gold patch 比对）。"
                "请用 featurebench 的 uv python 运行（见文件头说明），"
                "或在明确接受降级时加 --allow-degraded。",
                file=sys.stderr,
            )
            return 2
    runs_base = Path(args.runs_base)
    archive = Path(args.archive)
    out_dir = Path(args.out_dir)
    canonical, manifests, snap_files, extras = collect_runs(runs_base)
    if len(canonical) != 96:
        print(f"错误：canonical run 数 {len(canonical)} != 96", file=sys.stderr)
        return 2
    evidence = build_evidence_index(canonical, extras, runs_base, archive, snap_files)
    env_identity = build_env_identity(canonical, manifests, extras, runs_base)
    leak_audit = build_leak_audit(canonical, extras, runs_base, Path(args.dataset_cache))
    verifier = build_verifier_confusion(canonical, extras)

    # 输出
    if not args.check:
        out_dir.mkdir(parents=True, exist_ok=True)
        lines = [json.dumps(r, ensure_ascii=False, sort_keys=True) for r in canonical]
        (out_dir / "featurebench-runs.jsonl").write_text("\n".join(lines) + "\n",
                                                         encoding="utf-8")
        dump_json(out_dir / "featurebench-evidence-index.json", evidence)
        dump_json(out_dir / "featurebench-env-identity.json", env_identity)
        dump_json(out_dir / "featurebench-leak-audit.json", leak_audit)
        dump_json(out_dir / "featurebench-verifier-confusion.json", verifier)

    if args.check:
        # --check 不写文件，但必须是真正的检查：archive hash 锚点不符、或「重新生成结果」
        # 与已提交文件不一致时都要非零退出。否则「检查通过」只是打印了旧索引/旧数据。
        problems: list[str] = []
        mism = evidence["counts"]["archive_artifact_mismatches"]
        not_in_sums = evidence["counts"]["archive_artifact_not_in_sums"]
        if mism or not_in_sums:
            problems.append(f"archive 校验失败：mismatches={mism}, not_in_sums={not_in_sums}")
        runs_text = "\n".join(
            json.dumps(r, ensure_ascii=False, sort_keys=True) for r in canonical
        ) + "\n"
        regenerated = {
            "featurebench-runs.jsonl": runs_text,
            "featurebench-evidence-index.json":
                json.dumps(evidence, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            "featurebench-env-identity.json":
                json.dumps(env_identity, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            "featurebench-leak-audit.json":
                json.dumps(leak_audit, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            "featurebench-verifier-confusion.json":
                json.dumps(verifier, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        }
        for name, text in regenerated.items():
            committed = out_dir / name
            if not committed.exists():
                problems.append(f"缺少已提交输出 {name}")
            elif committed.read_text(encoding="utf-8") != text:
                problems.append(f"{name} 与重新生成结果不一致（需重新生成并 review）")
        if problems:
            for msg in problems:
                print("错误：" + msg, file=sys.stderr)
            return 1

    # 摘要（审计对账）
    v1 = [r for r in canonical if r["runtime_group"].startswith("v1-")]
    v2 = [r for r in canonical if r["runtime_group"].startswith("v2-")]
    pilot = [r for r in canonical if r["status"] == "pilot"]
    v1_sc = sum(1 for r in v1 if r["official"] is not None)
    v2_sc = sum(1 for r in v2 if r["official"] is not None)
    try:
        rel_out = out_dir.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        rel_out = out_dir.as_posix()
    print("== FeatureBench canonical runs ==")
    print(f"rows={len(canonical)}  v1={len(v1)} (scoreable {v1_sc})  "
          f"v2={len(v2)} (scoreable {v2_sc})  pilot={len(pilot)}")
    print(f"official reports total={sum(1 for r in canonical if r['official'] is not None)}  "
          f"resolved={sum(1 for r in canonical if r['official'] and r['official']['resolved'])}")
    print(f"attempts known={sum(r['attempts'] or 0 for r in canonical)} "
          f"({sum(1 for r in canonical if r['attempts'] is not None)}/{len(canonical)} rows)")
    print(f"physical runs={evidence['counts']['distinct_physical_runs']} "
          f"(canonical 行={len(canonical)}; cross-refs="
          f"{[c['run_ids'] for c in evidence['cross_references']]})")
    tokens_ui = sum(r["tokens"] or 0 for r in canonical if r["tokens_source"] == "ui")
    tokens_ses = sum(r["tokens"] or 0 for r in canonical if r["tokens_source"] == "session")
    print(f"tokens ui={tokens_ui}  session_fallback={tokens_ses}  total={tokens_ui + tokens_ses}")
    print(f"leak: runs_with_hits={leak_audit['totals']['runs_with_hits']}/"
          f"{leak_audit['totals']['runs']}  hits={leak_audit['totals']['hits_total']}  "
          f"gold_exact_matches={leak_audit['gold_comparison']['exact_sha256_matches']}")
    print(f"verifier B runs={verifier['totals']['b_runs']}  "
          f"confusion(all)={verifier['confusion']['all_b_runs']['counts']}")
    print(f"archive: sha256sums_sha256={evidence['sources']['archive'].get('sha256sums_sha256')}  "
          f"artifact_mismatches={evidence['counts']['archive_artifact_mismatches']}")
    print(f"outputs: {rel_out}/featurebench-{{runs.jsonl,evidence-index,env-identity,"
          f"leak-audit,verifier-confusion}}.json")
    if not snap_files:
        print("警告：没有读到数据快照", file=sys.stderr)
        return 2
    total_snapshot_rows = sum(v.get("rows", 0) for v in snap_files.values())
    print(f"snapshots: files={len(snap_files)} rows={total_snapshot_rows}")
    if total_snapshot_rows != 105:
        print(f"错误：snapshot 行数 {total_snapshot_rows} != 105", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
