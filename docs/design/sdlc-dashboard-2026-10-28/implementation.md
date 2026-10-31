# 循环工作台实现与验证

日期：2026-10-29。代码分支：`codex/sdlc-loop-workbench`。选择依据是聊天中第二张
[循环工作台](loop-workbench.png)，精修生成因网络错误失败，没有替换成其他方案。

## 2026-10-31：按真实记录展示阶段的推进、退回与重新提交

旧主图固定展示验证修复四节点，阶段条只说明顺序，完整 history 藏在弹窗里。
用户无法直接看出评审退回规格、验收退回计划等不同路线。新主视图直接消费已有
`task.timeline`，没有修改状态机、API 或增加依赖。

- 七阶段保留交付物入口，显示实际进入次数；已进入不再用对勾冒充通过。
- 每次退回按真实来源和目标画箭头，显示原因。点击后显示后续连续路线与各次流转说明。
- 完整列表包含推进、退回和阶段内更新，可筛选退回。刷新保留用户选中的记录；若记录
  消失，明确说明并提供重新选择入口，不静默跳到另一条。
- 沿实际记录找到重新进入原阶段的时点，只标为重新提交；没有再次进入却去了后续阶段
  也如实说明。路径断开或与当前状态不符时停止拼接。
- 修复操作与历史验证提交只按有效、连续的时间范围展示，合并按时间排序。时间缺失或
  倒序时不关联。改动说明来自提交者，没有逐条问题与修改的对应关系时明确说明。
- 当前文件、历史轮次证据继续分开。原四节点视图与逐轮裁决保留在「验证详情」里；
  不再用固定标签声称所有失败都会退回实现或通过后已进入评审。

前四条新增交互回归在旧代码均失败；现在客户端 **27 / 27**。完整验证的库单测
**227 / 227**、宿主 **32 / 32**、九组冒烟 **437 / 437** 通过。最后把修复和提交
合并为时间顺序后重新构建，客户端 27 项再次通过。compat 核对当前 App **0.2.1-rc.5**，
preset-sync 的 **22 + 6** 行一致。最终包不包含夹具、浏览器检查脚本或 React 副本。

浏览器流程：FLOW-DEMO → 评审退回规格 → 原因、修改和再次提交路线 → 第四轮历史
证据 → 切到验证退回计划 → 筛选/刷新；然后切回 LOOP-DEMO 复查原有验证和交付物功能。
Browser plugin not available，使用已缓存的 Playwright CLI + Chrome。地址
`http://127.0.0.1:4326/` 只服务明确标注的本地夹具，没有连接 DSH 认证服务。
最终源码在 **1421×1058、1120×1058、390×844 各 40 项**交互通过。页面身份、非空、
无框架报错、无控制台错误/警告、截图和操作结果均已检查；手机优先展示选中退回的详情。
截图已查看，保存在 `<本机临时截图>/`。

最终包 `ai-native-sdlc-dsh-sdlc-0.4.0-flow-46e802f88e84.tgz` 含 60 文件、33 个 JS。
先安装隔离 `verify-sdlc`，随后更新日常 desktop；发布 JS 与 patch 逐文件一致。
包安装器提示 peer 警告；真实 App 的 peer 兼容检查、运行时冒烟及安装文件核对均通过。
profile 中只有 SDLC 引用变化，其他依赖、bundles、profile patch 和其他锁条目不变。
备份在 `~/.dsh/backups/sdlc-stage-flow-2026-10-31T01-56-42-126Z/`，完整哈希见
`verification.json`。没有退出或重启 DSH，实机页面仍未确认；不重试此前被拒绝的远端推送。

## 2026-10-30：恢复每个阶段的交付物

根因是改版只保留了阶段名称和底部小链接，没有展示接口已提供的文件名、章节摘要。
阶段详情又使用单文件关联，验证证据被遗漏，实现阶段没有计划入口。

- 阶段条直接显示登记文件名，点击一次打开正文；顶部提供完整清单。
- 阶段详情和任务交付物卡片复用同一列表，展示文件名与章节摘要；自定义登记也保留。
- 验证阶段同时展示 verification 与 proof；实现阶段明确显示计划依据；完成阶段汇总全部。
- 打开文件时保留原阶段面板，关闭文件后恢复焦点；当前文件与历史轮次快照明确区分。
- 完整清单的 React key 与页面交付物区分开，避免打开清单后刷新留下重复 DOM。

验证：三项新增客户端回归在修复前均失败，修复后 21 项客户端测试全部通过。
完整 `npm run verify` 通过：库 227、客户端 21、宿主 32、9 组冒烟 437；compat 与
preset-sync 通过。未改变宿主接口或制品登记协议。

浏览器流程：任务详情 → 阶段文件 → 正文 → 返回阶段面板 → 完整清单 → 刷新。
Browser plugin not available；使用已缓存的 Playwright CLI + Chrome，地址为
`http://127.0.0.1:4326/`，仅服务本地示例组件，没有连接 DSH 认证服务。
最终源码在 1421×1058、390×844 各通过 29 项交互；1120×1058 也在最后的手机文件名
截断调整前通过 29 项。页面标题与内容正确、没有空白或框架错误界面、控制台无错误与警告，
截图已人工查看，阶段入口和弹窗未发生遮挡。截图保存于本机 `<本机临时截图>/*.png`。

60 文件、33 JS 的修正版包先安装隔离 profile，随后安装到日常 desktop；发布 JS 与
patch 逐文件核对一致，profile 仅改 SDLC 的包引用。完整 SHA256 见 `verification.json`。
安装前备份在 `~/.dsh/backups/sdlc-deliverables-2026-10-30T02-49-04-049Z/`。
未替用户退出 DSH；仍需完全退出再打开确认实际页面。远端推送沿用此前拒绝，不重试。

## 实现

- 七阶段总览、四节点循环、逐轮问题与证据、验证者工具轨迹、任务累计修复、交付物、迁移记录和复盘入口。
- 保留工作区与任务身份，支持搜索、筛选、主题切换和窄屏任务列表/详情切换。
- 每轮读取明确登记的运行与会话；重试不新增轮次，reject 不等于修复，未结束不等于正在执行。
- 历史证据来自该轮快照。刷新新增轮次或历史超出返回范围，都不会静默换成最新结果。
- 修复与发现没有明确对应关系时说明缺口；工具参数、输出、配置与隐藏推理不返回浏览器。
- 新端点只读，不触发 RSI 收集。修复了显式 root 缺失时错误回退到另一工作区的旧行为。
- 保留现有 DSH bundle、宿主行与 preset 的组合，不引入第二份 React 或 DSH 运行时依赖。

## 验证证据

最终源码运行：

```sh
DSH_APP='/Applications/DeepSeek Harness.app' npm run verify -w @ai-native-sdlc/dsh-sdlc
npm run compat
npm run preset-sync
```

结果：库单测 **227 / 227**、客户端交互 **18 / 18**、宿主接口 **32 / 32**；
9 个运行时冒烟脚本共 **437 / 437**。兼容当前 App **0.2.1-rc.3**，standard 副本
**22 行 + 6 行 SDLC** 无漂移。新交互用例曾对旧界面确认失败；新接口用例在路由未接入时失败。

浏览器检查使用**同一份客户端源码**、真实 React 和真实记录读取函数，仅数据来源使用
隔离夹具。**没有连接 DSH 服务，也没有模拟实际业务验证已通过。** 预览工作区明确标为
“界面验证 · 示例数据”。1421px 和 1120px 两个宽度各完成 **18 项** DOM 交互检查，
包括逐轮切换、问题选择、历史证据、弹窗焦点、方向键、交付物、阶段、迁移、主题、
刷新保留历史、断线提示、横向溢出、节点与阶段条不重叠、脚本异常检查。

截图（均为本地组件与示例数据）：

- [深色桌面](../../../output/playwright/loop-workbench-desktop.png)
- [浅色桌面](../../../output/playwright/loop-workbench-light.png)
- [390px 窄屏](../../../output/playwright/loop-workbench-mobile.png)
- [历史轮次](../../../output/playwright/loop-workbench-history.png)
- [本轮证据弹窗](../../../output/playwright/loop-workbench-evidence.png)
- [浏览器检查结果](../../../output/playwright/loop-workbench-checks.png)
- [1120px 检查结果](../../../output/playwright/loop-workbench-checks-narrow.png)
- [整体对照](../../../output/playwright/loop-workbench-comparison.png)与[详情对照](../../../output/playwright/loop-workbench-comparison-detail.png)

视觉检查结论见根目录 [design-qa.md](../../../design-qa.md)。

## 本地复跑

`tools/seed-loop-ui.mjs` 只写仓库忽略的 `.verify-home/loop-workspace` 与隔离工作区列表。
`tools/preview-loop-ui.mjs` 使用本地 React/React DOM 和 esbuild 生成独立 HTML，不访问真实 DSH。

```sh
node tools/seed-loop-ui.mjs
SDLC_REACT_ROOT=/path/to/node_modules \
SDLC_ESBUILD_MODULE=/path/to/esbuild/lib/main.js \
node tools/preview-loop-ui.mjs
```

输出 `.verify-home/loop-preview/index.html`。`?state=checks` 自动运行组件交互检查并显示结果；
`?state=flow`、`?state=light`、`?state=mobile` 展示阶段流转示例；
`?state=history`、`?state=evidence` 展开原有逐轮验证示例。
这些脚本和依赖不会进入插件发布包。

## 未完成的实机验收

初始测试包已装入仓库内的隔离 `verify-sdlc` profile，DSH Web 能启动。浏览器访问认证
页面的授权被用户拒绝，之后没有重试该访问，改用上述不连接 DSH 的本地组件预览。
因此 **不能据此宣称最终界面已在真实 DSH 页面验收**。最终构建与初始隔离安装包还存在
后续视觉修正的差别。初版交付时日常 `desktop` profile 未升级；2026-10-30 安装过交付物
修正版，2026-10-31 又安装上述阶段流转版，仍待重启后的页面确认。

远端推送此前也被用户拒绝，本次只保存本地提交，不重试推送。
