# 基准：怎么验证「优化之后到底好了没有」

这套 SDLC 是照着真实任务逐步优化出来的。缺的一环从来不是"更多测试"，而是
**同一条判据在新旧两版代码上给出不同答案**。缺了它，为修复写的断言会向修复方案
归一化，变成恒真。

本项目实测发生过一次：STATUS-PAGE 第三轮，验证者发现作者新加的冒烟夹具只有
10 个任务，而 ≤50 时两种实现返回完全一样——**那条断言在被修好的代码和被 reject
的代码上都是绿的**。

    $ node tools/bench/run.mjs

    ✅ 成立  STATUS-PAGE-1    基线违反 4 条 / 修复版违反 0 条
    ✅ 成立  FALSE-ALARM-1    基线违反 2 条 / 修复版违反 0 条
    ✅ 成立  PWSH-1           基线违反 4 条 / 修复版违反 0 条

退出码 0 = **每个**用例都成立（基线被证伪、修复版满足判据）。

## 用例

| 用例 | 基线 → 修复 | 在测什么 | 判据来源 |
|---|---|---|---|
| `STATUS-PAGE-1` | `80d8edc` → `HEAD` | 看板默认页丢了"该动手的"任务 | intent「不改变默认行为」+ spec R1「向后兼容（逐字）」 |
| `FALSE-ALARM-1` | `d946c9d` → `6ae7e09` | 已 `approve` 的 REVIEWING 被报成"在等人" | 看板的存在理由：一次调用答出"哪些卡住了" |
| `RSI-SCOPE-1` | `7955ddd` → 当前构建 | 验证者处于另一个 preset，记录为空却未报错 | RSI-2 R1/R3，DEMO-22149 六次真实运行 |
| `PWSH-1` | `ccb880e` → `6bed6ea` | 工具白名单没按平台选，两个平台都报错 | `tools.restrict()` 对不存在的工具名抛错 |

## 每个用例都必须是**两侧对照**

    基线版（有缺陷）  应当违反判据      ← 没有这一侧，用例是恒真断言
    当前/修复版       应当满足判据

`lib.mjs` 里的 `runCase` 强制这个形状，并把"基线一条都没违反"判为
**用例无效**（而不是"通过"）。

## 写新用例时必须守的四条

前三条都是我写的时候真踩过的，不是规范抄的：

1. **夹具要让判据可证伪。** 夹具里必须同时有"该被看见的"和"不该被看见的"，
   规模要越过边界（STATUS-PAGE 是默认页上限 50）。踩过的坑：
   - 夹具 ≤50 时两种实现返回一样 → 断言恒真（历史真实发生）
   - 写 `"同一 offset 跨时间给同一批"` 时，让**所有**任务同时跨过阈值，
     排序键相同、呈现序根本没变 → 又变成恒真。必须让**一部分**跨过去。
   - 写 `"默认路径 == 传入顺序取前 50"` 时，断言的是基线自己的顺序 → 必然通过。
     改成断言"改动前实现会取的那一批"才有牙齿。

2. **`state.yaml` 必须写成真的 YAML 文本**，不能靠 `JSON.stringify` 拼。实测：
   用对象字段拼出来的内容 `status` 解析不出来，于是所有任务都被当成"健康"，
   紧迫任务不再排在前面——**夹具缺陷会让判据静默失效**。

3. **同时报守恒组。** 只报"该变的变了"是不够的：修复不能把"该拦的"一起放掉。
   `FALSE-ALARM-1` 的守恒组（reject / needs_human / 无裁决 / DONE / IMPLEMENTING）
   就是这条。

4. **模块形态要在编译前定。** tsc 按最近的 `package.json` 的 `type` 决定产出
   CJS 还是 ESM；编译完再改 `type` 没用（产物里已经是 `exports.x = …`，
   在 ESM 作用域下报 `ReferenceError: exports is not defined`）。
   `runCase` 的 `moduleType` 参数就是给这个用的。

## ⚠️ 读结果时的陷阱：出现的失败，可能是**那个时代**的

用例钉在**历史提交**上，所以冻结代码的失败报告会包含**当时真实的缺陷**。

实测踩到：独立验证者跑冻结的 `80d8edc`，报
`冒烟 59/60 · 停滞计数应为 1，实际 4`，我把它当成当前待办——
其实那条早在 `dac82db` 就修了，当前代码是 69/69。

**先问一句"这是历史快照的问题，还是当前的？"，再动手。**

## 已知边界

- **用例数量还少（3 条）**。历史上可收集的**任务制品只有 3 个**
  （E2E-1 / STATUS-PAGE / WF-1，在 `4eda7a0` 被删、可从 git 历史取回），
  撑不起基准。所以用例的真实来源是**修过的 bug**——每个 bug 天然自带
  「坏的那版在父提交里、好的那版在修复提交里」这一对，git 历史里全在。
- **`E2E-1` 的制品现在不可用**：它被重新界定过（从"实现理赔功能"改成
  "制品链演示"），所以那批制品描述的是一个**没有对应代码**的虚构系统。
  想做"制品内部自洽"类的用例，得另找素材。
- **需要真实 Cordis 装配的接线层用例**：`PWSH-1` 证明了做得成
  ——桩服务 + 真实 `apply()` + 真实 `ToolRuntime`，**不需要 Electron**。
  同类问题（插件激活、inject、提示词段）都可以照这个手法加用例。
- 基准证明的是**这两版之间的差异**，不证明"判据覆盖了所有情况"。
  判据的来源是当时的制品，制品本身可能不完整。

## 2026-10-19：七个插件合并成一个包之后的适配

仓库把七个插件合并成一个包 `packages/sdlc`（`83d86b0`）。对基准的影响是
**两侧的源码布局可能不同**，而"基线用旧路径、修复版用新路径"正是这段历史
本身的一部分：

| 用例 | 基线侧（历史提交，旧路径保留） | 修复侧 |
|---|---|---|
| `STATUS-PAGE-1` | `80d8edc` → `packages/sdlc-status/src/scan.ts` | `HEAD` → `packages/sdlc/src/status`（合并布局） |
| `FALSE-ALARM-1` | `d946c9d` → 旧路径 | `6ae7e09` → 旧路径 |
| `PWSH-1` | `ccb880e` → 旧路径 | `6bed6ea` → 旧路径 |

所以 `lib.mjs` 不再假设一种布局，而是按 revision 判形：

- `mergedAt(rev)`：该 revision 有没有 `packages/sdlc/src`；
- `compileMerged(rev, work)`：用 `git archive` 取**整个** `packages/sdlc`，
  在临时目录里用包自己的 `package.json`（`type: module`）与 `tsconfig.json`
  编译，再 `import()` 加载。必须整包取——合并后组件之间有真实相对 import
  （`status/scan.ts` → `../task/state.js`），只取单文件编译不过；
- 旧布局仍走原来的 `git show` 单文件 + `require`。两种形态在同一个 work
  目录里共存（嵌套 `package.json` 的 `type` 优先）。

### PWSH-1 的 tsc 失败是**类型漂移**，不是用例失败（实测诊断）

合并后第一次跑 `node tools/bench/run.mjs` 时 PWSH-1 报 tsc 失败。原始输出：

    $ tsc -p …/ccb880e-module/tsconfig.json
    src/index.ts(297,11): error TS2353: Object literal may only specify known
      properties, and 'toolFilter' does not exist in type 'SubagentStartRequest'.
    src/index.ts(313,58): error TS2339: Property 'start' does not exist on
      type 'SubagentRuntime'.

原因不在合并：2026-10-19 App 升到 DSH 0.2.1 后，`ctx.subagents.start()` 与
`SubagentStartRequest.toolFilter` 已从运行时类型里删除（见 AGENTS.md
「0.2.1 兼容性」）。这两个 revision 是针对 0.2.0 API 写的，拿今天的
`node_modules` 类型去检查**必然**失败；而本用例比较的是**运行时行为**
（验证者工具白名单按平台选），与类型漂移无关。

处置：`compileFiles` 支持 `{ noCheck: true }`（只转译、不类型检查），
PWSH-1 的两个历史版本都用它。**不是**改历史源码去迁就新类型——那会伪造历史。

### 实测（2026-10-19，HEAD `7f2be0a`，Node v26.8.2）

    $ node tools/bench/run.mjs
    ### STATUS-PAGE-1 … ✅ 有效：基线违反 4 条，修复版 0 条。
    ### FALSE-ALARM-1 … ✅ 有效：基线违反 2 条，修复版 0 条。
    ### PWSH-1 …        ✅ 有效：基线违反 4 条，修复版 0 条。

    汇总：
      ✅ 成立  STATUS-PAGE-1       基线违反 4 条 / 修复版违反 0 条
      ✅ 成立  FALSE-ALARM-1       基线违反 2 条 / 修复版违反 0 条
      ✅ 成立  PWSH-1              基线违反 4 条 / 修复版违反 0 条

三个用例的"基线违反数"与合并前的历史读数一致（4 / 2 / 4），说明判据没有
因为换布局而变松或变紧。整轮约 4 秒。

⚠️ 复跑前提：仓库根 `node_modules` 里有 TypeScript 与 DSH 运行时（临时编译区
通过符号链接用它），**不需要** App、不需要 profile。

RSI-SCOPE-1 使用当前 `packages/sdlc/lib`，运行前先 build；它通过真实 Cordis 作用域和工具调度比较两版，模型返回使用确定性夹具。它不衡量真实模型的普遍效果。
