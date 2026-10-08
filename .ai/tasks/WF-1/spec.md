# Spec: 验证纪律的交付与可达性

## Requirements

### R1 存在一份可加载的验证纪律

`packages/sdlc-workflow` 注册一份 Skill，名字 `sdlc-verification-discipline`，
正文包含七条实测判据（每条注明出处）。注册走
`ctx.effect(() => ctx.skills.register({ name, description, content, source }))`——
`source` 必填，返回值是 disposer **必须托管**（否则卸载时留下悬空注册，实测抓到过）。

### R2 验证者能加载它

`sdlc-verify` 的验证者工具面（`toolFilter.allow`）**必须含 `skill`**。

依据：`dsh-tool-skill` 只做 `ctx.tools.register(skillTool)`，**不注册提示词段**——
Skill 目录除了这个工具**没有别的通道**到达模型。不含 `skill` = 那份清单不存在。

**这是本次的核心要求。** 前一轮它不成立（一份名字里写着"给验证者的"清单，
验证者够不着），已修但未验证。

### R3 加了 `skill` 不引入写能力

`skill` 是只读的（读 Skill 正文）。验证者**仍不得**拥有 `write` / `edit`。

### R4 落盘与重装的产物一致

装入 profile 的那份 `lib/index.js` 必须与仓库里的逐字相同。

## Design

`sdlc-workflow` 只做一件事：在 `apply()` 里注册一份 Skill。无工具、无文件写。

`sdlc-verify` 的 `BASE_VERIFIER_TOOLS` 从 `['read','grep','glob']`
改为 `['read','grep','glob','skill']`。

## Areas of concern

- ⚠️ **"验证者能加载它"这一条，验证者自己证明不了。**
  它能读代码确认 `toolFilter` 里有 `skill`，但"它自己能不能加载"是
  **外部观察**的事。真正决定性的证据是**验证者会话日志里有没有 `skill` 工具调用**——
  那是这次任务里最重要、也最容易漏掉的观测点。

- ⚠️ **原冒烟那条断言防不住这件事。** 它只查 `read`/`grep`/`glob`
  三个名字是否都在，所以 `skill` 被摘掉照样绿——**这正是缺口能溜过去的原因**。
  已补一条单独断言 `toolFilter 保留 skill`，并实测可证伪（拿掉即 FAIL）。

- ⚠️ 加载到之后**它会不会真的用**，那是模型行为，只能看证据，不能保证。
  不要把它写成"保证验证者会用"。

## 规格过程中的查证

写意图时我留了一条 open question：「怎么验证'验证者能加载它'？」

查证结果：`dsh-tool-skill` 的 `apply()` 只有 `ctx.tools.register(skillTool)`
与一个 `agent/pre-step` 钩子，**没有 `ctx.systemPrompt.section(...)`**。
所以 Skill 目录确实只通过 `skill` 工具到达模型。

这个查证决定了 R2 的写法：它不是"给验证者加个便利工具"，
而是**这条交付链的最后一环**——断了，整个 `sdlc-workflow` 就是装饰。
