# 实施与验证记录

## Files that change
packages/sdlc/src/shared/acceptance.ts、task/acceptance.ts，以及 task、verify、artifact、status、ui、workflow 的相关入口；配套单测、运行时冒烟和使用文档。

## Order of work
1. 复现旧版只提交部分清单仍可完成的行为。
2. 建立共享验收契约，补全目标阶段准入与登记。
3. 改造验证入口和完成准入，保留历史编号。
4. 补齐看板、迁移、双侧回归及分发检查。

## Risks
不能让旧 approve 被自动认作完整验收；不能遗漏 issue 工具的阶段迁移；不能把第一次验证读到的 Spec 当作登记基线。

## Proof
见 proof.md。这里是实现后的任务材料补录，不声称这些文件在实现前已经登记或由 DSH 独立验证者批准。
