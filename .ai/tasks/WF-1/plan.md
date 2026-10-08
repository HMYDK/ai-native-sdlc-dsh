# Plan: 验证纪律的交付与可达性

## Files that change

- `packages/sdlc-workflow/`（新增包：`src/index.ts`、`src/skill.ts`、
  `src/skill.test.ts`、`smoke.mjs`、`package.json`、`cordis.patch.yml`）
- `packages/sdlc-verify/src/index.ts`（`BASE_VERIFIER_TOOLS` 加 `skill` + 说明注释）
- `packages/sdlc-verify/smoke.mjs`（补一条单独断言）
- 根 `package.json`（`@deepseek-ai/dsh-skill` 进 devDependencies，供类型解析）
- `AGENTS.md`（登记新插件 + Skill 注册接口的实测细节）

## Order of work

1. 新建 `sdlc-workflow` 包（骨架照 `sdlc-status`）
2. 写 Skill 正文（七条实测判据）与注册逻辑
3. 单测（内容齐备）+ 冒烟（真实 Cordis 挂载 + 桩接住注册 + 归还）
4. `sdlc-verify` 工具面加 `skill`，补可证伪的断言
5. 打包、装入 profile、单例检查、核对装入产物与仓库一致
6. **跑一次真实 `sdlc_verify`**，然后**查验证者会话日志**
   看它有没有调用 `skill`（这是唯一能证明 R2 的观测点）

## Risks

- 🔴 **R2 只能靠"外部观测"证明，不是靠测试。** 验证者自己无法证明
  "我能加载它"。缓解：验证完成后我去读它的会话日志找 `skill` 工具调用。
  **如果日志里没有，那 R2 仍未成立**，不管 `toolFilter` 里写着什么。

- 🟡 **`Config` 必须是 Standard Schema 校验器**（本项目踩过裸对象报
  `reading 'validate'`）。本包用 `z.object({})`，与另外四个一致。

- 🟡 **单个 `@deepseek-ai/*` 进 `dependencies` 会摧毁整个工具调度**
  （模块内 Symbol 身份被破坏）。本包只用 peer + dev，装完必须跑单例检查。

- 🟡 **冒烟里 `ctx.dispose()` 不存在**（我第一版写错）。卸载入口是
  `ctx.fiber.dispose()`。

## Proof

| 要求 | 证据 |
|---|---|
| R1 存在可加载的 Skill | 单测 7/7（七节关键词、无占位符、反引号配对、措辞指向验证者）；冒烟 12/12（真实 Cordis 挂载 + 桩接住注册 + 内容逐字一致 + 归还次数 1）；本会话用 `skill` 工具加载成功 |
| **R2 验证者能加载它** | ⚠️ **两层**：① `toolFilter.allow` 含 `skill`（冒烟断言，且实测可证伪——拿掉即 FAIL）；② **验证者会话日志里出现 `skill` 工具调用**。②才是决定性证据 |
| R3 不引入写能力 | 冒烟已有断言 `toolFilter 不含写能力工具（write/edit）` 继续通过 |
| R4 装入产物一致 | 装入后逐字比对 `lib/index.js` 与仓库；单例检查 `@deepseek-ai` 包数 = 0 |

## 这次的测量意图

这次任务同时是一次**元测量**：那份 Skill 的七条判据正是用来质问我的。
所以验证完成后我要回答一个问题：

> **验证者拿到那份纪律之后，它对我的质问变了没有？**

具体看：它有没有做"作者没做的事"（编译旧版本对比、自造夹具、变异测试），
以及它在 `unverified` 里有没有如实交代做不到的事。
**这是"用 Skill 让方法盲区可被质问"这个设计第一次被真实检验。**
