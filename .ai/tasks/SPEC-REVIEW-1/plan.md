# Plan: SPEC 审查最小完整流程

## Files that change

verify/runtime.ts：提取独立派发与 preset 租约；spec-review.ts / spec-review-tool.ts：纯协议与工具；相关单测和 smoke/spec-review.mjs；artifact 写作指导、workflow Skill、README / TASK 与 docs/spec-review.md；隔离 profile 检查增加新工具验证。

## Order of work

实现原文快照与独立入口；实现回应/复审与失败记录；补程序和真实运行时测试；全量 verify；tarball 隔离 profile 检查；整理证明与语义评测边界。

## Risks

共用派发提取影响最终 Verifier；取消/写盘异常丢失证据；复审遗漏问题；来源被作者改写；把桩结果误写成模型质量。保留旧回归并增加对应负例；记录不包含个人 profile 或凭据。

## Proof

插件包 npm run verify；compat / preset-sync；npm pack 文件核对及隔离 profile 真实启动；完整过程与未覆盖范围记录 proof.md。不会创建虚假的独立 approve；真实模型评测另行授权。
