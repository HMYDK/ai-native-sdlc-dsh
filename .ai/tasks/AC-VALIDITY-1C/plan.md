# Plan: 用独立反例与 FeatureBench A/B 判定验收有效性提升及成本（Phase 0）

## Files that change

- `docs/evals/ac-validity-1c-case-table.md` / `.json`：历史 11 + 合成 6；官方 FP 8/2、FN 3/2；Source 依赖核验；0 confirmed ≠ 已证实 FP=0。
- `docs/evals/ac-validity-1c-offline-fixtures.md`：六类 fixture 的单一可执行命令、Phase 1 参数、DSH 运行面。
- `tools/evals/featurebench/fixtures/ac-validity-1c/check_fixtures.py`（新增）：生成六类 git repo + `unittest` 行为检查。
- `docs/evals/ac-validity-1c-preregistration.md`：主 10 runs + B1 3 runs 分开；身份链、preflight、停止/决策。
- `tools/evals/featurebench/manifests/ac-validity-1c/ac-validity-1c.yml`：只 A/B2，5 任务 = 10 runs。
- `tools/evals/featurebench/manifests/ac-validity-1c/ac-validity-1c-b1.yml`（新增）：只 B1，3 sympy = 3 runs，无 sphinx。
- `tools/evals/featurebench/check_ac_validity_1c.py`（新增）：计划/身份/预算/preflight 自检。
- `tools/evals/featurebench/run_matrix.py`：`--arm-plugin-dir` / `--arm-plugin-tarball` / `--strict-preflight` / 每臂 hash。
- `tools/evals/featurebench/run_arm.py`：`--plugin-tarball` / `--expected-plugin-sha256` / meta 身份字段。
- `.github/workflows/ci.yml`：`evals-check` 加 preflight 自检 + fixture 检查（不调模型/容器）。
- `docs/evals/ac-validity-1c-budget.md`：Phase 0 第二次 verify、Phase 1/2/B1 预算。
- `docs/evals/ac-validity-1c-handoff.md`：两份 manifest、每臂身份、image-map、主/B1 命令、Draft PR、F1–F7。
- `.ai/tasks/AC-VALIDITY-1C/`：intent/spec/plan、两轮 verification；不改 `packages/sdlc` 插件代码。

## Order of work

1. **F1 拆计划**：主 manifest 只 A/B2（5×2=10）；B1 单独 manifest（3×1=3，无 sphinx）；`plan` 字段、预算、触发指针一致。
2. **F2 身份链**：构建 A=`920b0eb`、B2=`5ee68cd`、B1=`085c8fd` 三份 tarball；记录 sha256；解包目录 + `js-yaml`；manifest 绑定；`run_matrix.py`/`run_arm.py` 支持 per-arm dir + hash 校验；负例 fail closed。
3. **F3 fixture**：`check_fixtures.py` 生成六类 repo；S1 补订单 ID；S2/S3/S4/S5/S6 检查真实入口/测试；单一命令 `FIXTURES OK`。
4. **F4 preflight/handoff**：`check_ac_validity_1c.py` 计划/身份/预算检查 + `--self-test` 负例；主/B1 strict dry-run；handoff 写 image-map、per-arm dir、命令、Draft PR。
5. **F5/F6/F7**：S1 Oracle 补 `ord-3`；B1 manifest arm key=`B1`，phase1 分 commit；handoff 改掉“工作区干净”，写独立分支 + Draft PR。
6. **Source 依赖核验**：只读归档核对 gettext/doctest 承诺接口、缺失符号、F2P 通过/失败；不写 FP=0/FN=0。
7. **CI**：`evals-check` 加 `check_ac_validity_1c.py --self-test` 与 `check_fixtures.py`。
8. **确定性检查**：`sanity_check --structural`、`check_ac_validity_1c --self-test`、`check_fixtures`、主/B1 strict dry-run、`npm run verify`、负例（缺 image-map/错 hash/共享 dir/B1 回主 manifest）。
9. **Draft PR**：从 `dev@5ee68cd` 建 `evals/ac-validity-1c-phase0`，提交 F1–F7 修复与首次 reject 记录；开 Draft PR，列 base/head、修复对照、未实测项；不合入 dev。
10. **第二次 `sdlc_verify`**：1 call / ≤2M / ≤30min / 不重试；记录 verdict；若 approve，将 verification 提交到 PR 分支；若 reject，如实报告，不自动重跑。

## Risks

- **首次 reject 仍未关闭**：AC-002/AC-003 需第二次独立验证；作者自评不能代替。
- **Source 依赖仍是 provisional**：静态核对只能说明“未证明是承诺路径必要依赖”，不能替审查者签字；不得写 FP=0/FN=0。
- **三份 tarball 是本地构建产物**：hash 已固定，但真实容器注入/effective preset 只能 Phase 2 核实；Phase 0 只做离线身份检查。
- **sympy 镜像未拉**：10.65GB；Phase 2 前需批准并 rebake；不得在 Phase 0 拉取。
- **B1 阈值未批准**：Phase 0 起草；Phase 2 前批准；不能按结果调。
- **fixture 只证明仓库行为**：不证明 verifier 裁决；Phase 1 的真实模型行为仍需预算。
- **runner 改动兼容性**：旧 `--plugin-dir` 调用必须保留；per-arm hash 校验不能被 `--allow-version-mismatch` 绕过。
- **Draft PR 分支保护**：若推送/PR 被阻止，停下报告，不绕过。
- **第二次 verify 预算**：1 call / 2M / 30min；不重试；若 reject，本轮不能 DONE。

## Proof

- **Case table**：JSON 断言官方 FP 8/2、FN 3/2、Source 层 confirmed=0、6 合成；8 FP `conflict`+`pending_reviewer`，3 FN `censored`；`source_dependency_analysis` 存在；文本不写“已证实 FP=0/FN=0”。
- **Fixtures**：`python3 tools/evals/featurebench/fixtures/ac-validity-1c/check_fixtures.py --workdir /tmp/validity-1c-fixtures` 退出 0，最后 `FIXTURES OK`；六类 `[ok]`；S1 含 `ord-3`；S2 是 `NoneType`；S3 是 `Settings.verbose` 且不含 `parse_date`。
- **F1/F2/F3**：主 manifest plan 10；B1 plan 3 且无 sphinx；三份 tarball sha256 与 manifest 一致；主/B1 strict dry-run 输出 5/3 条 plan + `[preflight] OK`；缺 image-map/错 hash/共享 dir/B1 加回主 arms 均非 0（`--self-test` + 命令行负例）。
- **F4**：handoff 含两份 manifest、每臂 commit/hash/dir、image-map、主/B1 命令、Phase 1 fixture/DSH、Draft PR、F1–F7；不写“工作区干净”。
- **F5/F6/F7**：S1 AC-002 含 `ord-3`；B1 manifest arm key `B1`；phase1 `commit` 字段分离；Draft PR 分支/base 写明。
- **回归**：`cd packages/sdlc && DSH_APP="$DSH_APP" npm run verify` 通过；`sanity_check --structural` 通过；CI `evals-check` 含确定性检查；`git diff --name-only` 不含 `packages/sdlc/src`。
- **独立验证**：第二次 `sdlc_verify` 1 次，逐项 AC 与 findings 保存在任务目录；不宣称 DONE。
- **诚实边界**：Phase 1/2/B1 未运行；sympy 镜像未拉；真实容器/preset 未验证；官方 resolved 只作旁证。
