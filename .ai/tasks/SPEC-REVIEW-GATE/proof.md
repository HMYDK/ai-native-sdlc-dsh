# Issue #29 验证记录

2026-11-21，插件本地 0.6.2，DSH 0.2.2-rc.3。任务材料在 Codex 实施时登记，独立 SPEC 审查和交付裁决没有生成。以下为程序和打包接线的验证证据。

## 双侧对照

同一份 `packages/sdlc/smoke/spec-review.mjs` 使用 `SDLC_TEST_LIB` 指向建议版 `f87530a` 的已安装产物。该任务有已登记的原文、Intent、Spec 和 Plan，但没有 SPEC 审查。进入 PLANNED 被放行，断言以 `unexpected success` 失败。当前版拒绝相同推进并保留状态字节，另外验证了跳到 IMPLEMENTING、VERIFYING、REVIEWING 和 DONE 的拒绝。

当前真实 Cordis、ToolRuntime 和 LocalFileSystem 冒烟以脚本响应为审查结果，覆盖 90 项检查。把任务、制品和验证组件配置到同一个 .ai/work-items 目录后，重跑相同的 90 项检查也通过。

| AC | 观察到的工具行为 |
|---|---|
| AC-001 | 未审查的逐步与跳阶段前进均拒绝。手改到 VERIFYING 的任务在派发独立交付验证前被拦。 |
| AC-002 | 来源清单缺项在派发前被拦。当前原文、澄清、Intent、Spec、清单类型或登记路径变动会使旧审查失效。缺失、损坏、非终局、跨任务及改动后的记录均未放行。 |
| AC-003 | 误引、无结构结果、失败和取消都未更新链尾。续审不能省略或选旧链尾，漏项会拒绝，争议保持阻断。实际修订后的 addressed 和反证后的 withdrawn 都可放行。 |
| AC-004 | 未修改输入时多个阶段复用同一记录，派发数不变。保留回退路径和最终裁决，历史任务补审可推进，单一旧审查链的未处理发现随补审延续，分叉须人工核查。 |
| AC-005 | 所有测试中的失败推进保留原始 state.yaml 字节。工具的保护及任意文件写入边界见 [使用与迁移](../../../docs/spec-review.md)。 |
| AC-006 | 全量 verify 通过，294 项库单测、45 项客户端单测与 13 组冒烟。评测器预算回归 3 项通过，compat 接受 9 个 peer，preset-sync 核对 23+6 行通过。 |

## 打包与真实宿主

`npm pack --ignore-scripts` 打包 77 文件，SHA-256 `48d2fa105fddbfe4df025ea4beb359d961c9e209aaeda8297b2eb21c9f364a07`。tarball 通过离线安装进入临时隔离 profile，无跳过 bundle、无 `entry did not activate` 或版本不兼容。`tools/profile-runtime-check.mjs` 校验真实工具注册（58 工具、18 个 SDLC 工具）、standard 隔离、看板 200 和受限审查者回收。新入口在真实服务上对无效父代理返回预期拒绝。

`tools/profile-cancellation-check.mjs` 用真实进程内 spawn 接收本地脚本的 SPEC 审查结果，经合法工具进入 VERIFYING，再触发交付验证取消。第一条脚本响应触发取消，之后没有第二次请求，活跃验证标记已清除，preset 已归还。外部受控后端的已发布 activation 取消探针也通过。

可用 `DSH_APP="/Applications/DeepSeek Harness.app" npm run verify --workspace=@ai-native-sdlc-plugin/dsh-sdlc` 重跑程序验证。隔离安装使用 App 的 pnpm 和 `npm pack` 产物，探针使用 App Electron 的 Node 模式，传入隔离 `DSH_HOME` 及已安装的 profile 路径。

评测没有发起付费模型请求。受控响应只证明门禁和工具行为，真实任务中的模型审查质量、Windows 和真实业务试用待验证。
