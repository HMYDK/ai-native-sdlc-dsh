# 探针证据：第三方 bundle 自引用子路径行，能否被真实 DSH 运行时安装并激活？

- 任务：共享任务 `task-1`（owner: `probe`）
- 执行时间：2026-10-19 17:49–17:58（Asia/Shanghai）
- 结论时间点：本文件写于探针完成后
- 完整可复现脚本：`.probe/repro.sh`（最近一次运行 **PASS=32 FAIL=0**，exit 0）

---

## 0. TL;DR（结论）

**成立。** 在一个**第三方 npm 包**（`@probe/two-rows`，`npm pack` 出来的 tarball 安装）上，
bundle patch 里写**两行、行名各自指向该包自己的子路径导出**（`@probe/two-rows/a`、`@probe/two-rows/b`），
在 **App 自带 CLI 初始化出的隔离 profile、真实 `dsh` 启动**中：

1. 两行都出现在 `--dump-config` 的合成树里，name 逐字为子路径；
2. profile 的 `package.json` 中 `dsh.profile.bundles` **自动**追加了 `@probe/two-rows`（无需手改）；
3. 真实启动进程里，**两个插件模块都执行了 `apply()`**（各自写出 marker，且 marker 里的 `pid`
   等于该次启动进程的 pid）；
4. 启动日志**没有** `entry did not activate`；
5. profile patch 把其中一行 `disabled: true` 后，**只有另一行激活**；恢复后两行又都激活（行级开关独立、可逆）。

也顺带实测到两条对后续重构有用的环境事实（详见 §6）：

- **`dsh plugin add` 不需要 PATH 上的 pnpm**：desktop CLI 硬编码使用 App 运行时自带的 pnpm
  （v11.28.5，`process.execPath` + `ELECTRON_RUN_AS_NODE=1` 调 `pnpm.mjs`）。本次探针全程没有安装 pnpm。
- **`--from-default-profile <name>` 是整目录替换**：会清掉 profile 的 `dependencies` 与
  `dsh.profile.bundles`，回到模板值。若要先 add 再重建，安装会丢；正确顺序是**先重建、再 add**。

---

## 1. 环境（实测）

| 项 | 值 | 来源 |
|---|---|---|
| 工作目录 | `<WORKSPACE>/AI Native SDLC` | `pwd` |
| App 可执行 | `/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness` | 实际调用 |
| CLI | `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js` | 实际调用 |
| CLI 版本 | `0.2.1-rc.2` | `CLI --version` |
| 运行时 | node `24.21.0`，electron `44.7.0`，darwin/arm64 | `ELECTRON_RUN_AS_NODE=1 $APP -p ...` |
| pnpm（PATH 上） | **不存在**（`command -v pnpm` → exit 1） | 实测 |
| pnpm（CLI 实际使用） | `11.28.5`（App 自带） | `dsh plugin add` 输出 + App 内 `runtime/versions.json` |
| 隔离 DSH_HOME | `<repo>/.probe/dsh-home`（复现脚本用 `<repo>/.probe/repro-home`） | 每个 CLI 调用都显式 `DSH_HOME=` |
| 用户 `~/.dsh` / desktop profile | **未触碰** | 所有调用带 `DSH_HOME`；未执行任何面向 desktop 的命令 |

固定调用方式（下文所有 `dsh ...` 均指这一行，未用 PATH 上的 `dsh`）：

```sh
APP="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
CLI="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"
cd "<WORKSPACE>/AI Native SDLC"
export DSH_HOME="$PWD/.probe/dsh-home"
dsh() { ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals "$CLI" "$@"; }
```

关于 pnpm 为什么不需要 PATH（从 App 内 `dsh-desktop-host/lib/cli.js` 读到的实现，非推断）：

```js
async function runDesktopCli(runtimeDir, supportDir) {
  installOfficeEngineResolution(runtimeDir);
  await runCli({
    manageDesktopProfile: true,
    packageManager: {
      command: process.execPath,
      args: ["--expose-internals",
             join(supportDir, "primary-runtime", "dependencies", "pnpm", "bin", "pnpm.mjs")],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
        PATH: `${join(supportDir, "bin")}${delimiter}${process.env.PATH ?? ""}`
      }
    }
  });
}
```

（读取方式：`ELECTRON_RUN_AS_NODE=1 "$APP" -e '...readFileSync(app.asar/...)'`，因为 `app.asar` 是文件，
shell 的 `ls/cat` 进不去，但 Electron 的 node 模式支持 asar 路径。`Resources/runtime/versions.json`
同时记录 `"pnpm": "11.28.5"`。）

---

## 2. 被测 fixture（全部源文件，完整）

位置：`.probe/fixture/two-rows/`；打包产物：`.probe/dist/probe-two-rows-0.0.0.tgz`
（sha256 = `3599171133fb1b0324c1fb02da150da5a5deb7edd18e95d6d232b1df69ece4e1`，5 个文件）。

`.probe/fixture/two-rows/package.json`：

```json
{
  "name": "@probe/two-rows",
  "version": "0.0.0",
  "private": true,
  "description": "Probe fixture: a third-party bundle whose patch has two rows, each pointing at a subpath export of this same package.",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./a": "./a.js",
    "./b": "./b.js",
    "./package.json": "./package.json"
  },
  "files": ["index.js", "a.js", "b.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`.probe/fixture/two-rows/cordis.patch.yml`：

```yaml
# Probe fixture bundle patch: two rows from the SAME package, each a subpath export.
- insert:
    - id: probe-a
      name: '@probe/two-rows/a'
    - id: probe-b
      name: '@probe/two-rows/b'
```

`.probe/fixture/two-rows/a.js`（`b.js` 结构对称，只把 a/probe-a 换成 b/probe-b）：

```js
// Probe plugin row `probe-a`, reached through the package's `./a` subpath export.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'probe-a'
export const inject = []

export function apply(ctx) {
  const dir = process.env.PROBE_MARKER_DIR
  if (!dir) throw new Error('probe-a: PROBE_MARKER_DIR is not set')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'a.txt'),
    `probe-a applied\nname from module: ${name}\npid: ${process.pid}\njson: ${JSON.stringify({ row: 'probe-a', module: '@probe/two-rows/a' })}\n`,
  )
  ctx.logger?.info?.('probe-a applied')
}
```

`.probe/fixture/two-rows/index.js`：只有 `export const name = '@probe/two-rows'`（bundle 是纯配置载体，
需要一个可解析的 main；没有 patch 行指向它）。

打包命令与原始输出：

```sh
cd .probe/fixture/two-rows && npm pack --pack-destination ../../dist
```

```
npm notice 📦  @probe/two-rows@0.0.0
npm notice Tarball Contents
npm notice 636B a.js
npm notice 636B b.js
npm notice 195B cordis.patch.yml
npm notice 200B index.js
npm notice 532B package.json
npm notice total files: 5
probe-two-rows-0.0.0.tgz
```

---

## 3. 步骤与原始读数

### S1 冷启动：`plugin add` 自动初始化 profile + 自动 reconcile bundles

```sh
dsh plugin --profile probe add "$PWD/.probe/dist/probe-two-rows-0.0.0.tgz"
```

原始输出（`.probe/logs/01-plugin-add.log`）：

```
dsh: initialized profile probe at <REPO>/.probe/dsh-home/profiles/probe
Progress: resolved 0, reused 1, downloaded 0, added 0
Packages: +1
+
Packages are cloned from the content-addressable store to the virtual store.
  Content-addressable store is at: <HOME>/Library/pnpm/store/v11
  Virtual store is at:             node_modules/.pnpm
Progress: resolved 1, reused 1, downloaded 0, added 1, done

dependencies:
+ @probe/two-rows 0.0.0

Done in 616ms using pnpm v11.28.5
```

安装后 profile `package.json`（`.probe/logs/02b-profile-package.after-first-add.json`）：

```json
{
  "name": "dsh-profile-probe",
  "private": true,
  "dependencies": {
    "@probe/two-rows": "file:<REPO>/.probe/dist/probe-two-rows-0.0.0.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@probe/two-rows"]
    }
  }
}
```

注意：**`dsh.profile.bundles` 是 CLI 自己追加的**——初始化模板只有 `["@deepseek-ai/dsh-base"]`。

### S2 `--dump-config`：两行都在，name 逐字为子路径

```sh
dsh --profile probe --dump-config > .probe/logs/02-dump-config.yml
```

`.probe/logs/02-dump-config.yml` 末尾（第 361–365 行）：

```yaml
# == @probe/two-rows
- id: probe-a
  name: '@probe/two-rows/a'
- id: probe-b
  name: '@probe/two-rows/b'
```

stderr 为空，exit 0。

### S3 用 web 模板重建 profile（为了能真实启动 app）

```sh
dsh --profile probe --from-default-profile web --dump-config > .probe/logs/03-web-template-dump.yml
```

重建后立即 `cat` profile `package.json`（终端输出，实测）：

```json
{
  "name": "dsh-profile-probe",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } }
}
```

**重建是整目录替换**：`dependencies` 清空、bundles 回到 web 模板值；`03-web-template-dump.yml` 里
也不再有 `probe-a`/`probe-b` 行（`grep -c "probe-a\|probe-b"` = 0）。所以后续必须先重建再 add。

### S4 在 web 模板 profile 上再装同一 tgz

```sh
dsh plugin --profile probe add "$PWD/.probe/dist/probe-two-rows-0.0.0.tgz"
```

输出（`.probe/logs/04-plugin-add-webprofile.log`）：

```
Progress: resolved 0, reused 1, downloaded 0, added 0
Packages: +1
+
...
dependencies:
+ @probe/two-rows 0.0.0

Done in 336ms using pnpm v11.28.5
```

profile `package.json`（`.probe/logs/04b-profile-package.webprofile.json`）：

```json
"dependencies": { "@probe/two-rows": "file:/.../probe-two-rows-0.0.0.tgz" },
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@probe/two-rows"
] } }
```

dump-config（`.probe/logs/05-dump-config-webprofile.yml` 第 1230–1234 行）：

```yaml
# == @probe/two-rows
- id: probe-a
  name: '@probe/two-rows/a'
- id: probe-b
  name: '@probe/two-rows/b'
```

### S5 真实启动（核心证据）：两行都激活

```sh
PROBE_MARKER_DIR="$PWD/.probe/markers/run1" \
  dsh --profile probe --port 0 --no-open
# 等 marker 出现后 kill；脚本：.probe/run-boot.sh run1
```

启动进程 pid = **70165**（脚本打印）；两个 marker 都由该 pid 写出：

```
markers/run1/a.txt:
probe-a applied
name from module: probe-a
pid: 70165
json: {"row":"probe-a","module":"@probe/two-rows/a"}

markers/run1/b.txt:
probe-b applied
name from module: probe-b
pid: 70165
json: {"row":"probe-b","module":"@probe/two-rows/b"}
```

启动日志（`.probe/logs/run1.log` 全文，只有两行）：

```
dsh: all_proxy names a SOCKS proxy, which is not supported; connecting directly for that scheme — set an http:// or https:// proxy URL instead
dsh web: http://127.0.0.1:50252/?token=dh7tj887tem9bom15IEIpdu6arsOMrDEbuRV0-yMBgk
```

- `grep "entry did not activate"` → **零命中**（三次启动 run1/run2/run3 都零命中）；
- `dsh web: http://...` 说明 web app 真的启动并监听了临时端口（`--port 0` = OS 选空闲端口，
  `--no-open` = 不打开浏览器）。

### S6 加分项：profile patch 禁用其中一行（行级开关独立）

向 `.probe/dsh-home/profiles/probe/cordis.patch.yml` 写入（原内容为 `[]`）：

```yaml
- id: probe-b
  disabled: true
```

dump-config（`.probe/logs/08-dump-config-disabled-b.yml` 第 1230–1236 行）：

```yaml
# == @probe/two-rows
- id: probe-a
  name: '@probe/two-rows/a'
# == @probe/two-rows, patched by <REPO>/.probe/dsh-home/profiles/probe/cordis.patch.yml
- id: probe-b
  name: '@probe/two-rows/b'
  disabled: true
```

再次真实启动（`.probe/run-boot.sh run2-disabled-b`，pid=70571）：

```
markers/run2-disabled-b/ 只有 a.txt（pid 70571）
b.txt 不存在
日志无 "entry did not activate"
日志有 dsh web: http://127.0.0.1:50342/?token=...
```

### S7 恢复：两行又都激活（可逆）

profile patch 恢复为 `[]` 后 restart（`.probe/run-boot.sh run3-reenabled`，pid=94195）：
a.txt、b.txt 都出现，pid 均为 94195，日志无 `entry did not activate`。

---

## 4. 判据对照（task-1 的 a–e）

| 判据 | 结果 | 证据 |
|---|---|---|
| a. dump-config 里能看到 `probe-a` / `probe-b` 两行且 name 为 `@probe/two-rows/...` | ✅ | `.probe/logs/02-dump-config.yml` L361–365；`.probe/logs/05-dump-config-webprofile.yml` L1230–1234 |
| b. profile `package.json` 的 `dsh.profile.bundles` 自动包含 `@probe/two-rows` | ✅ | `.probe/logs/02b-profile-package.after-first-add.json`、`.probe/logs/04b-profile-package.webprofile.json`；两次都是 `plugin add` 之后直接读到的，未手改 |
| c. 真实启动，两个 marker 都出现 | ✅ | `.probe/markers/run1/{a,b}.txt`（pid 70165 = 该次启动进程 pid）；复现脚本 s4-both 同样通过 |
| d. 启动日志无 `entry did not activate` | ✅ | run1/run2/run3 日志 grep 零命中 |
| e. 加分：一行 `disabled: true` 后只有另一个 marker | ✅ | `.probe/markers/run2-disabled-b/` 只有 `a.txt`（pid 70571）；恢复后 run3 两个 marker 都回来 |
| 附加：同一结论可复现 | ✅ | `.probe/repro.sh` 最近一次运行：`=== RESULT: PASS=32 FAIL=0 ===`，exit 0（完整主控输出 `.probe/repro-console.txt`，逐阶段日志/清单在 `.probe/repro/logs/`、`.probe/repro/markers/`） |

复现命令（一条）：

```sh
cd "<WORKSPACE>/AI Native SDLC" && .probe/repro.sh; echo "EXIT=$?"
```

---

## 5. 结论与边界（不要过度外推）

**已实测成立**（本机 DSH `0.2.1-rc.2`，tgz 安装、隔离 profile、真实启动）：

- 第三方 bundle 的 patch 可以**多行、行名指向同一个包自己的子路径导出**，两行都被真实运行时激活；
- `dsh plugin add` 的自动初始化 + 自动 reconcile 在这条路径上工作（bundle 声明被自动追加进 `dsh.profile.bundles`）；
- 行级 `disabled` 由 profile patch 覆盖，且只影响被覆盖那一行，可逆；
- 这条链路的每一步都有可复跑的脚本和原始日志。

**本次没有证明的（避免被当成已覆盖）**：

1. fixture **没有 peerDependencies、没有 import 任何 `@deepseek-ai/*`**。所以它只证明「bundle 行级机制 +
   包内子路径解析 + 真实激活」，**没有**覆盖七个 SDLC 包的 peer 兼容性 / `dsh-tools` 重复实例 /
   App 自动升级导致的 `incompatible-version` 跳过问题。
2. 只验证了 **tgz（真实分发形态）**，没验证绝对路径符号链接安装（本仓库已知符号链接安装有坑，
   见 `docs/dsh-plugin-contracts.md` §0.4）。
3. `--dump-config` / marker 只说明插件 `apply()` 执行；不说明插件的工具/服务/UI 在真实会话里可用
   （那属于各插件自己的冒烟与真实会话验证）。
4. 探针没有在内置 macOS 之外的平台跑。

---

## 6. 过程中值得带走的发现（含与仓库旧结论的差异）

### 6.1 `dsh plugin add` **会自动写** `dsh.profile.bundles`（与 AGENTS.md 旧说不一致）

AGENTS.md 记录过「`dsh plugin add` 只装包，不写 `dsh.profile.bundles`；必须手补」。
本次在 0.2.1-rc.2 上**两次实测均自动追加**：

- 冷启动：`["@deepseek-ai/dsh-base"]` → `["@deepseek-ai/dsh-base", "@probe/two-rows"]`
- web 模板：`["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]` → `+ "@probe/two-rows"`

可能原因（未验证，别当结论）：版本差异（0.2.0-rc.2 vs 0.2.1-rc.2）、安装形态（tgz vs 绝对路径符号链接）、
或 bundle 的 peer 与运行时兼容性影响的 reconcile 分支。**建议 Lead 把这句旧断言按版本/条件改写**，
不要让它继续以绝对句存在。

### 6.2 `--from-default-profile <name>` 是整目录替换，不是「只换模板」

`initializeProfileFromDefault` 用模板的 bundles 重新 `initProfile`，因此 profile 的 `dependencies`
和 `dsh.profile.bundles` 都回到模板值（旧目录被 rename 删除）。本次实测：先 add 再 `--from-default-profile web`，
安装和 bundle 注册都会丢。**顺序必须是：先 `--from-default-profile` 建好 profile，再 `plugin add`。**

### 6.3 不需要为 `plugin add` 准备 PATH 上的 pnpm

见 §1 的 CLI 实现引用。`command -v pnpm` 在本机不存在，但两次 `plugin add` 都成功，输出 `pnpm v11.28.5`，
store 位于 `~/Library/pnpm/store/v11`（复用本机已有 store，未联网下载）。

### 6.4 隔离 home 也会被 boot 写少量运行时文件

真实启动在 `.probe/dsh-home` 下生成了 `.credentials.yaml`、`.anonymous-user-id`、`storages/workspace.json`，
以及 `profiles/probe/cordis.yml`（内容为固定注释 + `[]`）。都在隔离目录内，`~/.dsh` 未受影响。
`.probe` 整体可丢弃；若 Lead 想保留证据再提交，记得只挑 `EVIDENCE.md` 或整体 gitignore。

### 6.5 小怪癖（不阻塞，未深究）

`dsh --profile probe --help` / `-h` 在本次环境下**无输出、exit 0**（web 模板 profile），因此 web app 的
`--port 0 --no-open` 参数是从 App 内 `@deepseek-ai/dsh-web-app/lib/startup.js` 的命令定义读出来的，
不是靠 `--help`。这不是本探针的目标，记录在此防止别人重复踩。

---

## 7. 证据文件索引

| 路径 | 内容 |
|---|---|
| `.probe/fixture/two-rows/` | fixture 源码（package.json / cordis.patch.yml / a.js / b.js / index.js） |
| `.probe/dist/probe-two-rows-0.0.0.tgz` | 被安装的 tarball（sha256 见 §2） |
| `.probe/logs/01-plugin-add.log` | 冷启动 `plugin add` 原始输出（含 auto-init） |
| `.probe/logs/02b-profile-package.after-first-add.json` | 首次 add 后 profile manifest（bundles 已含 @probe） |
| `.probe/logs/02-dump-config.yml` / `.probe/logs/05-dump-config-webprofile.yml` | 两行 dump（不同阶段） |
| `.probe/logs/03-web-template-dump.yml` | `--from-default-profile web` 重建后的 dump（无 probe 行） |
| `.probe/logs/04-plugin-add-webprofile.log` / `.probe/logs/04b-profile-package.webprofile.json` | 二次 add 原始输出与 manifest |
| `.probe/logs/08-dump-config-disabled-b.yml` | 禁用 probe-b 后的 dump（`disabled: true`） |
| `.probe/logs/10-dump-config-reenabled.yml` | 恢复后的 dump |
| `.probe/logs/run1.log` / `run2-disabled-b.log` / `run3-reenabled.log` | 三次真实启动完整日志 |
| `.probe/markers/run1/{a,b}.txt` | 双激活 marker（pid 70165） |
| `.probe/markers/run2-disabled-b/a.txt` | 禁用行后只剩 a（pid 70571） |
| `.probe/markers/run3-reenabled/{a,b}.txt` | 恢复后双激活（pid 94195） |
| `.probe/run-boot.sh` | 上文 run1/run2/run3 的启动脚本（固定测两 marker） |
| `.probe/repro.sh` | 端到端复现脚本（自动判 PASS/FAIL，最近一次 32/32） |
| `.probe/repro-console.txt` | repro.sh 的完整输出（含 `PASS=32 FAIL=0`） |
| `.probe/repro/logs/`、`.probe/repro/markers/` | repro 每阶段的原始日志与 marker |
