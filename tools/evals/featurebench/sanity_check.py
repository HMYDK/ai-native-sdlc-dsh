#!/usr/bin/env python3
"""评测清单、数据索引与评分器的自检（不调模型、不联网）。

三种模式：

1) `--structural`（CI 默认，不依赖 Docker/网络）：
   递归扫描 base manifest 与 `manifests/**/*.yml`（含 `regression-0.6.1/`），校验
   字段、任务 id 唯一性、镜像 digest 一致性、level 与 id 后缀一致、arm 的 preset、
   运行纪律取值上限、标准臂不得带引导（否则 A/B 不再可比），以及 runtime group：
   - base + V1 实验清单：plugin 0.6.0 / DSH 0.2.1-rc.5；
   - `regression-0.6.1/*.yml`：plugin 0.6.1 / DSH 0.2.2-rc.1；
   - 同一 runtime group 内 tarball sha256 必须一致，V2 不得复用 V1 的 tarball；
   - regression 清单必须是同名 V1 清单的同构副本（task id 列表与 arm 集合一致），
     保证「版本回归」比较的是同一协议。

2) `--index`（CI 用，不依赖 Docker/网络）：
   校验 `docs/evals/featurebench-baseline-index.json` 引用的所有 sha256、版本分组、
   数据文件行数/计数、task id 一致性、V1/V2 不混用（镜像名/digest）、not_run 清单
   完整性与 artifacts（runs.jsonl / evidence-index.json）hash。

3) `--control --task-id <id> --image <派生镜像>`（需要 `--execute`）：
   用官方 fb eval 跑 gold / empty 两个预测做负/正对照：
   - gold（数据集 patch 经官方 preprocess 还原）必须 resolved；
   - empty（空补丁）必须 unresolved。
   这是「评分链路没坏 + 官方 mask 环境可用」的最小证据，不消耗模型 token。

用法：
    python3 sanity_check.py --structural
    python3 sanity_check.py --index
    python3 sanity_check.py --control --task-id <id> --image fb-eval-base:<repo> \
        --config /tmp/fb/config.toml --execute
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent.parent
DEFAULT_INDEX = REPO / "docs" / "evals" / "featurebench-baseline-index.json"
REQUIRED_TOP = ("version", "date", "benchmark", "runtime", "arms", "run_policy", "tasks")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
RUNTIME_FIELDS = ("plugin_package", "plugin_version", "plugin_tarball_sha256",
                  "dsh_cli", "provider", "model", "reasoning_effort")
ALLOWED_ARMS = ("standard", "standard_guidance", "sdlc", "sdlc_guidance")
GROUP_V1 = "v1-0.6.0-0.2.1-rc.5"
GROUP_V2 = "v2-0.6.1-0.2.2-rc.1"
V1_VERSIONS = {"dsh_cli": "0.2.1-rc.5", "plugin_version": "0.6.0"}
V2_VERSIONS = {"dsh_cli": "0.2.2-rc.1", "plugin_version": "0.6.1"}
DERIVED_IMAGE_PREFIXES = ("fb-eval-base:", "fb-eval-base-061:")
INDEX_TOP_KEYS = ("schema_version", "generated_by", "benchmark", "runtime_groups",
                  "images", "experiments", "not_run_manifests", "artifacts",
                  "audit_level")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _select_rows(doc: dict, selector: str) -> list:
    """按 `a.b[]` 形式从快照里取出 run/detail 行（与 reaggregate.py 同语义）。"""
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


def _runtime_group_of(path: Path) -> str:
    return GROUP_V2 if "regression-0.6.1" in path.parts else GROUP_V1


def check_manifest(path: Path, base: dict | None, runtime_ref: dict | None,
                   expected_group: str | None, base_image_map: dict | None) -> list[str]:
    errs: list[str] = []
    try:
        m = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as e:
        return [f"{path}: YAML 解析失败: {e}"]
    if not isinstance(m, dict):
        return [f"{path}: 顶层不是 mapping"]
    for k in REQUIRED_TOP:
        if k not in m:
            errs.append(f"{path}: 缺少字段 {k}")
    if errs:
        return errs
    if not isinstance(m["version"], int):
        errs.append(f"{path}: version 必须是整数")
    ids = [t.get("id") for t in m["tasks"] if isinstance(t, dict)]
    if len(ids) != len(set(ids)):
        errs.append(f"{path}: 任务 id 有重复")
    if not m["tasks"]:
        errs.append(f"{path}: tasks 为空")
    for t in m["tasks"]:
        for k in ("id", "repo", "level", "image", "image_digest"):
            if k not in t:
                errs.append(f"{path}: task {t.get('id')} 缺少 {k}")
                continue
        tid = str(t.get("id"))
        if tid.endswith(".lv1") and t.get("level") != 1:
            errs.append(f"{path}: {tid} 后缀 lv1 但 level={t.get('level')}")
        if tid.endswith(".lv2") and t.get("level") != 2:
            errs.append(f"{path}: {tid} 后缀 lv2 但 level={t.get('level')}")
        if not DIGEST_RE.match(str(t.get("image_digest", ""))):
            errs.append(f"{path}: {tid} image_digest 格式不对")
        if base is not None:
            repo_images = {b["repo"]: (b["image"], b["image_digest"]) for b in base["tasks"]}
            if t["repo"] in repo_images and (t["image"], t["image_digest"]) != repo_images[t["repo"]]:
                errs.append(f"{path}: {tid} 的镜像与 base manifest 不一致（会混入不同环境）")
        if base_image_map is not None:
            expected = base_image_map.get(t.get("repo"))
            if expected is None:
                errs.append(f"{path}: {tid} 的 repo {t.get('repo')} 不在 base 镜像表")
            else:
                if str(t.get("image_digest")) != expected["image_digest"]:
                    errs.append(f"{path}: {tid} image_digest 与 base 同 repo 不一致")
                image = str(t.get("image"))
                if image != expected["image"] and not image.startswith(DERIVED_IMAGE_PREFIXES):
                    errs.append(f"{path}: {tid} image={image} 既不是 base 官方镜像也不是派生镜像")
    # arms：preset/引导文本必须与 base 的 treatment 定义一致。
    standard_preset = ""
    sdlc_preset = ""
    guidance_suffix = None
    if base is not None:
        base_arms = base["arms"]
        standard_preset = (base_arms.get("standard") or {}).get("preset", "")
        sdlc_preset = (base_arms.get("sdlc") or {}).get("preset", "")
        guidance_suffix = ((base_arms.get("sdlc") or {}).get("prompt_suffix") or "")
    names = set(m["arms"])
    has_guidance_variant = "sdlc_guidance" in names
    for name, arm in m["arms"].items():
        if name not in ALLOWED_ARMS:
            errs.append(f"{path}: 未知 arm {name}（允许 {', '.join(ALLOWED_ARMS)}）")
            continue
        if not arm.get("preset"):
            errs.append(f"{path}: arm {name} 缺少 preset")
        if name == "standard" and (arm.get("prompt_suffix") or "").strip():
            errs.append(f"{path}: standard arm 不允许带 prompt_suffix（A/B 可比性）")
        if base is None:
            continue
        # 无引导臂 = 纯 preset；有引导臂 = preset + base sdlc arm 的固定引导文本。
        # 2×2 里同时存在 sdlc（纯）与 sdlc_guidance（引导），其它清单的 sdlc 就是
        # 主 treatment（manifest 内自带引导文本）。
        suffix = arm.get("prompt_suffix") or ""
        if name == "standard":
            if arm.get("preset") != standard_preset:
                errs.append(f"{path}: arm {name} preset 与 base 标准臂不一致")
        elif name == "standard_guidance":
            if arm.get("preset") != standard_preset:
                errs.append(f"{path}: arm {name} preset 与 base 标准臂不一致")
            if suffix != guidance_suffix:
                errs.append(f"{path}: arm {name} 的引导文本必须与 base sdlc arm 完全一致")
        elif name == "sdlc_guidance":
            if arm.get("preset") != sdlc_preset:
                errs.append(f"{path}: arm {name} preset 与 base SDLC 臂不一致")
            if suffix != guidance_suffix:
                errs.append(f"{path}: arm {name} 的引导文本必须与 base sdlc arm 完全一致")
        elif name == "sdlc":
            if arm.get("preset") != sdlc_preset:
                errs.append(f"{path}: arm {name} preset 与 base SDLC 臂不一致")
            if has_guidance_variant:
                if suffix.strip():
                    errs.append(f"{path}: 2×2 清单里的纯 sdlc arm 不应带 prompt_suffix")
            elif suffix != guidance_suffix:
                errs.append(f"{path}: 主 treatment arm sdlc 必须带固定引导文本"
                            "（与 base sdlc arm 一致）")
    pol = m["run_policy"]
    for k in ("timeout_seconds", "max_tokens_per_run", "total_token_budget"):
        if not isinstance(pol.get(k), (int, float)) or pol.get(k) <= 0:
            errs.append(f"{path}: run_policy.{k} 必须是正数")
    if pol.get("timeout_seconds", 0) > 7200:
        errs.append(f"{path}: timeout_seconds 超过 7200（2h）")
    if pol.get("total_token_budget", 0) > 2_000_000_000:
        errs.append(f"{path}: total_token_budget 超过 2B，疑似写错")
    # runtime group：版本/tarball 必须与所在组一致。
    rt = m.get("runtime") or {}
    for k in RUNTIME_FIELDS:
        if k not in rt:
            errs.append(f"{path}: runtime 缺少 {k}")
    if runtime_ref is not None:
        for k in RUNTIME_FIELDS:
            if rt.get(k) != runtime_ref.get(k):
                errs.append(f"{path}: runtime.{k}={rt.get(k)!r} 与同组参考清单 "
                            f"{runtime_ref.get(k)!r} 不一致（跨版本混用？）")
    if expected_group is None:
        expected_group = _runtime_group_of(path)
    expected_versions = V2_VERSIONS if expected_group == GROUP_V2 else V1_VERSIONS
    for k, value in expected_versions.items():
        if rt.get(k) != value:
            errs.append(f"{path}: runtime.{k}={rt.get(k)!r}，"
                        f"{expected_group} 要求 {value!r}")
    return errs


def _load_runtime_ref(path: Path) -> dict:
    return (yaml.safe_load(path.read_text(encoding="utf-8")) or {}).get("runtime") or {}


def _check_regression_isomorphic(v1_files: list, regression_dir: Path,
                                 base_path: Path) -> list[str]:
    """regression-0.6.1/*.yml 必须是同名 V1 清单的同构副本（同 task 列表、同 arm 集合）。"""
    errs = []
    reg_files = {p.name: p for p in sorted(regression_dir.glob("*.yml"))} \
        if regression_dir.exists() else {}
    v1_by_name = {p.name: p for p in v1_files}
    v1_by_name["mvp.yml"] = base_path  # base manifest 的 V2 版本叫 mvp.yml
    for name, reg_path in sorted(reg_files.items()):
        v1_path = v1_by_name.get(name)
        if v1_path is None:
            errs.append(f"{reg_path}: 找不到同名 V1 清单（{name}）")
            continue
        reg = yaml.safe_load(reg_path.read_text(encoding="utf-8"))
        v1 = yaml.safe_load(v1_path.read_text(encoding="utf-8"))
        reg_ids = [str(t.get("id")) for t in reg.get("tasks") or []]
        v1_ids = [str(t.get("id")) for t in v1.get("tasks") or []]
        if reg_ids != v1_ids:
            errs.append(f"{reg_path}: task 列表与 V1 清单不同构")
        if set((reg.get("arms") or {}).keys()) != set((v1.get("arms") or {}).keys()):
            errs.append(f"{reg_path}: arm 集合与 V1 清单不同构")
    for name, v1_path in sorted(v1_by_name.items()):
        if name not in reg_files:
            errs.append(f"{regression_dir}: 缺少 V1 清单 {name} 的 regression 副本")
    return errs


def structural(manifests_dir: Path) -> int:
    base_path = HERE / "manifest.yml"
    base = yaml.safe_load(base_path.read_text(encoding="utf-8"))
    base_image_map = {t["repo"]: {"image": t["image"], "image_digest": t["image_digest"]}
                      for t in base["tasks"]}
    regression_dir = manifests_dir / "regression-0.6.1"
    errors = check_manifest(base_path, None, None, GROUP_V1, base_image_map)
    v1_files = sorted(manifests_dir.glob("*.yml")) if manifests_dir.exists() else []
    for f in v1_files:
        errors += check_manifest(f, base, base["runtime"], GROUP_V1, base_image_map)
    reg_files = sorted(regression_dir.glob("*.yml")) if regression_dir.exists() else []
    if reg_files:
        ref_name = "mvp.yml"
        ref_path = regression_dir / ref_name
        runtime_v2 = _load_runtime_ref(ref_path) if ref_path.exists() else {}
        if not runtime_v2:
            errors.append(f"{regression_dir}: 缺少 V2 参考清单 {ref_name}（无法校验 runtime）")
        for f in reg_files:
            errors += check_manifest(f, base, runtime_v2, GROUP_V2, base_image_map)
        errors += _check_regression_isomorphic(v1_files, regression_dir, base_path)
    print(f"manifests: base + V1 {len(v1_files)} "
          f"({', '.join(f.name for f in v1_files)}) + V2 regression {len(reg_files)} "
          f"({', '.join(f.name for f in reg_files)})")
    if errors:
        print("\n".join(f"ERROR {e}" for e in errors), file=sys.stderr)
        return 1
    print("structural check OK")
    return 0


# ---------------------------------------------------------------------------
# baseline-index 校验
# ---------------------------------------------------------------------------
def _counts_from_report_rows(rows: list) -> dict:
    scoreable = [r for r in rows if "resolved" in r]
    return {
        "attempted": len(rows),
        "scoreable": len(scoreable),
        "resolved": sum(1 for r in scoreable if r["resolved"]),
        "arms": sorted({str(r.get("arm")) for r in rows}),
    }


def index_check(index_path: Path) -> int:
    errors: list[str] = []
    if not index_path.exists():
        print(f"ERROR 缺少 baseline index：{index_path}", file=sys.stderr)
        return 1
    try:
        index = json.loads(index_path.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001 - 任何解析失败都要以非零退出
        print(f"ERROR baseline index 不是合法 JSON: {e}", file=sys.stderr)
        return 1
    for key in INDEX_TOP_KEYS:
        if key not in index:
            errors.append(f"{index_path}: 缺少字段 {key}")
    if errors:
        print("\n".join(f"ERROR {e}" for e in errors), file=sys.stderr)
        return 1
    if index.get("schema_version") != 1:
        errors.append(f"{index_path}: schema_version 必须为 1")
    if index.get("generated_by") != "tools/evals/featurebench/reaggregate.py":
        errors.append(f"{index_path}: generated_by 不是 reaggregate.py")

    base_path = HERE / "manifest.yml"
    base = yaml.safe_load(base_path.read_text(encoding="utf-8"))
    runtime_sources = {
        GROUP_V1: base["runtime"],
        GROUP_V2: _load_runtime_ref(HERE / "manifests" / "regression-0.6.1" / "mvp.yml"),
    }
    benchmark = index["benchmark"]
    package = str((base.get("benchmark") or {}).get("package") or "")
    grader_name, _, grader_version = package.partition("==")
    if benchmark.get("grader") != {"package": grader_name, "version": grader_version}:
        errors.append(f"{index_path}: benchmark.grader 与 base manifest 的 "
                      f"{grader_name}=={grader_version} 不一致")
    expected_dataset = {
        "repo": (base.get("benchmark") or {}).get("dataset"),
        "revision": (base.get("benchmark") or {}).get("revision"),
        "split": (base.get("benchmark") or {}).get("split"),
    }
    if benchmark.get("dataset") != expected_dataset:
        errors.append(f"{index_path}: benchmark.dataset 与 base manifest 不一致")

    # runtime groups：dsh/plugin/tarball 必须与各自参考 manifest 一致，且 V1≠V2。
    groups = index["runtime_groups"]
    for group in (GROUP_V1, GROUP_V2):
        if group not in groups:
            errors.append(f"{index_path}: 缺少 runtime group {group}")
            continue
        ref = runtime_sources.get(group) or {}
        for key in RUNTIME_FIELDS:
            if groups[group].get(key) != ref.get(key):
                errors.append(f"{index_path}: runtime_groups[{group}].{key} "
                              f"与参考清单不一致")
    if (groups.get(GROUP_V1, {}).get("plugin_tarball_sha256")
            == groups.get(GROUP_V2, {}).get("plugin_tarball_sha256")):
        errors.append(f"{index_path}: V1 与 V2 的 plugin_tarball_sha256 相同（版本混用？）")

    # images：官方镜像/digest 必须与 base manifest 一致。
    images = index["images"]
    base_images = {t["repo"]: {"official_image": t["image"],
                               "image_digest": t["image_digest"]}
                   for t in base["tasks"]}
    for repo, expected in base_images.items():
        got = images.get(repo) or {}
        if got.get("official_image") != expected["official_image"]:
            errors.append(f"{index_path}: images[{repo}].official_image 与 base 不一致")
        if got.get("image_digest") != expected["image_digest"]:
            errors.append(f"{index_path}: images[{repo}].image_digest 与 base 不一致")
        derived = got.get("derived_images") or {}
        for group in derived:
            if group not in (GROUP_V1, GROUP_V2):
                errors.append(f"{index_path}: images[{repo}] 的派生镜像分组 {group} 未知")

    # artifacts：hash 必须与磁盘一致；runs.jsonl 行数也要对。
    artifacts = index["artifacts"]
    runs_rows = None
    for name in ("runs_jsonl", "evidence_index"):
        record = artifacts.get(name)
        if record is None:
            continue
        path = REPO / record.get("path", "")
        if not path.is_file():
            errors.append(f"{index_path}: artifacts.{name} 引用的文件不存在: "
                          f"{record.get('path')}")
            continue
        actual = _sha256(path)
        if actual != record.get("sha256"):
            errors.append(f"{index_path}: artifacts.{name} sha256 不匹配 "
                          f"（文件变了但 index 未更新）")
        if name == "runs_jsonl":
            lines = [line for line in path.read_text(encoding="utf-8").splitlines()
                     if line.strip()]
            runs_rows = len(lines)
            if record.get("rows") != runs_rows:
                errors.append(f"{index_path}: artifacts.runs_jsonl.rows="
                              f"{record.get('rows')} 与实际 {runs_rows} 行不一致")

    executed_manifests: set = set()
    not_run_paths = set()
    experiments = index["experiments"]
    if not experiments:
        errors.append(f"{index_path}: experiments 为空")
    seen_experiments = set()
    for exp in experiments:
        exp_id = exp.get("id")
        if not exp_id:
            errors.append(f"{index_path}: experiment 缺少 id")
            continue
        if exp_id in seen_experiments:
            errors.append(f"{index_path}: experiment id 重复: {exp_id}")
        seen_experiments.add(exp_id)
        exp_groups = set(exp.get("runtime_groups") or [])
        if not exp.get("sides"):
            errors.append(f"{index_path}: {exp_id} 没有 sides")
        side_groups = set()
        for side in exp.get("sides") or []:
            side_id = side.get("id")
            label = f"{exp_id}/{side_id}"
            group = side.get("runtime_group")
            side_groups.add(group)
            if group not in (GROUP_V1, GROUP_V2):
                errors.append(f"{index_path}: {label} runtime_group={group} 未知")
                continue
            if group not in groups:
                errors.append(f"{index_path}: {label} runtime_group 未在顶层登记")
            # manifest：存在、hash、runtime 版本组、task id 唯一
            manifest_rec = side.get("manifest") or {}
            manifest_path = REPO / str(manifest_rec.get("path", ""))
            if not manifest_path.is_file():
                errors.append(f"{index_path}: {label} manifest 不存在: "
                              f"{manifest_rec.get('path')}")
                continue
            executed_manifests.add(str(manifest_rec.get("path")))
            if _sha256(manifest_path) != manifest_rec.get("sha256"):
                errors.append(f"{index_path}: {label} manifest sha256 不匹配")
            manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
            path_group = _runtime_group_of(manifest_path)
            if path_group != group:
                errors.append(f"{index_path}: {label} runtime_group={group} 与 manifest "
                              f"目录分组 {path_group} 不一致（V1/V2 混用？）")
            manifest_runtime = manifest.get("runtime") or {}
            for key in ("dsh_cli", "plugin_version", "plugin_tarball_sha256"):
                if manifest_runtime.get(key) != (groups.get(group) or {}).get(key):
                    errors.append(f"{index_path}: {label} manifest runtime.{key} "
                                  f"与 index 的组定义不一致")
            manifest_ids = [str(t.get("id")) for t in manifest.get("tasks") or []]
            if len(manifest_ids) != len(set(manifest_ids)):
                errors.append(f"{index_path}: {label} manifest task id 有重复")
            if side.get("manifest_task_ids") != manifest_ids:
                errors.append(f"{index_path}: {label} manifest_task_ids 与 manifest 不一致")
            # data：hash、行数、run 行内容
            report_rows: list = []
            for data_rec in side.get("data") or []:
                data_path = REPO / str(data_rec.get("path", ""))
                if not data_path.is_file():
                    errors.append(f"{index_path}: {label} data 不存在: "
                                  f"{data_rec.get('path')}")
                    continue
                if _sha256(data_path) != data_rec.get("sha256"):
                    errors.append(f"{index_path}: {label} data sha256 不匹配: "
                                  f"{data_rec.get('path')}")
                doc = json.loads(data_path.read_text(encoding="utf-8"))
                rows = _select_rows(doc, str(data_rec.get("runs_selector", "")))
                if data_rec.get("rows") != len(rows):
                    errors.append(f"{index_path}: {label} data {data_rec.get('path')} "
                                  f"rows={data_rec.get('rows')} 与实际 {len(rows)} 不一致")
                if data_rec.get("role") == "report":
                    report_rows.extend(rows)
            for row in report_rows:
                repo = row.get("repo")
                expected_image = (images.get(repo) or {})
                if not expected_image:
                    errors.append(f"{index_path}: {label} run repo={repo} 不在镜像表")
                    continue
                if row.get("image_digest") != expected_image.get("image_digest"):
                    errors.append(f"{index_path}: {label} run image_digest 与镜像表不一致")
                derived = (expected_image.get("derived_images") or {}).get(group)
                image = row.get("image")
                if image != expected_image.get("official_image") and image != derived:
                    errors.append(f"{index_path}: {label} run image={image!r} 不属于 "
                                  f"{group}（V1/V2 混用？）")
            if report_rows:
                observed_ids = sorted({str(r.get("task_id")) for r in report_rows})
                if observed_ids != list(side.get("observed_task_ids") or []):
                    errors.append(f"{index_path}: {label} observed_task_ids 与实际 run 不一致")
                if set(observed_ids) != set(manifest_ids):
                    errors.append(f"{index_path}: {label} 实际 run 的 task id 集合与 "
                                  f"manifest 不一致")
                counts = _counts_from_report_rows(report_rows)
                for key in ("attempted", "scoreable", "resolved"):
                    if (side.get("counts") or {}).get(key) != counts[key]:
                        errors.append(f"{index_path}: {label} counts.{key}="
                                      f"{(side.get('counts') or {}).get(key)} "
                                      f"与实际 {counts[key]} 不一致")
                if list((side.get("counts") or {}).get("arms") or []) != counts["arms"]:
                    errors.append(f"{index_path}: {label} counts.arms 与实际 run 不一致")
                if (side.get("counts") or {}).get("repeats") is None:
                    errors.append(f"{index_path}: {label} counts.repeats 缺失")
            time_window = side.get("time_window") or {}
            for key in ("started_at_min", "started_at_max", "source"):
                if key not in time_window:
                    errors.append(f"{index_path}: {label} time_window 缺少 {key}")
        if exp_groups != side_groups:
            errors.append(f"{index_path}: {exp_id} runtime_groups 与 sides 不一致")

    # not_run：完整性、hash、计划运行数、与已执行清单不重叠。
    reg_dir = HERE / "manifests" / "regression-0.6.1"
    reg_files = {str(p.relative_to(REPO)) for p in sorted(reg_dir.glob("*.yml"))} \
        if reg_dir.exists() else set()
    for record in index.get("not_run_manifests") or []:
        rel = str(record.get("path", ""))
        not_run_paths.add(rel)
        path = REPO / rel
        if not path.is_file():
            errors.append(f"{index_path}: not_run manifest 不存在: {rel}")
            continue
        if _sha256(path) != record.get("sha256"):
            errors.append(f"{index_path}: not_run manifest sha256 不匹配: {rel}")
        manifest = yaml.safe_load(path.read_text(encoding="utf-8"))
        tasks = manifest.get("tasks") or []
        arms = sorted((manifest.get("arms") or {}).keys())
        task_ids = [str(t.get("id")) for t in tasks]
        if len(task_ids) != len(set(task_ids)):
            errors.append(f"{index_path}: not_run manifest task id 有重复: {rel}")
        if record.get("tasks") != len(tasks) or record.get("arms") != arms:
            errors.append(f"{index_path}: not_run manifest {rel} 的 tasks/arms 描述与实际不一致")
        if record.get("planned_runs") != len(tasks) * len(arms):
            errors.append(f"{index_path}: not_run manifest {rel} planned_runs 不一致")
        if record.get("runtime_group") != GROUP_V2:
            errors.append(f"{index_path}: not_run manifest {rel} runtime_group 必须是 {GROUP_V2}")
    executed_regression = {m for m in executed_manifests if m in reg_files}
    if executed_regression & not_run_paths:
        errors.append(f"{index_path}: 同一 regression manifest 同时出现在 executed 与 not_run")
    if reg_files and (executed_regression | not_run_paths) != reg_files:
        missing = sorted(reg_files - executed_regression - not_run_paths)
        errors.append(f"{index_path}: regression manifest 未纳入 index: {missing}")
    if runs_rows is not None and runs_rows == 0:
        errors.append(f"{index_path}: runs.jsonl 行数为 0")

    if errors:
        print("\n".join(f"ERROR {e}" for e in errors), file=sys.stderr)
        return 1
    print(f"baseline index OK: {len(experiments)} experiments, "
          f"{sum(len(e.get('sides') or []) for e in experiments)} sides, "
          f"{len(index.get('not_run_manifests') or [])} not_run manifests, "
          f"artifacts={[k for k, v in (index.get('artifacts') or {}).items() if v]}")
    return 0


# ---------------------------------------------------------------------------
# gold / empty 官方评分对照（需要 Docker + fb；仅 --execute 跑）
# ---------------------------------------------------------------------------
def control(task_id: str, image: str, config: str | None, fb_bin: str) -> int:
    from datasets import load_dataset
    from featurebench.harness.utils import preprocess_hf_patch

    ds = load_dataset("LiberCoders/FeatureBench", "default", split="fast", revision="v1.1")
    row = next((r for r in ds if r["instance_id"] == task_id), None)
    if row is None:
        print(f"task {task_id} 不在 dataset fast split", file=sys.stderr)
        return 2
    gold = preprocess_hf_patch(row.get("patch", ""), row.get("FAIL_TO_PASS", []))
    if not gold.strip():
        print("gold patch 为空，无法做对照", file=sys.stderr)
        return 2
    env = dict(os.environ, FEATUREBENCH_IMAGE_PREFIX="docker.io")
    tmp = Path(tempfile.mkdtemp(prefix="fb-control-"))
    results = {}
    for label, patch in (("gold", gold), ("empty", "")):
        pred = tmp / f"{label}.jsonl"
        pred.write_text(json.dumps({
            "instance_id": task_id, "model_name_or_path": f"control-{label}",
            "model_patch": patch, "success": True, "n_attempt": 1,
        }, ensure_ascii=False) + "\n", encoding="utf-8")
        cmd = [fb_bin, "eval", "-p", str(pred), "--split", "fast", "--task-id", task_id,
               "--n-concurrent", "1", "--data-version", "v1.1"]
        if config:
            cmd += ["--config-path", config]
        work = tmp / label
        work.mkdir()
        r = subprocess.run(cmd, cwd=work, env=env, capture_output=True, text=True)
        (work / "eval.log").write_text(r.stdout + "\n" + r.stderr)
        report = {}
        if (work / "report.json").exists():
            report = json.loads((work / "report.json").read_text()).get("attempt_1", {})
        elif (pred.parent / "report.json").exists():
            report = json.loads((pred.parent / "report.json").read_text()).get("attempt_1", {})
        results[label] = {
            "resolved": bool(report.get("resolved_instances")),
            "pass_rate": report.get("pass_rate"),
            "postprocessed_patch_chars": len(patch),
            "eval_exit": r.returncode,
        }
        print(f"[control] {label}: resolved={results[label]['resolved']} "
              f"pass_rate={results[label]['pass_rate']}")
    ok = results["gold"]["resolved"] is True and results["empty"]["resolved"] is False
    print(json.dumps({"task_id": task_id, "image": image, "ok": ok, "results": results},
                     ensure_ascii=False, indent=2))
    if not ok:
        print("CONTROL FAILED：gold 应 resolved 且 empty 应 unresolved", file=sys.stderr)
        return 1
    print("control check OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--structural", action="store_true", help="校验清单结构（CI 用）")
    ap.add_argument("--index", action="store_true",
                    help="校验 baseline-index 的 hash/分组/计数（CI 用）")
    ap.add_argument("--control", action="store_true", help="gold/empty 对照（需 --execute）")
    ap.add_argument("--manifests-dir", default=str(HERE / "manifests"))
    ap.add_argument("--index-path", default=str(DEFAULT_INDEX))
    ap.add_argument("--task-id", help="control 用：固定任务 id")
    ap.add_argument("--image", help="control 用：本地派生镜像（fb-eval-base:<repo>）")
    ap.add_argument("--config", help="fb eval 的 config.toml")
    ap.add_argument("--fb-bin", default="fb")
    ap.add_argument("--execute", action="store_true", help="control 模式必须显式开启")
    args = ap.parse_args()
    if args.structural:
        return structural(Path(args.manifests_dir))
    if args.index:
        return index_check(Path(args.index_path))
    if args.control:
        if not args.execute:
            print("[dry-run] control 需要 --execute（会起容器跑官方测试）", file=sys.stderr)
            return 0
        if not (args.task_id and args.image):
            print("control 需要 --task-id 和 --image", file=sys.stderr)
            return 2
        return control(args.task_id, args.image, args.config, args.fb_bin)
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
