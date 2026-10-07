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
 * 判断一个路径是否属于测试资产。
 */
export function isTestPath(p: unknown): boolean {
  if (typeof p !== 'string' || p === '') return false;
  const normalized = p.replace(/\\/g, '/');
  return TEST_PATH_PATTERNS.some((re) => re.test(normalized));
}

/** 会对文件产生写入/删除效果的 shell 片段（用于 bash 通道的保守判定）。 */
const MUTATION_RE =
  /(^|[^<])>{1,2}\s|>>\s|\brm\b|\bmv\b|\bcp\b|\bsed\b\s+[^|]*-i|\btruncate\b|\btee\b|\bdd\b\s|git\s+(checkout|restore|rm|mv|reset|stash|apply|clean|revert)\b|\bpatch\b\s|\bshred\b/;

/**
 * 从 bash 命令里取出可能是路径的 token（保守：取全部看起来像路径的）。
 * 只用于判定，不做 shell 解析。
 */
export function pathTokens(command: unknown): string[] {
  if (typeof command !== 'string') return [];
  return command
    .split(/[\s;|&()'"`]+/)
    .map((t) => t.replace(/^[^/.\w-]+/, ''))
    .filter((t) => t.length > 0 && (t.includes('/') || /\.\w+$/.test(t)));
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
    if (!MUTATION_RE.test(command)) return { blocked: false };
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
