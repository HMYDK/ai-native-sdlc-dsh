#!/usr/bin/env node
/**
 * 兼容性门禁：每个插件的 peer 范围必须接受**这台机器上真实运行的 DSH 版本**。
 *
 * ## 为什么需要它
 *
 * 2026-10-17 App 从 `0.2.0-rc.2` 自动升到 `0.2.1-rc.2`，而七个插件的
 * peerDependencies 都钉着精确的 `0.2.0-rc.2`。DSH 0.2.1 的插件管理器会把
 * 这种插件判为 incompatible，安装时拒绝、启动时跳过 bundle——症状是
 * **插件全部静默消失**，App 照常启动，只有日志里一行 warning。
 *
 * 这种错误不能靠“记得同步版本”来防：App 是自动更新的，仓库不会。
 * 所以把判据写成检查：读 App 里真实的 `dsh/package.json`，用与 DSH 相同的
 * semver 规则（`includePrerelease: true`）逐条验证 peer 范围。
 *
 * 运行：`npm run compat`（脚本会自己用 App 的 Electron-as-Node 重入，
 * 因为普通 Node 读不了 `app.asar` 里的文件）。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app';
const APP_BIN = path.join(APP, 'Contents/MacOS/DeepSeek Harness');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 普通 Node 进不了 app.asar；用 App 自己的 Electron-as-Node 重入一次。
if (process.env.DSH_COMPAT_CHILD !== '1') {
  try {
    execFileSync(APP_BIN, [fileURLToPath(import.meta.url)], {
      stdio: 'inherit',
      env: { ...process.env, DSH_COMPAT_CHILD: '1', ELECTRON_RUN_AS_NODE: '1' },
    });
    process.exit(0);
  } catch (error) {
    process.exit(typeof error.status === 'number' ? error.status : 1);
  }
}

const semver = (await import(path.join(ROOT, 'node_modules/semver/index.js'))).default;
const runtime = JSON.parse(
  readFileSync(path.join(APP, 'Contents/Resources/app.asar/dsh/package.json'), 'utf8'),
).version;

const packages = [ROOT];
for (const name of readdirSync(path.join(ROOT, 'packages'))) {
  const dir = path.join(ROOT, 'packages', name, 'package.json');
  if (existsSync(dir)) packages.push(path.join(ROOT, 'packages', name));
}

const failures = [];
const rows = [];
for (const dir of packages) {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const requirements = {
    ...(manifest.engines?.dsh === undefined ? {} : { 'engines.dsh': manifest.engines.dsh }),
    ...Object.fromEntries(
      Object.entries(manifest.peerDependencies ?? {}).filter(
        ([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'),
      ),
    ),
  };
  for (const [name, range] of Object.entries(requirements)) {
    if (!semver.satisfies(runtime, range, { includePrerelease: true })) {
      failures.push({ package: manifest.name, requirement: name, range });
    }
  }
  rows.push({
    name: manifest.name,
    version: manifest.version,
    requirements: Object.keys(requirements).length,
  });
}

console.log(`DSH runtime (from ${APP}): ${runtime}`);
for (const row of rows) {
  console.log(`  ${row.name}@${row.version}  peers=${row.requirements}`);
}

if (failures.length > 0) {
  console.error('\n✗ 以下 peer 范围不接受当前 DSH 运行时：');
  for (const failure of failures) {
    console.error(`  - ${failure.package}: ${failure.requirement}@${failure.range}`);
  }
  console.error(
    '\n修法：把范围改成能同时覆盖当前运行时的范围（本项目用 ^0.2.1-rc.2），' +
      '不要钉死精确的旧版本——App 会自动升级，仓库不会。',
  );
  process.exit(1);
}

console.log(`\n✓ 全部 ${rows.length} 个包与 DSH ${runtime} 兼容`);
