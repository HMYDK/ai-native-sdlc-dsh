/** Component interaction checks. Real DOM, effects, focus and layout are checked in DSH Web. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(process.argv[2] || new URL('../lib/ui/client.js', import.meta.url), 'utf8');
const task = (root, status, title) => ({ id: 'SAME-1', repoRoot: root, repoLabel: root.slice(1), title, status,
  updated: '2026-10-16T10:00:00Z', artifacts: [{ kind: 'intent', file: 'intent.md' }], timeline: [], durations: [], blocked: [], verdict: null });
const payload = { roots: [{ root: '/alpha', label: 'alpha' }, { root: '/beta', label: 'beta' }], tasks: [
  task('/alpha', 'DONE', '已完成的第一个同名任务'), task('/beta', 'SPEC', '另一个工作区的同名任务'),
] };

function mount(data = payload) {
  let spec, component, current, initial = true;
  const stores = new Map();
  const jsx = (type, props, key) => ({ type, props: props || {}, key });
  const react = {
    useState(init) {
      const { values } = current;
      const slot = current.index++;
      if (!(slot in values)) {
        values[slot] = initial ? data : typeof init === 'function' ? init() : init;
        initial = false;
      }
      return [values[slot], v => { values[slot] = typeof v === 'function' ? v(values[slot]) : v; }];
    },
    useCallback: fn => fn,
    useEffect() {}, // This harness tests interactions, not effects. No fake network/lifecycle claims.
  };
  new Function('window', 'localStorage', source)(
    { __ModuleLoader__: { load: s => { spec = s; } } }, { getItem: () => 'A', setItem() {} });
  spec.factory(id => id === 'react' ? react : { jsx, jsxs: jsx }).apply({ slots: {
    inject: (_, fn) => { for (const _ of fn()) {} },
    register: (opts, c) => { if (opts.name === 'main') component = c; return () => {}; },
  } });
  function expand(node, path) {
    if (node == null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((n, i) => expand(n, path + '/' + (n?.key ?? i)));
    if (typeof node.type === 'function') {
      const id = path + ':' + node.type.name;
      const values = stores.get(id) || [];
      stores.set(id, values); current = { values, index: 0 };
      const result = node.type(node.props);
      return { component: node.type.name, props: node.props, child: expand(result, id) };
    }
    return { ...node, child: expand(node.props.children, path + '/children') };
  }
  let tree;
  const render = () => { tree = expand(jsx(component, {}), 'root'); return tree; };
  function find(predicate, start = tree) {
    const result = [];
    const walk = n => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(walk); if (predicate(n)) result.push(n); walk(n.child); };
    walk(start); return result;
  }
  render();
  return { render, find, rows: () => find(n => n.component === 'TaskLine'), detail: () => find(n => n.component === 'Detail')[0],
    click: n => { assert.ok(n, 'control exists'); n.props.onClick(); render(); } };
}
const text = n => n == null ? '' : typeof n !== 'object' ? String(n) : Array.isArray(n) ? n.map(text).join('') : text(n.child);

test('同名任务各自留在列表里，带有自己的工作区', () => {
  const ui = mount();
  assert.equal(ui.rows().length, 2);
  assert.ok(text(ui.rows()[0]).includes('alpha'));
  assert.ok(text(ui.rows()[1]).includes('beta'));
});
test('选中第二个工作区的同名任务，详情与唯一选中态一起切换', () => {
  const ui = mount();
  ui.click(ui.rows()[1]);
  assert.equal(ui.detail().props.task.repoRoot, '/beta');
  assert.deepEqual(ui.rows().map(n => n.props.active), [false, true]);
});
test('点交付物沿用所选任务的工作区，不读到另一个同名文件', () => {
  const ui = mount();
  ui.click(ui.rows()[1]);
  ui.detail().props.onOpen('intent.md'); ui.render();
  const viewer = ui.find(n => n.component === 'ArtifactViewer')[0];
  assert.equal(viewer.props.root, '/beta');
  assert.equal(viewer.props.task, 'SAME-1');
  assert.equal(viewer.props.file, 'intent.md');
});
test('状态筛选显示真实任务行，完成和未完成互斥', () => {
  const ui = mount();
  ui.click(ui.find(n => n.type === 'button' && text(n).startsWith('进行中'))[0]);
  assert.deepEqual(ui.rows().map(n => n.props.task.repoRoot), ['/beta']);
  ui.click(ui.find(n => n.type === 'button' && text(n).startsWith('已完成'))[0]);
  assert.deepEqual(ui.rows().map(n => n.props.task.repoRoot), ['/alpha']);
});
test('工作区筛选改变列表及默认详情，保留同名任务的正确来源', () => {
  const ui = mount();
  ui.find(n => n.type === 'select' && n.props['aria-label'] === '工作区')[0].props.onChange({ target: { value: '/beta' } }); ui.render();
  assert.equal(ui.rows().length, 1);
  assert.equal(ui.detail().props.task.repoRoot, '/beta');
});
test('关键词查标题和编号，无匹配时清除筛选可恢复', () => {
  const ui = mount();
  const search = () => ui.find(n => n.type === 'input' && n.props.type === 'search')[0];
  search().props.onChange({ target: { value: '  另一个  ' } }); ui.render();
  assert.equal(ui.rows().length, 1);
  assert.equal(ui.detail().props.task.repoRoot, '/beta');
  search().props.onChange({ target: { value: '没有这个任务' } }); ui.render();
  assert.equal(ui.rows().length, 0); assert.equal(ui.detail(), undefined);
  ui.click(ui.find(n => n.type === 'button' && text(n) === '清除筛选')[0]);
  assert.equal(ui.rows().length, 2);
});
test('迁移记录包含全部历史，长记录可按需展开', () => {
  const data = structuredClone(payload);
  data.tasks[0].timeline = Array.from({ length: 12 }, (_, i) => ({ to: 'SPEC', at: '2026-10-16T10:00:00Z', reason: '记录 ' + i + ' 完整内容' }));
  const ui = mount(data);
  ui.click(ui.find(n => n.type === 'button' && text(n) === '查看全部记录')[0]);
  const entries = ui.find(n => n.type === 'details');
  assert.equal(entries.length, 12);
  assert.ok(text(entries[0]).includes('记录 11')); assert.ok(text(entries[11]).includes('记录 0'));
  assert.ok(entries.every(n => !n.props.open));
});
test('空工作区能说明没有任务和检查过哪些位置', () => {
  const ui = mount({ tasks: [], roots: [], searched: ['/alpha/.ai/tasks'] });
  assert.ok(ui.find(n => n.type === 'h2' && text(n) === '还没有任务').length);
  assert.ok(ui.find(n => n.type === 'details' && text(n).includes('/alpha/.ai/tasks')).length);
});
