# RSI-1 实施记录

## Files that change

新增 packages/sdlc-rsi；sdlc-verify 增加 recording.ts、事件接线与实验指导入参；更新 workspace lock、忽略原始 RSI 数据的规则、说明和本任务制品。完整实施计划见 docs/superpowers/plans/2026-10-15-rsi.md。

## Order of work

先补验证生命周期测试及记录，再实现存储、快照、复盘与实验。使用真实 Cordis/ToolRuntime/LocalFileSystem 做接线测试，独立审查找出失真的实验结论并修复，然后打包、隔离安装、运行真实模型验证与对照。

本任务制品在实现和审查过程中补登记，不声称它们在实施前已经由状态机逐阶段创建。

## Risks

记录增加磁盘和少量运行开销；实验会消耗模型额度。无裁决、较快失败、参考答案泄漏、配置漂移可能导致错误乐观结论，均需在结果中明确呈现。只捕获完整可观察事实，不猜缺失数据。

## Proof

见 proof.md：验证器与 RSI 的 build/test/smoke、所有现有包检查、三条历史基准、测试场接线、tarball 文件清单、隔离真实模型运行和实验记录。确定性 provider 冒烟与真实模型观察分开描述；小夹具不构成能力提升证据。
