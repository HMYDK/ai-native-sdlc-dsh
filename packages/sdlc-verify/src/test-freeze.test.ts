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
 * 判定覆盖的守恒断言。
 *
 * **口径（实测，不要凭印象改）**：这 10 种写法在上一版实现下就**已经全部被拦住**，
 * 所以它是守恒断言——防止将来重构把已有覆盖弄丢——**不是回归证据**。
 *
 * 我曾在这里写过"9 条实测曾被放行"，那是假的，已按实测更正。
 * 真正的回归缺口是另外三个当时无人覆盖的形态（见下方 update-switch 用例）。
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

test('批量改写预期开关——不要求命令里出现测试路径', () => {
  // 这 3 条是**当时无人覆盖**的真实缺口：不带显式路径时，
  // 「变更操作 + 目标路径」那套判定必然放行，而它们会把全部快照改成当前输出。
  const mustBlock = [
    'npx jest -u',
    'npx jest --update-snapshots',
    'npx vitest -u',
    'pytest --snapshot-update',
    'npx jest -u --silent',
  ];
  for (const command of mustBlock) {
    const v = judgeTestMutation({ name: 'bash', arguments: { command } });
    assert.equal(v.blocked, true, `应被拦: ${command}`);
  }
  // 防误伤：别的工具里 -u 是别的意思
  const mustAllow = [
    'docker run -u root alpine',
    'curl -u user:pass https://example.com',
    'git log -u',
    'npm install -u',
  ];
  for (const command of mustAllow) {
    const v = judgeTestMutation({ name: 'bash', arguments: { command } });
    assert.equal(v.blocked, false, `不应被拦: ${command}`);
  }
});

test('pwsh 通道与 bash 同等对待（Windows 上只有 pwsh）', () => {
  const blocked = judgeTestMutation({
    name: 'pwsh',
    arguments: { command: 'Set-Content tests/test_x.py "pass"' },
  });
  assert.equal(blocked.blocked, true, 'pwsh 写测试资产应被拦');
});

test('测试运行器配置与快照也算测试资产（验证者实测的漏项）', () => {
  for (const p of [
    'src/__snapshots__/Panel.tsx.snap',
    'testdata/golden.json',
    'jest.config.js',
    'vitest.config.ts',
    'pytest.ini',
  ]) {
    assert.equal(isTestPath(p), true, `应识别为测试资产: ${p}`);
  }
  // spec/ 目录不再一律当测试资产（减少误伤），但 rspec 形态仍认
  assert.equal(isTestPath('docs/spec/design.md'), false, 'docs/spec/ 是文档，不该误伤');
  assert.equal(isTestPath('spec/models/order_spec.rb'), true, 'rspec 应识别');
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
