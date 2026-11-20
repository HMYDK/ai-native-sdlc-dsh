# Intent: 在开工前独立审查任务定义并支持修订复审

## Problem

Actor 从原始需求编写 Spec / AC 时可能形成一致的遗漏，直到代码完成才被发现。现有 Delivery Contract 给出引用锚点，最终 Verifier 可以反查，但缺少 SPEC 阶段可调用、可追溯且支持反证的独立反馈入口。

## Proposed outcome

SPEC 草稿写完后可独立对照原文找出具体遗漏、范围偏移和验收反例；作者修订或回应后复审，错误发现可以撤回，需求取舍留给用户。首版不改变状态推进或最终交付裁决。

## Affected users and systems

使用 AI 原生 SDLC 模式的作者和审查者；verify 组件、制品写作指导、workflow Skill、任务文档和运行时测试。

## Constraints

复用现有独立上下文和受限工具；一个包、原有七行组合。保持 AC / Verdict / state schema 与 checkAdvance 语义，不新增强制门禁。保留已有未提交文件；不发布、不动个人 profile，不追加付费模型调用。程序与运行时接线测试不冒充语义效果证据。

## Open questions

后续独立人工核对行为评测标签和预算；是否值得配置为强制流程不属于本轮。
