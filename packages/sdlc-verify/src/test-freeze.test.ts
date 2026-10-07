/**
 * 测试冻结判定逻辑的单测。
 *
 * 这部分是纯函数（无 DSH 依赖），所以能脱离 harness 验证。
 * 覆盖重点是**误伤**：门禁一旦拦错，人就会绕过它，控制随之失效。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTestPath, judgeTestMutation, pathTokens } from './test-freeze.js';

test('isTestPath 识别常见测试布局', () => {
  const yes = [
    'tests/test_status.py',
    'test/foo_test.go',
    'src/__tests__/panel.test.tsx',
    'packages/a/src/x.spec.ts',
    'services/api/tests/itest/OrderTest.java',
    'app/Models/OrderTests.cs',
    'spec/models/order_spec.rb',
    'features/login.feature',
    'conftest.py',
    'internal/store/store_test.go',
    'myproj/test_utils.py',
    'C:\\repo\\tests\\win_test.py', // 反斜杠也要认
  ];
  for (const p of yes) {
    assert.equal(isTestPath(p), true, `应识别为测试资产: ${p}`);
  }
});

test('isTestPath 不误伤产品代码与测试工具名', () => {
  const no = [
    'src/claims/StatusPanel.tsx',
    'claims-api/routes/status.py',
    'src/latest.ts', // 含 "test" 子串但非测试
    'docs/testing-standard.md', // 文档，不是测试资产
    'src/contest.ts',
    'lib/attestation.js',
    '', // 空
    null,
    undefined,
    42,
  ];
  for (const p of no) {
    assert.equal(isTestPath(p), false, `不应识别为测试资产: ${String(p)}`);
  }
});

test('write/edit 改测试文件被拦', () => {
  for (const name of ['write', 'edit']) {
    const v = judgeTestMutation({ name, arguments: { file_path: 'tests/test_status.py' } });
    assert.equal(v.blocked, true, `${name} 应被拦`);
    assert.match(String(v.reason), /冻结期内不可修改/);
  }
});

test('write/edit 改产品代码放行', () => {
  for (const name of ['write', 'edit']) {
    const v = judgeTestMutation({ name, arguments: { file_path: 'claims-api/routes/status.py' } });
    assert.equal(v.blocked, false, `${name} 不应被拦`);
  }
});

test('shell 改写测试文件被拦', () => {
  const cases = [
    "echo 'pass' > tests/test_status.py",
    'rm -rf tests/',
    'sed -i "" "s/assert/ pass /" tests/test_status.py',
    'git checkout HEAD -- tests/test_status.py',
    'cp /dev/null tests/test_status.py',
    'mv tests/test_status.py /tmp/',
  ];
  for (const command of cases) {
    const v = judgeTestMutation({ name: 'bash', arguments: { command } });
    assert.equal(v.blocked, true, `应被拦: ${command}`);
  }
});

/**
 * 回归用例。
 *
 * 口径要准确：其中 **9 条**是独立验证者实测出来、在修复前**确实被放行**的；
 * `shred` 在修复前已被拦住，留在这里作为**既有覆盖的守恒断言**
 * （防止将来重构时把它弄丢），不是回归证据。
 *
 * 每一条都对应一次真实的判定讨论，不要删。
 */
test('回归：实测过的绕过手法必须被拦', () => {
  const bypasses: Array<[string, string]> = [
    ['重定向不带空格', "echo 'pass' >tests/test_status.py"],
    ['解释器内写入（python）', `python3 -c "open('tests/test_status.py','w').write('')"`],
    ['解释器内写入（node）', `node -e "require('fs').writeFileSync('tests/a_test.py','')"`],
    ['find -delete', 'find tests -name "*.py" -delete'],
    ['find -exec', 'find tests -name "*.py" -exec truncate -s 0 {} \\;'],
    ['perl -pi', `perl -pi -e 's/assert/ pass /' tests/test_status.py`],
    ['git -C 插参数', 'git -C /repo checkout -- tests/a_test.py'],
    ['git switch --force', 'git switch --force main -- tests/'],
    ['install 覆盖', 'install -m 644 /dev/null tests/test_status.py'],
    ['shred', 'shred -u tests/test_status.py'],
  ];
  for (const [label, command] of bypasses) {
    const v = judgeTestMutation({ name: 'bash', arguments: { command } });
    assert.equal(v.blocked, true, `绕过手法未被拦（${label}）: ${command}`);
  }
});

test('只读 shell 命令不被拦（防误伤）', () => {
  const cases = [
    'pytest tests/test_status.py -v', // 只是跑测试
    'cat tests/test_status.py',
    'grep -n assert tests/test_status.py',
    'git diff tests/test_status.py',
    'git log --oneline -- tests/',
    'make test',
    'npm test',
  ];
  for (const command of cases) {
    const v = judgeTestMutation({ name: 'bash', arguments: { command } });
    assert.equal(v.blocked, false, `不应被拦: ${command}`);
  }
});

test('无关工具不被拦', () => {
  for (const name of ['read', 'grep', 'glob', 'sdlc_verify', 'todo_write']) {
    const v = judgeTestMutation({ name, arguments: { file_path: 'tests/test_status.py' } });
    assert.equal(v.blocked, false, `${name} 不应被拦`);
  }
});

test('畸形输入不抛异常（fail open on garbage, 但不是放行危险操作）', () => {
  assert.equal(judgeTestMutation({}).blocked, false);
  assert.equal(judgeTestMutation({ name: 'write' }).blocked, false);
  assert.equal(judgeTestMutation({ name: 'write', arguments: null }).blocked, false);
  assert.equal(judgeTestMutation({ name: 'bash', arguments: { command: 123 } }).blocked, false);
});

test('pathTokens 提取路径 token', () => {
  const tokens = pathTokens("echo x > tests/a.py && rm src/b.ts");
  assert.ok(tokens.includes('tests/a.py'), `应含 tests/a.py，实际：${tokens.join(',')}`);
  assert.ok(tokens.includes('src/b.ts'), `应含 src/b.ts，实际：${tokens.join(',')}`);
});
