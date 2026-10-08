/**
 * Skill 内容的单测。
 *
 * ## 为什么内容也需要测试
 *
 * 这份 Skill 的**全部价值就是它说了什么**。如果它丢了一节、
 * 或者某条被编辑时删掉了，插件照样加载、`register()` 照样成功——
 * **失败的样子是"它就是不出现"或"它少了最关键的那条"**，没人会知道。
 *
 * 所以这里断言：
 *   1. 注册形状对（`register()` 实际要什么）
 *   2. **七条实测结论每条都在**（用它们各自独有的关键词钉住）
 *   3. 内容里没有未替换的模板占位符
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_NAME, skillRegistration } from './skill.js';

test('注册形状：name / description / content / source 齐备，且类型对', () => {
  const r = skillRegistration();
  assert.equal(typeof r.name, 'string');
  assert.equal(typeof r.description, 'string');
  assert.equal(typeof r.content, 'string');
  assert.equal(r.source, 'bundled', 'source 是 register() 的必填项');
  assert.ok(r.name.length > 0);
  assert.ok(r.description.length > 0);
  assert.ok(r.content.length > 200, '正文太短说明没写完');
  // kebab-case：注册表的寻址要求
  assert.match(r.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, `name 必须是 kebab-case：${r.name}`);
});

test('七条实测结论每条都在（用各自独有的关键词钉住）', () => {
  // 每条对应正文里的一个小节。**用该节独有的词**，这样改坏了会红，
  // 而改措辞不会误报。
  const sections = [
    ['一、先怀疑作者的证据', '编译一份'], // 「从 git 取改动前的版本编译一份」
    ['二、判据能被证伪吗', '恒真'],
    ['三、新断言要证明过它能失败', '变异'],
    ['四、数字可复现吗', '并发'],
    ['五、制品与代码一致吗', '被抓到**三次**'],
    ['六、等价变异不是缺口', '结果完全相同'],
    ['七、不能验证的要如实说', 'needs_human'],
  ];
  for (const [what, keyword] of sections) {
    assert.ok(
      SKILL_CONTENT.includes(keyword),
      `${what}：正文里找不到关键词「${keyword}」——这一节可能被删了`,
    );
  }
});

test('每条都带着"它是怎么被发现的"，不是教条', () => {
  // 这是这份清单区别于"一份规范"的地方：每条都注明了出处，
  // 后来人能判断它是否仍然适用。数一下"实测"出现的次数是否够七条。
  const n = (SKILL_CONTENT.match(/\*\*实测\*\*/g) ?? []).length;
  assert.ok(n >= 7, `每条都该注明实测出处，实际只有 ${n} 处`);
});

test('正文里没有未替换的模板占位符（本仓库踩过这个坑）', () => {
  // 这个仓库在写文档时踩过：模板里残留 `{{title}}` 之类，
  // 而结构检查只查章节、查不出它。
  for (const bad of ['{{', 'TODO', 'FIXME', '（待填']) {
    assert.ok(!SKILL_CONTENT.includes(bad), `正文里残留了「${bad}」`);
  }
});

test('正文里的反引号是配对转义的（模板字符串的经典坑）', () => {
  // 这份正文住在 TS 模板字符串里，裸反引号会**提前闭合字符串**导致语法错误。
  // 编译期能挡住，但这条断言把"配对"这件事也说清楚：
  // 计数应当是偶数（每个 \` 成对出现）。
  const n = (SKILL_CONTENT.match(/`/g) ?? []).length;
  assert.equal(n % 2, 0, `反引号应当成对，实际 ${n} 个`);
});

test('它的措辞明确指向"验证者"，而不是泛泛的规范', () => {
  // 这份清单的效力来源就是它写给验证者。措辞漂移成"给作者的建议"
  // 会让它退化成一份文档——那是本项目第一版被否掉的形态。
  assert.match(SKILL_CONTENT, /给\*\*验证者\*\*的|写给\*\*验证者\*\*的/);
  assert.match(SKILL_CONTENT, /作者会（无恶意地）相信自己的方法/);
});

test('SKILL_NAME 与注册保持一致（别改了一处）', () => {
  assert.equal(skillRegistration().name, SKILL_NAME);
  assert.equal(skillRegistration().description, SKILL_DESCRIPTION);
});
