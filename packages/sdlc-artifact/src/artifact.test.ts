/**
 * 制品结构检查的单测（纯函数层，可脱离 DSH 运行）。
 *
 * 覆盖重点放在**三种缺陷的区分**上：missing / empty / placeholder。
 * 其中 `empty` 是刻意单列的——"有标题没内容"比"没写"更危险，
 * 因为它让人以为写过了。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIFACT_FILENAMES,
  ARTIFACT_KINDS,
  checkArtifact,
  extractSections,
  isArtifactKind,
  REQUIRED_SECTIONS,
  sectionBody,
  skeletonFor,
  type ArtifactKind,
} from './artifact.js';

/** 按必需章节生成一份"结构合格"的文档，便于单测从合格基线出发。 */
function wellFormed(kind: ArtifactKind): string {
  const lines = [`# ${kind}: 示例`, ''];
  for (const s of REQUIRED_SECTIONS[kind]) {
    lines.push(`## ${s.name}`, '', `这里是 ${s.name} 的正文内容，足够长以避免被判为空。`, '');
  }
  return lines.join('\n');
}

test('三种制品的必需章节与手册一致', () => {
  assert.deepEqual([...ARTIFACT_KINDS], ['intent', 'spec', 'plan']);
  const names = (k: ArtifactKind) => REQUIRED_SECTIONS[k].map((s) => s.name);

  // 手册阶段 01 的 intent 模板
  assert.deepEqual(names('intent'), [
    'Problem',
    'Proposed outcome',
    'Affected users and systems',
    'Constraints',
    'Open questions',
  ]);
  // 手册阶段 03 的 plan 模板
  assert.deepEqual(names('plan'), ['Files that change', 'Order of work', 'Risks', 'Proof']);
  // spec：手册说需求与设计合并，且必须标注关注领域
  assert.deepEqual(names('spec'), ['Requirements', 'Design', 'Areas of concern']);

  assert.deepEqual(ARTIFACT_FILENAMES, {
    intent: 'intent.md',
    spec: 'spec.md',
    plan: 'plan.md',
  });
});

test('结构合格的文档通过检查', () => {
  for (const kind of ARTIFACT_KINDS) {
    const r = checkArtifact(kind, wellFormed(kind));
    assert.equal(r.ok, true, `${kind} 应通过，实际问题：${JSON.stringify(r.findings)}`);
    assert.deepEqual(r.findings, []);
  }
});

test('缺失章节被报为 missing，并说明为什么需要它', () => {
  const doc = wellFormed('plan').replace(/## Proof[\s\S]*$/, '');
  const r = checkArtifact('plan', doc);
  assert.equal(r.ok, false);
  const f = r.findings.find((x) => x.section === 'Proof');
  assert.ok(f, '应报出缺 Proof');
  assert.equal(f.kind, 'missing');
  // 错误信息必须解释"为什么"，否则人会选择绕过而不是补上
  assert.match(f.detail, /为什么需要它/);
  assert.match(f.detail, /验证阶段的输入/);
});

test('回归：有标题但正文为空 → empty（不是 missing）', () => {
  // 这是最危险的一类：看起来写过了。
  const doc = wellFormed('intent').replace(
    /## Open questions[\s\S]*$/,
    '## Open questions\n\n',
  );
  const r = checkArtifact('intent', doc);
  assert.equal(r.ok, false);
  const f = r.findings.find((x) => x.section === 'Open questions');
  assert.ok(f);
  assert.equal(f.kind, 'empty', `应为 empty 而非 missing，实际 ${f.kind}`);
  assert.match(f.detail, /比不写更危险/);
});

test('回归：正文还是占位符 → placeholder', () => {
  const doc = wellFormed('spec').replace(
    '这里是 Areas of concern 的正文内容，足够长以避免被判为空。',
    '<在这里写关注点>',
  );
  const r = checkArtifact('spec', doc);
  assert.equal(r.ok, false);
  const f = r.findings.find((x) => x.section === 'Areas of concern');
  assert.ok(f);
  assert.equal(f.kind, 'placeholder');
  assert.match(f.detail, /占位符/);
});

test('骨架自检：skeletonFor 生成的东西**故意**判为不合格', () => {
  // 骨架只提供章节与用途说明，不含实质内容。它必须是"明显没写完"的状态，
  // 否则生成骨架就能通过门禁——那门禁就毫无意义了。
  for (const kind of ARTIFACT_KINDS) {
    const r = checkArtifact(kind, skeletonFor(kind, 'T'));
    assert.equal(r.ok, false, `${kind} 的骨架不该通过结构检查`);
  }
});

test('别名表足够宽容：措辞不同不该被拒', () => {
  // 误伤会降低门禁效力——人会想办法绕开它。所以常见同义写法必须认。
  const variants: Array<[ArtifactKind, string, string]> = [
    ['plan', 'Files that change', 'Files changed'],
    ['plan', 'Order of work', 'Steps'],
    ['plan', 'Risks', 'Risk'],
    ['intent', 'Proposed outcome', 'Outcome'],
    ['intent', 'Open questions', 'Open issues'],
    ['spec', 'Areas of concern', 'Concerns'],
  ];
  for (const [kind, canonical, alias] of variants) {
    const doc = wellFormed(kind).replace(`## ${canonical}`, `## ${alias}`);
    const r = checkArtifact(kind, doc);
    const f = r.findings.find((x) => x.section === canonical);
    assert.ok(!f, `${canonical} 应接受别名「${alias}」，实际报：${JSON.stringify(f)}`);
  }
});

test('别名表不发明语义：Proof 与 Tests 不是一回事', () => {
  // 手册的 Proof 要能证明目标行为；只写"跑了测试"不够。
  // 若把 tests 当别名，这一节就形同虚设。
  const doc = wellFormed('plan').replace('## Proof', '## Tests run');
  const r = checkArtifact('plan', doc);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((x) => x.section === 'Proof' && x.kind === 'missing'));
});

test('大小写与首尾空格不敏感', () => {
  const doc = wellFormed('intent')
    .replace('## Problem', '##   problem  ')
    .replace('## Constraints', '## CONSTRAINTS');
  const r = checkArtifact('intent', doc);
  assert.equal(r.ok, true, `大小写/空格不该影响判定：${JSON.stringify(r.findings)}`);
});

test('extractSections 只认二级标题，忽略一级与三级', () => {
  const md = ['# Title', '## A', '### A.1', '## B', '#### C'].join('\n');
  assert.deepEqual(extractSections(md), ['A', 'B']);
  // 带尾随 # 的合法形式
  assert.deepEqual(extractSections('## Closed ##'), ['Closed']);
});

test('sectionBody 取到下一个二级标题为止', () => {
  const md = ['## A', 'line1', '', '### nested', 'line2', '## B', 'other'].join('\n');
  const body = sectionBody(md, 'A');
  assert.match(body, /line1/);
  assert.match(body, /nested/);
  assert.match(body, /line2/);
  assert.ok(!body.includes('other'), '不该跨过下一个二级标题');
});

test('一个章节都没写时，全部报缺失（不会漏报）', () => {
  const r = checkArtifact('plan', '# Plan: 空\n\n只有这句话。\n');
  assert.equal(r.findings.length, REQUIRED_SECTIONS.plan.length);
  assert.ok(r.findings.every((f) => f.kind === 'missing'));
});

test('isArtifactKind 校验', () => {
  for (const k of ARTIFACT_KINDS) assert.equal(isArtifactKind(k), true);
  for (const bad of ['review', '', 'Intent', null, 42]) assert.equal(isArtifactKind(bad), false);
});

test('检查结果里带上实际找到的章节，便于对账', () => {
  const r = checkArtifact('plan', wellFormed('plan'));
  assert.deepEqual(r.found, ['Files that change', 'Order of work', 'Risks', 'Proof']);
  assert.equal(r.kind, 'plan');
});
