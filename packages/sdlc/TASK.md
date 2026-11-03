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
| `INTENT` | 建任务时只写 state.yaml；前进前撰写 intent/spec | 提出者 |
| `SPEC` | 加 `spec.md` | 产品负责人 |
| `PLANNED` | 加 `plan.md`；登记 Spec 的完整验收清单及内容指纹 | 工程师（计划评审通过） |
| `IMPLEMENTING` | intent/spec/plan 已登记且文件存在；Spec 与验收登记一致 | 工程师 |
| `VERIFYING` | Spec 与验收登记一致；上一轮问题已提交处理证据或明确延期 | 工程师实现完成 |
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
| `sdlc_task_create` | 建任务目录 + state.yaml；制品另用 sdlc_artifact_write 撰写 |
| `sdlc_task_status` | 报告状态、制品清单、缺失项、状态是否与实际文件一致 |
| `sdlc_task_advance` | 状态迁移，**先校验准入门槛**，并把迁移追加进 history |
| `sdlc_task_issue` | 登记审核问题、记录退回、提交处理证据、说明延期或取消中断的验证 |

## 0.6.0：完整验收范围从 Spec 登记

Spec 必须有且只有一个 `## Acceptance Criteria`（也接受 `## 验收标准`）章节。所有条目都是必选项，每项单独一行，使用明确的 ID 和正文：

```markdown
## Acceptance Criteria

- AC-001: 优惠金额计算正确
- AC-002: 并发请求不会重复使用优惠券
- AC-003: 优惠失败不能生成错误订单
```

ID 使用 `AC-` 前缀、英文大写字母或数字，可用连字符分段。编号必须唯一，正文不能为空；不接受代码块、子标题或无法解析的续行，避免悄悄漏掉要求。Requirements、Design、Areas of concern 章节仍然必需。结构检查不判断需求是否写全、标准质量或证据真假。

从 INTENT / SPEC 首次进入 **PLANNED 或任意更后续阶段**时，状态迁移会同时在 `state.yaml.acceptance` 登记清单、Spec 相对路径、整个文件的 SHA-256、登记 ID、时间和执行会话。跳阶段也执行这道检查。登记代表本次流程采用了这版规格，不代表独立人员审批。

登记之后，所有进入 PLANNED 及后续阶段的迁移（含问题工具的退回）和每次 `sdlc_verify` 都核对这份登记。**第一次验证也不能把已改过的 Spec 当成新起点。** 全文件指纹意味着说明文字、空白调整也会使登记失效；需要记录退回 SPEC，修改并重新推进登记。新登记即使沿用 AC 编号，也有新版本，旧裁决不能继续使用。

任务验证推荐省略 `criteria`：插件自动把全部登记项交给验证者。旧调用仍可提交完整正文或 `AC-001: 正文`，顺序可变，但缺项、改写、重复和未知项会在派发前拒绝并点名。额外检查用 `additional_criteria` 追加，采用 `EXTRA-...` 编号，不能代替必选 AC；额外检查也必须在本轮全部通过。无 task_id 的独立检查保持原有 criteria 和内容哈希编号，不能作为任务完成依据。

新任务裁决使用 `schema_version: 3`，保存本轮完整验收登记副本、实际清单和代码/制品快照。推进 REVIEWING / DONE 时独立重读当前 Spec，核对登记、裁决版本和逐项结果；缺项、重复/未知 ID、无证据、not_met 或 cannot_tell 都不能通过。**登记的 Spec 指纹**约束需求起点，**本轮 Verification 指纹**约束验证期间和验证后的代码/制品，两者分别检查。

旧任务只读浏览保留历史状态及原始结论，并显示“历史裁决未核对完整验收范围”。再次推进或验证时，必须回到 SPEC 补齐章节、登记并重新验证；不从旧 criteria 自动生成登记，不批量改写 DONE 状态。旧裁决和旧问题继续保留原有内容哈希编号；旧问题仍须显式提交并独立复验，新记录不重新解释旧编号。

看板使用同一套契约解析和覆盖检查，显示应验、已答、满足数量及缺失 ID。覆盖已核对不等于发布授权，也不保证 Spec 最初包含了全部用户需求。

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
