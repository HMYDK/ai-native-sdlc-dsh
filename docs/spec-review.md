# SPEC 阶段的独立审查

`sdlc_spec_review` 在开始实现前，对照原始需求审查 Intent / Spec / AC，报告遗漏、范围偏移、验收方法缺口与必须澄清的需求问题。它使用现有 verify 组件的独立上下文和受限工具，不增加组件行。

核心问题：**能否构造一种满足当前 Spec / AC，却违背有依据用户要求的行为？** 同时检查是否把用户明确排除的能力重新加进规格。此时功能可以尚未实现；缺少实现、测试输出或 plan 不是规格缺陷。

这是建议执行的纠偏流程，不是新的推进门禁。工具不修改 `state.yaml`、AC 登记、问题状态或 `verification.json`，不返回 `approve/reject`。完成审查表示取得了结构有效且对应本轮输入的反馈，不保证需求已穷尽覆盖。最终 `sdlc_verify` 仍独立检查交付行为。

## 第一次审查

1. 建立任务，写入并登记 Intent / Spec，进入 SPEC；不要求已有 plan 或代码仓库。
2. 将用户完整相关原文保存为工作区内的 UTF-8 文件，保留出处和已确认的澄清。不要用作者的总结冒充原文。
3. 调用：

```json
{
  "task_id": "EXPORT-1",
  "sources": [
    {
      "path": ".ai/tasks/EXPORT-1/source.md",
      "origin": "原始需求的 Issue URL / 用户消息标识；文件保留原文与上下文",
      "kind": "original"
    }
  ]
}
```

`sources` 支持 1–8 个文件。`kind` 分为 `original`（原始需求）、`clarification`（确认过的澄清）、`author_inference`（作者推断），至少一份 original。path 为工作区内相对路径，origin 为可追溯出处。插件只读取本地文件，不联网抓取 URL；取得原文与保留上下文由调用方负责。kind / origin 是调用方声明，插件不认证其真实性；文件快照和哈希仅固定输入版本。

也可以通过现有 `sdlc_task_advance` 的 artifacts 参数登记 `source` 文件；省略 sources 时第一次审查读取它。它不会把 Intent 或 Contract 中的作者描述自动视为原始需求。既有任务无需自动迁移。

当前原文、Intent、Spec 和任务状态总计最多 256 KiB；含前轮材料的提示词最多 512 KiB，前轮记录最多 2 MiB。超过限制返回未完成，未派发模型；不静默截断原文。

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

必须逐项回应前轮全部 active_findings；模型复审也必须逐项覆盖。只有本任务已完成的审查可以作为前轮。明确指定 previous_review，不自动猜测并发调用中哪个结果是最新或相关的。省略 sources 时继承前轮的路径/出处/类别并**重新读取当前文件**；同时给审查者前轮来源与旧 Spec，便于核对变化。需求新增或澄清时显式传入完整 sources 清单。

一次调用仅派发一次模型，不受最终验证的 `verifierRetryOnMalformed` 自动重试设置影响。使用同一组件的 provider / model / maxTokens 配置；重复调用仍会产生额外成本。反复争议没有新证据时，应把具体争议交给用户，不能以不断重派代替处理。

未覆盖模型路由时，审查者也继承调用会话的推理强度。`sdlc_spec_review` 没有单独的 reasoningEffort 参数；本地试验通过父代理的模型选项显式选择 low，插件没有改变所有会话的默认值。已观察到的结果依赖具体模型、推理强度及输出预算，不应把一次成功当成任意配置都能完成的保证。

## 记录与失败语义

每轮保存到 `.ai/tasks/<ID>/spec-reviews/<review_id>.json`，包含原始输入快照、出处声明、提示词、模型会话、结构化输出、作者回应、关联前轮与执行事件。中途记录为 running；成功后为 completed。来源缺失、输入在调用期间变化、输出结构错误、引用原文无法匹配或复审漏项时为 incomplete；取消为 cancelled。失败不伪造成“无发现”，也不阻断现有任务推进。

原文引用校验只证明引文存在于输入中，不能证明模型的语义推断正确。继承的历史记录也不是防篡改边界。记录含原文和模型输出，提交或分享前须审查其中的私人信息；不要提交本机 profile、密钥或未经检查的运行记录。

记录独立于最终交付裁决和 RSI 的 verifier 运行统计，以免把前置反馈算作交付 approve。需要了解本轮到底执行了什么，可从 review_file 的 events 追溯。运行时写盘失败是工具错误，不能将未落盘结果报告为已完成。

## 验证范围

`src/verify/spec-review.test.ts` 检查引用、回应覆盖和复审结果处理。`smoke/spec-review.mjs` 用真实 Cordis / ToolRuntime / LocalFileSystem 调用工具，但使用受控模型返回，覆盖修订、撤回、争议、失败、取消、输入变化与不新增推进门禁。

这些测试证明协议和接线，不证明模型能可靠识别需求遗漏。真实模型行为须按独立预算运行案例并保留失败、误报、人工介入和成本；评测材料见 [SPEC 审查案例](evals/spec-review-cases.md)。

2026-11-18 至 19 的首次真实模型试验（本地 0.6.2 / DSH 0.2.2-rc.3 / deepseek-v4-pro，实际 reasoningEffort=high）完成 2/4 次：首轮发现了预设的构建遗漏，局部范围例出现有争议的反馈，两次复审均触及输出上限、未产出结构化结果。修订确认和反证撤回尚未在真实模型下跑通；完整材料、用量与限制见 [首轮报告](../.ai/tasks/SPEC-REVIEW-1/eval-2026-11-18/report.md)。

2026-11-19 后续排障使用 low，取得了有依据的 addressed 与逐项 withdrawn，见 [复审排障报告](../.ai/tasks/SPEC-REVIEW-1/eval-2026-11-19/report.md)。期间仍有一次 JSON 生成失败、一次评测器误取消，均保留；SPEC 提示词增加了简短反馈要求，评测器修复了已生成终局提交的预算处理。样本较小且配置逐步变化，尚未完成“实际未修却声称已修”的真实负例及独立交付验收。


2026-11-19 的 [正反例补测](../.ai/tasks/SPEC-REVIEW-1/eval-2026-11-19-controls/report.md) 在明确字符顺序后取得有限域正例的空发现反馈；原先措辞不明的版本保留一项歧义，不能直接计作误报。未修反例因模型拼接引文而被记录为 incomplete，尚无有效结论。三次中完成两次，模型完成率与引用格式遵循仍是限制；没有把未通过校验的 open 字段当成成功。
