# RSI 任务证据与插件改进实施计划

## Files that change
`packages/sdlc/src/rsi/` 负责记录、分析、提案和反馈；`src/shared/task-recording.ts`、`src/task/index.ts` 负责任务事件；`src/verify/` 保留验证运行身份。`src/ui/` 展示记录健康状态。对应单测、真实运行时冒烟、`tools/bench/` 对照、包版本与使用说明一并维护。

## Order of work

1. 修复跨 preset 采集，增加真实会话查询补漏、完整性检查和负向回归。
2. 增加任务生命周期记录，关联作者/验证者和多仓库代码起点，保存可恢复的索引。
3. 将任务证据、复盘假设、改进任务和对照/反馈关联起来，复用既有任务与制品工具。
4. 从 DEMO-22149 提取不含业务正文的事实摘要，建立旧版与新版两侧对照；旧版必须确实失败。
5. 全量验证、隔离 tarball 装配、记录限制；逐文件审查后提交推送。

## Risks
重点检查真实 scoped 事件而非无作用域桩；异步写入队列必须受管且可 flush；查询不可用不冒充完整。任务记录失败不得改写真实裁决，但必须可见。重启、多任务、同名跨工作区和多仓库不能互串。

## Proof
从真实任务筛选不含业务正文的计数，旧版与新版运行同一个 Cordis/ToolRuntime/LocalFS 夹具。旧版必须违反判据，新版满足；结果写入 evidence/version-comparison.json。完整执行 build/test/smoke、四个版本对照、compat、preset-sync 和隔离测试场检查。用带内容哈希的 tarball 安装隔离 profile，核对发布文件并启动检查。独立审查必须复现任务切换写失败与跨版本仅写制品的边界。
