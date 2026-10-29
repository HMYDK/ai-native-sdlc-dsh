# 循环工作台实现与验证

日期：2026-10-29。代码分支：`codex/sdlc-loop-workbench`。选择依据是聊天中第二张
[循环工作台](loop-workbench.png)，精修生成因网络错误失败，没有替换成其他方案。

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
`?state=light`、`?state=history`、`?state=evidence`、`?state=mobile` 可重现对应截图状态。
这些脚本和依赖不会进入插件发布包。

## 未完成的实机验收

初始测试包已装入仓库内的隔离 `verify-sdlc` profile，DSH Web 能启动。浏览器访问认证
页面的授权被用户拒绝，之后没有重试该访问，改用上述不连接 DSH 的本地组件预览。
因此 **不能据此宣称最终界面已在真实 DSH 页面验收**。最终构建与初始隔离安装包还存在
后续视觉修正的差别。日常 `desktop` profile 未升级。

远端推送此前也被用户拒绝，本次只保存本地提交，不重试推送。
