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

/** 常见的测试文件/目录命名。跨语言，宁可多认几个。 */
const TEST_PATH_PATTERNS: RegExp[] = [
  /(^|\/)tests?\//i, // tests/ test/
  /(^|\/)__tests__\//i, // jest
  /(^|\/)specs?\//i, // spec/ specs/
  /(^|\/)__mocks__\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i, // foo.test.ts foo.spec.jsx
  /_test\.(go|py|rb)$/i, // go / python / ruby
  /(^|\/)test_[^/]+\.py$/i, // pytest
  /Test\.java$/, // java
  /Tests\.(cs|kt|scala)$/i, // .NET / kotlin / scala
  /_spec\.rb$/i, // rspec
  /\.feature$/i, // cucumber
  /(^|\/)conftest\.py$/i, // pytest fixtures
];

/**
 * 裸的测试目录名（`tests`、`spec`…）。
 *
 * 必须单独认：`find tests -name "*.py" -delete` 这类命令里的目标是**目录本身**，
 * 没有斜杠也没有扩展名，上面那些模式全都匹配不到——实测就是在这里漏检的。
 */
const BARE_TEST_DIR_RE = /^(tests?|specs?|__tests__|__mocks__)$/i;

/**
 * 判断一个路径是否属于测试资产。
 */
export function isTestPath(p: unknown): boolean {
  if (typeof p !== 'string' || p === '') return false;
  const normalized = p.replace(/\\/g, '/');
  if (BARE_TEST_DIR_RE.test(normalized)) return true;
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
    .map((t) => t.replace(/^[^/.\w-]+/, ''))
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

  // shell 通道：只有同时出现"写操作"与"测试路径"才拦，避免误伤只读命令
  if (name === 'bash') {
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
