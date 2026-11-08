import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 裸 Context 没有 profile 的包解析器。插件中的动态 import 也必须使用
// App 的依赖，不能把新 ToolRuntime 和仓库旧版 dsh-tools 混在同一次冒烟里。
export const runtimeModules = process.env.DSH_SMOKE_MODULES ?? path.join(
  process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app',
  'Contents/Resources/app.asar/dsh/node_modules',
);
const anchor = pathToFileURL(path.join(runtimeModules, 'noop.js')).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) {
      return nextResolve(specifier, { ...context, parentURL: anchor });
    }
    return nextResolve(specifier, context);
  },
});
