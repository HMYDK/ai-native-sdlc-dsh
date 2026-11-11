#!/usr/bin/env python3
"""把 run_arm.py 的 patch 转成 FeatureBench `fb eval` 接受的 predictions JSONL。

每个 arm 一个文件（官方 eval 的 report 按 arm 分开更好读）：
    python3 make_predictions.py --task-id <id> --out-prefix /tmp/fb/runs/<id> \
        --arm-dir standard=/tmp/fb/runs/<id>/standard --arm-dir sdlc=/tmp/fb/runs/<id>/sdlc

注意：`success` 表示「推理是否产出补丁」（FeatureBench 的语义），不是「测试是否通过」。
即使 patch 为空也写 success=true，让官方评分器把它计为 unresolved 而不是从分母里剔除。
agent 失败/超时/over_budget 由 meta.json 记录，报告里单列。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--task-id", required=True)
    ap.add_argument("--out-prefix", required=True, help="输出前缀，实际写 <prefix>-<arm>.jsonl")
    ap.add_argument("--arm-dir", action="append", required=True,
                    help="arm=结果目录，可重复，例如 standard=/tmp/runs/x/standard")
    args = ap.parse_args()

    for spec in args.arm_dir:
        arm, _, d = spec.partition("=")
        d = Path(d)
        patch_path = d / "patch.diff"
        patch = patch_path.read_text(encoding="utf-8", errors="replace") if patch_path.exists() else ""
        meta = {}
        if (d / "meta.json").exists():
            try:
                meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
            except Exception:
                meta = {}
        rec = {
            "instance_id": args.task_id,
            "model_name_or_path": f"dsh-sdlc-eval-{arm}",
            "model_patch": patch,
            "success": True,
            "n_attempt": 1,
        }
        out = Path(f"{args.out_prefix}-{arm}.jsonl")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(rec, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"{arm}: {out} patch_chars={len(patch)} agent_completed={meta.get('agent_completed')} "
              f"failure={meta.get('agent_failure')}")


if __name__ == "__main__":
    main()
