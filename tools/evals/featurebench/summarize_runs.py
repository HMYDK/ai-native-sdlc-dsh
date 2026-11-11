#!/usr/bin/env python3
"""把 5 任务 × 2 臂的运行产物汇总成报告数据（人读 markdown + 机读 json）。

用法：
    python3 summarize_runs.py --manifest manifest.yml --runs-root /tmp/fb-runs \
        --out /tmp/fb-runs/report-data.json --markdown /tmp/fb-runs/report.md

关键口径（与 issue #8 的报告要求对应）：
- 官方评分为唯一成绩来源；agent 自报/验证者裁决不作为成绩；
- 所有运行都进分母：timeout / over_budget / infra_error / empty_patch / agent_error /
  unresolved 分类单列；
- B 组额外记录：是否真的调用 sdlc_*、sdlc_verify 的裁决（approve/reject/needs_human）、
  以及裁决与官方评分是否错配（verifier false-positive/negative 的线索）；
- 参考副本泄漏扫描命中的文件路径逐个列出（不改官方镜像）。

依赖：zstandard 可选（没有时仍能汇总，只是读不到按工具的 session 统计）。
"""
from __future__ import annotations

import argparse
import glob
import json
import re
from pathlib import Path

import yaml


def load_json(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def official_metrics(task_dir: Path, arm: str) -> dict:
    # fb eval 的 report 可能落在 arm 目录或 eval-<arm>/ 下（见 evaluate_matrix 的注释）
    for cand in (task_dir / arm / "report.json", task_dir / f"eval-{arm}" / "report.json"):
        d = load_json(cand) if cand.exists() else None
        if d:
            a = d.get("attempt_1", {})
            return {
                "resolved": bool(a.get("resolved_instances")),
                "pass_rate": a.get("pass_rate"),
                "resolved_rate": a.get("resolved_rate"),
                "errors": a.get("error_instances"),
                "not_applied_empty": a.get("not_applied_patch_empty_instances"),
            }
    return {}


def session_tokens(task_dir: Path) -> int | None:
    """从 session 日志汇总每条 assistant 消息的 usage.totalTokens（UI 读数丢失时的兜底）。

    实测与 DSH Web 的「用量」读数一致（seaborn standard 2.23M vs UI 2.2M）；
    B 组会多算验证者子会话的消耗，所以报告里与 UI 值并列而不是替换。
    """
    try:
        import zstandard
    except Exception:
        return None
    total = 0
    for f in glob.glob(str(task_dir / "**" / "*.zstd"), recursive=True):
        try:
            raw = zstandard.ZstdDecompressor().stream_reader(open(f, "rb")).read()
        except Exception:
            continue
        for line in raw.splitlines():
            try:
                x = json.loads(line)
            except Exception:
                continue
            d = x.get("data") or {}
            msg = d.get("message") if isinstance(d.get("message"), dict) else {}
            u = msg.get("usage") or d.get("usage")
            if isinstance(u, dict) and isinstance(u.get("totalTokens"), int):
                total += u["totalTokens"]
    return total or None


VERDICT_STATUSES = ("approve", "reject", "needs_human")


def extract_verify_status(text: str) -> str | None:
    """从 sdlc_verify 结果文本里取「有效裁决」，优先 structured verdict。

    - 正常结果：`"verdict": {"status": "..."}` 是经过 criteria policy 后的有效裁决；
      `raw_verdict.status` / `raw_status` 只是模型原始判断，可能被降级。
    - 验证器输出无法解析时，index 会直接返回 `{"status": "needs_human", ...}`（无 raw_status）。
    - 老日志/截断文本没有结构化结果时，回退到 raw_status。
    """
    m = re.search(r'"verdict"\s*:\s*\{\s*"status"\s*:\s*"(approve|reject|needs_human)"', text)
    if m:
        return m.group(1)
    m = re.match(r'\s*\{\s*"status"\s*:\s*"(approve|reject|needs_human)"', text)
    if m:
        return m.group(1)
    m = re.search(r'"raw_status"\s*:\s*"(approve|reject|needs_human)"', text)
    return m.group(1) if m else None


def sdlc_stats(task_dir: Path) -> dict:
    """从 session 日志统计实际工具调用与 verify 裁决（zstandard 可选）。"""
    try:
        import zstandard  # noqa: F401
    except Exception:
        return {"available": False, "reason": "zstandard not installed"}
    calls: dict[str, int] = {}
    verdicts: list[str] = []
    for f in glob.glob(str(task_dir / "**" / "*.zstd"), recursive=True):
        try:
            raw = zstandard.ZstdDecompressor().stream_reader(open(f, "rb")).read()
        except Exception:
            continue
        for line in raw.splitlines():
            try:
                d = json.loads(line)
            except Exception:
                continue

            def walk(o):
                if isinstance(o, dict):
                    if o.get("type") == "tool-call" and isinstance(o.get("name"), str):
                        calls[o["name"]] = calls.get(o["name"], 0) + 1
                    for v in o.values():
                        walk(v)
                elif isinstance(o, list):
                    for v in o:
                        walk(v)
                elif isinstance(o, str):
                    # sdlc_verify 的结果 JSON 嵌在 tool/result 文本里；取有效 status
                    # （可能被 policy 从 approve 降级为 needs_human/reject），
                    # 不能直接读 raw_status。
                    status = extract_verify_status(o)
                    if status is not None:
                        verdicts.append(status)

            walk(d)
    sdlc = {k: v for k, v in calls.items() if k.startswith("sdlc_")}
    return {"available": True, "sdlc_tool_calls": sdlc, "verify_verdicts": verdicts,
            "used_sdlc": bool(sdlc)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default=str(Path(__file__).with_name("manifest.yml")))
    ap.add_argument("--runs-root", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--markdown", required=True)
    args = ap.parse_args()

    manifest = yaml.safe_load(open(args.manifest, encoding="utf-8"))
    runs_root = Path(args.runs_root)
    arms = list(manifest["arms"].keys())
    # matrix.json 保存了每次 attempt 的 token 用量；meta.json 只有最后一次尝试，
    # infra 重试过的 run 只看 meta 会少算成本。这里按 (task, arm) 对齐回报告行。
    matrix_runs: dict = {}
    matrix_path = runs_root / "matrix.json"
    if matrix_path.exists():
        matrix_data = load_json(matrix_path) or {}
        for mrun in matrix_data.get("runs") or []:
            key = (mrun.get("task"), mrun.get("arm"))
            matrix_runs[key] = mrun
    sdlc_arms = [a for a in arms if "SDLC" in (manifest["arms"][a].get("preset") or "")]
    tasks = []
    for task in manifest["tasks"]:
        task_dir = runs_root / task["id"]
        if not task_dir.exists():
            task_dir = runs_root / task["id"].split(".")[0]  # 兼容首批目录
        for arm in arms:
            d = task_dir / arm
            if not (d / "meta.json").exists():
                continue
            meta = load_json(d / "meta.json") or {}
            row = {
                "task_id": task["id"],
                "repo": task["repo"],
                "arm": arm,
                "preset": meta.get("preset"),
                "image": meta.get("image"),
                "image_digest": meta.get("image_digest"),
                "tokens": meta.get("token_usage"),
                "elapsed_seconds": meta.get("elapsed_seconds"),
                "patch_chars": meta.get("patch_chars"),
                "full_patch_chars": meta.get("full_patch_chars"),
                "agent_completed": meta.get("agent_completed"),
                "agent_failure": meta.get("agent_failure"),
                "leak_scan_hits": meta.get("leak_scan_hits", []),
            }
            row.update(official_metrics(task_dir, arm))
            mrun = matrix_runs.get((task["id"], arm))
            if mrun:
                row["attempts"] = mrun.get("attempts")
                row["attempt_usage"] = mrun.get("attempt_usage")
            if row["tokens"] is None and mrun and isinstance(mrun.get("tokens"), (int, float)):
                row["tokens"] = int(mrun["tokens"])
                row["tokens_source"] = "matrix_attempts_sum"
            elif row["tokens"] is None:
                row["tokens"] = session_tokens(d)
                row["tokens_source"] = "session" if row["tokens"] else None
            else:
                row["tokens_source"] = "ui"
            # 发生 infra 重试时 meta 只是最后一次尝试，改用 matrix 的 attempt 总和。
            if (mrun and isinstance(mrun.get("tokens"), (int, float))
                    and int(mrun.get("attempts") or 1) > 1):
                row["tokens"] = int(mrun["tokens"])
                row["tokens_source"] = "matrix_attempts_sum"
            if arm in sdlc_arms:
                # 必须传当前 arm 目录 d，不能传 task_dir：2×2 的同一 task 下同时有
                # sdlc/ 与 sdlc_guidance/，递归读会串臂、把另一臂的工具调用/裁决算进来。
                row.update(sdlc_stats(d))
                verdicts = row.get("verify_verdicts") or []
                if "resolved" not in row:
                    row["verifier_vs_official"] = "not_applicable"
                elif not verdicts:
                    # 超时截断可能没来得及产出裁决；不能算成不一致
                    row["verifier_vs_official"] = "no_verdict"
                else:
                    approves = verdicts[-1] == "approve"
                    row["verifier_vs_official"] = "agree" if approves == row["resolved"] else "mismatch"
            tasks.append(row)

    # matrix.json 里记录过尝试、但没留下 meta.json 的 run（infra 重试耗尽或初始化阶段就挂掉）
    # 不能从报告和分母里静默消失；补成显式 infra_error 行，保留 attempted cohort。
    seen = {(r["task_id"], r["arm"]) for r in tasks}
    matrix_path = runs_root / "matrix.json"
    matrix = load_json(matrix_path) if matrix_path.exists() else None
    task_by_id = {t["id"]: t for t in manifest["tasks"]}
    for mrun in (matrix or {}).get("runs") or []:
        tid, arm = mrun.get("task"), mrun.get("arm")
        if tid not in task_by_id or arm not in arms or (tid, arm) in seen:
            continue
        tasks.append({
            "task_id": tid,
            "repo": task_by_id[tid]["repo"],
            "arm": arm,
            "preset": manifest["arms"][arm].get("preset"),
            "image": mrun.get("image"),
            "image_digest": None,
            "tokens": mrun.get("tokens"),
            "tokens_source": "ui" if mrun.get("tokens") is not None else None,
            "elapsed_seconds": None,
            "patch_chars": mrun.get("patch_chars"),
            "full_patch_chars": None,
            "agent_completed": mrun.get("agent_completed"),
            "agent_failure": "infra_error",
            "infra_exit_code": mrun.get("exit"),
            "attempts": mrun.get("attempts"),
            "leak_scan_hits": [],
        })
        seen.add((tid, arm))

    data = {"manifest": str(Path(args.manifest).resolve()),
            "runs_root": str(runs_root.resolve()), "runs": tasks}
    Path(args.out).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = ["# FeatureBench A/B 运行汇总", ""]
    lines.append("| repo | arm | resolved | pass_rate | tokens | elapsed_s | patch_chars | agent_failure |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for r in tasks:
        lines.append(f"| {r['repo']} | {r['arm']} | {r.get('resolved')} | {r.get('pass_rate')} | "
                     f"{r.get('tokens')} | {r.get('elapsed_seconds')} | {r.get('patch_chars')} | "
                     f"{r.get('agent_failure') or ''} |")
    lines.append("")
    for arm in arms:
        rows = [r for r in tasks if r["arm"] == arm]
        if rows:
            resolved = sum(1 for r in rows if r.get("resolved"))
            avg = sum(float(r.get("pass_rate") or 0) for r in rows) / len(rows)
            lines.append(f"- **{arm}**: n={len(rows)}, resolved={resolved}, avg_pass_rate={avg:.4f}")
    for arm in sdlc_arms:
        b = [r for r in tasks if r["arm"] == arm and "resolved" in r]
        if b:
            used = sum(1 for r in b if r.get("used_sdlc"))
            agree = sum(1 for r in b if r.get("verifier_vs_official") == "agree")
            noverdict = sum(1 for r in b if r.get("verifier_vs_official") == "no_verdict")
            mismatch = sum(1 for r in b if r.get("verifier_vs_official") == "mismatch")
            lines.append(f"- **{arm} 流程采纳**: {used}/{len(b)} 次真的调用过 sdlc_*；"
                         f"验证者 vs 官方: agree={agree}, mismatch={mismatch}, no_verdict={noverdict}")
    leaks = sum(1 for r in tasks if r.get("leak_scan_hits"))
    lines.append(f"- **参考副本泄漏**: {leaks}/{len(tasks)} 次运行扫描命中（镜像内 vendored 实现，未修改环境；见 README 已知限制）")
    Path(args.markdown).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
