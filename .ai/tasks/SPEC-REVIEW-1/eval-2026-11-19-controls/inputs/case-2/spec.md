# Spec: 恢复 gettext helpers

## Delivery Contract

### Source
原始任务见 source.md，逐项接口约定以其原文为准。

### Outcome
- O-1: 四个接口可被调用，返回 source.md 中约定的结果。

### Boundary
承诺四个接口的行为恢复；不扩展原文明确排除的输入类型。
排除完整 gettext 构建、add_uids、extract_messages 及其他符号修复；本次仅处理这四个已列出的接口。

### Oracle
在标准库 unittest 中导入 app.gettext_helpers 的四个接口，对 AC-001 至 AC-004 的每组输入执行 assertEqual，全部通过。

### AC mapping
- O-1 → AC-001、AC-002、AC-003、AC-004

## Acceptance Criteria
- AC-001: add(2, 3) == 5 且 add(-2, 3) == 1。
- AC-002: render("x") == "<x>" 且 render("") == "<>"。
- AC-003: extract("a b") == ["a", "b"]，extract("  a\tb  ") == ["a", "b"]，extract("") == []。
- AC-004: normalize("  x  ") == "x" 且 normalize("  ") == ""。

## Requirements
按 source.md 的约定恢复四个接口。

## Design
分别实现加法、尖括号包裹、无参数 split 和 strip。实现后用 Oracle 中的具体断言验证。

## Areas of concern
新需求需要来源依据；不把外部评分器或泛化最佳实践加入承诺。
