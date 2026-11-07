#!/usr/bin/env python3
"""把一次评测的 runs 目录归档成可保存/转移的 tar.gz（默认不含 session 原件）。

为什么需要：`run_arm.py` 的产物默认在 `/tmp/fb-runs*`，机器重启就没了；session
日志含完整对话与工具输出，体积大且可能带环境信息，默认不归档。

归档内容（每个 task/arm 目录）：
  meta.json, run.json, adoption.json, patch.diff, leak_scan.txt，
  patch.full.diff（可用 --no-full-patch 关闭），
  eval-<arm>/report.json 与 eval.log（如果存在）。

用法：
    python3 archive_runs.py --runs-root /tmp/fb-runs --out /tmp/featurebench-2026-11-06-runs.tar.gz
    python3 archive_runs.py --runs-root /tmp/fb-runs --out x.tar.gz --with-sessions
"""
from __future__ import annotations

import argparse
import hashlib
import json
import tarfile
import time
from pathlib import Path

KEEP_FILES = ("meta.json", "run.json", "adoption.json", "patch.diff", "leak_scan.txt",
              "patch.full.diff", "prompt.txt")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs-root", required=True)
    ap.add_argument("--out", required=True, help="输出 tar.gz 路径")
    ap.add_argument("--with-sessions", action="store_true", help="也归档 sessions/（体积大）")
    ap.add_argument("--no-full-patch", action="store_true", help="不归档 patch.full.diff")
    args = ap.parse_args()

    root = Path(args.runs_root)
    if not root.exists():
        raise SystemExit(f"runs root 不存在: {root}")
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    files = 0
    bytes_added = 0
    entries = []

    def add(tar: tarfile.TarFile, path: Path) -> None:
        nonlocal files, bytes_added
        rel = path.relative_to(root)
        tar.add(path, arcname=str(rel))
        files += 1
        bytes_added += path.stat().st_size
        entries.append({"path": str(rel), "bytes": path.stat().st_size})

    with tarfile.open(out, "w:gz", compresslevel=6) as tar:
        for task_dir in sorted(p for p in root.iterdir() if p.is_dir()):
            if task_dir.name.startswith("."):
                continue
            for f in KEEP_FILES:
                for p in task_dir.rglob(f):
                    if f == "patch.full.diff" and args.no_full_patch:
                        continue
                    if "sessions" in p.parts and not args.with_sessions:
                        continue
                    add(tar, p)
            for eval_dir in task_dir.glob("eval-*"):
                for f in ("report.json", "eval.log"):
                    p = eval_dir / f
                    if p.exists():
                        add(tar, p)
            if args.with_sessions:
                for p in task_dir.rglob("*.zstd"):
                    add(tar, p)
        for f in ("matrix.json", "summary.json", "report-data.json", "report.md"):
            p = root / f
            if p.exists():
                add(tar, p)

    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    meta = {
        "runs_root": str(root.resolve()),
        "archive": str(out.resolve()),
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "files": files,
        "uncompressed_bytes": bytes_added,
        "archive_bytes": out.stat().st_size,
        "sha256": digest,
        "with_sessions": args.with_sessions,
        "entries": entries,
    }
    out.with_suffix(out.suffix + ".meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: meta[k] for k in ("archive", "files", "uncompressed_bytes",
                                           "archive_bytes", "sha256")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
