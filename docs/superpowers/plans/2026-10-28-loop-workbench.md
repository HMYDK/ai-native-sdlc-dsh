# 循环工作台实现计划

> 执行方式：按 superpowers:subagent-driven-development 分工；子代理额度用尽后由主代理接手，继续完成实现和验证。

**Goal:** 让选中的第二版深色工作台展示真实 SDLC 阶段、验证轮次、修复记录和证据，并保留任务、工作区与交付物浏览。

**Architecture:** 保留宿主两行和现有客户端注册方式。列表端点保持轻量，选中任务后独立读取 execution 端点。每轮按 run ID 建模，记录缺失与真实裁决分开显示；不从 reject 次数推算修复。

**Tech Stack:** 现有 TypeScript、DSH FileSystem/认证 fetch、宿主 React、CSS 与功能性 SVG 流程连接线。图标使用 Tabler Icons 的固定版本子集，不引入第二份 DSH 运行时。

## 1. 真实执行数据

- [x] `src/ui/execution.test.ts` 覆盖三轮、轮内重试、取消、缺失结束记录、跨任务混入、软链、超限、旧任务和修复调用结果。
- [x] `src/ui/execution.ts` 只读 manifest 所登记的 runs/sessions，返回有界摘要，不回传原始会话或隐藏推理。
- [x] `src/ui/index.ts` 增加 `/api/sdlc-ui.execution?task=...&root=...`，明确 root 不允许回退到别的工作区；读取 DSH_HOME 对应工作区列表。
- [x] `test/board.test.mjs` 验证新端点、只读、隔离存储根和工作区身份。

合同：`{taskId,repoRoot,status,issues,rounds,repairs}`。round 含 `id,number,source,startedAt,finishedAt,outcome,attemptCount,summary,criteria,findings,testEvidence,changesSummary,toolEvents`。source 为 `rsi` 或 `current_verdict`；outcome 缺结束时为 `incomplete`。repairs 区分 `fix_start/fix_end/backtrack`，不相加伪造返工次数。

## 2. 工作台界面与交互

- [x] 先在 `test/client.test.mjs` 加轮次切换、历史保留、证据归属、缺失记录不报运行中、无修复不报返工的交互用例，并对旧界面确认失败。
- [x] 重做 `src/ui/client.js` 的布局和样式：任务导航、七阶段总览、四节点循环、右侧发现与证据、执行轨迹、轮次条、交付物和复盘。
- [x] 选中任务时加载 execution，离开时取消请求；轮询不覆盖用户正在浏览的历史轮次，错误保留上次结果并说明过期。
- [x] 每轮证据弹窗使用该轮快照，不能打开最新版 verification 冒充历史；保留交付物原生 dialog 的 Escape 和焦点返回。
- [x] 完成深浅主题、窄屏两步导航、键盘焦点、加载/空/错误/记录不完整状态。

## 3. 验证和交付

- [x] 跑 `DSH_APP='/Applications/DeepSeek Harness.app' npm run verify -w @ai-native-sdlc-plugin/dsh-sdlc`，以及 compat/preset-sync。
- [ ] 最终包的真实 DSH GUI 验收：初始测试包已在隔离 profile 安装和启动；认证页面访问被拒绝，未重试。
- [x] 使用同一客户端源码、真实 React 和三轮夹具生成本地预览；Chrome DOM 交互检查及深浅主题、窄屏、历史、弹窗截图完成，与第二版整体/细节并排对照。此项不等于 DSH 实机验收。
- [x] 修复发现的问题，更新设计 QA、包说明与本次证据；审查 `git ls-files` 后仅提交相关文件。

用户已拒绝本次远端推送，因此保留本地提交，不再次尝试推送。不会升级用户的 desktop profile，隔离运行可供查看。
