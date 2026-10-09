/**
 * @ai-native-sdlc/dsh-sdlc-ui —— **客户端半**（手写，不经任何构建）。
 *
 * ## 为什么是手写的
 *
 * 客户端 bundle 的格式是 `window.__ModuleLoader__.load({...})` 的 CJS 包装，
 * 由宿主在浏览器里求值。官方用它自己的 tsdown preset 生成这个包装，
 * 但那只是把普通 CJS 套一层——**用 `require("react/jsx-runtime")` 直接写
 * `jsx(...)` 调用就够了**（`Builtin` 的说明原文：
 * "React runtime exposed **without JSX transformation**"）。
 *
 * 范例取自 `@deepseek-ai/dsh-client-ui-brand-official` 的 `lib/client.js`
 * ——一个仅 1863 字节的官方最小客户端插件。
 *
 * ## 这一版是**探针**
 *
 * 它只回答一个问题：**`dsh web` 会不会加载 `exports["./client"]`。**
 *
 * 所以它刻意做得极小、且渲染结果**肉眼可辨**：往侧栏面板列表挂一个
 * 带文字的项。如果它出现了，说明整条链路（发现 → 求值 → slots 注入 → 渲染）
 * 是通的；不出现，说明我早先"做不出来"的结论虽然理由写错了，结论却对。
 *
 * ⚠️ **不要**在这里加 `host.call(...)` 之前就假装它能拿到数据——
 * 本仓库的纪律是"加载 ≠ 可用"，而"能渲染一个静态标识"不等于"能画任务链"。
 */
window.__ModuleLoader__.load({
  id: '@ai-native-sdlc/dsh-sdlc-ui',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    let jsxRuntime = require('react/jsx-runtime');

    /**
     * 探针面板项。
     *
     * 用 `jsx` 而不是 JSX 语法——没有变换步骤，`jsx(type, props, key)` 就是
     * 普通函数调用。渲染一行文字，好让"它在不在"这个问题一眼可答。
     */
    function SdlcPanelButton() {
      return jsxRuntime.jsx(
        'div',
        {
          // 刻意内联样式：这一版不引入主题 token，先把"能不能出现"问清楚。
          // 确认可行之后再改用 ctx.theme 的 token（那是第二步）。
          style: {
            padding: '4px 8px',
            fontSize: '12px',
            color: '#e879f9',
            border: '1px solid #e879f9',
            borderRadius: '4px',
            whiteSpace: 'nowrap',
          },
          title: 'AI 原生 SDLC：探针项。若你能看到这行字，说明客户端半被加载并渲染了。',
        },
        'SDLC-ui ✓',
      );
    }

    /** 需要的服务：slot 注册表。 */
    const inject = ['slots'];

    /**
     * 把探针项注入侧栏面板列表。
     *
     * `ctx.slots.inject(key, callback)` —— callback 返回一个**生成器**，
     * 逐个 `yield` 注册；那种写法是官方范例的形式，它让"一次注入、
     * 多项注册"的声明式生命周期可被正确回收。
     */
    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', function* () {
        yield ctx.slots.register({ name: 'sidebar.panellist' }, SdlcPanelButton);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
