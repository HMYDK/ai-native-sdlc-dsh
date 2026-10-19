/**
 * 验证者自己的 Agent Preset。
 *
 * ## 为什么 0.2.1 之后必须有这个文件
 *
 * DSH 0.2.0 的 `SubagentStartRequest` 上还有 `persona` 和 `toolFilter` 两个字段，
 * 我们靠它们把验证者变成「另一个角色 + 只读工具面」。0.2.1-rc.2 把这两个字段
 * **从公开契约里删掉了**，并在官方 `tool-subagent` 里明确报错：
 *
 *   `tool-subagent: persona is no longer supported; configure persona and tool
 *    plugins in an Agent Preset and select it with agentPreset (spawn only)`
 *
 * 所以迁移不是「换个参数名」，而是把「验证者是谁、能碰什么」从一次调用的
 * 附加参数，变成一份**独立的 preset 组合**。这反而更硬：旧 `toolFilter` 只能
 * 从继承面摘工具，scope 自注册的 `subagent` / `structured_output` 摘不掉；
 * preset 是从零组合，没写进去的工具根本不存在。
 *
 * ## 这份 preset 刻意只有只读能力
 *
 * - `tool-fs` 的 `write` / `edit` 显式关掉；
 * - 不放 `tool-subagent` / `tool-workflow`：验证者不能再派代理，也就不存在
 *   「孙代理拿到 write」的逃逸面；
 * - 不放 `tool-web` / `tool-ask-user`：验证要落在可复核的本地证据上；
 * - 保留 `bash`（或 `pwsh`）以便复核测试证据。bash 技术上能写文件——这是
 *   诚实的边界，persona 里如实说明，靠职责而不是虚假的能力声明约束。
 * - 保留 `skill`：`sdlc-workflow` 交付的验证纪律是一份 Skill，没有这个工具
 *   验证者就读不到它（这个坑实测踩过）。
 *
 * ## 为什么用代码而不是 YAML 声明
 *
 * preset 的 `plugins` 里有平台分支（win32 用 pwsh，其余用 bash）。写成代码
 * 可以直接用 `process.platform` 构造，且能和单元测试共享同一份定义；写在
 * `cordis.patch.yml` 里则需要 `!!js` 表达式，测试只能对字符串做断言。
 */

import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';

/** 验证者 preset 的稳定 id；`sdlc_verify` 用它选择子代理组合。 */
export const VERIFIER_PRESET_ID = 'sdlc-verifier';

/**
 * preset 里的角色行。
 *
 * 刻意**只写身份**，不复制 `VERIFIER_PERSONA` 的全文：详细纪律随每次验证的
 * 任务提示词下发（`buildVerificationPrompt`），这样只有一处事实来源。
 */
const VERIFIER_PRESET_PERSONA =
  'You are the SDLC verifier: an independent reviewer who did not write the change ' +
  'under review and does not trust claims about it. Your job is to try to refute the ' +
  'change using evidence a human can re-check.';

/**
 * 本平台实际存在的 shell 工具。
 *
 * 官方 bundle 在 win32 禁用 `tool-bash`、在其它平台禁用 `tool-pwsh`。
 * preset 里只能放本平台那一个——放两个会让另一条分支在加载时失败。
 */
const shellPlugin =
  process.platform === 'win32'
    ? { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh' }
    : { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' };

/**
 * 验证者的完整组合。
 *
 * 顺序是加载顺序：persona / 指令 / 时间上下文先就位，工具随后注册。
 * `read_image` 保留（只读）；`write` / `edit` 关掉。
 */
export const VERIFIER_PRESET: PresetDefinition = {
  id: VERIFIER_PRESET_ID,
  name: 'SDLC Verifier',
  description:
    'Independent verifier for the AI-native SDLC: read-only filesystem access, a shell for ' +
    're-checking test evidence, and the verification-discipline skill. No write/edit, no delegation.',
  order: 900,
  plugins: [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: { prefix: VERIFIER_PRESET_PERSONA },
    },
    {
      id: 'agent-instructions',
      name: '@deepseek-ai/dsh-agent-instructions',
      config: { maxBytes: 65536 },
    },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    shellPlugin,
    {
      id: 'tool-fs',
      name: '@deepseek-ai/dsh-tool-fs',
      config: { read: true, readImage: true, write: false, edit: false },
    },
    {
      id: 'tool-fs-search',
      name: '@deepseek-ai/dsh-tool-fs-search',
      config: { sampleOverCapGlobResults: false },
    },
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    // 宿主的工具是全局注册的，preset 不会自动隔离它们。这一行在验证者
    // scope 里做最后的 allow 过滤，把 sdlc_* / working_directory 等宿主工具
    // 从工具面摘掉。没有它，验证者能解冻测试、推进任务状态。
    { id: 'tool-filter', name: '@ai-native-sdlc/dsh-sdlc/verify/preset-filter' },
  ],
};

/** 本平台应有的 shell 行 id，供测试断言使用。 */
export const VERIFIER_SHELL_ID = shellPlugin.id;
