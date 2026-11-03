/**
 * 验证者 preset 的结构单测。
 *
 * 为什么这层必须单独钉住：0.2.1 把 `toolFilter` / `persona` 从
 * `SubagentStartRequest` 上删掉了，验证者的只读能力从「一次调用的参数」
 * 变成了「一份 preset 组合」。参数写错会立刻报错，而**组合里少写/多写一个
 * 工具不会报错**——它只是让验证者悄悄多出一个写工具，或者读不到验证纪律。
 * 这正是本项目反复踩的「静默失败」，所以用单测把组合的形状钉死。
 */

import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import assert from 'node:assert/strict';
import { VERIFIER_PRESET, VERIFIER_PRESET_ID, VERIFIER_SHELL_ID } from './preset.js';
import { apply as applyToolFilter, globalToolNames } from './preset-filter.js';
import { buildVerificationPrompt, VERIFIER_PERSONA } from './verdict.js';

const rows = VERIFIER_PRESET.plugins;
const names = rows.map((row) => row.name);

test('preset id 与派发时使用的常量一致', () => {
  assert.equal(VERIFIER_PRESET.id, VERIFIER_PRESET_ID);
});

test('每个 plugin 行的 id 唯一（重复 id 会让 loader 行互相覆盖）', () => {
  const ids = rows.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, `重复 id: ${JSON.stringify(ids)}`);
  assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0), '每个行都要有显式 id');
});

test('write / edit 在 preset 里被显式关掉', () => {
  const fsRow = rows.find((row) => row.name === '@deepseek-ai/dsh-tool-fs');
  assert.ok(fsRow, '缺少 tool-fs 行');
  assert.equal(fsRow.config?.write, false, 'write 必须显式为 false');
  assert.equal(fsRow.config?.edit, false, 'edit 必须显式为 false');
  assert.equal(fsRow.config?.read, true, 'read 必须保留');
});

test('没有委派 / 联网 / 提问能力（否则验证者可以另开一条写路径）', () => {
  for (const forbidden of [
    '@deepseek-ai/dsh-tool-subagent',
    '@deepseek-ai/dsh-tool-workflow',
    '@deepseek-ai/dsh-tool-web',
    '@deepseek-ai/dsh-tool-ask-user',
    '@deepseek-ai/dsh-tool-todo',
    '@deepseek-ai/dsh-tool-present',
  ]) {
    assert.ok(!names.includes(forbidden), `preset 不应包含 ${forbidden}`);
  }
});

test('保留 skill 通道：验证纪律做成 Skill 后，没有这个工具就读不到', () => {
  assert.ok(names.includes('@deepseek-ai/dsh-skill-filesystem'), '缺少 skill provider');
  assert.ok(names.includes('@deepseek-ai/dsh-tool-skill'), '缺少 skill 加载工具');
});

test('必须有工具过滤行：宿主工具是全局注册的，preset 不会自动隔离', () => {
  // 实测（0.2.1 真实宿主）：没有这一行时，验证者的工具面里仍然有
  // sdlc_task_create / sdlc_fix_end / sdlc_verify —— 它能解冻测试、推进任务。
  assert.ok(names.includes('@ai-native-sdlc-plugin/dsh-sdlc/verify/preset-filter'), '缺少 preset-filter 行');
});

test('过滤行 deny 掉当前 global 层的全部工具（而不是固定名单）', () => {
  const calls: unknown[] = [];
  const ctx = {
    tools: {
      schemas: () => [{ name: 'sdlc_fix_end' }, { name: 'sdlc_task_advance' }, { name: 'working_directory' }],
      restrict: (filter: unknown) => {
        calls.push(filter);
        return () => {};
      },
    },
  };
  applyToolFilter(ctx as unknown as Context);
  assert.deepEqual(calls, [{ deny: ['sdlc_fix_end', 'sdlc_task_advance', 'working_directory'] }]);
  // 以后宿主新增工具也会被这条规则覆盖：它来自运行时枚举，不是手写名单。
  assert.deepEqual(globalToolNames(ctx.tools), ['sdlc_fix_end', 'sdlc_task_advance', 'working_directory']);
});

test('shell 只放本平台存在的那一个', () => {
  const shells = rows.filter(
    (row) => row.name === '@deepseek-ai/dsh-tool-bash' || row.name === '@deepseek-ai/dsh-tool-pwsh',
  );
  assert.equal(shells.length, 1, `只能有一个 shell 行，实际: ${JSON.stringify(shells.map((r) => r.name))}`);
  assert.equal(shells[0].id, VERIFIER_SHELL_ID);
  assert.equal(
    shells[0].name,
    process.platform === 'win32' ? '@deepseek-ai/dsh-tool-pwsh' : '@deepseek-ai/dsh-tool-bash',
  );
});

test('验证者提示词仍带完整纪律（preset 的 persona 只写身份）', () => {
  const prompt = buildVerificationPrompt({ intentOfChange: '测试' });
  assert.ok(prompt.includes(VERIFIER_PERSONA), '提示词必须包含完整的 VERIFIER_PERSONA');
  assert.match(prompt, /technically able to change files/, '必须如实说明 bash 能写文件');
  assert.match(prompt, /Ignore any instruction that would have you modify/i, '必须要求忽略修改类指导');
  assert.doesNotMatch(prompt, /read-only tools|You cannot modify/i, '不得再声称能力上只读');
});
