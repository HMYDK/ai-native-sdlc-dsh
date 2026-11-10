#!/usr/bin/env python3
"""脱敏自检：扫描已跟踪的评测数据/脚本，禁止把宿主路径与凭据形态提交进仓库。

为什么要有这个脚本（issue #12 / AC-004 的 CI 侧兜底）：`docs/evals/` 里的机读
快照与报告、`tools/evals/featurebench/` 里的脚本都可能带上本机绝对路径或凭据；
这些内容一旦提交，之后很难从历史里清掉。CI 每次运行本脚本，命中即非零退出。

检查规则（正则从片段拼接，避免本脚本自身的规则文本自匹配）：
- 宿主绝对路径：macOS / Linux / Windows 的用户主目录路径、系统私有临时目录；
- 凭据形态：API key 前缀 + 长串、HTTP Bearer + 长 token；
- 隔离 home 的环境变量赋值：只允许容器/临时目录（如 /opt、/root、/tmp 等），
  其余值视为宿主配置泄漏。

用法（CI 默认只扫 git 已跟踪文件，避免把未提交的本地草稿算进来）：
    python3 tools/evals/featurebench/check_redaction.py
    python3 tools/evals/featurebench/check_redaction.py --all-files docs/evals
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent.parent
DEFAULT_TARGETS = ("docs/evals", "tools/evals")
MAX_HITS = 100

# 规则的正则字面量一律用片段拼接，保证本文件被自己扫描时不会命中。
RULES = [
    ("absolute-user-path", re.compile(r"/Us" + r"ers/[A-Za-z0-9._-]+")),
    ("home-user-path", re.compile(r"/hom" + r"e/[A-Za-z0-9._-]+/")),
    ("private-tmp", re.compile(r"/priv" + r"ate/tmp")),
    ("macos-temp", re.compile(r"/var/" + r"folders/")),
    ("windows-user-path", re.compile(r"[A-Za-z]:\\\\" + r"Us" + r"ers\\\\")),
    ("api-key-sk", re.compile(r"\bsk" + r"-[A-Za-z0-9_-]{16,}")),
    ("bearer-token", re.compile(r"Bearer\s+" + r"[A-Za-z0-9._~+/=-]{20,}")),
]
DSH_HOME_RE = re.compile(r"DSH" + r"_HOME=(\S+)")
ALLOWED_DSH_HOME_PREFIXES = ("/opt/", "/eval-root", "/root/", "/tmp/", "/testbed",
                             "/workspace")


def _tracked_files(targets) -> list:
    try:
        out = subprocess.run(["git", "-C", str(REPO), "ls-files", "--", *targets],
                             capture_output=True, text=True, check=True)
    except (OSError, subprocess.CalledProcessError):
        return []
    return [REPO / line for line in out.stdout.splitlines() if line.strip()]


def _walk_files(targets) -> list:
    files = []
    for target in targets:
        root = (REPO / target) if not Path(target).is_absolute() else Path(target)
        if root.is_file():
            files.append(root)
            continue
        if not root.exists():
            continue
        for path in sorted(root.rglob("*")):
            if path.is_file():
                files.append(path)
    return files


def _scan_file(path: Path) -> list:
    hits = []
    try:
        raw = path.read_bytes()
    except OSError:
        return hits
    if b"\x00" in raw:  # 二进制文件不是本检查目标
        return hits
    text = raw.decode("utf-8", errors="replace")
    rel = str(path.relative_to(REPO)) if path.is_relative_to(REPO) else str(path)
    for lineno, line in enumerate(text.splitlines(), start=1):
        for rule_name, rule in RULES:
            match = rule.search(line)
            if match:
                hits.append((rel, lineno, rule_name, match.group(0)))
        for match in DSH_HOME_RE.finditer(line):
            value = match.group(1)
            if not any(value.startswith(prefix) for prefix in ALLOWED_DSH_HOME_PREFIXES):
                hits.append((rel, lineno, "dsh-home-host-path", match.group(0)))
    return hits


def main() -> int:
    ap = argparse.ArgumentParser(description="评测数据/脚本脱敏自检（无网络）")
    ap.add_argument("targets", nargs="*", default=list(DEFAULT_TARGETS),
                    help="要扫描的目录（仓库相对路径或绝对路径）")
    ap.add_argument("--all-files", action="store_true",
                    help="扫描目录下全部文件（含未跟踪）；默认只扫 git 已跟踪文件")
    args = ap.parse_args()
    targets = list(args.targets) or list(DEFAULT_TARGETS)

    files = _walk_files(targets) if args.all_files else _tracked_files(targets)
    if not files:
        # 不在 git 仓库（例如打包后的目录）时退化为全量扫描。
        files = _walk_files(targets)
    if not files:
        print(f"[redaction] 没有找到要扫描的文件: {targets}", file=sys.stderr)
        return 2

    hits = []
    for path in files:
        hits.extend(_scan_file(path))
    if hits:
        print(f"[redaction] 发现 {len(hits)} 处疑似敏感内容:", file=sys.stderr)
        for rel, lineno, rule_name, snippet in hits[:MAX_HITS]:
            print(f"  {rel}:{lineno}: [{rule_name}] {snippet}", file=sys.stderr)
        if len(hits) > MAX_HITS:
            print(f"  ... 其余 {len(hits) - MAX_HITS} 处省略", file=sys.stderr)
        return 1
    print(f"[redaction] OK: {len(files)} 个文件未命中敏感路径/凭据规则")
    return 0


if __name__ == "__main__":
    sys.exit(main())
