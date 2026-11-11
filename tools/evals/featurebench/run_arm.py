#!/usr/bin/env python3
"""FeatureBench A/B 单臂执行器：官方 mask/restore + 无宿主挂载 + Web GUI 驱动。

模式：
  agent  —— 初始化官方任务环境，启动容器内 DSH Web，宿主无头 Chrome 驱动
            「标准模式」或「AI 原生 SDLC」preset，跑完用官方 complete_runtime 抽 patch；
  empty  —— 只初始化、不产生改动（负对照：官方评分器应当 unresolved）。

安全门：默认 dry-run；必须 `--execute` 才启动容器/模型调用（AC-007：默认不触发昂贵调用）。

退出码：0 成功；2 基础设施错误（可重试一次）；3 agent 未完成（不重试，结果保留）。
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from pathlib import Path

import yaml

# 注意：docker / datasets / featurebench 只在真实执行（--execute）时按需导入。
# CI 的 evals-check 用 `--mode empty` 做 dry-run（不碰 Docker、不调模型），runner 上
# 只装 pyyaml；顶层导入会让这次「不烧 token 的预演」直接 ImportError。
# 这与「dry-run 默认不触发昂贵调用」的承诺保持一致。

HERE = Path(__file__).resolve().parent
DEFAULT_MANIFEST = HERE / "manifest.yml"
CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
]
INFRA_EXIT, AGENT_EXIT = 2, 3


def find_chrome() -> str:
    for p in CHROME_CANDIDATES:
        if Path(p).exists():
            return p
    return shutil.which("google-chrome") or shutil.which("chromium") or ""


def load_manifest(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_instance(task_id: str):
    # 运行时依赖按需导入：见文件顶部说明（CI dry-run 不装 datasets/featurebench）。
    from datasets import load_dataset
    from featurebench.infer.models import TaskInstance

    ds = load_dataset("LiberCoders/FeatureBench", "default", split="fast", revision="v1.1")
    for row in ds:
        if row["instance_id"] == task_id:
            d = dict(row)
            d["level"] = 1 if task_id.endswith(".lv1") else 2
            return d, TaskInstance.from_dict(d)
    raise SystemExit(f"task not found in dataset: {task_id}")



def strip_patch_paths(patch: str, prefixes: tuple[str, ...]) -> str:
    """从官方提取的补丁里去掉流程制品目录（.ai/ 等），只保留代码交付物。

    为什么：B 组的 SDLC 流程会在 /testbed/.ai 下写任务/裁决/RSI 制品；官方
    complete_runtime 用 `git add -A` 会把这些一起抽进 model_patch，单次可达 19MB。
    官方评分只需要代码，流程制品作为证据单独保留（patch.full.diff + sessions）。
    """
    sections: list[str] = []
    current: list[str] = []
    keep = True
    for line in patch.splitlines(keepends=True):
        if line.startswith("diff --git "):
            if current and keep:
                sections.append("".join(current))
            current = [line]
            keep = not any(f"b/{p}" in line for p in prefixes)
        else:
            current.append(line)
    if current and keep:
        sections.append("".join(current))
    return "".join(sections)

def leak_signature(row: dict) -> str:
    """从 gold restore patch 里取一个实现函数签名，用于容器泄漏扫描。"""
    from featurebench.harness.utils import preprocess_hf_patch

    gold = preprocess_hf_patch(row.get("patch", ""), row.get("FAIL_TO_PASS", []))
    lines = [ln[1:] for ln in gold.splitlines() if ln.startswith("+") and not ln.startswith("+++")]
    for ln in lines:
        t = ln.strip()
        if t.startswith("def ") and len(t) > 25:
            return t
    for ln in lines:
        if len(ln.strip()) > 40:
            return ln.strip()
    return ""


def make_inject_tar(credentials: Path, plugin_dir: Path, setup_script: Path) -> io.BytesIO:
    """容器只需要这几样东西；不挂任何宿主目录（事故记录见 README）。"""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        tar.add(str(credentials), arcname="inject/credentials.yaml")
        tar.add(str(plugin_dir), arcname="inject/plugin")
        tar.add(str(setup_script), arcname="inject/setup-web.sh")
    buf.seek(0)
    return buf


def parse_adoption(sessions_dir: Path) -> dict:
    """从 DSH session 日志统计 B 组是否真的用了 SDLC 工具（zstandard 可选依赖）。"""
    try:
        import zstandard  # type: ignore
    except Exception:
        return {"available": False, "reason": "zstandard not installed (uv pip install zstandard)"}
    names: dict[str, int] = {}
    files = list(sessions_dir.rglob("*.zstd")) if sessions_dir.exists() else []
    for f in files:
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
                        names[o["name"]] = names.get(o["name"], 0) + 1
                    for v in o.values():
                        walk(v)
                elif isinstance(o, list):
                    for v in o:
                        walk(v)

            walk(d)
    sdlc = {k: v for k, v in names.items() if k.startswith("sdlc_")}
    return {
        "available": True,
        "session_files": len(files),
        "tool_calls": names,
        "sdlc_tool_calls": sdlc,
        "used_sdlc": bool(sdlc),
        "called_sdlc_verify": "sdlc_verify" in sdlc,
    }


# 复用输出目录重试时必须清掉的 attempt 产物：否则上一轮的 patch/predictions 会被
# evaluate_matrix 当成本次提交去评分，或上一次的 payload 被误读。
ATTEMPT_ARTIFACTS = ("run.json", "meta.json", "patch.diff", "patch.full.diff",
                     "predictions.jsonl")


def clear_attempt_artifacts(out: Path) -> list[str]:
    """删除上一次尝试留在 out 目录里的 attempt 产物，返回实际删除的文件名。"""
    removed: list[str] = []
    for name in ATTEMPT_ARTIFACTS:
        stale = out / name
        if stale.exists():
            stale.unlink()
            removed.append(name)
    return removed


def session_token_total(sessions_dir: Path) -> int | None:
    """从已导出的 session 日志汇总 assistant usage.totalTokens（driver timeout 兜底）。

    与 summarize_runs.session_tokens 同口径；会包含验证者子会话的消耗，所以只在
    run.json 缺失（timeout 时 driver 被 kill）时使用，并在 meta 里标明 source。
    """
    try:
        import zstandard
    except Exception:
        return None
    total = 0
    found = False
    for f in sorted(sessions_dir.rglob("*.zstd")):
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
                found = True
    return total if found else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    ap.add_argument("--task-id", required=True)
    ap.add_argument("--arm", required=True, help="manifest arms 里的 arm 名（如 standard/sdlc/sdlc_guidance）")
    ap.add_argument("--mode", default="agent", choices=["agent", "empty"])
    ap.add_argument("--image", required=True, help="派生镜像，例如 fb-eval-base:sympy")
    ap.add_argument("--out", required=True, help="结果目录（不提交）")
    ap.add_argument("--plugin-dir", help="解包后的插件目录（含 dsh-sdlc/ 与 js-yaml/）")
    ap.add_argument("--credentials", help="隔离的 .credentials.yaml")
    ap.add_argument("--web-port", type=int, default=3115)
    ap.add_argument("--cdp-port", type=int, default=9400)
    ap.add_argument("--timeout", type=int, help="覆盖 manifest 的单 run 墙钟上限（秒）")
    ap.add_argument("--max-tokens", type=int, help="覆盖 manifest 的单 run token 上限")
    ap.add_argument("--keep-container", action="store_true", help="失败时保留容器便于排查")
    ap.add_argument("--allow-version-mismatch", action="store_true",
                    help="容器内 DSH/插件版本与 manifest 不一致时仍然继续（不推荐）")
    ap.add_argument("--execute", action="store_true", help="真正执行（默认 dry-run）")
    args = ap.parse_args()

    manifest = load_manifest(Path(args.manifest))
    tasks = {t["id"]: t for t in manifest["tasks"]}
    if args.task_id not in tasks:
        print(f"task {args.task_id} not in manifest (预注册清单之外)", file=sys.stderr)
        return 2
    task = tasks[args.task_id]
    if args.arm not in manifest["arms"]:
        print(f"arm {args.arm!r} 不在 manifest arms {list(manifest['arms'])} 里", file=sys.stderr)
        return 2
    arm_cfg = manifest["arms"][args.arm]
    policy = manifest.get("run_policy", {})
    timeout = args.timeout or int(policy.get("timeout_seconds", 2700))
    max_tokens = args.max_tokens or int(policy.get("max_tokens_per_run", 0))
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.FileHandler(out / "runtime.log"), logging.StreamHandler()],
    )
    log = logging.getLogger("run_arm")

    chrome = find_chrome()
    node = shutil.which("node")
    driver = HERE / "driver.mjs"
    if args.mode == "agent":
        missing = [n for n, v in [("chrome", chrome), ("node", node),
                                  ("--plugin-dir", args.plugin_dir),
                                  ("--credentials", args.credentials)] if not v]
        if missing:
            print("missing prerequisites:", missing, file=sys.stderr)
            return 2

    if not args.execute:
        print("[dry-run] task:", args.task_id, "arm:", args.arm, "mode:", args.mode)
        print("[dry-run] image:", args.image, "preset:", arm_cfg["preset"])
        print("[dry-run] policy: timeout=%ss max_tokens=%s" % (timeout, max_tokens))
        print("[dry-run] prompt suffix chars:", len(arm_cfg.get("prompt_suffix") or ""))
        print("[dry-run] add --execute to actually run")
        return 0

    # 复用同一输出目录重试时，上一次尝试的 run.json/meta.json/patch/predictions 必须先
    # 清掉：driver 提前退出会读到旧 payload；初始化阶段失败则可能让 evaluate_matrix 把
    # 上一轮的 patch.diff 当成本次提交评分。
    clear_attempt_artifacts(out)

    # 真正执行才需要的运行时依赖（dry-run 已在上面返回）。
    import docker
    from featurebench.infer.container import ContainerManager
    from featurebench.infer.runtime import RuntimeHandler

    row, inst = load_instance(args.task_id)
    prompt = row["problem_statement"] + (arm_cfg.get("prompt_suffix") or "")
    (out / "prompt.txt").write_text(prompt, encoding="utf-8")

    client = docker.from_env()
    name = f"fb-{args.mode}-{args.arm}-{uuid.uuid4().hex[:6]}"
    container = None
    chrome_proc = None
    infra_error = None
    agent_failed = None
    try:
        container = client.containers.run(
            args.image, "sleep infinity", detach=True, platform="linux/amd64", name=name,
            ports={f"{args.web_port}/tcp": ("127.0.0.1", args.web_port)},
        )
        # 官方镜像里由 volume 留下的空目录也清掉（不挂载，但目录可能随 commit 保留）。
        container.exec_run(["bash", "-lc", "rm -rf /eval /run-eval; true"])
        log.info("container %s up", container.name)

        # 版本探测：manifest 钉死的 DSH/插件版本必须与容器内实际一致，否则实验不可比。
        # setup-web 会把 node/dsh 加到 PATH；`docker exec` 默认 PATH 里没有，需显式加
        ver_run = container.exec_run(
            ["bash", "-lc", "export PATH=/opt/node24/bin:$PATH; dsh --version 2>/dev/null | tail -1"])
        dsh_actual = (ver_run.output or b"").decode("utf-8", "replace").strip().splitlines()
        dsh_actual = dsh_actual[-1].strip() if dsh_actual else ""
        plugin_actual = ""
        if args.plugin_dir:
            pkg = Path(args.plugin_dir) / "dsh-sdlc" / "package.json"
            if pkg.exists():
                try:
                    plugin_actual = json.loads(pkg.read_text(encoding="utf-8")).get("version", "")
                except Exception:
                    plugin_actual = ""
        want_dsh = manifest["runtime"].get("dsh_cli", "")
        want_plugin = manifest["runtime"].get("plugin_version", "")
        if dsh_actual != want_dsh or (plugin_actual and plugin_actual != want_plugin):
            msg = (f"version mismatch: dsh={dsh_actual!r} want={want_dsh!r}; "
                   f"plugin={plugin_actual!r} want={want_plugin!r}")
            if args.allow_version_mismatch:
                log.warning(msg + " (allowed)")
            else:
                raise RuntimeError(msg)

        cm = ContainerManager(log)
        orig_exec = cm.exec_command

        def patched_exec(container_, command, timeout=None, workdir=None, log_file=None):
            # 官方初始化会 apt 装 tmux/asciinema；CN 网络不可靠且与评测无关，跳过。
            if "apt-get update" in command and "tmux" in command:
                return (0, "")
            return orig_exec(container_, command, timeout=timeout, workdir=workdir, log_file=log_file)

        cm.exec_command = patched_exec
        rh = RuntimeHandler(cm, log)
        init_log = out / "init.log"
        init_log.touch()
        if not rh.initialize_runtime(container, inst, init_log):
            raise RuntimeError("initialize_runtime failed")
        rh.clear_package_caches(container, init_log)
        log.info("official masking + git re-init + cache clear done")

        # 泄漏面自检 + gold 签名扫描（不修改官方镜像，只记录）。
        sig = leak_signature(row)
        check = container.exec_run(["bash", "-lc",
            'for p in /root/my_repo /eval /run-eval /tmp/mask.patch; do [ -e "$p" ] && echo "LEAK:$p"; done; echo CHECK_DONE'])
        leak_hits = ""
        if sig:
            scan = container.exec_run(["bash", "-lc",
                f"grep -rl --binary-files=without-match {json.dumps(sig)} / "
                "--exclude-dir=proc --exclude-dir=sys --exclude-dir=dev --exclude-dir=testbed 2>/dev/null | head -50 || true"])
            leak_hits = scan.output.decode("utf-8", "replace")
        (out / "leak_scan.txt").write_text(
            "isolation check:\n" + check.output.decode("utf-8", "replace") +
            "\nsignature:\n" + sig + "\nhits:\n" + leak_hits, encoding="utf-8")
        if "LEAK:" in check.output.decode():
            raise RuntimeError("isolation check failed: " + check.output.decode())

        if args.mode == "agent":
            credentials = Path(args.credentials).resolve()
            plugin_dir = Path(args.plugin_dir).resolve()
            container.put_archive("/opt", make_inject_tar(credentials, plugin_dir, HERE / "setup-web.sh"))
            req = container.exec_run(
                ["bash", "-lc", "bash /opt/inject/setup-web.sh"],
                environment={"WEB_PORT": str(args.web_port),
                             "DSH_EVAL_PROVIDER": manifest["runtime"].get("provider", "deepseek-account"),
                             "DSH_EVAL_MODEL": manifest["runtime"].get("model", "deepseek-flash")},
            )
            (out / "setup.log").write_text(req.output.decode("utf-8", "replace"))
            if req.exit_code != 0:
                raise RuntimeError("setup-web failed: " + (out / "setup.log").read_text()[-1500:])

            token = ""
            for _ in range(180):  # dsh web 在负载高时启动可能 >60s，token 轮询放宽到 3min
                time.sleep(1)
                r = container.exec_run(["bash", "-lc", "cat /opt/dsh-eval/token.txt 2>/dev/null"])
                token = r.output.decode().strip().removeprefix("token=").strip()
                if token:
                    break
            if not token:
                raise RuntimeError("no web token")

            url = f"http://127.0.0.1:{args.web_port}/?token={token}"
            profile_dir = f"/tmp/chromeprof-fb-{uuid.uuid4().hex[:8]}"
            shutil.rmtree(profile_dir, ignore_errors=True)
            chrome_log = open(out / "chrome.log", "w")
            chrome_proc = subprocess.Popen(
                [chrome, "--headless=new", "--disable-gpu", "--no-first-run",
                 "--no-default-browser-check", f"--remote-debugging-port={args.cdp_port}",
                 f"--user-data-dir={profile_dir}", url],
                stdout=chrome_log, stderr=chrome_log)
            for _ in range(60):
                time.sleep(1)
                q = subprocess.run(["curl", "-s", "-m", "2", f"http://127.0.0.1:{args.cdp_port}/json/list"],
                                   capture_output=True, text=True)
                if str(args.web_port) in q.stdout and "page" in q.stdout:
                    break
            else:
                raise RuntimeError("chrome CDP not ready")

            prompt_file = out / "prompt.txt"
            run_json = out / "run.json"
            try:
                # driver 自己负责在 MAX_WALL_S / MAX_TOKENS 处停 turn 并写 payload；
                # Python 侧 timeout 只是驱动挂死时的安全网（留出 stopTurn 的收尾时间）。
                r = subprocess.run(
                    [node, str(driver), str(args.cdp_port), arm_cfg["preset"],
                     str(prompt_file), str(run_json)],
                    capture_output=True, text=True, timeout=timeout + 240,
                    env=dict(os.environ, WEB_PORT=str(args.web_port), MAX_TOKENS=str(max_tokens),
                             MAX_WALL_S=str(timeout)),
                )
            except subprocess.TimeoutExpired as e:
                (out / "agent_run.log").write_text(f"TIMEOUT after {timeout}s\n{e.stdout or ''}\n{e.stderr or ''}")
                agent_failed = "timeout"
                r = None
            if r is not None:
                (out / "agent_run.log").write_text(r.stdout + "\n" + r.stderr)
                if r.returncode != 0:
                    agent_failed = f"driver_error(exit={r.returncode})"
                else:
                    payload = json.loads(run_json.read_text())
                    if payload.get("turn_error"):
                        agent_failed = "turn_error"
                    elif payload.get("aborted") == "over_budget":
                        agent_failed = "over_budget"
                    elif payload.get("aborted") == "timeout":
                        agent_failed = "timeout"
                    elif not payload.get("done"):
                        agent_failed = "agent_incomplete"

            # 会话日志取出并统计流程采纳（容器删除前）。
            try:
                arch, _ = container.get_archive("/opt/dsh-eval/sessions")
                data = b"".join(arch)
                sess_dir = out / "sessions"
                shutil.rmtree(sess_dir, ignore_errors=True)
                with tarfile.open(fileobj=io.BytesIO(data)) as t:
                    t.extractall(sess_dir)
                adoption = parse_adoption(sess_dir)
            except Exception as e:  # 证据缺失不能吞掉，写下来
                adoption = {"available": False, "reason": f"session export failed: {e}"}
            (out / "adoption.json").write_text(json.dumps(adoption, ensure_ascii=False, indent=2))

        patch = rh.complete_runtime(container, inst, out / "runtime.log")
        if patch is None:
            raise RuntimeError("complete_runtime failed")
        full_patch = patch
        patch = strip_patch_paths(full_patch, (".ai/", ".dsh/"))
        if len(patch) != len(full_patch):
            (out / "patch.full.diff").write_text(full_patch, encoding="utf-8")
        (out / "patch.diff").write_text(patch, encoding="utf-8")
        patch_sha = hashlib.sha256(patch.encode("utf-8")).hexdigest()
        run_meta = {}
        if (out / "run.json").exists():
            try:
                run_meta = json.loads((out / "run.json").read_text())
            except Exception:
                run_meta = {}
        # timeout 时 driver 进程被 kill，run.json 可能没写出来（实测），此时 session 日志
        # 已经导出；用 session 汇总 token 兜底，否则 run_matrix/编排会把这次昂贵运行记成
        # 0 token，总预算约束被绕过。
        token_usage = run_meta.get("usage_tokens")
        token_usage_source = "driver" if token_usage is not None else None
        if token_usage is None and args.mode == "agent":
            fallback = session_token_total(out / "sessions")
            if fallback is not None:
                token_usage = fallback
                token_usage_source = "session_fallback"
        meta = {
            "task_id": inst.instance_id,
            "arm": args.arm,
            "mode": args.mode,
            "preset": arm_cfg["preset"],
            "image": args.image,
            "image_digest": task.get("image_digest"),
            "dsh_cli": manifest["runtime"].get("dsh_cli"),
            "dsh_cli_actual": dsh_actual,
            "plugin_version": manifest["runtime"].get("plugin_version"),
            "plugin_version_actual": plugin_actual,
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "elapsed_seconds": run_meta.get("elapsed_s"),
            "token_usage": token_usage,
            "token_usage_source": token_usage_source,
            "agent_completed": bool(run_meta.get("done")),
            "agent_failure": agent_failed,
            "aborted": run_meta.get("aborted"),
            "patch_chars": len(patch),
            "full_patch_chars": len(full_patch),
            "artifact_patch_chars": len(full_patch) - len(patch),
            "patch_sha256": patch_sha,
            "sdlc_tool_calls": (json.loads((out / "adoption.json").read_text())
                                .get("sdlc_tool_calls", {}) if (out / "adoption.json").exists() else {}),
            "leak_scan_hits": [ln for ln in leak_hits.splitlines() if ln.strip()],
            "policy": {"timeout_seconds": timeout, "max_tokens_per_run": max_tokens},
        }
        (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
        print(json.dumps(meta, ensure_ascii=False, indent=2))
        if agent_failed == "turn_error" or run_meta.get("turn_error"):
            # 模型流在 message_stop 前断开（实测）属于外部/基础设施失败，按策略允许 infra 重试一次。
            # 注意必须放在通用 agent_failed 分支之前：否则 turn_error 会先返回 AGENT_EXIT，
            # 而 run_matrix 只对 INFRA_EXIT 重试，模型流中断永远不会被重试。
            log.warning("turn ended with error (stream close?); classified as infra for retry")
            return INFRA_EXIT
        if agent_failed:
            # driver 自身失败（CDP/页面状态/插入 prompt）属于评测基础设施问题，
            # 按策略允许 infra 重试一次；agent 真的跑完但超时/超预算才不重试。
            if str(agent_failed).startswith("driver_error"):
                return INFRA_EXIT
            return AGENT_EXIT
        return 0
    except Exception as e:
        infra_error = e
        log.error("INFRA ERROR: %s", e)
        return INFRA_EXIT
    finally:
        if chrome_proc:
            chrome_proc.terminate()
        if container:
            if infra_error and args.keep_container:
                print("container kept for debugging:", container.name, file=sys.stderr)
            else:
                try:
                    container.remove(force=True)
                except Exception:
                    pass


if __name__ == "__main__":
    sys.exit(main())
