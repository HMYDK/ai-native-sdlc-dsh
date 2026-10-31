# sdlc-task

`.ai/tasks/<TASK-ID>/state.yaml` 是**状态与制品索引的事实来源**。


> **使用位置**：本组件只在新建会话选择「AI 原生 SDLC」Agent Preset 时挂载；
> 标准模式会话没有这些工具与提示词。见 [包总览](README.md#安装与使用)。

## 为什么状态在 Git 里，不在插件里

手册第 2.2 节：*"Session 只是执行载体，Artifact 才是事实来源。"*
所以这个插件是**守护者**，不是持有者：

- 读 `state.yaml` → 报告状态、指出缺哪个制品
- 写 `state.yaml` → 记录状态迁移、问题处理与验证轮次，先校验准入门槛
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
| `IMPLEMENTING` | intent/spec/plan 已登记且文件存在 | 工程师 |
| `VERIFYING` | intent/spec/plan 存在；上一轮问题已提交处理证据或明确延期 | 工程师实现完成 |
| `REVIEWING` | 最新独立裁决 approve、标准覆盖完整、代码/制品未变、无未解决阻断问题 | 独立验证通过 |
| `DONE` | 同上；全部问题已复验解决或明确延期；review 制品存在 | 评审完成（不代替 Git 合并授权） |

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
| `sdlc_task_issue` | 登记审核问题、记录退回、提交处理证据、说明延期或取消中断的验证 |

## 0.5.0：发现问题后如何流转

验证返回的问题自动进入 `state.workflow.issues`，每项有固定 ID、来源轮次和动作记录。
审核发现的问题用 `sdlc_task_issue action=report` 登记。使用顺序：

1. `start`：给出问题 ID、原因和目标阶段。改需求去 SPEC，改方案去 PLANNED，改代码去 IMPLEMENTING；仅补证据可留在当前阶段。阶段退回和问题动作同一次保存。
2. `submit`：填写实际修改和测试证据。这只代表作者提交，不代表问题解决。
3. 回到 VERIFYING，再调用 `sdlc_verify`。验证者必须逐个返回 `issue_results`，只有明确的 `resolved` 才关闭该项。
4. 非阻断建议可以 `defer` 并说明原因；阻断问题不能延期。完成后登记新问题会重新进入 REVIEWING。

直接调用 verify 也会检查未处理问题；不能靠跳过 task_advance 绕开。改了代码、规格、计划
或验收标准后重新验证，必须先有对应阶段的退回记录。单纯提交相同代码不会让验证失效。
`sdlc_fix_start/end` 继续负责测试冻结；它们不代表问题已修好，也不能代替上述处理记录。

每轮裁决存入 `verifications/<run-id>.json`，包含原始裁决、有效裁决、标准 ID 和版本摘要。
`artifacts.verification` 指向该轮文件；`verification.json` 只作为兼容副本。没有完整裁决、
结果漏项/重复/未知 ID、验证中内容变化、验证后内容变化，都不能作为完成依据。

版本摘要覆盖工作区 Git 仓库内已跟踪及未忽略文件，以及 intent/spec/plan；排除 `.ai`、
`.dsh`、`node_modules`、`.git`。多仓库可通过 `sdlc_verify code_roots` 指定相对仓库根。
超过 32 个仓库、20000 文件、单文件 8 MiB、总内容 128 MiB，或含无法完整核对的链接/
子模块/冲突时明确停止，不能声称版本已确认。它不保证模型判据质量，也不代替 CI。

验证进程中断后，`cancel_verification` 写明原因再重试；迟到结果不能完成该任务。
旧任务没有版本记录，必须重新验证。首次重试会原样归档旧裁决、保留旧问题；不会补造
以前未登记的退回。旧任务只读浏览不改历史。自动检查不阻止人工修改 Git 中的记录。
