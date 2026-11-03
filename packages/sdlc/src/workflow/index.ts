/**
 * @ai-native-sdlc-plugin/dsh-sdlc/workflow
 *
 * AI 原生 SDLC 的**工作流本身**，作为一个 Skill 交付。
 *
 * ## 这个插件为什么存在
 *
 * 另外四个插件交付的是**工具**：任务状态机、制品结构检查、独立验证、看板。
 * 它们管住了「东西在不在」——`sdlc_task_advance` 缺制品就拒绝。
 *
 * 但它们管不住「东西有用没用」。实测的代价：作者写的验收判据
 * **看着专业、其实无法证伪**（夹具小到让断言恒真），而四处结构检查全绿。
 *
 * 根因是**没有地方写"什么叫写得好"**，所以也没人拿它质问作者。
 *
 * 这里补上那块：一份**给验证者的判据清单**。
 *
 * ## 为什么走 Skill，以及为什么它算机制
 *
 * 本项目实测过：**建议性控制没有约束力**（只有 guard/deny 有）。
 * 所以"写一份给作者看的规范"是没有意义的。
 *
 * 但"什么叫写得好"确实**没法机械化**——能被机械化的，`sdlc-artifact`
 * 已经在查了（章节在不在）。于是它必须落在一个**会执行它的角色**身上：验证者。
 *
 * 这份 Skill 因此是**写给验证者的**，由验证者拿去质问作者。
 * 作者（也就是写代码的那个 agent）忽略不了，因为质问发生在验证环节。
 *
 * ## 它没有工具、不写文件
 *
 * 本插件只注册一份 Skill，不注册任何工具，也不碰文件系统。
 * 如果你在找"怎么用"，用另外四个插件的工具；这份 Skill 是它们的**质量标准**。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

import { skillRegistration } from './skill.js';

// 只需 skills —— 访问别的服务会在加载时抛 `cannot get property "X" without inject`。
// `dsh-skill` 通过 declaration merging 给 `Context` 加上 `skills`，
// 所以下面那行 `import type` 看着没用但**必须在**：不 import 它的类型，
// tsc 会报 Property 'skills' does not exist（本仓库踩过同类的坑，见 helpers.ts）。
import type {} from '@deepseek-ai/dsh-skill';

export const name = 'sdlc-workflow';

export const inject = ['skills'];

/**
 * 没有配置项——**刻意**。
 *
 * 本仓库明确记过：`Config` 必须是 Standard Schema 校验器（schemastery 或 zod），
 * 给一个裸对象会在运行时报 `reading 'validate'`。所以这里仍然用 `z.object({})`，
 * 与另外四个插件同一套写法。
 *
 * 为什么是空的：这份清单**不该可配**。它一改就会改变所有会话的验证行为，
 * 那不是配置能承担的东西——要改就改代码、走提交与评审。
 */
export const Config = z.object({});

export function apply(ctx: Context): void {
  // 名字/描述/正文都是模块级常量，所以这里没有运行时可失败的分支——
  // 一个"永远为假"的检查只会骗人（tsc 也会指出它没有重叠）。
  // 真正该被钉住的是**内容的形状**，那由 skill.test.ts 直接断言。
  //
  // ⚠️ `register()` 返回一个 **disposer**，必须交给 `ctx.effect()` 托管。
  // 我第一版把返回值丢掉了——于是插件卸载时**这份 Skill 不会被归还**，
  // 留下一个指向已卸载插件的悬空注册。冒烟的"归还"断言抓到了它
  // （`dispose 归还次数应为 1，实际 0`）。
  //
  // `ctx.effect()` 是 Cordis 管理副作用的入口：回调在 fiber 卸载时被调用。
  ctx.effect(() => ctx.skills.register(skillRegistration()));
}
