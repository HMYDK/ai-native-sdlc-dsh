#!/usr/bin/env python3
"""把 Node 24 + dsh CLI 烤进 FeatureBench 官方镜像的派生镜像。

为什么要这一步：官方镜像没有 Node 24，而 DSH CLI 需要 Node>=24.9。每次 A/B 都
在容器里现装 Node/npm 包会多花几分钟且容易受网络影响；一次烤好、四个 repo 复用。

产物：`--tag` 指定的镜像（如 `fb-eval-base:sympy`），供 run_arm.py 使用。

用法：
    python3 bake_base.py --image <官方镜像> --tag fb-eval-base:<repo> \
        --node-tarball /path/node-v24.21.0-linux-x64.tar.xz --execute

默认 dry-run（只打印计划）；必须显式 `--execute` 才启动容器/装包，避免误触发。
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import uuid


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True, help="FeatureBench 官方镜像")
    ap.add_argument("--tag", required=True, help="派生镜像 tag，例如 fb-eval-base:sympy")
    ap.add_argument("--node-tarball", required=True, help="linux-x64 Node 24 tar.xz（本地文件）")
    ap.add_argument("--dsh-version", default="0.2.1-rc.5")
    ap.add_argument("--registry", default="https://registry.npmmirror.com")
    ap.add_argument("--execute", action="store_true", help="真正执行（默认 dry-run）")
    args = ap.parse_args()

    if not shutil.which("docker"):
        print("docker not found", file=sys.stderr)
        return 2
    if not args.execute:
        print("[dry-run] would build:", args.tag, "from", args.image)
        print("[dry-run] install Node 24 from", args.node_tarball,
              "and `npm install -g @deepseek-ai/dsh@%s`" % args.dsh_version)
        print("[dry-run] add --execute to actually run")
        return 0

    name = f"fb-bake-{uuid.uuid4().hex[:8]}"
    try:
        r = run(["docker", "run", "-d", "--name", name, "--platform", "linux/amd64",
                 "-v", f"{args.node_tarball}:/inject/node.tar.xz:ro",
                 args.image, "sleep", "infinity"])
        if r.returncode != 0:
            print("docker run failed:", r.stderr[-800:], file=sys.stderr)
            return 1
        script = f"""
set -e
mkdir -p /opt/node24
tar xJf /inject/node.tar.xz -C /opt/node24 --strip-components=1
export PATH=/opt/node24/bin:$PATH
node -v
npm -v
# npm 11 默认阻止 install scripts；DSH 的 subprocess-local / node-pty 需要它们。
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs \
  --registry={args.registry} @deepseek-ai/dsh@{args.dsh_version}
dsh --version
"""
        r = run(["docker", "exec", name, "bash", "-lc", script])
        print(r.stdout[-2000:])
        if r.returncode != 0:
            print("bake failed:", r.stderr[-2000:], file=sys.stderr)
            return 1
        r = run(["docker", "commit", name, args.tag])
        if r.returncode != 0:
            print("commit failed:", r.stderr[-800:], file=sys.stderr)
            return 1
        print("baked:", args.tag)
        return 0
    finally:
        run(["docker", "rm", "-f", name])


if __name__ == "__main__":
    sys.exit(main())
