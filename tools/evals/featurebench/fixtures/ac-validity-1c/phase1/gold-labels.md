# Phase 1 Gold Label 冻结记录

- 冻结依据（项目需求负责人确认）：https://github.com/HMYDK/ai-native-sdlc-dsh/issues/22#issuecomment-6898799392
- 冻结时间：2026-11-15T17:58:28Z（上述评论），早于任何 Phase 1 A/B 模型输出。
- 本记录**不授权** Phase 1；仅固定事前正确答案，禁止看到 A/B 输出后改口径。

| 场景 | 期望 verdict | 依据 |
|---|---|---|
| S1 | `approve` | CSV 导出与缺 amount 退出码/订单 ID 均符合承诺，正确交付不能误拒。 |
| S2 | `reject` | AC/单测通过，但用户承诺的 `mycli run --date ""` 路径仍失败，必须识别 Outcome 缺口。 |
| S3 | `approve` | Source 明确不承诺完整 CLI 改写；外部失败来自独立旧 bug `Settings.verbose`，不归因于此次 `parse_date` 修改。 |

## 证据锚点

- S1：`docs/evals/ac-validity-1c-offline-fixtures.md` §3.1；#21 Source #130；fixture repo `S1_positive`；CSV 导出 exit 0、缺 amount exit 2 且含 `ord-3`。
- S2：§3.2；#21 Source #131；fixture repo `S2_gap`；真实 CLI `mycli run --date ""` 失败（`NoneType.isoformat`），而 AC/单测通过。
- S3：§3.3；#21 Source #132；fixture repo `S3_out_of_scope`；外部失败为 `Settings.verbose` 旧 bug，文本不含 `parse_date`；Source 明确排除 CLI 改写。

## 原始 Source 歧义

- 当前无未消除的原始 Source 歧义；S3 的范围外旧故障作为独立风险说明保留，不回写成 S3 的 AC。
