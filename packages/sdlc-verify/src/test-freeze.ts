/**
 * 测试文件识别与"冻结期间禁止改动测试"的判定逻辑。
 *
 * 刻意做成纯函数、无 DSH 依赖，这样可以脱离 harness 单测。
 * 这是 bug 修复闭环的核心保护：
 *
 *   Bug → 写失败的测试 → 确认复现 → **冻结测试** → 改产品代码 → 测试通过
 *
 * 冻结期内，Actor 若能顺手改掉那个"失败的测试"，整条证明链就失效了。
 * 所以必须有一道**单调**的拒绝（`ctx.tools.guard()`），而不是提示词里的请求。
 */

/**
 * 常见的测试资产命名。跨语言，宁可多认几个。
 *
 * ⚠️ 这是一个**名字模式表**，不是完备定义——未覆盖的命名不会被冻结。
 * 独立验证者实测出来的漏项（已补）：Jest/Vitest 快照、testdata、测试运行器配置。
 * 补充原则：凡是「能让失败的测试变绿」的文件都算测试资产，
 * 不只是 `*_test.py` 这类正牌测试文件——改快照、改 fixture、改运行器配置
 * 效果完全一样。
 */
const TEST_PATH_PATTERNS: RegExp[] = [
  /(^|\/)tests?\//i, // tests/ test/
  /(^|\/)__tests__\//i, // jest
  /(^|\/)__mocks__\//i,
  /(^|\/)__snapshots__\//i, // jest/vitest 快照（实测漏项）
  /\.snap$/i, // 快照文件本身（实测漏项）
  /(^|\/)testdata\//i, // go / 通用固定数据（实测漏项）
  /(^|\/)fixtures?\//i, // 测试夹具
  /(^|\/)golden(en)?\//i, // 黄金文件
  /\.(test|spec)\.[cm]?[jt]sx?$/i, // foo.test.ts foo.spec.jsx
  /_test\.(go|py|rb|js|ts)$/i, // go / python / ruby / js
  /(^|\/)test_[^/]+\.py$/i, // pytest
  /Test\.java$/, // java
  /Tests\.(cs|kt|scala)$/i, // .NET / kotlin / scala
  /_spec\.rb$/i, // rspec
  /\.feature$/i, // cucumber
  /(^|\/)conftest\.py$/i, // pytest fixtures
  // 测试运行器配置：改这些同样能让失败的测试变绿（实测漏项）
  /(^|\/)(jest|vitest|playwright|cypress)\.config\.[cm]?[jt]s$/i,
  /(^|\/)pytest\.ini$/i,
  /(^|\/)tox\.ini$/i,
  /(^|\/)karma\.conf\.[cm]?js$/i,
  /(^|\/)phpunit\.xml(\.dist)?$/i,
  /(^|\/)\.mocharc\.[cm]?[jt]s$/i,
];

/**
 * `spec/` 目录单独处理：它在**代码仓库**里通常是 rspec 测试，
 * 但在**文档仓库**里可能是规格说明。一律当测试资产会造成误伤
 * （实测 `docs/spec/design.md` 被判为测试路径），而误伤会让人绕过门禁。
 *
 * 折中：只认常见的 rspec 形态（`spec/` 下的 `.rb`，或 `spec/` 顶层本身）。
 */
const RSPEC_PATH_RE = /(^|\/)spec\/[^/]+\.rb$/i;

/**
 * 裸的测试目录名（`tests`、`spec`…）。
 *
 * 必须单独认：`find tests -name "*.py" -delete` 这类命令里的目标是**目录本身**，
 * 没有斜杠也没有扩展名，上面那些模式全都匹配不到——实测就是在这里漏检的。
 */
const BARE_TEST_DIR_RE = /^(tests?|__tests__|__mocks__|__snapshots__|testdata|fixtures?)$/i;

/**
 * 判断一个路径是否属于测试资产。
 */
export function isTestPath(p: unknown): boolean {
  if (typeof p !== 'string' || p === '') return false;
  const normalized = p.replace(/\\/g, '/');
  if (BARE_TEST_DIR_RE.test(normalized)) return true;
  if (RSPEC_PATH_RE.test(normalized)) return true;
  return TEST_PATH_PATTERNS.some((re) => re.test(normalized));
}

/**
 * 会对文件产生写入/删除效果的 shell 片段。
 *
 * ⚠️ **这是保守启发式，不是硬边界。** 判定基于命令**文本**，因此任何
 * 不落进这些模式的等价写法都能绕过（例如自造二进制、`node -e` 里的 fs.writeFileSync、
 * 变量拼出的命令名）。真正的硬约束应当落在工具限制或沙箱层
 * （冻结期直接 restrict 掉写能力）。
 *
 * 下面这些形态是**实测出来的绕过点**，逐一补上：
 *   1. `>tests/x.py`（重定向后无空格）—— 原正则要求 `>\s`，漏掉了
 *   2. `python3 -c "open('tests/x','w')"` —— 解释器内写入
 *   3. `find tests -delete` / `-exec`
 *   4. `perl -pi -e`
 *   5. `git -C repo checkout -- tests/` —— `-C` 插在中间
 */
const MUTATION_RE = [
  // 重定向：允许 `>` 后无空格（修复实测漏检）
  /(^|[^<])>{1,2}\s*\S/,
  // 文件操作
  /\b(rm|mv|cp|install|truncate|tee|shred|chmod|chown)\b/,
  /\bdd\b\s/,
  /\bsed\b\s+[^|]*-i/,
  /\bperl\b\s+[^|]*-[a-z]*i/,
  // `[^|]*` 是非贪婪才能正确匹配 `-delete`：贪婪版本会把 `-` 一起吃掉。
  // 两个分支都留：带 `-` 的 find 动作，以及裸 `delete`。
  /\bfind\b[^|]*?-(delete|exec)\b/,
  /\bfind\b[^|]*?(delete|exec)\b/,
  // 解释器内写入（-c / -e / --eval 后跟内容）
  /\b(python3?|node|ruby|php|deno|bun)\b[^|]*\s(-c|-e|--eval)\b/,
  // git 的写操作（允许 -C <path> 等全局参数插在 git 与子命令之间）
  /\bgit\b(\s+-[^\s]+\s+\S+)*\s+(checkout|restore|rm|mv|reset|stash|apply|clean|revert|switch)\b/,
  /\bpatch\b\s/,
  // 测试运行器的「批量改写预期」开关：它们直接把断言改成当前输出，
  // 效果等同于改测试，是让失败变绿的常用手法（验证者实测记录）
  // 允许包运行器前缀（`npx jest -u`、`pnpm dlx vitest -u`…）——
  // 原来的 `\b(jest|...)` 因为 `npx` 在前而词边界不成立，实测漏检。
  /(^|[\s;&|])(npx|pnpm|yarn|bunx|bun)?[\s]*(jest|vitest|pytest|ava|playwright|cypress)\b[^|]*(-u\b|--update[-a-z]*\b|--snapshot-update\b|--update-snapshots\b)/,
].map((re) => re.source).join('|');

const MUTATION_RE_COMPILED = new RegExp(MUTATION_RE);

/**
 * 从 bash 命令里取出可能是路径的 token。
 *
 * 注意一个实测出来的盲点：`find tests -name "*.py" -delete` 里的 `tests`
 * 是**裸目录名**——既没有斜杠也没有扩展名，会被"看起来像路径"的过滤条件丢掉，
 * 于是变更操作识别对了、目标却找不到，整体放行。
 * 所以这里额外保留可能是测试根的裸目录名（BARE_TEST_DIR_RE，见文件上方）。
 */
export function pathTokens(command: unknown): string[] {
  if (typeof command !== 'string') return [];
  return command
    .split(/[\s;|&()'"`]+/)
    // 剥掉前导的 shell 装饰符，**以及 `key=` 形式的前缀**。
    // `dd of=tests/x.py` 里的 `of=` 不剥掉就认不出目标——实测漏检点。
    // 注意顺序：先剥装饰符，再无条件剥 `key=`（`of=tests/x.py` 整段都要去掉）。
    .map((t) => t.replace(/^[^/.\w-]+/, '').replace(/^[A-Za-z_][A-Za-z0-9_]*=/, ''))
    .filter(
      (t) =>
        t.length > 0 &&
        (t.includes('/') || /\.\w+$/.test(t) || BARE_TEST_DIR_RE.test(t)),
    );
}

export interface TestMutationJudgement {
  blocked: boolean;
  reason?: string;
  target?: string;
}

/**
 * 判定一次工具调用是否在改动测试资产。
 *
 * 只使用 `name` 与 `arguments` —— 即**结构化**的调用事实，
 * 而不是命令文本的编码形态。因此 base64 / 变量拼接之类的规避手段
 * 在这里不起作用（对照 docs/dsh-pitfalls.md 第 10 条）。
 */
export function judgeTestMutation(exec: {
  name?: unknown;
  arguments?: unknown;
}): TestMutationJudgement {
  const name = typeof exec?.name === 'string' ? exec.name : '';
  const args = exec?.arguments as Record<string, unknown> | undefined;

  // 文件工具：写 / 改 直接看 file_path
  if (name === 'write' || name === 'edit') {
    const target = args?.['file_path'];
    if (isTestPath(target)) {
      return {
        blocked: true,
        target: String(target),
        reason: `测试资产在冻结期内不可修改：${String(target)}`,
      };
    }
    return { blocked: false };
  }

  // shell 通道：只有同时出现"写操作"与"测试路径"才拦，避免误伤只读命令。
  //
  // 必须同时认 `bash` 与 `pwsh`：DSH 官方 bundle 在 win32 上把 tool-bash
  // 设为 disabled、启用 tool-pwsh（工具名 'pwsh'）。只认 bash 会让冻结
  // 在 Windows 上对所有 shell 写操作完全失效（验证者指出，本机无法实测）。
  if (name === 'bash' || name === 'pwsh') {
    const command = args?.['command'];
    if (typeof command !== 'string') return { blocked: false };
    if (!MUTATION_RE_COMPILED.test(command)) return { blocked: false };
    const hit = pathTokens(command).find((t) => isTestPath(t));
    if (hit !== undefined) {
      return {
        blocked: true,
        target: hit,
        reason: `测试资产在冻结期内不可修改（经由 shell）：${hit}`,
      };
    }
  }

  return { blocked: false };
}
