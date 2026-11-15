# AC-VALIDITY-01B：离线反例与预期裁决

- **对应 issue**：[#21 AC-VALIDITY-01B](https://github.com/HMYDK/ai-native-sdlc-dsh/issues/21)
- **实现范围**：只调整 `buildVerificationPrompt()` 与定向测试；不新增 Agent/Runner/Schema。
- **证据层级**：本文是**离线设计与人工 Review 材料**，不是真实模型运行结果。AC-002/003 的真实模型行为证据尚未取得（付费 spot check 需单独预算批准）；独立 A/B 与统计结论由 #22 负责。
- **使用方式**：人工对照 prompt 与预期 verdict；未来若批准预算，按本文场景跑 1–2 个真实模型案例，记录 task/run_id、Source、verdict、findings、工具执行与可复核证据，**不宣称统计收益**。

每条场景都按 Delivery Contract 的五子节给出输入，并给出「AC 全 met 但 Outcome 仍失败」的最小反例（如适用）。

---

## 汇总表

| # | 场景 | 预期顶层裁决 | 关键理由 |
|---|---|---|---|
| 1 | 正向交付：AC 与真实入口都通过 | `approve` | 无反例、无实质证据缺口 |
| 2 | 明确遗漏：AC 全 met，但真实 CLI 仍失败 | `reject` | 已证实本次承诺的 Outcome 失败 |
| 3 | 明确局部范围：局部接口通过，外部 Grader 要求完整功能 | `approve`（附风险说明） | 已确认范围外的独立功能不因 hidden tests 扩需求 |
| 4 | 关键证据缺失：真实入口无法执行 | `needs_human` + `unverified` | 反例无法执行/决定性证据缺失，影响交付结论 |
| 5 | 无关历史失败：不同子系统的旧测试失败 | `approve`（附 `unverified`） | 无关既有失败不阻断 |
| 6 | Source/Boundary 实质歧义：是否承诺完整构建不清 | `needs_human` + `unverified` | 歧义影响目标/范围判断，先澄清 |

---

## 场景 1：正向交付

**Source**

- Issue #130：“新增 `mycli export --format csv`，字段 id、amount、status；订单缺 amount 时非零退出。”

**Outcome**

- O-1：`mycli export --format csv` 生成含表头和每笔订单一行的 CSV。
- O-2：订单缺 amount 时退出码非 0。

**Boundary**

- 承诺：CSV 导出、三个固定字段、缺字段非零退出。
- 排除：Excel/JSON 导出、字段自定义、分页。
- 假设：数据来自现有 orders 表；不新增认证。

**Oracle**

- O-1：3 笔订单夹具上运行 `mycli export --format csv --out /tmp/orders.csv`，退出码 0；文件 4 行，表头为 `id,amount,status`。
- O-2：缺 amount 的订单运行同一命令，退出码 2，错误信息包含订单 ID。

**AC mapping**

- O-1 → AC-001, AC-002
- O-2 → AC-003

**反例/证据**

- 构造不出“AC 全 met 但 O-1/O-2 仍失败”的具体反例。
- 真实入口执行通过；AC-001..AC-003 均有可复核证据。

**预期裁决**：`approve`。无 `spec_mismatch`，无阻断性 `unverified`。

**对应 prompt 规则**：无反例且无实质证据缺口 → 不制造阻断。

---

## 场景 2：明确遗漏（AC 全 met，真实入口失败）

**Source**

- Issue #131：“让 `mycli run` 在 `--date ""` 时正常退出，并修 `parse_date('')` 返回 `None`。”

**Outcome**

- O-1：`mycli run --date ""` 退出码 0，输出一条可读警告。
- O-2：`parse_date('')` 返回 `None`。

**Boundary**

- 承诺：空日期路径的 CLI 行为 + `parse_date` 返回值。
- 排除：其他日期格式扩展、无关 CLI 子命令。
- 假设：现有 `mycli run` 的调用链不变。

**Oracle**

- O-1：`mycli run --date ""` 退出码 0，输出包含 `empty date`。
- O-2：`python -c "from app.dates import parse_date; assert parse_date('') is None"` 退出码 0。

**AC mapping**

- O-1：**没有 AC**——这是一处验收缺口（AC 清单只覆盖了返回值，没有覆盖真实 CLI 行为）。
- O-2 → AC-001
- 公共回归约束：AC-002（非空日期解析结果不变）

**最小具体反例**

- AC-001 只断言 `parse_date('')` 返回 `None`；AC-002 只断言非空日期不变。两者都可以满足，但 `mycli run` 的调用方仍执行 `parse_date('').isoformat()`，没有处理 `None`。
- 结果：**列出的 AC 全部 `met`，但 O-1（真实 CLI 退出码 0 并输出警告）仍失败**；`mycli run --date ""` 抛 `AttributeError`，退出码 1。这个反例证明 AC 清单没有覆盖 Source 承诺的 CLI 行为，同时真实消费路径已经失败。

**预期裁决**：`reject`。O-1 属于 Source 明确承诺的交付目标，且真实入口已经失败，所以不是“仅 AC 不足待确认”，而是已证实的交付缺陷。finding 用 `spec_mismatch` 或 `logic_error`，同时指出缺失的 AC 和真实入口证据；evidence 写命令、输出、Source 位置和影响。

**对应 prompt 规则**：已证实真实消费入口/已确认 Outcome 失败且属本次承诺 → `reject`；AC 缺口本身若未证明失败才用 `needs_human`。

---

## 场景 3：明确局部范围（外部 Grader 要求更多）

**Source**

- Issue #132：“只修 `parse_date()` 对空字符串返回 `None`，不改调用方和 API；完整 CLI 重写不在本任务范围。”

**Outcome**

- O-1：`parse_date('')` 返回 `None`。
- O-2：非空合法日期的解析结果不变。

**Boundary**

- 承诺：只改 `app/dates.py::parse_date` 的空字符串分支。
- 排除：调用方重构、CLI 重写、日期格式扩展；依据是 Source 明确限定。
- 假设：其他调用方只依赖现有返回类型。

**Oracle**

- O-1：`python -c "from app.dates import parse_date; assert parse_date('') is None"` 退出码 0。
- O-2：现有日期解析测试全绿。

**AC mapping**

- O-1 → AC-001, AC-002
- 公共回归约束：AC-003（现有测试保持通过）

**反例/证据**

- 外部 Grader 还运行一个“完整 CLI 重写”隐藏测试，该测试因另一个独立旧 bug 失败；Source 和 Boundary 明确排除 CLI 重写。
- 本任务的局部接口通过；该隐藏测试不由本任务承诺，不能据此把 AC 扩成完整 CLI。

**预期裁决**：`approve`，在 `unverified` 里记录“外部 Grader 的完整 CLI 测试失败，但已确认超出 Source 范围，仅作风险”。不 `reject`，不偷偷加 AC。

**对照**：如果该 CLI 是本任务承诺的局部接口的唯一真实消费路径，失败就不能用 out-of-scope 免除；按场景 2 处理（reject/needs_human）。本场景的 approve 只成立于「外部 CLI 与已承诺路径无关」被确认。

**对应 prompt 规则**：已确认只涉及 Source/Boundary 明确排除、且与已承诺路径无关的独立功能 → 记录外部评分风险，不单独阻断 `approve`；真实入口/必要依赖失败仍不得 `approve`。

---

## 场景 4：关键证据缺失

**Source**

- Issue #133：“恢复 `foo()` 并让 `mycli run` 正常调用它。”

**Outcome**

- O-1：`mycli run` 能正常完成，不抛异常。

**Boundary**

- 承诺：`foo()` 恢复 + `mycli run` 调用路径可用。
- 排除：其他子命令。
- 假设：本机具备运行 `mycli` 所需的原生依赖。

**Oracle**

- O-1：`mycli run` 退出码 0，输出 `ok`。

**AC mapping**

- O-1 → AC-001（`foo()` 存在）
- O-1 → AC-002（`mycli` 的调用点存在）

**反例/证据**

- AC-001/AC-002 都 `met`（静态检查通过），但本机缺少一个原生依赖，`mycli run` 无法执行；没有可复核的真实入口结果。
- 没有实际失败证据，也没有成功证据；无法判断 Outcome 是否满足。

**预期裁决**：`needs_human` + `unverified`。不 `reject`（没有证实缺陷），也不 `approve`（关键证据缺失）。如能修复运行环境，重新执行真实入口。

**对应 prompt 规则**：关键真实入口无法执行或决定性证据缺失 → `unverified`；影响交付结论时 `needs_human`，不得默认 `approve`。

---

## 场景 5：无关历史失败

**Source**

- Issue #134：“给 `foo()` 增加参数校验；非法输入返回错误，合法输入保持原行为。”

**Outcome**

- O-1：非法输入返回可读错误。
- O-2：合法输入行为不变。

**Boundary**

- 承诺：`foo()` 的参数校验和错误路径。
- 排除：其他子系统。
- 假设：现有合法输入路径保持兼容。

**Oracle**

- O-1：`python -c "from app.foo import foo; foo(-1)"` 退出码非 0，错误信息可读。
- O-2：现有 `foo` 测试全绿。

**AC mapping**

- O-1 → AC-001
- O-2 → AC-002

**反例/证据**

- 交付功能通过；另一个子系统的一个旧测试在改动前的基线也失败，与本任务无关。

**预期裁决**：`approve`，在 `unverified` 里记录“无关子系统旧失败，基线同样存在”。不 `reject`。

**对应 prompt 规则**：无关既有失败 → 留证，不自动拒绝。

---

## 场景 6：Source/Boundary 实质歧义

**Source**

- Issue #135：“恢复与 gettext 构建相关的必要符号；具体接口范围、最小构建夹具和验收口径待确认。”
- 任务说明没有明确承诺某一个 `python -m sphinx -b gettext` 命令必须成功，也没有列出完整符号范围。

**Outcome**

- O-1：未明确——需要先澄清恢复哪些符号、用哪个最小构建夹具、是否以真实 builder 成功为验收。

**Boundary**

- 未明确排除/承诺哪些符号；`add_uids`、`extract_messages` 是否属于范围需要澄清。

**Oracle**

- 未确定：接口级测试，还是某个真实 builder 命令。

**AC mapping**

- 只映射了四个接口；真实构建行为没有 AC。

**反例/证据**

- 四个接口都 `met`；真实 builder 因 `add_uids` 缺失失败；但 Source 没有明确承诺该构建范围/口径，失败不能直接判为本次交付缺陷。

**预期裁决**：`needs_human` + `unverified`。不自行把 `add_uids` 加成 AC（扩需求），也不因 Source 自洽而 `approve`。把范围、最小构建夹具、失败命令和缺失符号交给人类澄清。

**对照 #20 3A/3B**：如果 Source 明确承诺最小 gettext 构建可用（3B），真实构建失败就是交付缺陷，预期 `reject`；只有构建范围/环境/证据不确定时才 `needs_human`。本场景属于后者。

**对应 prompt 规则**：Source/Boundary 实质歧义 → `needs_human` + `unverified`；只在影响交付结论时阻断；不能用 out-of-scope 免除真实目标功能失败。

---

## 人工 Review 检查清单

- [ ] 每条场景的 Source/Outcome/Boundary/Oracle/AC mapping 是否完整、可追溯。
- [ ] 场景 2 的最小反例是否真能“AC 全 met 但 Outcome 失败”，并有真实入口证据。
- [ ] 场景 3 是否明确“范围外独立功能”而非“真实消费路径的一部分”；后者按 #16 处理。
- [ ] 场景 4 是否没有把“无法执行”误写成 `reject` 或 `approve`。
- [ ] 场景 5 的失败是否确实与本任务无关、在基线上也失败。
- [ ] 场景 6 是否没有偷偷扩 AC；是否交还人类。
- [ ] 所有结论是否只基于 prompt 规则与人工推演；真实模型行为仍标注“未取得”。

## 真实模型 Spot Check（未执行，预算未批）

如维护者批准预算，建议只跑场景 2 与场景 3（相反预期），记录：

- task/run_id、模型、DSH/插件版本；
- 原始 Source 与 Delivery Contract；
- 最终 verdict、findings、`unverified`；
- 实际执行的命令/输出与可复核文件；
- 明确标注这是行为观察，不是统计性质量结论；A/B 留 #22。
