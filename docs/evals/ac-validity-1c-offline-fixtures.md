# AC-VALIDITY-1C 离线 fixture（Phase 0 可执行版；Phase 1 未执行）

- **对应 issue**：[#22](https://github.com/HMYDK/ai-native-sdlc-dsh/issues/22)
- **用途**：把 #21 的 6 个离线反例变成**可执行、可复核、输入锁定**的最小 fixture。Phase 1 固定跑 **场景 1/2/3**；场景 4/5/6 保留给 Phase 2/后续。
- **状态**：Phase 1 预算**未批准**；本文没有真实模型运行结果（Phase 0 的 1 次 `sdlc_verify` 不跑 fixture）。所有 `expected_verdict` 来自 #21 的离线设计与人工推演，不是统计结论。
- **不新建 Runner**：fixture 是 `tools/evals/featurebench/fixtures/ac-validity-1c/` 下的 git 仓库生成器 + 行为检查器；Phase 1 的 DSH 调用复用 `setup-web.sh` / `driver.mjs`，不新增评测平台。

---

## 1. 单一确定性命令（先跑这个）

```bash
python3 tools/evals/featurebench/fixtures/ac-validity-1c/check_fixtures.py \
  --workdir /tmp/ac-validity-1c-fixtures
```

该命令会：

1. 在 `--workdir` 下**创建/清理**六个独立 git repo（固定作者、固定提交日期，base → head 两个提交）；
2. 用系统 Python `unittest`（不依赖 pytest）运行每例的真实入口/测试；
3. 对照预期 exit code / 输出 / 失败来源，打印 `[ok]` 或 `[FAIL]`；
4. 只有六例全部匹配才返回 0。

它不调用模型、Docker、网络或 FeatureBench；`/tmp/validity-1c-fixtures` 由脚本自己创建，不是文档里凭空出现的路径。

预期最后一行：`FIXTURES OK: six scenarios materialized and their observable behavior matches`。

脚本同时是 fixture 的**最小源码**：`check_fixtures.py` 内的 `S1_BASE/S1_HEAD` … `S6_BASE/S6_HEAD` 就是六个 repo 的固定文件与变更。改 fixture 必须改脚本并重跑；不接受手写 `/tmp` 目录当证据。

---

## 2. 六类 fixture 与可观察行为

| # | repo | 类别 | 固定输入 | 真正执行的检查 | 预期 verdict |
|---|---|---|---|---|---|
| S1 | `S1_positive` | 正向完成 | Issue #130：CSV 导出、固定字段、缺 amount 非零退出 | `python -m unittest discover -s tests -v`；`python -m app.cli export --format csv --orders orders_ok.json --out out.csv`；缺 amount 用 `orders_missing.json` | `approve` |
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

### 3.1 S1（positive）

- repo：`/tmp/validity-1c-fixtures/S1_positive`（由第 1 节命令生成）。
- 预期：`approve`；AC-001/AC-002 均 `met`，无阻断性 `unverified`。

```json
{
  "intent_of_change": "Deliver Source issue #130: `mycli export --format csv` writes a CSV with header id,amount,status and one row per order; an order missing amount exits 2 with an error naming the order id.",
  "criteria": [
    "AC-001: `python -m app.cli export --format csv --orders orders_ok.json --out out.csv` exits 0 and writes a 4-line file with header id,amount,status.",
    "AC-002: `python -m app.cli export --format csv --orders orders_missing.json --out out.csv` exits 2 and the error contains `ord-3`."
  ],
  "diff": "git diff HEAD~1..HEAD",
  "test_evidence": "python -m unittest discover -s tests -v -> 2 tests OK; export command -> exit 0; missing amount -> exit 2 with 'error: order ord-3 missing amount'",
  "scope": "Phase 1 fixture S1 only; judge this repository snapshot; no network."
}
```

复核命令：

```bash
cd /tmp/validity-1c-fixtures/S1_positive
python -m unittest discover -s tests -v
python -m app.cli export --format csv --orders orders_ok.json --out /tmp/s1.csv; echo "exit=$?"; wc -l /tmp/s1.csv
python -m app.cli export --format csv --orders orders_missing.json --out /tmp/s1-bad.csv; echo "exit=$?"
```

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
  "test_evidence": "python -m unittest discover -s tests -v -> 2 tests OK; real CLI `python -m app.cli run --date \"\"` -> exit 1 with AttributeError: 'NoneType' object has no attribute 'isoformat'",
  "scope": "Phase 1 fixture S2 only; judge this repository snapshot; no network."
}
```

复核命令：

```bash
cd /tmp/validity-1c-fixtures/S2_gap
python -m unittest discover -s tests -v          # 2 tests OK
python -m app.cli run --date ""; echo "exit=$?"  # 预期非零；不是 import error
```

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
  "test_evidence": "python -m unittest discover -s tests -v -> 2 tests OK; python -m unittest tests_external.test_full_cli -v -> failure from independent legacy Settings.verbose bug; failure text does not mention parse_date",
  "scope": "Phase 1 fixture S3 only; judge this repository snapshot; no network."
}
```

复核命令：

```bash
cd /tmp/validity-1c-fixtures/S3_out_of_scope
python -m unittest discover -s tests -v                 # 2 tests OK
python -m unittest tests_external.test_full_cli -v; echo "external_exit=$?"  # 失败：Settings.verbose
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
  cp -r node_modules/js-yaml /tmp/phase1/plugins/$X/js-yaml
done
shasum -a 256 /tmp/phase1/pkgs/*/*.tgz
```

> 运行前必须核对 tarball sha256 与上表一致；不一致就停止，不能用 `--allow-version-mismatch` 绕过。

### 4.2 隔离 DSH Web（复用 setup-web.sh / driver.mjs）

Phase 1 不新建 Runner；沿用 `tools/evals/featurebench/setup-web.sh` 的思路和 `driver.mjs`：

```bash
# 以下命令需要 PATH 中有 dsh 0.2.2-rc.3（容器派生镜像或执行机安装）
for X in A B; do
  export DSH_HOME=/tmp/phase1/home/$X
  dsh --profile web --dump-default-config >/dev/null
  # 按 setup-web.sh：复制 plugins/$X/dsh-sdlc 与 js-yaml 到 profile node_modules，
  # 配置 model=deepseek-account/deepseek-flash、permission=danger-full-access、
  # 关闭 session-log/otel，workspace-controller.documentsDirectory=/tmp/phase1/eval-root-$X
done

# 每个场景/臂：将默认工作区指向该 fixture repo，启动 web + Chrome，再用 driver.mjs
export DSH_HOME=/tmp/phase1/dsh-home-A
mkdir -p /tmp/phase1/eval-root-A/deepseek-harness
ln -sfn /tmp/validity-1c-fixtures/S2_gap /tmp/phase1/eval-root-A/deepseek-harness/default-workspace
cd /tmp/validity-1c-fixtures/S2_gap
nohup dsh web --no-open --port 59611 --host 127.0.0.1 > /tmp/phase1/dsh-home-A/web.log 2>&1 &

/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --headless=new --remote-debugging-port=9222 \
  --user-data-dir=/tmp/phase1/chrome-A --no-first-run about:blank &

WEB_PORT=59611 node tools/evals/featurebench/driver.mjs \
  9222 "AI 原生 SDLC" /tmp/phase1/prompts/S2.txt /tmp/phase1/out/S2-A.txt
```

`prompts/S2.txt` 只包含“不要改文件；用第 3.2 节参数调用一次 `sdlc_verify`；输出 verdict JSON 后停止”。A/B 使用同一个 prompt 文件、同一个 driver、同一个端口约定，只换 `DSH_HOME` 和 plugin 目录。

> **本机宿主 PATH 没有 `dsh`，Phase 0 没有执行本节命令。** 这里记录的是 Phase 1 获批后的可复核步骤；真实模型调用仍需单独预算批准。

---

## 5. 场景 4/5/6（保留；Phase 1 不跑）

第 1 节的确定性命令已经物化并检查 S4/S5/S6；Phase 1 只用 S1/S2/S3。保留场景的预期裁决与可观察行为：

- **S4**：静态测试通过，真实入口因 `missing_native_dep` 无法运行 → `needs_human` + `unverified`；不把“无法执行”写成 `reject` 或 `approve`。
- **S5**：目标测试通过，`tests_legacy.test_old` 在 head 与 base 都失败 → `approve` + `unverified`；不把无关旧失败当成本次缺陷。
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

- **F3**：六类 fixture 已从文本变成可执行脚本；`python -m app.cli` 有 `__main__`，repo 由脚本创建；S1 补了订单 ID 断言。
- **F4**：Phase 1 的插件 identity、DSH 启动与 driver 命令写清；Phase 2 的 manifest/image-map/preflight 见 [preregistration](ac-validity-1c-preregistration.md) 和 [handoff](ac-validity-1c-handoff.md)。
- **F5**：S1 AC-002/复核命令包含 `ord-3`。
- 本文件不宣称 fixture 已经过真实模型验证；Phase 1 未运行。
