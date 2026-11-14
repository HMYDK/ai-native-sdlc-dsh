# 交付契约（Delivery Contract）示例与边界

`spec.md` 在 `## Acceptance Criteria` 之前有一个唯一的 `## Delivery Contract`，固定五个 `###` 子节：`Source`、`Outcome`、`Boundary`、`Oracle`、`AC mapping`。它的用途是给下游验证者（#21）一个稳定、可引用、可版本化的锚点，让「原始目标 → AC → 真实执行证据」可以相互追溯。

**它不是语义保证，也不是状态推进硬门禁。** `sdlc_artifact_check` 只检查五个子节是否存在、是否为空、是否残留占位符；`sdlc_task_advance` 不调用 `checkArtifact`，Actor 直接写 `spec.md` 仍可绕过。Source 是否真实、Outcome 是否充分、AC mapping 是否完整，由独立验证者和人核对。

---

## 模板

```markdown
## Delivery Contract

### Source
引用原始需求/Issue/文档，并给出可追溯位置（URL、文件路径或原文摘录）。
来源不可取得或含糊时写「待确认：具体问题」，不要编造。

### Outcome
- O-1: 最终消费者可观察的结果（不是“实现某函数”）
- O-2: ...

### Boundary
- 承诺：本次交付包含什么
- 排除：明确不包含什么，依据是什么
- 假设：依赖的前提；范围变化要有依据

### Oracle
- O-1: 代表性真实调用命令 + 预期结果
- O-2: ...

### AC mapping
- O-1 → AC-001, AC-002
- O-2 → AC-003
```

规则：

- `## Acceptance Criteria` 仍是唯一权威 AC 清单；`AC mapping` 只引用它的 AC ID，不复制第二份清单。
- hidden tests / 官方 Grader 不是用户承诺，除非 Source 明确引用；范围冲突写进 `Areas of concern`，不要偷偷扩 AC。
- Oracle 选择**一条有代表性的真实消费路径**，不默认跑全项目 E2E；它和 #16 的交付路径检查是同一个输入。
- 结构完整 ≠ 语义充分；五个子节都在，也可能全是空话。

---

## 示例 1：正常功能（CLI 导出 CSV）

```markdown
# Spec: 订单导出 CSV

## Delivery Contract

### Source
- Issue #123 原文：“运营需要一个命令把订单导出为 CSV，字段包含 id、amount、status。”
- 可追溯：https://example.com/issues/123

### Outcome
- O-1: 运行 `mycli export --format csv` 会生成 CSV，含表头 id,amount,status，每笔订单一行。

### Boundary
- 承诺：CSV 导出、三个固定字段、缺字段时非零退出。
- 排除：Excel/JSON 导出、字段自定义、分页。
- 假设：订单数据来自现有 `orders` 表；不新增认证。
- 依据：Issue #123 明确只要求 CSV。

### Oracle
- O-1: 在 3 笔订单夹具上运行 `mycli export --format csv --out /tmp/orders.csv`，退出码 0；文件 4 行（含表头），字段顺序正确。

### AC mapping
- O-1 → AC-001, AC-002, AC-003

## Acceptance Criteria
- AC-001: 命令生成 CSV 文件，首行为 id,amount,status。
- AC-002: 每笔订单占一行，字段值与订单数据一致。
- AC-003: 订单缺少 amount 时退出码非 0，并输出可读错误。

## Requirements
支持运营导出订单 CSV。

## Design
复用现有 orders 查询；新增 CSV 序列化；错误路径返回退出码 2。

## Areas of concern
大数据量下的内存占用；订单字段缺失时的错误信息是否包含订单 ID。
```

---

## 示例 2：只修局部接口

```markdown
# Spec: 修复 parse_date 对空字符串的处理

## Delivery Contract

### Source
- Issue #124 原文：“只修 parse_date() 对空字符串返回 None，不改调用方和 API。”
- 可追溯：https://example.com/issues/124

### Outcome
- O-1: `parse_date('')` 返回 `None`；`parse_date('2026-11-14')` 的现有行为不变。

### Boundary
- 承诺：只改 `app/dates.py::parse_date` 的空字符串分支。
- 排除：调用方重构、日期格式扩展、API 变更。
- 假设：其他调用方只依赖现有返回类型。
- 依据：Issue #124 明确限定局部接口。

### Oracle
- O-1: `python -c "from app.dates import parse_date; assert parse_date('') is None"` 退出码 0；现有日期解析测试全绿。

### AC mapping
- O-1 → AC-001, AC-002

## Acceptance Criteria
- AC-001: `parse_date('')` 返回 `None`，不抛异常。
- AC-002: 非空合法日期的解析结果与修改前一致。
- AC-003: 现有日期解析测试保持通过。

## Requirements
按 Issue #124 只修 `parse_date` 的空字符串分支。

## Design
在 `parse_date` 入口增加空字符串短路；不动调用方。

## Areas of concern
外部“完整日期功能”测试若要求新格式，属于另一项需求；不在本任务偷加 AC，必要时升级为 needs_human。
```

---

## 示例 3：原始需求 vs 外部评分冲突

这个例子对应 VERIFY-01 里的 sphinx gettext 假阳性：任务说明只要求恢复列出的接口，而官方隐藏测试还要求其他被剥离的符号。

```markdown
# Spec: 恢复 gettext builder 的列出的接口

## Delivery Contract

### Source
- 任务说明原文：“恢复以下四个接口，使最小 gettext 构建可用：A、B、C、D。”
- 可追溯：任务说明/Issue 摘录（见任务目录的 source 引用）。

### Outcome
- O-1: 四个列出的接口可导入，且最小文档夹具的 gettext builder 可运行。

### Boundary
- 承诺：只恢复 A、B、C、D 四个接口。
- 排除：`add_uids`、`extract_messages` 及其他被剥离符号；依据是 Source 只列出四个接口。
- 假设：官方隐藏测试可能要求更多符号；这是范围冲突，不是本任务已确认的需求。
- 范围变化：如果把官方隐藏测试的要求加入 AC，必须有 Source 依据或人类确认。

### Oracle
- O-1: 在最小文档夹具上运行 `python -m sphinx -b gettext docs /tmp/out`；四个接口的导入与最小构建路径可执行。

### AC mapping
- O-1 → AC-001, AC-002, AC-003, AC-004
- 未映射：`add_uids`、`extract_messages`（在 Boundary 中排除，不偷偷加成 AC）

## Acceptance Criteria
- AC-001: A 可导入并可调用。
- AC-002: B 可导入并可调用。
- AC-003: C 可导入并可调用。
- AC-004: D 可导入并可调用。

## Requirements
恢复 Source 列出的四个接口，使最小 gettext 构建可用。

## Design
按接口逐个恢复；不扩大符号范围。

## Areas of concern
官方隐藏测试要求 `add_uids` 等未列出的符号；若真实构建入口因这些符号失败，按 #16 记录为交付路径风险，并按 #21 的范围冲突规则使用 needs_human。不要把隐藏测试直接当成用户承诺。
```

---

## 结构检查与迁移边界

- 检查器验证 `## Delivery Contract` 唯一、位于 `## Acceptance Criteria` 之前、五个 `###` 子节存在、非空、无占位符/骨架注释；不做语义判断。
- 第一个 `###` 之前的段首也会检查占位符/骨架注释；重复的 Delivery Contract 直接报错，避免下游只读到第一个。
- `Delivery Contract` 必须放在 `## Acceptance Criteria` 之前；否则 `###` 子标题会落进验收章节，`parseSpecAcceptance` 会把它们当成非法续行。
- 旧任务不会被自动重写。旧 Spec 在 `sdlc_artifact_check` 下会报缺章；更新在途 Spec 需要 `overwrite: true`，并因 Spec 指纹变化记录退回 SPEC、重新登记 AC。
- 旧骨架不再匹配 `isUnmodifiedSkeleton`，同样需要显式 `overwrite: true`。
- 三个示例是人工评审材料，不是自动化行为测试；真实模型是否遵守 Source/Boundary 由 #22 的评测检验，不在本项宣称。
