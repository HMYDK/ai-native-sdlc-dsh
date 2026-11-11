# 版本回归：plugin 0.6.1 / DSH 0.2.2-rc.1 vs 0.6.0 / 0.2.1（最小回归，2026-11-08）

- 目的：用户确认升级 App 与插件后，验证**新版本是否出现正确率/成本回归**（最小回归，10 runs）。
- 预注册：[`../../tools/evals/featurebench/manifests/regression-0.6.1/mvp.yml`](../../tools/evals/featurebench/manifests/regression-0.6.1/mvp.yml)
  （任务/arms 与首批 `manifest.yml` 一致，只更新 runtime 版本与预算 300M）
- 环境：plugin **0.6.1** + DSH CLI **0.2.2-rc.1**；镜像 `fb-eval-base-061:*`（新烤）；
  dataset v1.1 / deepseek-flash(max) / 单 run 45min、40M token 上限不变
- 基线：首批 2026-11-06（plugin 0.6.0 / DSH 0.2.1-rc.5），同 5 任务 × A/B

## 结果（官方 fb eval）

| 任务 | A 旧版 | A 新版 | B 旧版 | B 新版 |
|---|---|---|---|---|
| pypa/packaging | ✅ 100% | ❌ **98.64%** | ✅ 100% | ✅ 100%（timeout，补丁通过） |
| pytest-dev/pytest | ✅ 100% | ✅ 100%（turn_error，补丁通过） | ✅ 100% | ✅ 100% |
| pydantic/pydantic | ✅ 100% | ✅ 100% | ✅ 100% | ✅ 100% |
| mwaskom/seaborn | ✅ 100% | ✅ 100% | ✅ 100%（timeout） | ✅ 100%（timeout） |
| sphinx-doc/sphinx | ❌ 7.69% | ❌ **53.85%** | ❌ 7.69% | ❌ 7.69% |
| **resolved** | **4/5** | **3/5** | **4/5** | **4/5** |
| 平均 F2P | 0.815 | 0.905 | 0.815 | 0.815 |

- **B（SDLC+引导）没有回归**：仍是 4/5 resolved；
- A 少的 1 个是 packaging 的 **98.64% 边缘失败**（13 个测试里差 1 个），属于单次运行波动，不是系统性破坏；
- sphinx A 的 F2P 从 7.69% 提升到 53.85%（仍 unresolved）；B 不变。

### 配对差异（新版）

B 独有胜 1（packaging）、A 独有胜 0、平 4 → 新版本 B−A 净 +1；旧版是 5 平。仍是边缘个例，不能当 treatment effect。

## 成本与耗时（新版明显更贵）

| 任务/臂 | 旧 token | 新 token | 倍数 | 备注 |
|---|---|---|---|---|
| packaging A | 7.7M | 20.9M | **2.7×** | 1396s（旧 370s） |
| packaging B | 9.5M | 28.4M* | **3.0×** | 45min timeout |
| pytest A | 3.3M | 4.7M | 1.4× | turn_error |
| pytest B | 13.4M | 12.2M | 0.9× | |
| pydantic A | 8.5M | 10.5M | 1.2× | |
| pydantic B | 13.5M | 15.8M | 1.2× | |
| seaborn A | 2.2M | 2.2M | 1.0× | |
| seaborn B | 2.9M | 14.8M* | **5.1×** | 45min timeout |
| sphinx A | 1.2M | 10.5M | **8.5×** | F2P 也提高到 53.85% |
| sphinx B | 8.1M | 4.9M | 0.6× | |
| **总计** | **70.4M** | **124.9M*** | **1.77×** | `*` 为 session 口径（timeout 运行 UI 读数缺失） |

- 总 token **+77%**；耗时也变长（A 单 run 从 305–370s 升到 410–1396s），新版有 **2 次 45min timeout**（旧版 1 次）。
- 成本上升集中在 packaging / sphinx / seaborn-B；pytest、pydantic 基本不变，sphinx B 反而变便宜。
- 注意：新版实测单 run 波动大（pilot 的 packaging A 20.9M，而旧版同任务 7.7M），所以“成本回归”更准确的描述是：**相同任务下 token 可能涨 2–8 倍，但不是所有任务都涨**。

## 验证者（新版）

5 次 B 运行中：3 次与官方一致、**2 次不一致**——
- `sphinx`：approve×4 但官方 unresolved（**假阳性**，与旧版一致的老问题）；
- `seaborn`：最终 reject 但官方 resolved（**假阴性**，新版新增观察）。

与旧版结论一致：验证者 approve 不能当成绩；新版没有改善，甚至出现假阴性案例。

## 兼容性/工程

- 新版 driver 需要一处适配：DSH 0.2.2 的「预览版说明」引导弹层在点「新建会话」后才出现，会挡住 preset 菜单；已修复并提交（driver 先循环关闭弹层再选 preset）。
- 版本探测在每次运行记录 `dsh_cli_actual=0.2.2-rc.1` / `plugin_version_actual=0.6.1`，与 manifest 一致（不一致会按 infra 失败）。
- 旧版 `fb-eval-base:*` 镜像仍保留，新版本用 `fb-eval-base-061:*`，互不覆盖。

## 结论

1. **升级没有造成正确率回归**：B 组保持 4/5；A 组少 1 个是 98.64% 的单个测试边缘失败，不能判定为系统性回归。
2. **升级带来了成本上升**：同任务 token 1.0–8.5×，总体 **+77%**（70.4M → 124.9M），并出现更多 45min timeout。这是 **运营层面的回归**，不是正确率回归。
3. **旧结论不变**：A/B 正确率没有稳定差异（新版净 +1 对，仍是边缘）；B 成本更高；验证者 approve 不可靠（新版同时出现假阳性与假阴性）。
4. 若继续用新版本做正式实验，应按新成本重估预算（约为旧版的 1.8–2×），并考虑放宽 45min/40M 上限，避免 timeout 截断。

## 产物

- runs：`/tmp/fb-runs-regression-mvp/<task_id>/<arm>/`
- 官方评分：同目录 `eval-<arm>/report.json`
- 机读：[`featurebench-2026-11-08-version-regression-data.json`](featurebench-2026-11-08-version-regression-data.json)
- 预注册清单：[`../../tools/evals/featurebench/manifests/regression-0.6.1/mvp.yml`](../../tools/evals/featurebench/manifests/regression-0.6.1/mvp.yml)

## 预算

本轮 10 次运行 UI/session 口径 **124.9M token**（用户选择最小回归，上限 300M）。
累计（含前两轮）约 **787 + 125 ≈ 912M / 1B**。
