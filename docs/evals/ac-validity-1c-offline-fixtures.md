# AC-VALIDITY-1C 离线 fixture（Phase 0 可执行版；Phase 1 未执行）

- **对应 issue**：[#22](https://github.com/HMYDK/ai-native-sdlc-dsh/issues/22)
- **用途**：把 #21 的 6 个离线反例变成**可执行、可复核、输入锁定**的最小 fixture。Phase 1 固定跑 **场景 1/2/3**；场景 4/5/6 保留给 Phase 2/后续。
- **状态**：Phase 1 预算**未批准**；本文没有真实模型运行结果（Phase 0 的 1 次 `sdlc_verify` 不跑 fixture）。所有 `expected_verdict` 来自 #21 的离线设计与人工推演，不是统计结论。
- **不新建 Runner**：fixture 是 `tools/evals/featurebench/fixtures/ac-validity-1c/` 下的 git 仓库生成器 + 行为检查器；Phase 1 的 DSH 调用复用 `setup-web.sh` / `driver.mjs`，不新增评测平台。

---

## 1. 单一确定性命令（先跑这个）

```bash
python3 tools/evals/featurebench/fixtures/ac-validity-1c/check_fixtures.py \
  --workdir /tmp/validity-1c-fixtures
```

该命令会：

1. 在 `--workdir` 下**创建/清理**六个独立 git repo（固定作者、固定提交日期，base → head 两个提交）；
2. 用系统 Python `unittest`（不依赖 pytest）运行每例的真实入口/测试；
3. 对照预期 exit code / 输出 / 失败来源，打印 `[ok]` 或 `[FAIL]`；
4. 只有六例全部匹配才返回 0。

它不调用模型、Docker、网络或 FeatureBench；`/tmp/validity-1c-fixtures` 由脚本自己创建，不是文档里凭空出现的路径。

**目录所有权**：脚本会在 workdir 写一个 `.ac-validity-1c-fixtures-owner` marker。下次复跑时，只有带 marker 的既有目录才会被清理；同名但缺 marker 的目录（或不在临时根下的同名目录）会被拒绝并原样保留。首次使用前若机器上已有旧的无 marker 目录，请人工确认后自行移除。`--self-test` 覆盖：临时根之外的同名目录不删、缺 marker 的既有目录不删、符号链接路径拒绝、带 marker 的目录可重复清理；自测目录全部用 `mkdtemp`/`TemporaryDirectory` 唯一创建，不在准备阶段对固定名字调用 `rmtree`，连续运行两遍无残留。

预期最后一行：`FIXTURES OK: six scenarios materialized and their observable behavior matches`。

脚本同时是 fixture 的**最小源码**：`check_fixtures.py` 内的 `S1_BASE/S1_HEAD` … `S6_BASE/S6_HEAD` 就是六个 repo 的固定文件与变更。改 fixture 必须改脚本并重跑；不接受手写 `/tmp` 目录当证据。

---

## 2. 六类 fixture 与可观察行为

| # | repo | 类别 | 固定输入 | 真正执行的检查 | 预期 verdict |
|---|---|---|---|---|---|
| S1 | `S1_positive` | 正向完成 | Issue #130：CSV 导出、固定字段、缺 amount 非零退出 | `python3 -m unittest discover -s tests -v`；`python3 -m app.cli export --format csv --orders orders_ok.json --out out.csv`；缺 amount 用 `orders_missing.json` | `approve` |
| S2 | `S2_gap` | AC 全 met 但真实 Outcome 失败 | Issue #131：`mycli run --date ""` 正常退出 + `parse_date('')` 返回 None | 作者 AC 测试通过；真实 CLI 仍抛 `AttributeError: 'NoneType' object has no attribute 'isoformat'` | `reject` |
| S3 | `S3_out_of_scope` | 明确范围外独立失败 | Issue #132：只修 `parse_date`；不改调用方/CLI | 目标 AC 测试通过；`tests_external.test_full_cli` 因独立旧 bug `Settings.verbose` 失败，且失败文本不含 `parse_date` | `approve`（附风险说明） |
| S4 | `S4_missing_evidence` | 关键证据缺失 | Issue #133：恢复 `foo()` 并让 `mycli run` 调用 | 静态测试通过；真实入口因 `missing_native_dep` 无法运行（不是语法错误） | `needs_human` + `unverified` |
| S5 | `S5_unrelated` | 无关既有失败 | Issue #134：给 `foo()` 加参数校验 | 目标测试通过；`tests_legacy.test_old` 在 head 与 base 都失败（`legacy failure marker`） | `approve`（附 `unverified`） |
| S6 | `S6_ambiguity` | Source 实质歧义 | Issue #135：恢复 gettext 相关符号；范围/夹具/口径未定 | 四个接口测试通过；真实 builder 因 `app.versioning.add_uids` 缺失失败 | `needs_human` + `unverified` |

> S1 的缺 amount 错误信息必须含订单 ID（`ord-3`），与 #21 的 Oracle 对齐；这是审核者 F5 的要求，已在 fixture 脚本和 criteria 中钉住。

---

## 3. Phase 1 固定场景 1/2/3（standalone `sdlc_verify`）

Phase 1 要比较的是 **verifier prompt**（A=`085c8fd` / B=`5ee68cd`），不是任务状态机或 Actor 写作。每个 fixture 直接调用 `sdlc_verify` 的 **standalone** 形式，不传 `task_id`：

```jsonc
{
  "intent_of_change": "…",
  "criteria": ["AC-001: …", "AC-002: …"],
  "diff": "git diff HEAD~1..HEAD",
  "test_evidence": "…",
  "scope": "…"
}
```

- 同一场景 A/B 的参数**逐字相同**；唯一变量是 DSH 里挂载的插件构建。
- 验证者仍会执行 shell（`bash`），所以它必须能跑真实入口；这是设计的一部分。
- 6 次调用 = 3 场景 × 2 臂；主会话的 tool-call 包装不计为第二个 verifier 调用，但其 token 计入预算。
- **冻结清单**：`tools/evals/featurebench/fixtures/ac-validity-1c/phase1/plan.yml`（固定顺序、输入指纹、输出/日志、DSH_CLI、软预算）；gold label 见同目录 `gold-labels.md`；离线校验 `check_phase1_plan.py`。

<a id="s21-1"></a>
### 3.1 S1（positive）

- repo：`/tmp/validity-1c-fixtures/S1_positive`（由第 1 节命令生成）。
- 预期：`approve`；AC-001/AC-002 均 `met`，无阻断性 `unverified`。

```json
{
  "intent_of_change": "Deliver Source issue #130: `mycli export --format csv` writes a CSV with header id,amount,status and one row per order; an order missing amount exits 2 with an error naming the order id.",
  "criteria": [
    "AC-001: `python3 -m app.cli export --format csv --orders orders_ok.json --out out.csv` exits 0 and writes a 4-line file with header id,amount,status.",
    "AC-002: `python3 -m app.cli export --format csv --orders orders_missing.json --out out.csv` exits 2 and the error contains `ord-3`."
  ],
  "diff": "git diff HEAD~1..HEAD",
  "test_evidence": "python3 -m unittest discover -s tests -v -> 2 tests OK; export command -> exit 0; missing amount -> exit 2 with 'error: order ord-3 missing amount'",
  "scope": "Phase 1 fixture S1 only; judge this repository snapshot; no network."
}
```

复核命令：

```bash
cd /tmp/validity-1c-fixtures/S1_positive
python3 -m unittest discover -s tests -v
python3 -m app.cli export --format csv --orders orders_ok.json --out /tmp/s1.csv; echo "exit=$?"; wc -l /tmp/s1.csv
python3 -m app.cli export --format csv --orders orders_missing.json --out /tmp/s1-bad.csv; echo "exit=$?"
```

<a id="s21-2"></a>
### 3.2 S2（gap）

- repo：`/tmp/validity-1c-fixtures/S2_gap`。
- 预期：`reject`；AC 全 `met`，但 Source 承诺的真实 CLI outcome 失败。

```json
{
  "intent_of_change": "Deliver Source issue #131: `mycli run --date \"\"` exits 0 with a readable warning, and `parse_date('')` returns None. The user-visible CLI path is part of the promised outcome.",
  "criteria": [
    "AC-001: `parse_date('')` returns None.",
    "AC-002: Parsing non-empty valid dates is unchanged."
  ],
  "diff": "git diff HEAD~1..HEAD",
  "test_evidence": "python3 -m unittest discover -s tests -v -> 2 tests OK; real CLI `python3 -m app.cli run --date \"\"` -> exit 1 with AttributeError: 'NoneType' object has no attribute 'isoformat'",
  "scope": "Phase 1 fixture S2 only; judge this repository snapshot; no network."
}
```

复核命令：

```bash
cd /tmp/validity-1c-fixtures/S2_gap
python3 -m unittest discover -s tests -v          # 2 tests OK
python3 -m app.cli run --date ""; echo "exit=$?"  # 预期非零；不是 import error
```

<a id="s21-3"></a>
### 3.3 S3（out-of-scope）

- repo：`/tmp/validity-1c-fixtures/S3_out_of_scope`。
- 预期：`approve`，在 `unverified` / risk finding 记录“外部完整 CLI 测试失败，但失败来自独立旧 bug，且 Source 明确排除 caller/CLI 重写”。
- 关键：外部失败文本是 `AttributeError: 'Settings' object has no attribute 'verbose'`，不含 `parse_date`；目标 `tests/test_dates.py` 全绿。

```json
{
  "intent_of_change": "Deliver Source issue #132: fix only `parse_date()` for the empty string to return None; do not change callers or the API. The complete CLI rewrite is explicitly out of scope.",
  "criteria": [
    "AC-001: `parse_date('')` returns None.",
    "AC-002: Non-empty valid date parsing is unchanged.",
    "AC-003: Existing date tests remain green."
  ],
  "diff": "git diff HEAD~1..HEAD",
  "test_evidence": "python3 -m unittest discover -s tests -v -> 2 tests OK; python3 -m unittest tests_external.test_full_cli -v -> failure from independent legacy Settings.verbose bug; failure text does not mention parse_date",
  "scope": "Phase 1 fixture S3 only; judge this repository snapshot; no network."
}
```

复核命令：

```bash
cd /tmp/validity-1c-fixtures/S3_out_of_scope
python3 -m unittest discover -s tests -v                 # 2 tests OK
python3 -m unittest tests_external.test_full_cli -v; echo "external_exit=$?"  # 失败：Settings.verbose
```

---

## 4. Phase 1 运行面（未执行；需单独批准）

### 4.1 两臂插件身份

Phase 1 的 A 是 `085c8fd`（旧 verifier，已有 #20），B 是 `5ee68cd`（#21 verifier）。实际构建产物：

| 臂 | commit | tarball sha256 | 解包目录 |
|---|---|---|---|
| `A_phase1` | `085c8fd` | `106247171248772794bd0ac99fa20ea9e2ff42d29d04a79e3032241158d27784` | `plugins/A_phase1/` |
| `B_phase1` | `5ee68cd` | `8bb74f3a8bc20be10b2b2cd704cdf6f081e64fa70a812c6d124c4823faedb404` | `plugins/B_phase1/` |

构建/打包（离线；不启动容器、不连模型）：

```bash
set -euo pipefail
REPO="$(git rev-parse --show-toplevel)"
mkdir -p /tmp/phase1/{src,pkgs,plugins,home,prompts,out}
git worktree add /tmp/phase1/src/A 085c8fd
git worktree add /tmp/phase1/src/B 5ee68cd
for X in A B; do
  npm ci --prefix /tmp/phase1/src/$X
  npm run build --prefix /tmp/phase1/src/$X/packages/sdlc
  mkdir -p /tmp/phase1/pkgs/$X
  (cd /tmp/phase1/src/$X/packages/sdlc && npm pack --pack-destination /tmp/phase1/pkgs/$X)
  mkdir -p /tmp/phase1/plugins/$X
  tar -xzf /tmp/phase1/pkgs/$X/*.tgz -C /tmp/phase1/plugins/$X
  mv /tmp/phase1/plugins/$X/package /tmp/phase1/plugins/$X/dsh-sdlc
  cp -r "$REPO/node_modules/js-yaml" /tmp/phase1/plugins/$X/js-yaml
done
shasum -a 256 /tmp/phase1/pkgs/*/*.tgz
```

> 运行前必须核对 tarball sha256 与上表一致；不一致就停止，不能用 `--allow-version-mismatch` 绕过。

### 4.2 隔离 DSH Web（A/B 两套固定 home）

**约定**：A/B 的插件安装、profile、`dsh web`、日志必须使用同一套 home；只换插件构建，不换案例输入。

| arm | commit | tarball sha256 | DSH_HOME | plugin 目录 | workspace root | web / CDP |
|---|---|---|---|---|---|---|
| A | `085c8fd` | `106247171248772794bd0ac99fa20ea9e2ff42d29d04a79e3032241158d27784` | `/tmp/phase1/dsh/A` | `/tmp/phase1/plugins/A` | `/tmp/phase1/eval-root-A` | `59611` / `9222` |
| B | `5ee68cd` | `8bb74f3a8bc20be10b2b2cd704cdf6f081e64fa70a812c6d124c4823faedb404` | `/tmp/phase1/dsh/B` | `/tmp/phase1/plugins/B` | `/tmp/phase1/eval-root-B` | `59612` / `9223` |

以下命令需要 PATH 中有 `dsh 0.2.2-rc.3`（容器派生镜像或执行机安装）；**Phase 0 不执行**，也不声称已经启动成功。

```bash
set -euo pipefail
REPO="$(git rev-parse --show-toplevel)"
DSH_CLI="${DSH_CLI:?set DSH_CLI to the DSH 0.2.2-rc.3 CLI path; do not rely on PATH}"
mkdir -p /tmp/phase1/dsh/A /tmp/phase1/dsh/B \
  /tmp/phase1/eval-root-A/deepseek-harness \
  /tmp/phase1/eval-root-B/deepseek-harness \
  /tmp/phase1/prompts /tmp/phase1/out

install_profile() {
  local plugin_dir="$1" eval_root="$2"
  "$DSH_CLI" --profile web --dump-default-config >/dev/null
  local profile="$DSH_HOME/profiles/web"
  mkdir -p "$profile/node_modules/@ai-native-sdlc-plugin"
  rm -rf "$profile/node_modules/@ai-native-sdlc-plugin/dsh-sdlc"
  cp -r "$plugin_dir/dsh-sdlc" "$profile/node_modules/@ai-native-sdlc-plugin/dsh-sdlc"
  rm -rf "$profile/node_modules/js-yaml"
  cp -r "$plugin_dir/js-yaml" "$profile/node_modules/js-yaml"
  node -e '
    const fs = require("fs"); const p = process.argv[1];
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    d.dependencies = d.dependencies || {};
    d.dependencies["@ai-native-sdlc-plugin/dsh-sdlc"] = "0.6.2";
    d.dsh = d.dsh || {}; d.dsh.profile = d.dsh.profile || {};
    d.dsh.profile.bundles = d.dsh.profile.bundles || [];
    if (!d.dsh.profile.bundles.includes("@ai-native-sdlc-plugin/dsh-sdlc"))
      d.dsh.profile.bundles.push("@ai-native-sdlc-plugin/dsh-sdlc");
    fs.writeFileSync(p, JSON.stringify(d, null, 2));
  ' "$profile/package.json"
  cat > "$profile/cordis.patch.yml" <<YAML
- id: agent-default-model
  config:
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: max
- id: permission
  config:
    defaultPreset: danger-full-access
- id: workspace-controller
  config:
    documentsDirectory: $eval_root
- id: session-log-deepseek
  disabled: true
- id: otel
  disabled: true
- id: session-telemetry-otel
  disabled: true
YAML
}

export DSH_HOME=/tmp/phase1/dsh/A
install_profile /tmp/phase1/plugins/A /tmp/phase1/eval-root-A
export DSH_HOME=/tmp/phase1/dsh/B
install_profile /tmp/phase1/plugins/B /tmp/phase1/eval-root-B

mkdir -p /tmp/phase1/prompts /tmp/phase1/out
python3 "$REPO/tools/evals/featurebench/fixtures/ac-validity-1c/phase1/check_phase1_plan.py" \
  --stage-prompts /tmp/phase1/prompts

# --- A：085c8fd，旧 verifier ---
export DSH_HOME=/tmp/phase1/dsh/A
ln -sfn /tmp/validity-1c-fixtures/S2_gap /tmp/phase1/eval-root-A/deepseek-harness/default-workspace
cd /tmp/validity-1c-fixtures/S2_gap
nohup "$DSH_CLI" web --no-open --port 59611 --host 127.0.0.1 > /tmp/phase1/out/S2-A.web.log 2>&1 &
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --headless=new --remote-debugging-port=9222 \
  --user-data-dir=/tmp/phase1/chrome-A --no-first-run about:blank &
MAX_TOKENS=2000000 MAX_WALL_S=1200 WEB_PORT=59611 node "$REPO/tools/evals/featurebench/driver.mjs" \
  9222 "AI 原生 SDLC" /tmp/phase1/prompts/S2.txt /tmp/phase1/out/S2-A.txt \
  > /tmp/phase1/out/S2-A.driver.log 2>&1

# --- B：5ee68cd，#21 verifier ---
export DSH_HOME=/tmp/phase1/dsh/B
ln -sfn /tmp/validity-1c-fixtures/S2_gap /tmp/phase1/eval-root-B/deepseek-harness/default-workspace
cd /tmp/validity-1c-fixtures/S2_gap
nohup "$DSH_CLI" web --no-open --port 59612 --host 127.0.0.1 > /tmp/phase1/out/S2-B.web.log 2>&1 &
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --headless=new --remote-debugging-port=9223 \
  --user-data-dir=/tmp/phase1/chrome-B --no-first-run about:blank &
MAX_TOKENS=2000000 MAX_WALL_S=1200 WEB_PORT=59612 node "$REPO/tools/evals/featurebench/driver.mjs" \
  9223 "AI 原生 SDLC" /tmp/phase1/prompts/S2.txt /tmp/phase1/out/S2-B.txt \
  > /tmp/phase1/out/S2-B.driver.log 2>&1
```

`--stage-prompts` 会把仓库冻结的 `phase1/prompts/S1.txt`、`S2.txt`、`S3.txt` 复制到 `/tmp/phase1/prompts/`，并逐份核对 `plan.yml` 中的 SHA256；不得重新手写或生成另一份 prompt。S1/S2/S3 的 A/B 两臂都读取同一份对应文件；执行前由 `check_phase1_plan.py` 校验 workspace/base/head/diff 与 plan 一致。

| # | 调用 | 冻结 prompt | web / CDP | output | driver log | web log |
|---|---|---|---|---|---|---|
| 1 | S1-A | `/tmp/phase1/prompts/S1.txt` | 59611 / 9222 | `/tmp/phase1/out/S1-A.txt` | `S1-A.driver.log` | `S1-A.web.log` |
| 2 | S1-B | `/tmp/phase1/prompts/S1.txt` | 59612 / 9223 | `/tmp/phase1/out/S1-B.txt` | `S1-B.driver.log` | `S1-B.web.log` |
| 3 | S2-A | `/tmp/phase1/prompts/S2.txt` | 59611 / 9222 | `/tmp/phase1/out/S2-A.txt` | `S2-A.driver.log` | `S2-A.web.log` |
| 4 | S2-B | `/tmp/phase1/prompts/S2.txt` | 59612 / 9223 | `/tmp/phase1/out/S2-B.txt` | `S2-B.driver.log` | `S2-B.web.log` |
| 5 | S3-A | `/tmp/phase1/prompts/S3.txt` | 59611 / 9222 | `/tmp/phase1/out/S3-A.txt` | `S3-A.driver.log` | `S3-A.web.log` |
| 6 | S3-B | `/tmp/phase1/prompts/S3.txt` | 59612 / 9223 | `/tmp/phase1/out/S3-B.txt` | `S3-B.driver.log` | `S3-B.web.log` |

S1/S3 复用上面的 A/B 命令模板，只按表中替换 workspace、prompt、端口/输出/日志；同一场景 A/B 的 Source、criteria、diff、test_evidence、scope 逐字相同，只换插件构建。`MAX_TOKENS=2000000` / `MAX_WALL_S=1200` 是**单次监控/软停止**，不是硬预算；总 8M/2h 是软目标。UI usage 不可读或 Stop 失效时，执行者必须终止后续调用并人工处置；失败/超时保留在 6 次 ITT 分母，不自动重试。

> **本机宿主 PATH 没有 `dsh`，Phase 0 没有执行本节命令。** 这里记录的是 Phase 1 获批后的可复核步骤；真实 profile 加载、模型调用仍需单独预算批准。静态一致性检查：`check_phase1_docs.py --self-test`（见 §7）。

---

## 5. 场景 4/5/6（保留；Phase 1 不跑）

第 1 节的确定性命令已经物化并检查 S4/S5/S6；Phase 1 只用 S1/S2/S3。保留场景的预期裁决与可观察行为：

<a id="s21-4"></a>
### 5.1 S4（evidence missing）

- **S4**：静态测试通过，真实入口因 `missing_native_dep` 无法运行 → `needs_human` + `unverified`；不把“无法执行”写成 `reject` 或 `approve`。
<a id="s21-5"></a>
### 5.2 S5（unrelated failure）

- **S5**：目标测试通过，`tests_legacy.test_old` 在 head 与 base 都失败 → `approve` + `unverified`；不把无关旧失败当成本次缺陷。
<a id="s21-6"></a>
### 5.3 S6（ambiguity）

- **S6**：四个接口测试通过，真实 builder 因 `app.versioning.add_uids` 缺失失败，Source 未承诺完整 builder → `needs_human` + `unverified`；不自行把 `add_uids` 加成 AC。

后两例若在 Phase 2/后续使用，按第 3 节的 standalone 参数格式固定输入，并由审查者先确认预期裁决。

---

## 6. 输入锁定与证据

- 每个 fixture repo 由脚本固定 base/head 提交；`git diff HEAD~1..HEAD` 就是 `diff`。
- 同一场景 A/B 的 `criteria`、`intent_of_change`、`diff`、`test_evidence`、`scope` 逐字相同；只换插件构建。
- 记录 run_id、verdict、findings、实际工具/命令、token、耗时；人工按 finding 里的命令复跑。
- 从主会话 JSONL 按 `callId == tool/result.message.toolCallId` 配对 `sdlc_verify` 调用/结果；不解析自由文本猜 verdict。
- 不把 `needs_human` 增多当成功；不把结构合规当质量；不做显著性宣称。
- Phase 1：6 次调用；≤8M token 总、单次 ≤2M、≤2h；超限停止，不重试。

## 7. 审核意见对应

- **F3**：六类 fixture 已从文本变成可执行脚本；`python3 -m app.cli` 有 `__main__`，repo 由脚本创建；S1 补了订单 ID 断言。
- **F4**：Phase 1 的插件 identity、DSH 启动与 driver 命令写清；Phase 2 的 manifest/image-map/preflight 见 [preregistration](ac-validity-1c-preregistration.md) 和 [handoff](ac-validity-1c-handoff.md)。
- **F5**：S1 AC-002/复核命令包含 `ord-3`。
- **DSH 命令一致性**：`check_phase1_docs.py --self-test` 会把运行 `DSH_HOME` 改回一个不一致的 home、删除 `eval-root` 的 `mkdir`、以及坏链接都必须拒绝；默认模式核对 A/B home、workspace、日志、hash 和链接/锚点。
- **workspace 完整性**：`check_phase1_plan.py` 对六个实际 workspace 拒绝 tracked staged/unstaged 变更，并拒绝可能影响入口的未跟踪文件（仅放行已知生成物 `out.csv` 与 `__pycache__/*.pyc`）；`--dirty-workspace-test` 在临时副本上对 S2 `app/dates.py` 做暂存前/暂存后修改并确认拒绝。
- 本文件不宣称 fixture 已经过真实模型验证；Phase 1 未运行。
