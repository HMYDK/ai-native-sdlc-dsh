# SPEC 阶段的独立审查

`sdlc_spec_review` 在开始实现前，对照原始需求审查 Intent / Spec / AC，报告遗漏、范围偏移、验收方法缺口与必须澄清的需求问题。它使用现有 verify 组件的独立上下文和受限工具，不增加组件行。

核心问题：**能否构造一种满足当前 Spec / AC，却违背有依据用户要求的行为？** 同时检查是否把用户明确排除的能力重新加进规格。此时功能可以尚未实现；缺少实现、测试输出或 plan 不是规格缺陷。

向前进入 PLANNED 或之后阶段必须有当前有效的审查，且 `active_findings` 为空。`sdlc_verify(task_id)` 也检查这一前提。成功审查登记当前记录的 ID 和文件指纹，阶段、AC 登记、交付问题与 `verification.json` 仍由各自的流程管理。

## 第一次审查

1. 建立任务，写入并登记 Intent、Spec。把相关用户原文保存为任务目录下的 UTF-8 文件，保留出处和上下文。
2. 调用 `sdlc_task_advance` 进入 SPEC，在 `artifacts` 中登记 `{"source":"source.md"}`。已在 SPEC 但缺少登记的任务，可先退回 INTENT 登记来源，再进入 SPEC。
3. 调用 `sdlc_spec_review({"task_id":"EXPORT-1"})`。此时可以还没有 plan 或实现。

有多份原文、澄清或作者推断时，另存一份 JSON 数组，例如任务目录下的 `spec-sources.json`，并用 `artifacts.spec_sources` 登记它。示例中的路径相对工作区根。

```json
[
  {"path":".ai/tasks/EXPORT-1/source.md","origin":"用户需求消息，保留原文","kind":"original"},
  {"path":".ai/tasks/EXPORT-1/clarification.md","origin":"用户确认纳入已归档订单","kind":"clarification"}
]
```

清单含 1–8 个文件，必须把 `artifacts.source` 登记的文件标为 `original`。可用类型为 `original`、`clarification`、`author_inference`。单一来源直接登记 `source` 即可。显式传 `sources` 时，路径、顺序、类别和出处都必须与登记清单一致；通常只传 `task_id`。插件读取本地文件，出处和类别由调用方声明，哈希用于核对版本。

当前原文、清单、Intent、Spec 和任务状态总计最多 256 KiB；含前轮材料的提示词最多 512 KiB，前轮记录最多 2 MiB。超过限制返回未完成，未派发模型；不静默截断原文。

结构化反馈最多 64 KiB，每轮最多 32 条新发现，累计最多 128 条未解决发现。输出超过限制时记录本轮未完成，不自动重试；这些上限用于控制反馈规模，不代表小于上限就语义充分。

## 反馈与修订

工具返回 `review_id`、`review_file`、`review_complete`、`outcome`，完成时附 `review` 与 `active_findings`：

- `review.findings`：新增的 omission / scope_drift / weak_oracle / ambiguity。每项包含持久编号、source_id、逐字 source_quote、Spec 位置、problem、counterexample 和 suggestion。
- `review.follow_up`：对前轮未解决发现逐项给出 addressed（修订已消除问题）、withdrawn（原发现不成立）、open（仍存在）或 needs_clarification（需要需求确认），并给出独立依据。
- `review.limitations`：无法核实的来源、判断边界；没有发现不等于已证明充分。
- `active_findings`：前轮仍 open / needs_clarification 的发现与本轮新发现。原编号保留，不因复审换号。

明确遗漏由作者修订 Spec / AC；不成立的发现由作者提供反证；涉及需求取舍或实质争议时向用户提出具体问题。不要因为模型报告一个发现就自行扩大需求。审查者负责独立复核作者回应，也可以撤回错误发现。

## 复审

```json
{
  "task_id": "EXPORT-1",
  "previous_review": "前轮返回的 UUID review_id",
  "responses": [
    {
      "finding_id": "前轮 active_findings 中的原编号",
      "response": "已在 AC-002 增加全量订单 ID 比对；或者给出原文/事实反证与位置。"
    }
  ]
}
```

作者和审查者都必须逐项覆盖当前审查的全部未解决发现。查看 `sdlc_task_status` 的 `spec_review_id` 可找到当前记录。提供的 `previous_review` 必须是这个 ID。已有未解决发现时必须显式带这个 ID；该记录无未解决发现时，省略 ID 会由工具接续当前链。审查读取当前登记的完整来源，并提供前轮来源与 Spec 供对照。需求新增或澄清时在 SPEC 更新来源文件或登记清单，再复审。

一次调用仅派发一次模型，不受最终验证的 `verifierRetryOnMalformed` 自动重试设置影响。使用同一组件的 provider / model / maxTokens 配置；重复调用仍会产生额外成本。反复争议没有新证据时，应把具体争议交给用户，不能以不断重派代替处理。

未覆盖模型路由时，审查者也继承调用会话的推理强度。`sdlc_spec_review` 没有单独的 reasoningEffort 参数；本地试验通过父代理的模型选项显式选择 low，插件没有改变所有会话的默认值。已观察到的结果依赖具体模型、推理强度及输出预算，不应把一次成功当成任意配置都能完成的保证。

## 记录与失败语义

每轮记录位于 `spec-reviews/<review_id>.json`，保存实际输入、快照指纹、结构化反馈、前轮引用与响应，以及执行事件。工具只在有效结果落盘、再次核对输入和任务状态后更新 `state.yaml` 的 `spec_review` 引用。来源缺失、输出结构错误、引文无效、输入在审查中变化、复审漏项或取消都会保留失败记录；这类运行不会成为登记的审查。已有记录仍然匹配当前输入时可以继续使用。

向前推进和启动任务模式的最终验证时，工具从任务引用读取记录，核对任务身份、文件指纹和复审关系，并重新计算未解决发现。它还会对照当前的 Source、Intent、整个 Spec/AC、清单及每项来源文件。输入变化需退回 SPEC 重审。复用有效记录只读取文件，不派发模型。进入 REVIEWING 或 DONE 仍需要现有的独立交付裁决。

真正的需求歧义要由用户澄清，把已确认的内容登记为来源，再让审查者复核。未解决的阻断状态持续到取得有效复审。当前没有可信的人工豁免工具，`reason` 或作者自填的许可字段无法让任务通过。

## 历史任务与信任边界

部署新规则时保留旧任务状态、历史和交付裁决。历史任务下一次向前推进或启动任务模式验证前，需要退回 SPEC，登记来源并补审。已有单条旧审查链时，在首次补审传入其最后一轮真实 ID 和逐项响应。旧审查有分叉、损坏或缺失的前轮时，工具保留原记录并要求人工核对、恢复；不会自动选择一条链丢掉另一条的发现。DONE 任务可继续查看，重新打开后遵循同一迁移路径。

该门禁约束 SDLC 工具执行的状态迁移和任务模式验证。只改一个阶段字段无法让任务模式验证通过。拥有任意仓库写权限的人可以修改状态及全部证据，插件无法认证来源或抵御这类修改。团队需要额外约束时，可在 Git/CI 层核对审查记录和关联提交，保护分支及证据的写入权限。

审查记录含原文和模型输出，提交或分享前须核对私人信息。SPEC 审查记录与最终交付裁决、RSI 的交付验证统计分别存放。

## 验证范围

`src/verify/spec-review.test.ts` 检查引用、回应覆盖和复审结果处理。`smoke/spec-review.mjs` 用真实 Cordis / ToolRuntime / LocalFileSystem 调用工具，但使用受控模型返回，覆盖无审查跳阶段、失败和损坏记录、版本变化、修订和撤回、历史任务补审，以及进展中复用有效记录。

这些测试证明协议和接线，不证明模型能可靠识别需求遗漏。真实模型行为须按独立预算运行案例并保留失败、误报、人工介入和成本；评测材料见 [SPEC 审查案例](evals/spec-review-cases.md)。

以下是真实模型对建议版（门禁之前）的读数，用于追溯早先的语义试验与限制。

2026-11-18 至 19 的首次真实模型试验（本地 0.6.2 / DSH 0.2.2-rc.3 / deepseek-v4-pro，实际 reasoningEffort=high）完成 2/4 次：首轮发现了预设的构建遗漏，局部范围例出现有争议的反馈，两次复审均触及输出上限、未产出结构化结果。修订确认和反证撤回尚未在真实模型下跑通；完整材料、用量与限制见 [首轮报告](../.ai/tasks/SPEC-REVIEW-1/eval-2026-11-18/report.md)。

2026-11-19 后续排障使用 low，取得了有依据的 addressed 与逐项 withdrawn，见 [复审排障报告](../.ai/tasks/SPEC-REVIEW-1/eval-2026-11-19/report.md)。期间仍有一次 JSON 生成失败、一次评测器误取消，均保留；SPEC 提示词增加了简短反馈要求，评测器修复了已生成终局提交的预算处理。样本较小且配置逐步变化，尚未完成“实际未修却声称已修”的真实负例及独立交付验收。

2026-11-19 的 [正反例补测](../.ai/tasks/SPEC-REVIEW-1/eval-2026-11-19-controls/report.md) 在明确字符顺序后取得有限域正例的空发现反馈；原先措辞不明的版本保留一项歧义，不能直接计作误报。未修反例因模型拼接引文而被记录为 incomplete，尚无有效结论。三次中完成两次，模型完成率与引用格式遵循仍是限制；没有把未通过校验的 open 字段当成成功。
