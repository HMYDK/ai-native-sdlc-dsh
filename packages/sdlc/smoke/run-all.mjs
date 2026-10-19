#!/usr/bin/env node
/**
 * 依次跑七个组件的运行时冒烟测试。
 *
 * 合并前每个包各有一个 `smoke.mjs`、各自一条 npm script；合并后它们都在
 * `smoke/<component>.mjs`，由这个入口统一驱动。**这不改变冒烟测试本身**：
 * 每个文件仍然用真实 Cordis 上下文 + 真实 ToolRuntime 挂载组件并真的 dispatch
 * 工具调用，只是入口从七个变成一条命令。
 *
 * 前置条件：必须在 App 自带的 Electron-as-Node 下运行（`npm run smoke` 已保证）。
 * 子进程用同一个可执行文件 + `--expose-internals`，并继承
 * `ELECTRON_RUN_AS_NODE=1`，所以子进程与父进程用的是同一份运行时。
 *
 * 退出码 0 = 七个全过；1 = 有点名失败的组件。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const scripts = readdirSync(HERE)
  .filter((name) => name.endsWith('.mjs') && name !== 'run-all.mjs')
  .sort();

if (scripts.length === 0) {
  console.error('smoke/ 下没有冒烟脚本');
  process.exit(1);
}

const failed = [];
for (const script of scripts) {
  console.log(`\n${'='.repeat(72)}\n== smoke/${script}\n${'='.repeat(72)}`);
  const result = spawnSync(process.execPath, ['--expose-internals', path.join(HERE, script)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (result.status !== 0) failed.push(script);
}

console.log(`\n${'='.repeat(72)}`);
if (failed.length > 0) {
  console.log(`❌ 冒烟失败的组件（${failed.length}/${scripts.length}）：${failed.join(', ')}`);
  process.exit(1);
}
console.log(`✅ 七个组件冒烟全部通过（${scripts.length} 个脚本）`);
