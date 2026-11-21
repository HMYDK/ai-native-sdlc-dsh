# Spec: 有限输入域的四个接口

## Delivery Contract

### Source
见 source.md 的受控原始任务说明，完整列举本次承诺的 9 组输入输出。

### Outcome
- O-1: app.gettext_helpers 的四个接口在原文列举的 9 组输入上返回约定结果。

### Boundary
只承诺 Source 明确列举的有限输入域。包括同类型其他取值在内，域外行为不作要求。不引入完整 gettext 构建、额外符号、CLI 或外部环境。

### Oracle
使用标准库 unittest 导入四个接口，对 Source 的全部 9 组输入逐一 assertEqual；用例表与 Source 逐项核对，不能遗漏或用任意新增输入替代。该有限域以外没有验收要求。

### AC mapping
- O-1 → AC-001、AC-002、AC-003、AC-004

## Acceptance Criteria
- AC-001: add(2, 3) == 5 且 add(-2, 3) == 1。
- AC-002: render("x") 返回按 U+003C、U+0078、U+003E 顺序且各一次拼接的字符串，render("") 返回按 U+003C、U+003E 顺序且各一次拼接的字符串。
- AC-003: extract("a b") == ["a", "b"]，extract("  a\tb  ") == ["a", "b"]，extract("") == []。
- AC-004: normalize("  x  ") == "x" 且 normalize("  ") == ""。

## Requirements
字符串字面量按 Python 语法解释，\t 为一个 U+0009 制表符；返回字符串为精确完整值，不包含额外字符。实现 Source 中全部 9 组输入输出。没有未列输入的通用算法承诺。

## Design
按 Source 的有限输入域实现四个接口，并用 Oracle 的完整枚举验证。具体实现算法由实现者决定。

## Areas of concern
新增输入或完整构建属于范围变化，须有新的需求依据。不要把当前有限域任务扩成通用算法任务。
