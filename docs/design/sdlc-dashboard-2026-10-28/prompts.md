# Image Gen 提示词

日期：2026-10-28。工具：内置 image_gen。

三次调用都附入已查看的现有截图 `rsi2-record-health.png`，作为语义参考。

## 流程画布

```text
Use case: ui-mockup. Create ONE realistic, production-quality desktop application UI concept, not a poster, not a wireframe. Direction name: 流程画布. This is a Chinese AI-native SDLC dashboard inside DeepSeek Harness. Target dimensions: 1440 x 1024, crisp full screen, natural landscape desktop proportions, no computer bezel or browser chrome. Current date anchor: 2026-10-28, Asia/Shanghai. Any dates should say 10月28日. Mark the screen discreetly "设计预览 · 示例数据".

Reference image role: the attached screenshot is the EXISTING UI the user dislikes, supplied only for domain grounding. It shows a monotonous one-way stage strip, latest verdict, artifact list, and record completeness. Completely redesign its structure and visual system. Do not repeat the reference's narrow layout or sparse block stack. Preserve the product semantics: stages are exactly 意图 → 规格 → 计划 → 实现 → 验证 → 评审 → 完成. "修复" is an activity within 实现, not a new top-level stage. Read-only observation and drill-down; no deploy/approve/merge/pause/run controls.

Design brief: a beautiful, polished, warm light workflow canvas for a software developer to understand WHERE a task is, WHY it returned, WHAT changed, and WHICH verification round is happening. The repeated loop from validation rejection back to implementation and re-verification must be the unmistakable visual focus.

Visual system: white and very pale warm-gray #F8F9F7 surface, almost black ink #1C252C, restrained cobalt #3C5BDB current focus, desaturated teal completed states, amber/coral only on failed checks. Editorial clarity, quiet sophistication, sharp alignment, 8px spacing rhythm, 32px outside padding. Large confident 28px task title, 14-16px readable Chinese UI copy, clean modern sans-serif like Inter plus PingFang, monospace only IDs. Hairline separators, selective 10px corners, no gradients, no glass, no decorative hero art, no generic four-stat-card row, no nested cards. Full-bleed app surface.

Layout: slim 60px host icon rail on far left; compact 230px task navigation with workspace "AI Native SDLC", search, three tidy task rows. Selected row "DEMO-028" / "修复订单优惠计算" with small "复验中" badge. Other sample rows "TASK-027 · 规格整理" and "TASK-026 · 已完成". Main area has breadcrumb "任务 / DEMO-028", beautiful title "修复订单优惠计算", subtitle "验证第 3 轮 · 上轮 1 项未通过", one primary blue viewing action "查看本轮证据" top right.

Hero centered workflow canvas occupying about the top middle half of the main area, with subtle sparse dot grid only within the canvas, not boxed in a card. Arrange all 7 stages as a connected left-to-right flow, earlier three compact, implementation and verification slightly emphasized, final two muted upcoming. Each node has a small tidy line icon, its Chinese stage label, one short status. Implementation says "修复完成"; verification current node says "第 3 轮 · 进行中". Draw a prominent graceful amber curved return arrow clearly from 验证 back to 实现 below the two nodes, with a visible arrowhead pointing into 实现 and a centered label "未通过 → 修复 → 再验证". Forward implementation → verification arrow remains clearly visible, forming an actual closed loop. A small pill on the return path says "已返工 2 次". Completion path from 验证 to 评审 is faint and labeled "通过后". It must be a real explanatory workflow, not seven decorative boxes.

Below canvas: headline "每一轮，都有来由" or "验证与修复". A 3-item horizontal connected round history, spacious:
"第 1 轮" / red "未通过 · 3 项问题" / "定位会员优惠覆盖问题"
"第 2 轮" / amber "未通过 · 1 项问题" / "补充边界条件修复"
"第 3 轮" / blue "复验中" / "核对最后一项修复"
First two round tiles minimal surface separators, third selected with fine blue rule. Then one focused detail row below selected third round: "待复验：优惠叠加边界" with small chips "发现 F-03" → "修复 7c3d2a1" → "测试证据" and short text "已提交修复，等待独立验证结果". This conveys finding → change → evidence; don't fabricate pass while ongoing.

Bottom understated horizontal artifact strip "交付物" with compact links "意图" "规格" "计划" "验证记录" "评审待生成"; a small secondary row "完成后 · 复盘 → 改进任务" with thin return/branch icon showing improvement continues. Show "执行记录：完整" separately from task status. No huge metrics, no extra features or newsfeed. A sophisticated focused working product, generous but productive space. Use accurate simplified Chinese, aligned content, precise arrows and readable labels, no lorem ipsum, no clipping.
```

## 循环工作台

```text
Use case: ui-mockup. Create ONE realistic, exceptionally polished production-quality desktop software UI concept. Direction name: 循环工作台. Chinese AI-native SDLC dashboard inside DeepSeek Harness. Target dimensions: 1440 x 1024, natural desktop landscape UI, content only, no monitor, no browser chrome. Date anchor: 2026-10-28 Asia/Shanghai. If a date appears use "10月28日". Include a tiny clear "设计预览 · 示例数据".

The attached old UI screenshot is REFERENCE ONLY for existing product semantics. The user explicitly wants a different beautiful design, and says the existing screen lacks the SDLC workflow and verification/fix loop. Radically redesign it with a new dark visual system and loop-centered interaction; do NOT mimic the narrow white layout.

Main user goal: Watch an agent work through independent verification, understand exactly why the task went back for repair, inspect what was repaired, then see the next validation round. All seven SDLC stages must remain visible: 意图 → 规格 → 计划 → 实现 → 验证 → 评审 → 完成. 修复 is an activity inside 实现, not another top-level SDLC stage. Show current task at third verification after two failed rounds. Actions are read-only drill-down, no run/deploy/approve/pause controls.

Visual language: refined dark professional instrument, charcoal #171B1D base, softer #22282A surfaces, bone white primary type, muted gray secondary text, sophisticated mint #AFDCC8 active focus, warm coral #DD9B83 rejection, dim slate future. Very restrained fine-line topological strokes, no glowing neon, no space art, no gradients, no glass, no heavy shadows, no cyberpunk. Outstanding typography and generous spacing; 30px Chinese title, 14-16px body, mono IDs and round count. Modern typography resembling Linear or a high-end creative desktop tool, but original layout. Fine separators instead of nested panels; small 8px corner radii selectively. No four KPI tiles. Full-bleed app, not a floating card.

Layout: 60px vertical host icon rail, 220px dark navigation. Product "AI 原生 SDLC". Workspace "AI Native SDLC". Task list with "DEMO-028 修复订单优惠计算" selected in subtle mint tint, two other sample tasks underneath. Main header breadcrumb "任务 / DEMO-028" and title "修复订单优惠计算". A compact elegant seven-stage ribbon along the top of main view: first four completed, 验证 is bright mint current, last two dim. No percentages.

Main composition: central LARGE circular/rounded-square 4-node workflow occupying left two-thirds of main space, with a clean loop path clearly connected using directional arrowheads clockwise. Nodes at four cardinal positions:
top "发现问题" small "F-03 · 优惠叠加边界"
right "修复实现" small "作者 · 已提交修复"
bottom "执行检查" small "测试证据已生成"
left "独立验证" small "验证者 · 正在复验"
Current left verification node mint highlighted. Other completed activities low contrast. Coral return connector visibly points from 独立验证 to 发现问题 and is labeled "未通过 · 返回修复"; there should be no ambiguity about direction. A subtle separate branch from 独立验证 to the right edge/lower right outside the loop labeled "通过 → 评审 → 完成". At the center a beautifully typeset large "03" with "当前验证轮次" above and "复验中" below. Subtle text "2 次未通过 · 1 项待复验". The ring is a readable workflow diagram inside the product, not a decorative donut chart.

Right third: unboxed side detail with a vertical separator. Header "这一轮为什么发生". Clear short chain:
"上轮发现" / "F-03 会员优惠边界不一致"
"本轮修复" / "统一优惠叠加计算" / small commit 7c3d2a1
"当前进展" / "独立验证正在核对边界用例"
One focused primary mint button "查看本轮证据".
Below a small real execution summary "Agent 执行轨迹" with 3 clean chronological log rows, compact tools in mono: "read  读取验收标准", "bash  运行边界测试", "result  等待验证裁决". This is external tool activity, NOT chain of thought. A tiny horizontal return arrow beside rows indicates "结果 → 下一步行动"; no exposed hidden reasoning.

Bottom across main area: a round scrubber with exactly 3 connected selections:
"第 1 轮 · 未通过 3 项" in coral,
"第 2 轮 · 未通过 1 项" in coral,
"第 3 轮 · 复验中" selected mint.
Beneath it a single quiet footer bar "交付物：意图 / 规格 / 计划 / 验证记录" left, "执行记录完整" right. A tertiary text link "完成后复盘 → 改进任务" distinct from task completion. Ensure all typography is legible, large enough, everything aligned, intentional space around the circular loop, no crowded card inventory, no random metrics, no fake percentage completion. Strong visual identity while entirely plausible to implement.
```

## 交付全景

```text
Use case: ui-mockup. Create ONE realistic, visually refined high-fidelity desktop application design. Direction name: 交付全景. Target: Chinese AI-native SDLC task dashboard inside DeepSeek Harness. Target dimensions 1440 x 1024; natural desktop landscape, complete app screen, no browser chrome or device frame. Current date anchor 2026-10-28 Asia/Shanghai; visible date "10月28日". Discreet caption "设计预览 · 示例数据".

Attached reference is a current narrow UI screenshot supplied ONLY as domain context. User dislikes its visual simplicity and the lack of iterative workflow. Create a substantially different polished full-width portfolio kanban design, not a reskin. Existing semantics must remain: SDLC stages are exactly 意图, 规格, 计划, 实现, 验证, 评审, 完成; repair is work inside implementation. There is an explicit verification rejection → implementation repair → re-verification loop. All UI controls here are read-only browsing and drilling into evidence; no task drag handles, no buttons that deploy, run, approve, or change task state.

Design purpose: a developer managing several tasks sees every task's location in the entire lifecycle, which ones are repeating work, and inspects the selected task's full verification and repair story without leaving the board. The hero is a seven-column workflow board PLUS one integrated bottom task inspector, not cards full of feature advertisements.

Visual system: bright ivory #FBFAF7 background, dark ink #262A24 typography, forest green #35654C primary, muted apricot #C58565 return/rejection, slate #86929B secondary, very subtle cream alternate lane fills. Strong Swiss editorial grid, 28px page heading, readable 14-16px Chinese body, restrained thin outlined stage icons. The workspace feels warm, composed, high-end and practical, no gradient, no glass, no large KPI cards, no generic blue admin dashboard. Small clean line icons, generous whitespace, rounded 8px task surfaces only where tasks are true discrete objects. Avoid nesting cards. Everything rests on base app surface. Details organized with space and 1px dividers.

Composition: far left 60px narrow host rail. Optional small navigation area no wider than 160px with "工作区" and selected "AI Native SDLC", plus compact "任务" and "复盘". Main area fills rest. Header title "交付全景", subtitle "从意图到交付，看见每一次往返". Workspace selector and search unobtrusive on right, one segmented control "流程 / 列表" with 流程 selected.

Seven equally aligned columns across main board, headers all visible in this order: "意图" "规格" "计划" "实现" "验证" "评审" "完成". Fine stage icons and counts; no cramped microtype. Max 6 example task cards total, not every cell filled:
意图: "TASK-031" / "导出任务摘要"
规格: "TASK-029" / "批量任务筛选"
计划: empty understated "暂无任务"
实现: "TASK-030" / "修复记录缺口" / amber small "返工第 1 次"
验证: selected "DEMO-028" / "订单优惠计算" / dark green chip "第 3 轮 · 复验中" / small "已返工 2 次"
评审: "TASK-025" / "交付物预览" / "验证通过"
完成: "TASK-026" / "工具列表优化" / "待复盘".
Selected verification task has a strong fine forest-green border and a tiny connection anchor to the inspector below. In the space below stage headings and above cards, the default thin line connects 实现 → 验证. Draw an unmistakable terracotta curved return arrow from 验证 BACK to 实现 under these two selected columns, with arrowhead clearly pointing at 实现 and label "验证未通过 → 回到实现". Label above forward path "修复后再验证". This shows the SDLC is not a one-way kanban. Keep loop contained so it doesn't cross card text.

Bottom integrated inspector occupying roughly 350px: separated by one fine horizontal rule, full main width, not floating overlay. Left header "DEMO-028 · 修复订单优惠计算", with visible sublabel "验证第 3 轮，正在复验最后一项修复". Right a single green primary view action "查看完整证据".
Below header three round columns connected in temporal sequence:
"第 1 轮" "未通过 · 3 项问题" "已进入修复"
"第 2 轮" "未通过 · 1 项问题" "已提交边界修复"
"第 3 轮" "复验中" "等待独立验证"
A continuous line with small return arcs between first/second and second/third emphasizes repeat cycles. Third round selected with dark green underline.
Then the inspector's bottom line tells a concise evidence story left-to-right: "发现 F-03" → "修复 7c3d2a1" → "测试结果" → "复验待出". No claimed pass for ongoing round. Evidence are clickable document labels, not big cards. Display "执行记录完整" separate from task completion. Footer a subtle improvement continuation from completed tasks: "完成 → 复盘 → 改进任务 ↗" pointing towards intent stage via small link, not a huge line crossing screen. This shows improvement beyond done without inventing deployment gates.

Focus on sophisticated typographic rhythm, easy scanning, correct connector direction, clean lanes, readable Chinese, no huge empty blocks, no clipped horizontal board, no overloaded badges, no cartoon art. The user must immediately understand both the overall SDLC and the selected task's repeated verification/repair history.
```
