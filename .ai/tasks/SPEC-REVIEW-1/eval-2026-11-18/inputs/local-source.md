# 原始任务说明（受控案例）
只恢复以下四个接口的行为，不要求完整 gettext 构建。

四个接口位于 app.gettext_helpers：
- add(a, b)：本次承诺整数加法；验收 add(2, 3) == 5、add(-2, 3) == 1。
- render(value)：为字符串加一对尖括号；验收 render("x") == "<x>"、render("") == "<>"。
- extract(message)：按 Python str.split() 的无参数语义拆词；验收 extract("a b") == ["a", "b"]、extract("  a\tb  ") == ["a", "b"]、extract("") == []。
- normalize(value)：按 Python str.strip() 的无参数语义去首尾空白；验收 normalize("  x  ") == "x"、normalize("  ") == ""。
非上述输入类型的错误处理不属于本次承诺。

本任务的交付方是直接调用上述接口的代码。完整 gettext 构建、add_uids、extract_messages 及其他独立符号的修复不在范围内。验收以以上明确列出的输入输出为准，不要求新增外部环境、CLI 或完整 builder 检查。
