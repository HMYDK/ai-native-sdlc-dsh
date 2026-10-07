# AI 原生 SDLC 落地仓库

把 Anthropic《[AI 原生 SDLC 实战手册](https://claude.com/resources/articles/the-ai-native-sdlc-playbook)》
的方法论落地到 **DeepSeek Harness (DSH)**。手册中文全译在 [handbook/](handbook/)。

## 一句话

**每个阶段的产出是一份提交入库的制品，下一阶段读它。**
`intent.md` → `spec.md` → `plan.md` → diff + 测试 → 带评审发现的 PR → 事故记录。
提交历史同时就是审计追踪。

## 当前进度

| | 状态 |
|---|---|
| 仓库骨架、制品目录约定 | ✅ |
| 两道门禁脚本（发布 / 制品） | ✅ 逻辑已自测 24/24 |
| 三个 Skill | ✅ |
| 插件挂载 | ⬜ **未完成——门禁当前静默失效** → [PLUGIN-SETUP.md](PLUGIN-SETUP.md) |
| 门禁 deny/ask 端到端实测 | ❌ **实测未通过** → [incident](artifacts/incidents/2026-10-07-gate-not-wired.md) |
| 阶段 06 无人闭环 | ⬜ 需先决定 Host 常驻还是外部 cron |

> ⚠️ **重要：钩子尚未接线，门禁当前不生效。**
> 2026-10-07 的端到端实验证明，`git push origin main` 在真实 Git 操作中**未被阻断**。
> 根因是桥接插件 `dsh-hooks-claude-code` 未安装，因此没有任何东西读取 `hooks.json`。
> **`.claude/hooks/` 现在是惰性代码。** 详见
> [artifacts/incidents/2026-10-07-gate-not-wired.md](artifacts/incidents/2026-10-07-gate-not-wired.md)。

## 目录

| 路径 | 作用 |
|---|---|
| [handbook/](handbook/) | 手册原文，只读参考 |
| [AGENTS.md](AGENTS.md) | 项目记忆，每次会话自动读取 |
| [.dsh/skills/](.dsh/skills/) | 组织沉淀知识（DSH 项目级根，开箱即用） |
| [.claude/hooks/](.claude/hooks/) | 门禁脚本（shell 子进程） |
| [artifacts/](artifacts/) | 制品链 |
| [PLUGIN-SETUP.md](PLUGIN-SETUP.md) | 插件挂载操作说明（人工步骤） |
| [work/dsh-inspect/docs/](work/dsh-inspect/docs/) | DSH 能力调研结论（带行号引用，是决策依据） |

## 现在可以做什么

**门禁脚本的逻辑已经可以自测**，不需要装任何插件：

```sh
bash .claude/hooks/verify-gates.sh
```

它会验证 24 条「什么被阻断、什么被放行、什么被误伤」。
这是**脚本逻辑**的验证，不是**桥接挂载**的验证——后者见 PLUGIN-SETUP.md 第 4 步。

## 两道门禁

**发布门禁** [production-gate.sh](.claude/hooks/production-gate.sh)——拦主干推送、生产命名空间、
生产发布动作、生产数据破坏性操作。被拦时不要改写命令绕过，走
[deployment-gate](.dsh/skills/deployment-gate/SKILL.md) 里写的授权流程。

**制品门禁** [artifact-guard.sh](.claude/hooks/artifact-guard.sh)——强制制品命名，
并要求 `spec/`/`plan/` 必须与某个 intent 配对（先写 intent，再写规格）。

## 必须知道的边界（本机实测，不是从手册推断的）

这套东西提高的是「**违规变得罕见**」，不是「**违规不可能**」。

| 缺口 | 事实 |
|---|---|
| 无不可覆盖的管理层 | 配置层全在用户可写目录。能改 `~/.dsh/` 的人可以关掉任何控制 |
| 无网络出口管控 | DSH 沙箱「文件效果是全部策略词汇」。**无法限制网络** |
| 无受保护路径 | 沙箱按目录范围放行，不识别 `.git/`、CI 配置、密钥 |
| 不能改写入参 | 钩子只能拒绝，不能「消毒后放行」 |
| 钩子只覆盖 7/30 事件 | 无策略层、无热重载 |
| 无审批人归属 | `approval/decided` 只记结果，不记谁批的 |
| 规范日志不脱敏 | 逐字落盘，且默认 zstd 压缩不可直读 |

→ **合规边界必须落在 host 层**（文件属主 / MDM / 独立运行身份），DSH 只能做执行面。
完整分析见 [work/dsh-inspect/docs/](work/dsh-inspect/docs/)。

## 相关文件

- [AGENTS.md](AGENTS.md) — 项目记忆与关键约束，改仓库前先读
- [PLUGIN-SETUP.md](PLUGIN-SETUP.md) — 插件挂载（含已知不支持项）
- [.dsh/skills/ai-native-sdlc/SKILL.md](.dsh/skills/ai-native-sdlc/SKILL.md) — 制品链方法论
- [.dsh/skills/artifact-authoring/SKILL.md](.dsh/skills/artifact-authoring/SKILL.md) — 制品写作质量判据
