# Spec: 恢复 gettext helpers

## Delivery Contract

### Source
原始任务见 source.md，逐项接口约定以其原文为准。

### Outcome
- O-1: 四个接口可被调用，返回 source.md 中约定的结果。
- O-2: 对规定的最小文档夹具构建 gettext 成功，产出含 Hello 的消息目录。

### Boundary
承诺四个接口的行为恢复；不扩展原文明确排除的输入类型。
构建所必需的依赖属于范围，不以未点名为由排除；只覆盖原文规定的夹具，不扩展到所有项目、版本或 builder。

### Oracle
在标准库 unittest 中导入 app.gettext_helpers 的四个接口，对 AC-001 至 AC-004 的每组输入执行 assertEqual，全部通过。
另外创建原文规定的 docs/index.rst，运行 python -m sphinx -b gettext docs out，断言退出码 0，读取 out/index.pot 检查 msgid "Hello"。输入夹具和具体命令与 source.md 一致；失败保留异常作为证据。

### AC mapping
- O-1 → AC-001、AC-002、AC-003、AC-004
- O-2 → AC-005、AC-006

## Acceptance Criteria
- AC-001: add(2, 3) == 5 且 add(-2, 3) == 1。
- AC-002: render("x") == "<x>" 且 render("") == "<>"。
- AC-003: extract("a b") == ["a", "b"]，extract("  a\tb  ") == ["a", "b"]，extract("") == []。
- AC-004: normalize("  x  ") == "x" 且 normalize("  ") == ""。
- AC-005: source.md 规定的最小 gettext 构建命令退出码 0。
- AC-006: 该构建产出的 out/index.pot 包含 msgid "Hello"。

## Requirements
按 source.md 的约定恢复四个接口。
同时使规定的最小 gettext 构建可用。

## Design
分别实现加法、尖括号包裹、无参数 split 和 strip。实现后用 Oracle 中的具体断言验证。
通过最小构建定位并修复必要依赖；不预先排除未点名符号。

## Areas of concern
新需求需要来源依据；不把外部评分器或泛化最佳实践加入承诺。
