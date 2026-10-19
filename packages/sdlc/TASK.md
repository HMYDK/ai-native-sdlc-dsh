# sdlc-task

`.ai/tasks/<TASK-ID>/state.yaml` 是**状态与制品索引的事实来源**。

## 为什么状态在 Git 里，不在插件里

手册第 2.2 节：*"Session 只是执行载体，Artifact 才是事实来源。"*
所以这个插件是**守护者**，不是持有者：

- 读 `state.yaml` → 报告状态、指出缺哪个制品
- 写 `state.yaml` → 只在状态迁移时写，且先校验准入门槛
- **不缓存状态**。每次读盘。人可以手改文件，改完下一读就生效。

代价（明确记录）：状态机是**可检测、可审计**的，但不是**不可绕过**的——
手改 `state.yaml` 能跳过门槛。这与仓库的既定原则一致：硬约束要靠别的层
（分支保护 / CI），客户端只负责让违规**显眼**、让误操作**变难**。

## 状态机

```
INTENT → SPEC → PLANNED → IMPLEMENTING → VERIFYING → REVIEWING → DONE
```

| 状态 | 进入前必须存在的制品 | 谁推进 |
|---|---|---|
| `INTENT` | `intent.md`（create 时必写） | 提出者 |
| `SPEC` | 加 `spec.md` | 产品负责人 |
| `PLANNED` | 加 `plan.md` | 工程师（计划评审通过） |
| `IMPLEMENTING` | plan.md 里必须有测试/证据说明 | 工程师 |
| `VERIFYING` | 代码或测试有改动（`git status` 非空，或 `verification.json` 不存在） | 工程师实现完成 |
| `REVIEWING` | `verification.json` 存在且 `status != reject` | 独立验证通过 |
| `DONE` | `review.json` 存在 | 评审 + 合并 |

**允许回退**：`IMPLEMENTING → PLANNED`（计划错了）是合法的，且应记录原因。
回退不是违规——**发现了更好的方案却不敢改计划**才是。

## state.yaml 形状

```yaml
task: PROJ-1024
title: 客户自助查询理赔状态
status: VERIFYING
created: 2026-10-07
updated: 2026-10-08
artifacts:
  intent: intent.md
  spec: spec.md
  plan: plan.md
history:
  - at: 2026-10-07T10:12:00Z
    from: INTENT
    to: SPEC
    reason: 产品负责人接受意图
```

- `artifacts` 里的路径**相对于任务目录**，不写绝对路径（任务目录可整体移动）
- `history` 只追加，不修改——它是**本次任务的状态审计**
- 不记录审批人：DSH 的 approval 事件只记结果不记谁批的，而本仓库不需要审批归属

## 工具

| 工具 | 作用 |
|---|---|
| `sdlc_task_create` | 建任务目录 + state.yaml + intent.md 骨架 |
| `sdlc_task_status` | 报告状态、制品清单、缺失项、状态是否与实际文件一致 |
| `sdlc_task_advance` | 状态迁移，**先校验准入门槛**，并把迁移追加进 history |
