# 原始任务说明（受控案例）
恢复必要的接口，使最小 gettext 构建可用。

四个接口位于 app.gettext_helpers：
- add(a, b)：本次承诺整数加法；验收 add(2, 3) == 5、add(-2, 3) == 1。
- render(value)：为字符串加一对尖括号；验收 render("x") == "<x>"、render("") == "<>"。
- extract(message)：按 Python str.split() 的无参数语义拆词；验收 extract("a b") == ["a", "b"]、extract("  a\tb  ") == ["a", "b"]、extract("") == []。
- normalize(value)：按 Python str.strip() 的无参数语义去首尾空白；验收 normalize("  x  ") == "x"、normalize("  ") == ""。
非上述输入类型的错误处理不属于本次承诺。

最小构建的具体验收：在依赖已安装的项目环境中，对 docs/index.rst（内容为标题 Hello 及其合法下划线）运行 python -m sphinx -b gettext docs out，退出码 0，out/index.pot 含 msgid "Hello"。可以补全达到这个结果所必需的依赖。仅承诺这个最小夹具，不要求任意项目、所有 Sphinx 版本或其他 builder 兼容。
