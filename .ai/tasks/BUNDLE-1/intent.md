# Intent：七个插件合并为一个包

## Problem

这一套 SDLC 机制目前是**七个独立 npm 包**（verify / task / artifact / status /
workflow / ui / rsi），每个包各自是一个 DSH bundle。实测代价全部落在分发层：

1. **七份 `peerDependencies`**。2026-10-17 App 从 `0.2.0-rc.2` 升到 `0.2.1-rc.2`
   时，七个包因精确锁旧版本被版本门禁一起跳过——App 照常启动、插件全部**静默消失**。
2. **七个 tarball、七条 `dsh.profile.bundles` 条目、七次安装**，还出现过
   "CLI 只装包不写 bundles、必须手补"的维护动作。
3. **跨包 import 在安装后走不通**（实测：把兄弟包写进 dependencies 安装会失败）。
   于是 `sessionCwd` / `requireSessionCwd` / `resolveOptions` / `writePolicy` 在
   verify/task/artifact/status 里是**四份逐字相同**的副本，靠四份"漂移检测"测试盯着；
   `sdlc-status` 还复制了一份状态机常量，再用读源码文本的契约测试盯漂移。
4. 插件页七张卡暗示这是七个可独立选择的东西，而它们其实是一套方法论。

用户的要求："这一套 sdlc 是否可以做到一个插件中，然后目前的这些插件都做成
这个插件中的组件？"并明确："不要管存在的困难，我们要始终坚持去做正确的事情。"

## Proposed outcome

**分发层合并、执行层保形**：

- 一个 npm 包 `@ai-native-sdlc/dsh-sdlc@0.2.0`、一个 bundle、一条
  `dsh.profile.bundles` 条目、一个 tarball；
- `cordis.patch.yml` 一条 `insert`、**七个组件行**，行 id 与合并前完全一致
  （`sdlc-task` / `sdlc-verify` / …），因此 profile 里的按 id 覆盖、插件页的
  行级开关、`fiberPhase` 诊断、每个组件各自的 `inject` / `Config` / fiber 全部保留；
- 包内共享代码收敛为单一真相：`src/shared/helpers.ts` 一份，status 直接 import
  task 的状态机常量；重复副本与盯副本的契约测试删除；
- 工具、Skill、提示词段、`state.yaml` / `verification.json` 契约、验证者 preset
  的隔离策略行为不变；
- 文档与工具链（bench / mutation / activation-check / time-travel / 测试场）
  跟随新布局；旧七包从 desktop profile 移除，合并包真装、真跑、真验证。

明确的**非目标**：不把七行压成一个 Cordis 插件行（那会压掉唯一真正在起作用的
隔离边界，而分发粒度并不因此变化）；不改变任何业务语义；不碰发布授权/分支保护。

## Affected users and systems

- 本仓库维护者：安装/升级从七步变一步；版本只有一个。
- 使用这套插件的 DSH profile（desktop / 隔离 profile）：`dsh.profile.bundles`
  条目与依赖从七个变一个；profile 里 `- id: sdlc-task` 之类覆盖继续有效。
- 验证者 preset：内部 `tool-filter` 行改为新包内子路径
  `@ai-native-sdlc/dsh-sdlc/verify/preset-filter`。
- 工具链：`tools/bench`（HEAD 侧路径）、`mutation-score`（组件映射与 shared 目标）、
  `plugin-activation-check`（七行解析与整树 sha256）、`time-travel-check`（递归发现）。
- 另一仓库 `sdlc-playground` 的 `tools/playground-check.mjs`：import 旧包路径，
  需要同步适配。

## Constraints

- **边界只能放在真实差异存在的地方**：分发单位的判据是"谁独立安装/升级/消费"，
  执行单位的判据是"谁独立失效/诊断/开关"。前者收敛成一个，后者保持七个。
- **`@deepseek-ai/dsh-*` 绝不能进 `dependencies`**（会装出第二份 `dsh-tools`，
  破坏模块内 Symbol 身份，导致每次工具调用都失败）；只写 peer + dev。
- **`sdlc-ui` 行必须写精确包名**：`dsh-client-modules` 只扫描精确包名的 loader 行
  来发现 `dsh.client`；写成子路径会让浏览器半静默消失（host 端点照常 200）。
- 每个组件行仍必须导出 `apply` / `inject` / `Config`；行 id 不得改。
- 行为不变由**既有测试**证明：单测 + 七组件真实运行时冒烟 + bench 三用例 +
  compat；减少的测试必须能逐条说明为什么不再有意义。
- 迁移必须先在隔离 profile 用**真实 tarball** 验证，再切换用户 profile；
  `.probe` / `.verify-home` 等本地证据目录不进 git。

## Open questions

- 合并后 mutation 基线是否需要立即全量重测？（本轮只做路径迁移；局部
  `sdlc-task` 实测 102/126、24 存活——是代码演化的真实读数。是否作为后续任务？）
- 测试场仓库 `sdlc-playground` 的检查脚本适配与推送，是否随本轮一起完成？
  （倾向一起完成，否则"跨组件组合检查"暂时没有当前形态的绿证。）
- 未来若出现真正的独立消费者或独立发布节奏，是否再拆包？（判据：证据出现再拆，
  而不是现在为假想需求保留假边界。）
