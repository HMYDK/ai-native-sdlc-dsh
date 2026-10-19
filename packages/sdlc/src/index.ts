/**
 * 包入口模块 —— 也就是 **sdlc-ui 组件的 host 半**。
 *
 * ## 为什么 UI 组件必须挂在包根，而不是 `./ui` 子路径
 *
 * `@deepseek-ai/dsh-client-modules` 只扫描**精确包名**的 loader 行
 * （`exactPackageSpecifier`：`@scope/name` 恰好两段；子路径返回 undefined），
 * 用它定位该包的 `dsh.client` 声明并把客户端 bundle 编进 `window.__DSH_BOOT__`。
 * 合并前 sdlc-ui 是独立包、行名就是包名，所以没问题；合并后如果 `sdlc-ui` 行
 * 仍指向 `./ui` 子路径，浏览器半会**静默消失**（host 半的端点照常工作，
 * 只有面板不出现）——本轮实测抓到过一次（boot payload 里没有该 entry）。
 *
 * 所以七行里 `sdlc-ui` 这一行的 name 是包名本身，模块就是这里：重新导出
 * `ui/index.ts` 的插件定义。其余六个组件仍用子路径导出，不受影响。
 *
 * 这也符合 DSH 文档里 `dsh.client` 包的常规形态：package 的 host 半边必须
 * 出现在 Loader 里，客户端半才能被发现。
 */
export * from './ui/index.js';
