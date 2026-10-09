/**
 * @ai-native-sdlc/dsh-sdlc-ui —— **host 半**。
 *
 * ## 关于这个包
 *
 * 它的**主要交付物是客户端半**（`lib/client.js`，手写，不经过 tsc）：
 * 一个把制品链、状态迁移与验证裁决画出来的面板。
 *
 * 本文件是 host 半。它现在只做一件事：让 bundle 能被加载。
 * 之后客户端半会通过 `host.call(...)` 向这里要数据。
 *
 * ⚠️ 客户端半**不经 tsc**：它的格式是 `window.__ModuleLoader__.load({...})`
 * 的 CJS 包装，由宿主在浏览器里求值，不是 ESM。
 * 所以 tsconfig 只 include 本文件（见 tsconfig.json 的 include）。
 */
import z from '@deepseek-ai/schemastery';

export const name = 'sdlc-ui';

/** host 半目前不访问任何服务。 */
export const inject: string[] = [];

export const Config = z.object({});

export function apply(): void {
  // 刻意留空。
  //
  // 这里**不放**任何占位逻辑："先塞一个空 apply 以后再填" 是本仓库踩过的
  // 那类东西——它会让人以为接线已经通了。host 半真的需要做什么时再加。
}
