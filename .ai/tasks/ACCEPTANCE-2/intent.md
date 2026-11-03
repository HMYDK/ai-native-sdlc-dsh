# Issue #2：不能用部分验收结果完成整个任务

## Problem
任务验证原来接受调用方自己传入的 criteria，完成准入又只对照这份列表。Spec 有三项时，调用方只提交一项也可能得到 approve 并推进 DONE。

## Proposed outcome
把 Spec 的全部验收项登记为任务依据，让验证入口、阶段迁移、完成准入和看板使用同一份清单。

## Affected users and systems
SDLC 任务状态机、制品检查、独立验证、历史任务读取与看板。

## Constraints
使用现有 spec.md 与 state.yaml，不新建 acceptance.yaml。客户端检查不承担防篡改、发布授权或需求质量判断。

## Open questions
没有已证实的真实模型事故；缺陷由确定性 ToolRuntime 用例复现。本次不把夹具结果当作业务事故证据。
