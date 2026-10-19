/**
 * 包入口模块。它本身**不是**被挂载的插件。
 *
 * 合并后的分发单位是「一个包 / 一个 bundle」，执行单位仍是七个组件行：
 * `cordis.patch.yml` 里的每一行指向本包的一个子路径导出
 * （`./task`、`./artifact`、`./verify`、`./status`、`./workflow`、`./rsi`、`./ui`）。
 * 每个组件仍拥有自己的 `inject` / `Config` / `apply` / fiber，因此故障域、
 * `fiberPhase` 诊断、行级开关与 profile 按 id 覆盖都不变。
 *
 * 保留 `exports["."]` 只是包解析的常规要求（`main`/`exports["."]` 是必需的）；
 * 没有任何 loader 行指向它。
 */
export const name = 'sdlc-bundle';
