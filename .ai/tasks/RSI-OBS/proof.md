# Issue #31 验收记录

2026-11-21，插件 0.6.2 开发构建，macOS DeepSeek Harness 0.2.2-rc.5。

| 验收范围 | 可复核结果 |
| --- | --- |
| AC-001 审查生命周期 | `OBS-EXPORT` 保留六轮完成、取消与引用失败记录，另在运行期间查询到 `running`。复审覆盖 `open`、`needs_clarification`、`addressed`、`withdrawn`。观察到损坏、跨任务、链尾无法读取或缺少前轮时的证据缺口。 |
| AC-002 版本关联 | 原始 AC 只检查 CSV 表头。复审保存从表头检查到完整订单 ID 断言的差异和指纹。`AC-001` 经显式映射关联最终逐项裁决、独立执行和同轮次阶段快照。旧 v3 裁决保留 `approve`，缺少当时的 Review 引用时显示 `unlinked`。 |
| AC-003 独立执行 | 基线 CSV 实现只返回第一页，真实断言退出 1。修订后退出 0，显示 `proven`。作者单独执行且最终任务为 DONE 时仍显示 `unverified`。独立执行退出 1 时显示 `failed`，同时展示受控的 `approve`。 |
| AC-004 完整性与用量 | Source 漂移、删除阶段快照和截断会话都有缺口。重复分析保留任务状态字节，去重后的受控会话共上报 187 Token。无审查记录的任务显示 `not_observed`。 |
| AC-005 回归 | `npm run verify` 通过，含 294 项库单测、45 项客户端单测、看板宿主测试及 14 组冒烟。RSI 证据链冒烟 36 项，默认任务目录和 `.ai/work-items` 均通过。SPEC 门禁 90 项，两种任务目录均通过。`typecheck`、`compat`、`preset-sync` 及脱敏检查通过。 |

## 复跑与字段样例

```bash
DSH_APP='/Applications/DeepSeek Harness.app'
npm run build
report_dir="$(mktemp -d /tmp/rsi-obs.XXXXXXXX)"
RSI_OBS_REPORT="$report_dir/observations.json" \
ELECTRON_RUN_AS_NODE=1 "$DSH_APP/Contents/MacOS/DeepSeek Harness" \
  --expose-internals packages/sdlc/smoke/rsi-observability.mjs
```

[observations.json](evidence/observations.json) 是该命令生成的受控结果摘要，保留审查 ID、相对记录路径、判定及指纹。每轮使用新的临时工作区，脚本退出前验证关键引用文件可读取。夹具通过真实 Cordis、ToolRuntime、LocalFileSystem 和 DSH Bash 工具调用任务、审查、验证与 RSI 工具，Bash 执行实际的 CSV 消费断言。模型响应、会话查询和 Token 数由确定性夹具提供。

| 字段 | 口径 |
| --- | --- |
| Review、回应、复审及逐 AC 裁决 | 来自对应的结构化记录。`addressed` 是复审结论，`withdrawn` 是撤回。哈希用于检查版本，来源真实性仍由登记方声明。 |
| Finding 与交付关联 | 来自明示 AC ID、实际条文变化、验证绑定版本和 Delivery Contract 的明确映射。缺任何关联时展示 `unlinked`。 |
| Outcome 状态 | 源于独立验证者明确引用的 Oracle，以及与对应调用 ID 对账后的 DSH 前台结构化退出码。证据路径分别指向退出记录与会话快照。 |
| 成本及缺口 | 墙钟取各轮开始和结束时间。Token 来自会话作用范围内的实际 `usage` 字段，跳过子会话继承的历史事件。本样例为受控用量，未知成本用 `null` 表示。 |

## 分发与边界

`npm pack --ignore-scripts` 产物 80 文件，SHA-256 为 `25b10f9409f3f22126070627559261b14878f4def516e7f5571f027c900912ce`。使用 App 自带 pnpm 与缓存离线装入隔离 web profile，并登记 bundle。SDLC 模式加载 58 个工具，其中 18 个为 SDLC 工具。`sdlc_spec_review` 取得预期的无效父代理拒绝，随后实际调用 `sdlc_rsi_analyze`，准确返回同一个未完成审查记录。standard 隔离、验证者工具范围与归还、看板 HTTP 200 均通过。

本次实测平台为 macOS Bash。PowerShell、真实付费模型的指令遵循和业务项目实证仍待覆盖。被测 Oracle 只代表该声明的消费路径和代码版本。审查的因果收益需要受控对照与外部标签。
