# #22 / AC-VALIDITY-1C 交接包（Phase 0 整改稿；未 DONE）

- **更新时间**：2026-11-15
- **基线**：`HMYDK/ai-native-sdlc-dsh`，`dev@5ee68cd`
- **交付分支**：`evals/ac-validity-1c-phase0`（从 `dev@5ee68cd` 建；Draft PR，不直接合入 `dev`）
- **状态**：三次 `sdlc_verify` 均为 **reject**。第三次（最终授权，run `c1904ac6-6e03-490b-a7fd-bf8af80898fa`，绑定代码 head `401f091`）AC-001..005/007 met、**AC-006 not_met**；F1/C6 unresolved，F2–F6 resolved。第三次 finding（Phase 1 DSH_HOME/mkdir、README 链接、case table 锚点）已按审核者裁决做**确定性修复**，**不再进行第四次模型验证**，等人工 Reviewer 逐项签字。Phase 1/2/B1 未批准、未运行。
- **用途**：让审查者/下一台执行机器知道已经确认什么、环境有什么、Phase 0 产出了什么、Phase 1/2 怎么跑、哪些事不能做。

---

## 1. 一句话

#22 要用独立证据判定：**「Delivery Contract（#20）+ Verifier 充分性审查（#21）」是否真的减少了“`approve` 但原始 Source/用户目标未交付”，同时没有把误拒、`needs_human`、无裁决、Token/墙钟和返工成本推高。** 官方 FeatureBench `resolved` 只是旁证，不是用户目标本身。

---

## 2. 环境核对（2026-11-15 本机实测）

| 项目 | 读数 | 说明 |
|---|---|---|
| 仓库/分支 | `dev@5ee68cd` | `master@920b0eb`、`085c8fd` 均存在 |
| Docker | `29.5.3`，`aarch64/linux` | 已安装；**本机未启动 amd64/Rosetta 容器**（Phase 0 不需要） |
| 派生镜像 | `fb-eval-base-061:{sphinx,seaborn,packaging,pytest,pydantic,astropy}` 各约 30GB | 历史镜像；**sympy 官方镜像不在本机** |
| FeatureBench | `featurebench==0.3.0` 已安装（uv tool） | Phase 0 不再安装；Phase 1/2 直接用 |
| DSH | App `0.2.2-rc.3` 已安装；宿主 PATH 无 `dsh` CLI | 容器派生镜像内自带 `dsh`；Phase 0 不启动 |
| Node / Chrome | `node v24.14.0`；Google Chrome 已安装 | Phase 0 未启动无头 Chrome |
| 凭据 | `~/.dsh/.credentials.yaml` 存在 | 不复制、不提交；未验证调用 |
| 历史归档 | `~/.dsh-eval-archive/2026-11-08/`、`verify-01/`、`2026-11-10-grader-rerun/` | 抽样 sha256 与 attribution data 一致；验证者核对 84/84 路径通过 |
| sympy 官方镜像 | `libercoders/featurebench-specs_sympy-instance_3d889fef`，digest `sha256:207ff124…`，**10.65GB** | 维护者确认；**Phase 0 未拉取**；Phase 2 前按 `bake_base.py` 用 rc.3 rebake |
| 数据集缓存 | `~/.cache/huggingface/datasets/LiberCoders___feature_bench/.../feature_bench-fast.arrow` | 用于读 sympy 任务；未联网 |

> 上表区分“已读出”与“未执行”。Docker 容器、无头 Chrome、真实模型、sympy 镜像和 FeatureBench 评分链路都**没有**在 Phase 0 运行（除两次独立 `sdlc_verify` 的 verifier 子代理）。

---

## 3. 已确认决策

| 决策 | 结论 |
|---|---|
| Phase 0 | 首次执行已获授权；审核后接受材料为草稿，要求修复 F1–F7 后再验证；不直接合入 `dev`。 |
| 本轮改动范围 | 用户授权：docs/任务制品 + `tools/evals/featurebench` 的 runner/preflight/fixture；**不改 `packages/sdlc` 插件代码**、不跑付费模型。 |
| 首轮模型 | `deepseek-flash`；A/B 固定同一 route/model/参数。 |
| Phase 1 | 固定 #21 场景 **1/2/3** × 2 臂；6 次 verifier 调用；≤8M Token / 2h；单次 ≤2M。 |
| Phase 1 臂 | `A_phase1=085c8fd`；`B_phase1=5ee68cd`；输入锁定，只换 verifier prompt。 |
| Phase 2 主实验 | `A=master@920b0eb`；`B2=dev@5ee68cd`；5 任务 × 2 臂 = **10 runs**；≤120M / 8h。 |
| Phase 2 B1 | `085c8fd`；**单独 manifest**；3 个 sympy 任务 × 1 臂 = **3 runs**；≤30M / 2h；触发阈值 Phase 2 前批准。 |
| 新任务 | sympy `test_inverse` / `test_nullspace` / `test_puiseux`；镜像 10.65GB，Phase 0 不拉。 |
| A 臂定义 | `AI 原生 SDLC` preset + `920b0eb` 真实基线插件构建；不是标准 preset，也不是无效果插件。 |
| 第二次验证 | 用户已批准：1 call / ≤2M / ≤30min / 不重试；首次 reject 保留为历史。 |
| 提交方式 | 独立分支 `evals/ac-validity-1c-phase0` + Draft PR；不直接合入 `dev`。 |
| 人工 gold label | 审查者最终核对；独立于 A/B Actor 生成的 Spec/Delivery Contract/Verifier 裁决。 |

---

## 4. 历史案例口径（已按数据修正）

**官方 FP = 8 runs / 2 任务；官方 FN = 3 runs / 2 任务。官方 FP 与 Source 层错误放行分开。**

| 口径 | runs | 去重任务 | 说明 |
|---|---:|---:|---|
| 官方 FP（`resolved=false` + `approve`） | **8** | **2** | 7 gettext + 1 doctest；含 V1 7 + V2 1；V1/V2 分层 |
| 官方 FN（`resolved=true` + `reject`） | **3** | **2** | seaborn 2 runs + packaging 1 run；全部 `agent_failure=timeout`，**censored** |
| Source 层错误放行 | **0 confirmed** | — | **不是“已证实 FP=0”**；8 个官方 FP 全部 conflict/provisional 待审查 |
| Source 层错误拒绝 | **0 confirmed** | — | **不是“已证实 FN=0”**；3 个 FN 全部 censored |

- gettext/doctest 的 Source 明确排除完整 i18n builder / doctest extension；官方 F2P 的通过项是承诺接口，失败项是完整 builder/extension。静态核对见 [case table §2.1](ac-validity-1c-case-table.md#source-dependency-check)。
- 这仍是 **Source/Grader conflict**，不是已证实的 Source 层错误放行；审查者必须独立判断“缺失符号是否是已承诺消费路径的必要依赖”，本轮不写 FP=0/FN=0。
- 3 个 FN 每次最后 `sdlc_verify` 缺失/被截断，官方 `resolved=1.0` 与 `reject` 矛盾；标 **censored**。

---

## 5. Phase 0 交付物

| 交付物 | 路径 | 状态 |
|---|---|---|
| 独立 case table | `docs/evals/ac-validity-1c-case-table.md` + `.json` | 11 历史 + 6 合成；官方 FP/FN 与 Source 层分开；§2.1 Source 依赖核验 |
| 可执行 fixture | `tools/evals/featurebench/fixtures/ac-validity-1c/check_fixtures.py` | 六类 repo 物化 + `unittest` 行为检查；S1 含订单 ID |
| Fixture 说明 | `docs/evals/ac-validity-1c-offline-fixtures.md` | 单一命令、六类预期、Phase 1 参数、DSH 运行面 |
| 预注册方案 | `docs/evals/ac-validity-1c-preregistration.md` | 主 10 runs + B1 3 runs 分开；身份链、preflight、停止/决策 |
| 主实验 manifest | `tools/evals/featurebench/manifests/ac-validity-1c/ac-validity-1c.yml` | A/B2，5 任务 = 10 runs |
| B1 manifest | `tools/evals/featurebench/manifests/ac-validity-1c/ac-validity-1c-b1.yml` | B1，3 sympy = 3 runs，无 sphinx |
| Preflight | `tools/evals/featurebench/check_ac_validity_1c.py` | 计划/身份/预算检查 + 负例自检；CI `evals-check` 已接入 |
| Runner 支持 | `tools/evals/featurebench/run_matrix.py` / `run_arm.py` | `--arm-plugin-dir` / `--arm-plugin-tarball` / `--strict-preflight` / hash 校验 |
| 预算申请 | `docs/evals/ac-validity-1c-budget.md` | Phase 0 两次 verify、Phase 1 8M/2h、Phase 2 120M/8h、B1 30M/2h |
| 本交接 | `docs/evals/ac-validity-1c-handoff.md` | 环境、决策、命令、审批边界 |

### 5.1 确定性检查（不跑模型）

```bash
python3 tools/evals/featurebench/sanity_check.py --structural
python3 tools/evals/featurebench/check_ac_validity_1c.py --self-test
python3 tools/evals/featurebench/fixtures/ac-validity-1c/check_phase1_docs.py --self-test
python3 tools/evals/featurebench/fixtures/ac-validity-1c/check_phase1_docs.py
python3 tools/evals/featurebench/fixtures/ac-validity-1c/check_fixtures.py --self-test
python3 tools/evals/featurebench/fixtures/ac-validity-1c/check_fixtures.py --workdir /tmp/validity-1c-fixtures
```

`--self-test` 覆盖：临时根之外的同名目录不删、缺 `.ac-validity-1c-fixtures-owner` marker 的既有目录不删、符号链接路径拒绝、带 marker 的目录可重复清理；自测目录只用唯一 `mkdtemp`/`TemporaryDirectory` 创建，连续运行两遍无残留。正常六类 fixture 复跑见下一行。

补充离线命令（需要已构建的 `/tmp/ac1c/artifacts`）：

```bash
python3 tools/evals/featurebench/check_ac_validity_1c.py --artifact-root /tmp/ac1c/artifacts
```

### 5.2 Phase 0 回归读数（2026-11-15，本机）

- `cd packages/sdlc && DSH_APP="/Applications/DeepSeek Harness.app" npm run verify`：exit 0；库单测 285 pass / 0 fail，客户端 45 pass / 0 fail，运行时冒烟 12 个脚本全过。
- `sanity_check.py --structural`：现有 base/V1/V2/verify-01 清单通过。
- `check_ac_validity_1c.py --self-test`：base 计划 5×2=10 / 3×1=3，12 个负例全部 fail closed（含 plugin dir/tarball 绑定、空 --only-arm）。
- `check_fixtures.py`：六类 fixture 全部 `[ok]`，最后 `FIXTURES OK`。
- 主/B1 strict dry-run：主 5 条 `[plan]` + `[preflight] OK`；B1 3 条 + `[preflight] OK`。
- `git diff --name-only`：不含 `packages/sdlc/src` 插件代码。
- **未运行**：真实模型、FeatureBench 评分、Docker 容器、无头 Chrome、sympy 镜像拉取。

### 5.3 F1–F7 整改对照（审核者 2026-11-15）

| 项 | 修改 | 复核命令 / 结果 |
|---|---|---|
| F1 主/B1 混跑 | 主 manifest 只 A/B2（5×2=10）；B1 单独 manifest（3×1=3，无 sphinx） | `check_ac_validity_1c.py --self-test` 拒绝 B1 回主 arms；主/B1 strict dry-run 5/3 条 plan |
| F2 单 plugin-dir | `--arm-plugin-dir` / `--arm-plugin-tarball` / `--strict-preflight`；`run_arm.py` 绑定 dir 与 tarball 内容 | 主 strict dry-run 输出 A/B2 不同 hash；错 hash/共享 dir/空 `--only-arm` 均非 0 |
| F3 fixture | `fixtures/ac-validity-1c/check_fixtures.py` 物化六类 repo + `unittest`；补 `__main__`、S1 订单 ID | `FIXTURES OK`；S1 `ord-3`、S2 `NoneType`、S3 `Settings.verbose`/无 `parse_date` |
| F4 handoff/preflight | 本节 §7.2/§8 给主/B1 命令、image-map、per-arm dir/tarball；`--execute` 见获批后说明 | 主/B1 strict dry-run `[preflight] OK`，无 `image=MISSING` |
| F5 S1 Oracle | fixtures doc §3.1 AC-002 与 fixture check 要求 `ord-3` | 见 F3 |
| F6 arm key | B1 manifest key=`B1`；phase1 分 `commit` 字段 | `check_ac_validity_1c.py` 校验 |
| F7 Draft PR | 本 handoff 指向 `evals/ac-validity-1c-phase0` + Draft PR；不写“工作区干净” | PR #26；base `dev@5ee68cd` |

---

## 6. Phase 1（付费；未批准）

- 固定 S-01/02/03；每场景 A/B 两臂；共 **6 次 verifier 调用**。
- 锁死输入：同一场景的 Source、criteria、diff、test_evidence、scope、代码快照、环境与工具面完全一致；只替换 `A_phase1=085c8fd` / `B_phase1=5ee68cd` 的 verifier prompt。
- 记录：run_id、verdict、findings、工具执行、Token、耗时；人工核对 finding 是否可复现。
- 预算：≤8M Token / 2h；单次 ≤2M；超限停止，不重试。
- Fixture 的单一物化/行为检查命令、`sdlc_verify` 参数见 [offline fixtures](ac-validity-1c-offline-fixtures.md) §3；完整 DSH 命令见该文 §4。

**Phase 1 关键启动/驱动命令（获批后；与 offline fixtures §4.2 使用同一 DSH_HOME 约定）：**

| arm | commit | tarball sha256 | DSH_HOME | plugin 目录 | workspace root | web / CDP |
|---|---|---|---|---|---|---|
| A | `085c8fd` | `106247171248772794bd0ac99fa20ea9e2ff42d29d04a79e3032241158d27784` | `/tmp/phase1/dsh/A` | `/tmp/phase1/plugins/A` | `/tmp/phase1/eval-root-A` | `59611` / `9222` |
| B | `5ee68cd` | `8bb74f3a8bc20be10b2b2cd704cdf6f081e64fa70a812c6d124c4823faedb404` | `/tmp/phase1/dsh/B` | `/tmp/phase1/plugins/B` | `/tmp/phase1/eval-root-B` | `59612` / `9223` |

```bash
set -euo pipefail
REPO="$(git rev-parse --show-toplevel)"
mkdir -p /tmp/phase1/dsh/A /tmp/phase1/dsh/B \
  /tmp/phase1/eval-root-A/deepseek-harness \
  /tmp/phase1/eval-root-B/deepseek-harness \
  /tmp/phase1/prompts /tmp/phase1/out

install_profile() {
  local plugin_dir="$1" eval_root="$2"
  dsh --profile web --dump-default-config >/dev/null
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

# A：085c8fd
export DSH_HOME=/tmp/phase1/dsh/A
ln -sfn /tmp/validity-1c-fixtures/S2_gap /tmp/phase1/eval-root-A/deepseek-harness/default-workspace
cd /tmp/validity-1c-fixtures/S2_gap
nohup dsh web --no-open --port 59611 --host 127.0.0.1 > /tmp/phase1/dsh/A/web.log 2>&1 &
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --headless=new --remote-debugging-port=9222 \
  --user-data-dir=/tmp/phase1/chrome-A --no-first-run about:blank &
WEB_PORT=59611 node "$REPO/tools/evals/featurebench/driver.mjs" \
  9222 "AI 原生 SDLC" /tmp/phase1/prompts/S2.txt /tmp/phase1/out/S2-A.txt

# B：5ee68cd
export DSH_HOME=/tmp/phase1/dsh/B
ln -sfn /tmp/validity-1c-fixtures/S2_gap /tmp/phase1/eval-root-B/deepseek-harness/default-workspace
cd /tmp/validity-1c-fixtures/S2_gap
nohup dsh web --no-open --port 59612 --host 127.0.0.1 > /tmp/phase1/dsh/B/web.log 2>&1 &
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --headless=new --remote-debugging-port=9223 \
  --user-data-dir=/tmp/phase1/chrome-B --no-first-run about:blank &
WEB_PORT=59612 node "$REPO/tools/evals/featurebench/driver.mjs" \
  9223 "AI 原生 SDLC" /tmp/phase1/prompts/S2.txt /tmp/phase1/out/S2-B.txt
```

- 只有维护者明确批准后才运行；A/B 的 prompt 文件、`sdlc_verify` 参数逐字相同，只换插件构建。

---

## 7. Phase 2 主实验（A vs B2；付费；未批准）

- **A vs B2**：5 任务 × 2 臂 = **10 scored runs**；每任务每臂 1 rep；顺序交替；≤120M / 8h。
- **任务**：3 个新 sympy 任务 + 2 个 sphinx 诊断任务；诊断只作回归，不进入独立收益分母。
- **主指标**：Source 层错误放行（人工 gold label，task 去重；ITT/decided/task 三套分母）。
- **守护指标**：Source 层错误拒绝、`needs_human`、无裁决/超时、scope 冲突处理、Token/墙钟、返工/复验。
- **旁证**：官方 `resolved`/`pass_rate` 单列；Source 与 Grader 冲突不等同于用户任务失败。

### 7.1 每臂身份

| 臂 | commit | tarball sha256 | 解包目录 |
|---|---|---|---|
| A | `920b0eb` | `40172ed2067b36e07fb2791a57a091240fbc8519140574f2b707d33aed87b0c1` | `plugins/A` |
| B2 | `5ee68cd` | `8bb74f3a8bc20be10b2b2cd704cdf6f081e64fa70a812c6d124c4823faedb404` | `plugins/B2` |
| B1 | `085c8fd` | `106247171248772794bd0ac99fa20ea9e2ff42d29d04a79e3032241158d27784` | `plugins/B1` |

### 7.2 主实验 strict preflight

```bash
python3 tools/evals/featurebench/run_matrix.py \
  --manifest tools/evals/featurebench/manifests/ac-validity-1c/ac-validity-1c.yml \
  --runs-root /tmp/fb-ac1c/main \
  --credentials /tmp/fb-ac1c/creds.yaml \
  --image-map "sphinx-doc/sphinx=fb-eval-rc3:sphinx" \
  --image-map "sympy/sympy=fb-eval-rc3:sympy" \
  --arm-plugin-dir "A=/tmp/ac1c/plugin/A" \
  --arm-plugin-dir "B2=/tmp/ac1c/plugin/B2" \
  --arm-plugin-tarball "A=/tmp/ac1c/pkgs/A/ai-native-sdlc-plugin-dsh-sdlc-0.6.2.tgz" \
  --arm-plugin-tarball "B2=/tmp/ac1c/pkgs/B2/ai-native-sdlc-plugin-dsh-sdlc-0.6.2.tgz" \
  --strict-preflight
```

预期：5 条 `[plan]`、`[preflight] OK: 5 tasks, arms=['A', 'B2']`、退出 0。`--strict-preflight` 缺 image-map/plugin dir/tarball/hash 时非 0；`--only-arm` 不能代替本清单。

**获批后执行**：在上面的命令末尾追加 `--execute`（不要改其他参数）；未批准不得加。执行前再核对三份 tarball sha256 与 §7.1 一致；`--allow-version-mismatch` 不能绕过 hash/目录绑定。

---

## 8. Phase 2 B1（条件性消融；单独 manifest；未批准）

- **manifest**：`ac-validity-1c-b1.yml`；B1=`085c8fd`；3 个 sympy × 1 臂 = **3 runs**；≤30M / 2h；单 run ≤10M；**不含 sphinx**。
- 触发阈值见 [preregistration §6](ac-validity-1c-preregistration.md#b1-threshold)；Phase 2 前批准。
- **单独运行命令**：

```bash
python3 tools/evals/featurebench/run_matrix.py \
  --manifest tools/evals/featurebench/manifests/ac-validity-1c/ac-validity-1c-b1.yml \
  --runs-root /tmp/fb-ac1c/b1 \
  --credentials /tmp/fb-ac1c/creds.yaml \
  --image-map "sympy/sympy=fb-eval-rc3:sympy" \
  --arm-plugin-dir "B1=/tmp/ac1c/plugin/B1" \
  --arm-plugin-tarball "B1=/tmp/ac1c/pkgs/B1/ai-native-sdlc-plugin-dsh-sdlc-0.6.2.tgz" \
  --strict-preflight
```

预期：3 条 `[plan]`、`[preflight] OK: 3 tasks, arms=['B1']`、退出 0；不得出现 sphinx。

**获批后执行**：在 B1 命令末尾追加 `--execute`；未批准不得加。B1 只在主实验触发阈值满足且预算批准后运行。

---

## 9. 审批边界

- Phase 0 三次验证均为 reject；第三次是最终授权，**不再批准第四次模型调用**。剩余三项按审核者裁决做确定性修复 + 人工验收。
- Phase 1 / Phase 2 / B1 未批准；分别申请。
- 不拉 sympy 镜像、不启动 Docker、不调用 FeatureBench，直到 Phase 1/2 获批。
- 不得按结果挑任务/样本/阈值；预注册后修改需单独提交并说明。
- 不得把官方 `resolved` 当用户目标；不得把结构合规率当质量收益；不得把 `needs_human` 增加当成功。
- 历史 8 个官方 FP 只能 provisional/conflict，3 个 FN 只能 censored；不能写“已证实 FP=0/FN=0”。

### 9.1 第三次 reject 后的确定性修复（不再跑模型）

第三次验证绑定代码 head：`401f0911797c2d1235fee015200e72e72aad437f`。之后只做以下文档/命令修复；真实 DSH 启动仍留 Phase 1 前置检查。

| 第三次 finding | 文件/位置 | 检查命令 | 结果 |
|---|---|---|---|
| Phase 1 安装/运行 DSH_HOME 不一致、`ln` 缺父目录 | `docs/evals/ac-validity-1c-offline-fixtures.md` §4.2；本文件 §6 | `check_phase1_docs.py --self-test` + 默认模式 | `PHASE1 DOCS SELF-TEST OK`；`PHASE1 DOCS OK`；A/B 安装/运行 home 一致、eval-root/log 父目录在 `ln` 前创建；负例改回不一致 home / 删 mkdir 被拒 |
| README 链接层级错误 | `tools/evals/featurebench/fixtures/ac-validity-1c/README.md` | 同一 checker 的链接检查 | 链接解析到真实文件；坏链接自测被拒 |
| case table S-01..S-06 锚点悬空 | `docs/evals/ac-validity-1c-case-table.md`；fixtures 文档 §3.1/3.2/3.3、§5.1/5.2/5.3 | 同一 checker 的锚点检查 | 六个 `#s21-1..6` 全部解析到显式 `<a id>`；缺锚点自测被拒 |

确定性回归：`check_phase1_docs.py`、`check_ac_validity_1c.py --self-test` / `--artifact-root`、`check_fixtures.py --self-test` 两遍 + 六类 fixture 两遍、`check_redaction.py`、`sanity_check.py --structural`、`npm run verify`（285+45、12 smoke）全部通过；CI 见 PR #26。**未执行** `dsh web` / Chrome / driver，也未进行第四次模型验证。

---

## 10. 已知限制 / 风险

- 三次 `sdlc_verify` 均为 reject：第三次 AC-006 `not_met`，其后只做确定性修复；**第四次模型验证不批准**，需人工 Reviewer 逐项签字。不能宣称 DONE。
- 历史 8 个官方 FP 只有 2 个任务；V1/V2 不能混算；全部 conflict，Source 层 FP 0 confirmed。
- 3 个 FN 是 censored（timeout），不能当 FN 基线。
- A vs B2 同时改变 Actor 写作与 Verifier 判断；只能报联合效果；B1 才隔离 Verifier。
- 结构合规 ≠ 交付质量。
- 小样本；零错误放行不能证明改善；不做显著性。
- 本机宿主 PATH 无 `dsh` CLI；Phase 1/2 需在容器派生镜像或已安装 dsh 的执行机运行。
- 分支保护/工具阻塞：停下报告，不绕过。

---

## 11. 交接检查清单

- [x] 核对 repo commit、Docker、featurebench 0.3.0、DSH 0.2.2-rc.3、Node/Chrome/凭据。
- [x] 核对归档与抽样 sha256；验证者复核 84/84 路径。
- [x] 历史口径修正为官方 FP 8/2、FN 3/2；Source/Grader 分开；FN censored。
- [x] 六类 fixture 物化 + 行为检查（`check_fixtures.py`）。
- [x] 主 10 runs / B1 3 runs 两份 manifest + preflight 负例自检。
- [x] 三份插件 tarball sha256 + per-arm plugin dir/hash 校验。
- [x] `npm run verify`、`sanity_check --structural`、fixture/preflight 全过。
- [x] 第二次独立 `sdlc_verify` 已运行（reject；run `0553a496…`）；新 findings 已修复。
- [x] 第三次、也是最终授权的 `sdlc_verify` 已运行（reject；run `c1904ac6…`；绑定 `401f091`）。
- [x] 第三次三项 finding 已做确定性修复；无第四次模型验证。
- [ ] 人工 Reviewer 对三项 finding 逐项签字；之后才讨论 PR 转 Ready/合并。
- [ ] 审查者核对 8 个官方 FP 的 provisional Source 层标签。
- [ ] Phase 1 / Phase 2 / B1 预算批准。

---

## 12. 需要维护者/审查者决定的问题

1. 8 个官方 FP 的 Source 层标签：approve（接受 Source 排除句）/ needs_human（排除句不足）/ reject（缺失符号属于承诺路径）。
2. 第三次 `sdlc_verify` 已 reject；三项 finding 已确定性修复。请人工 Reviewer 逐项签字；**不再申请第四次模型验证**。
3. Phase 1（8M/2h/6 calls/2M）与 Phase 2 主实验（120M/8h）、B1（30M/2h）的最终授权。
4. sympy 镜像 rebake / Phase 2 环境准备是否批准。
