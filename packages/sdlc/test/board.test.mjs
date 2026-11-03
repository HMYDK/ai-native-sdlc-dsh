#!/usr/bin/env node
/**
 * sdlc-ui **宿主半**的行为测试：看板必须扫到**所有**工作区。
 *
 * ## 它守的那个真实缺陷
 *
 * 面板的根解析原来是"取第一个 `.ai/tasks` 非空的候选根，然后 break"。
 * 多工作区下后果不是"少显示一点"，而是**永远只显示那一个仓库**：
 * 实测面板只显示 `workspace-a` 的残留任务 RSI-1，
 * 而 `workspace-b` 里 8 个真实任务（含 CART-22358）
 * 一次都没出现过；切换工作区也没用，因为客户端半**不传** `?cwd=`。
 *
 * 所以这里刻意让请求**不带任何查询参数**，工作区只从
 * `~/.dsh/storages/workspace.json` 来 —— 与真实面板发的那个请求一致。
 *
 * ⚠️ 这个文件的价值在于**它能在旧代码上变红**。请务必跑一次 A/B：
 *     node board.test.mjs lib/index.js            # 绿
 *     node board.test.mjs <旧 lib/index.js>        # 必须红
 * 不会红的测试只是在复述实现。
 *
 * 用法：node board.test.mjs [lib/index.js 的路径]
 * 退出码 0 = 全过；1 = 有断言失败。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {createHash} from 'node:crypto';

const LIB = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..', 'lib', 'ui', 'index.js'));

let pass = 0;
let fail = 0;
const ok = (m) => { pass += 1; console.log(`  \u2713 ${m}`); };
const bad = (m) => { fail += 1; console.log(`  \u2717 ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

// ── 隔离：通过 DSH_HOME 指定独立存储，不改 HOME，也不读取日常工作区列表。
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'boardtest-')));
const TEST_DSH_HOME = path.join(TMP, 'isolated-dsh');
process.env.DSH_HOME = TEST_DSH_HOME;
// 进程 cwd 及其祖先也是一路候选根，所以 cwd 放在一个**没有** .ai/tasks 的地方
const NEUTRAL = path.join(TMP, 'neutral');
fs.mkdirSync(NEUTRAL, { recursive: true });
process.chdir(NEUTRAL);

/** 造一个假工作区：`<root>/.ai/tasks/<id>/{state.yaml,intent.md}`。 */
function makeWorkspace(root, id, title, updated) {
  const dir = path.join(root, '.ai', 'tasks', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'intent.md'), `# ${title}\n\n夹具正文。\n`);
  fs.writeFileSync(path.join(dir, 'state.yaml'), [
    `task: ${id}`,
    `title: "${title}"`,
    'status: DONE',
    'created: 2026-01-01T00:00:00.000Z',
    `updated: ${updated}`,
    'artifacts:',
    '  intent: "intent.md"',
    'history:',
    `  - at: "${updated}"`,
    '    from: ""',
    '    to: "DONE"',
    '    reason: "测试夹具"',
    '',
  ].join('\n'));
}

const WS_A = path.join(TMP, 'wsA');
const WS_B = path.join(TMP, 'wsB');
const WS_C = path.join(TMP, 'wsC'); // 只在 ?cwd= 里出现，**不在**持久化列表里
makeWorkspace(WS_A, 'AAA-1', 'A 工作区的任务', '2026-01-01T00:00:00.000Z');
// B 更晚 → 排序后应当排前面（看板第一眼是最近动过的）
makeWorkspace(WS_B, 'BBB-2', 'B 工作区的任务', '2026-02-02T00:00:00.000Z');
makeWorkspace(WS_C, 'CCC-3', 'C 工作区的任务', '2026-01-15T00:00:00.000Z');
fs.writeFileSync(path.join(WS_A, '.ai/tasks/AAA-1/rsi.json'), JSON.stringify({task_id:'AAA-1',evidence_complete:false,run_count:6,session_count:7,issues:['验证者记录为空'],review_status:'pending'}));
// A 里再放一个没有 state.yaml 的杂物目录：它**不该**被算成任务
fs.mkdirSync(path.join(WS_A, '.ai', 'tasks', 'not-a-task'), { recursive: true });

// ── 持久化的工作区列表（形状照抄实机的 ~/.dsh/storages/workspace.json）
const storages = path.join(TEST_DSH_HOME, 'storages');
fs.mkdirSync(storages, { recursive: true });
fs.writeFileSync(path.join(storages, 'workspace.json'), JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds: ['w1', 'w2'] },
  tables: {
    workspaces: {
      w1: { path: WS_A, title: '工作区A', sessionIds: [], createdAt: '', updatedAt: '' },
      w2: { path: WS_B, title: '工作区B', sessionIds: [], createdAt: '', updatedAt: '' },
    },
  },
}, null, 2));

// ── 假 ctx：只实现宿主半真正用到的那几个面
//
// ⚠️ 形状必须**忠实于真实接口**：`ctx.fs.resolve()` 返回的是
// `FsTarget = {targetKey, displayPath}` —— 其中 `targetKey` 是"同一个文件
// 必然相同"的稳定身份（dsh-fs 的类型注释原文），本地后端 resolve 时会
// normalize + **realpath**。第一版这里编了一个不存在的 `.path` 字段，
// 于是"按目录身份去重"这件事在夹具里根本不存在，测不出重复任务。
const routes = [];
const realOrSelf = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const ctx = {
  fs: {
    async resolve(p, opts) {
      const cwd = opts && opts.cwd ? opts.cwd : process.cwd();
      const real = realOrSelf(path.resolve(cwd, p));
      return { targetKey: 'file:' + real, displayPath: real };
    },
    async listDir(target) {
      return fs.readdirSync(target.displayPath, { withFileTypes: true })
        .map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }));
    },
    async readText(target) {
      return fs.readFileSync(target.displayPath, 'utf8');
    },
    contains(parent, child) {
      const relative = path.relative(parent.displayPath, child.displayPath);
      return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
    },
    async stat(target) {
      try { const s = fs.statSync(target.displayPath); return {type: s.isFile() ? 'file' : 'directory', size: s.size}; }
      catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
    },
    async readBytes(target, _signal, maxBytes) {
      const bytes = fs.readFileSync(target.displayPath);
      assert.ok(bytes.length <= maxBytes);
      return bytes;
    },
  },
  connection: { fetch: { register(route) { routes.push(route); return () => {}; } } },
  effect(fn) { return fn(); },
};

const mod = await import(pathToFileURL(LIB).href);
if (typeof mod.apply !== 'function') {
  console.error(`无法加载 ${LIB}：没有导出 apply`);
  process.exit(1);
}
mod.apply(ctx, { tasksDir: '.ai/tasks' });

const tasksRoute = routes.find((r) => r.path === '/api/sdlc-ui.tasks');
const artifactRoute = routes.find((r) => r.path === '/api/sdlc-ui.artifact');
const executionRoute = routes.find((r) => r.path === '/api/sdlc-ui.execution');
if (!tasksRoute || !artifactRoute || !executionRoute) {
  console.error('路由没注册上，后面的断言都不成立');
  process.exit(1);
}
const get = async (route, query) =>
  route.fetch(new Request('http://localhost' + route.path + (query ? '?' + query : '')));

console.log(`\n== 聚合：不带参数，两个工作区都要扫到（${path.basename(path.dirname(LIB))}/index.js） ==`);
// ⚠️ 真实面板发的就是**这一个**请求：没有 cwd，没有 root，什么都没有。
const res = await get(tasksRoute, '');
check(res.status === 200, `tasks 路由 200（实际 ${res.status}）`);
const data = await res.json();
const ids = (data.tasks ?? []).map((t) => t.id);
check(ids.includes('AAA-1'), '扫到持久化列表里第一个工作区的任务 AAA-1');
check(ids.includes('BBB-2'), '扫到第二个工作区的任务 BBB-2 —— 旧代码在这里只返回第一个根');
check(!ids.includes('not-a-task'), '不含 state.yaml 的杂物目录不算任务');
check(ids.length === 2, `任务总数 2（实际 ${ids.length}：${ids.join(',')}）`);

const taskA = (data.tasks ?? []).find((t) => t.id === 'AAA-1');
const taskB = (data.tasks ?? []).find((t) => t.id === 'BBB-2');
check(taskA?.rsi?.evidence_complete === false && taskA.rsi.run_count === 6, 'DONE 任务仍显示执行证据缺失');
check(taskB?.rsi === null, '没有 RSI 摘要不伪装为记录完整');
check(taskA?.repoRoot === WS_A, 'AAA-1 带着自己的 repoRoot');
check(taskB?.repoRoot === WS_B, 'BBB-2 带着自己的 repoRoot（不是第一个根的）');
check(taskB?.repoLabel === '工作区B', `来源名取自 workspace.json 的 title（实际 ${JSON.stringify(taskB?.repoLabel)}）`);
check(
  Array.isArray(data.roots) && data.roots.length === 2,
  `响应里报出 2 个根（实际 ${JSON.stringify(data.roots)})`,
);
check(data.roots?.every((r) => r.taskCount === 1), '每个根的 taskCount 只数真的画出来的任务');
check(ids[0] === 'BBB-2', '最新的排在前面（BBB-2 的 updated 更晚）');
check(
  Array.isArray(data.searched) && data.searched.length >= 2 && data.searched.every((p) => p.endsWith('/.ai/tasks')),
  '空白时可解释"查过哪里"',
);

console.log('\n== 制品路由：必须在**任务自己**的根里读 ==');
const a1 = await get(artifactRoute, 'task=AAA-1&file=intent.md');
check(a1.status === 200, `AAA-1 的制品可读（实际 ${a1.status}）`);
const b1 = await get(artifactRoute, 'task=BBB-2&file=intent.md');
check(b1.status === 200, `BBB-2 的制品可读 —— 旧代码拿第一个根去找，会 404（实际 ${b1.status}）`);
if (b1.status === 200) {
  const body = await b1.json();
  check(body.text.includes('B 工作区的任务'), 'BBB-2 读到的是它自己的正文，不是 A 的同名文件');
}
const evil = await get(artifactRoute, 'task=BBB-2&file=intent.md&root=/etc');
check(evil.status === 404, '显式 root 不在候选集合时返回 404，不回退到别的工作区');
const escape = await get(artifactRoute, 'task=BBB-2&file=../../../../etc/passwd');
check(escape.status === 400, 'file 参数仍拒绝路径穿越');
const unknown = await get(artifactRoute, 'task=NOPE-9&file=intent.md');
check(unknown.status === 404, '不存在的任务仍 404');

console.log('\n== 登记、列表和打开使用同一条文件路径 ==');
const taskDir = path.join(WS_A, '.ai/tasks/AAA-1');
const nestedFile = 'verifications/51fe59b3-2244-4db4-bdc9-041ec7c9c59e.json';
const registerFile = (kind, file) => {
  const stateFile = path.join(taskDir, 'state.yaml');
  fs.writeFileSync(stateFile, fs.readFileSync(stateFile, 'utf8').replace('artifacts:\n', `artifacts:\n  ${kind}: "${file}"\n`));
};
fs.mkdirSync(path.join(taskDir, 'verifications'));
const nestedText = JSON.stringify({task:'AAA-1',criteria:['完整验收标准'],verdict:{status:'reject',summary:'这份是所选轮次',findings:[]}});
fs.writeFileSync(path.join(taskDir, nestedFile), nestedText);
registerFile('verification', nestedFile);
const nested = await get(artifactRoute, new URLSearchParams({task:'AAA-1',root:WS_A,file:nestedFile}));
const nestedBody = await nested.json();
check(nested.status === 200 && nestedBody.text === nestedText, '逐轮验证文件按登记路径打开，不替换成最新 verification.json');
check(nestedBody.kind === 'verification', '响应带登记的制品类型，阅读视图不依赖固定文件名');
check(nestedBody.criteria?.[0]?.text === '完整验收标准' && /^AC-[a-f0-9]{16}$/.test(nestedBody.criteria[0].id), '完整标准带稳定 ID，结果重排也能找到正确正文');
fs.writeFileSync(path.join(taskDir, 'verifications/unregistered.json'), '{}');
check((await get(artifactRoute, 'task=AAA-1&file=verifications/unregistered.json')).status === 403, '嵌套目录里的未登记文件仍不可读');
for (const file of ['/etc/passwd', '../intent.md', 'verifications/../intent.md', 'verifications//r.json', './intent.md', 'verifications\\r.json', 'verifications/%2e%2e/secret', 'file:/etc/passwd']) {
  check((await get(artifactRoute, new URLSearchParams({task:'AAA-1',file}))).status === 400, `拒绝不规范路径 ${file}`);
}
fs.symlinkSync(path.join(WS_B, '.ai/tasks/BBB-2/intent.md'), path.join(taskDir, 'outside.md'));
registerFile('outside', 'outside.md');
check((await get(artifactRoute, 'task=AAA-1&file=outside.md')).status === 403, '登记也不能让软链读取另一个任务的文件');
fs.symlinkSync(path.join(WS_B, '.ai/tasks/BBB-2'), path.join(taskDir, 'linked'));
registerFile('linked', 'linked/intent.md');
check((await get(artifactRoute, 'task=AAA-1&file=linked/intent.md')).status === 403, '目录软链也不能越出任务目录');
const listed = (await (await get(tasksRoute, '')).json()).tasks.find(t => t.id === 'AAA-1');
check(listed.artifacts.find(a => a.kind === 'verification')?.bytes > 0, '列表能读到与打开接口一致的逐轮裁决');
check(listed.artifacts.filter(a => ['outside','linked'].includes(a.kind)).every(a => a.bytes === 0 && a.sections.length === 0), '列表同样不读取越界交付物');
const longText = JSON.stringify({decision:'accept',summary:'长评审记录。'.repeat(42000)});
fs.writeFileSync(path.join(taskDir,'review.json'),longText); registerFile('review','review.json');
const longBody = await (await get(artifactRoute,'task=AAA-1&file=review.json')).json();
check(longBody.text === longText && longBody.bytes === Buffer.byteLength(longText), '长 JSON 完整返回且按字节计数，不切断后伪装成损坏文件');
fs.writeFileSync(path.join(taskDir,'too-big.json'), ' '.repeat(16 * 1024 * 1024 + 1)); registerFile('large','too-big.json');
check((await get(artifactRoute,'task=AAA-1&file=too-big.json')).status === 413, '超过读取上限明确说明，不能悄悄截断');
registerFile('missing','verifications/missing.json');
check((await get(artifactRoute,'task=AAA-1&file=verifications/missing.json')).status === 404, '登记但已缺失的文件明确返回 404');

console.log('\n== 客户端给的候选根也会被扫（?cwd= 是**追加候选**，不是过滤） ==');
const withC = await (await get(tasksRoute, 'cwd=' + encodeURIComponent(WS_C))).json();
const idsC = (withC.tasks ?? []).map((t) => t.id);
check(idsC.includes('CCC-3'), '只有 ?cwd= 提到的 wsC 也能被扫到');
check(idsC.includes('AAA-1') && idsC.includes('BBB-2'), '持久化列表里的两个也没有因此被挤掉');

console.log('\n== 同一个工作区的两种写法（软链）不许产生重复任务 ==');
{
  // ⚠️ 这条是独立验证抓到的**本次改动引入的回归**：候选根如果按**路径字符串**
  // 去重，同一个工作区以两种写法出现（软链路径 vs 解析后的真实路径）就会被当成
  // 两个候选；全扫之后同一个任务被扫两遍，看板上出现两条一模一样的卡片。
  // 旧代码因为"找到第一个就 break"看不到这个问题。
  // 正确做法是按**目录身份**（`FsTarget.targetKey`，同文件必同 key）去重。
  const WS_A_LINK = path.join(TMP, 'wsA-link');
  if (!fs.existsSync(WS_A_LINK)) fs.symlinkSync(WS_A, WS_A_LINK);
  check(fs.realpathSync(WS_A_LINK) === fs.realpathSync(WS_A), '夹具有效：软链与真实路径解析到同一个目录');

  const dup = await (await get(tasksRoute, 'cwd=' + encodeURIComponent(WS_A_LINK))).json();
  const dupIds = (dup.tasks ?? []).map((t) => t.id);
  const times = dupIds.filter((x) => x === 'AAA-1').length;
  check(times === 1, `AAA-1 只出现一次（实际 ${times} 次，tasks=${JSON.stringify(dupIds)}）`);
  const nRoots = (dup.roots ?? []).length;
  check(nRoots === 2, `只报 2 个根 —— 软链与真实路径是同一个目录（实际 ${nRoots}：${JSON.stringify((dup.roots ?? []).map((r) => r.root))}）`);
  check(
    (dup.roots ?? []).every((r) => fs.realpathSync(r.root) === fs.realpathSync(WS_A) || fs.realpathSync(r.root) === fs.realpathSync(WS_B)),
    '报出来的根都指向真实存在的两个工作区',
  );
}

console.log('\n== 执行记录：指定工作区、只读摘要与旧任务兼容 ==');
const current = { task: 'AAA-1', at: '2026-10-28T10:00:00Z', verdict: {status: 'reject', summary: 'A 的独立裁决', criteria_results: [], findings: []} };
fs.writeFileSync(path.join(WS_A, '.ai/tasks/AAA-1/verification.json'), JSON.stringify(current));
const requestExecution = await get(executionRoute, new URLSearchParams({task: 'AAA-1', root: WS_A}));
const execution = await requestExecution.json();
check(requestExecution.status === 200 && execution.repoRoot === WS_A && execution.taskId === 'AAA-1', '执行记录沿用所选任务的工作区');
check(execution.rounds?.[0]?.source === 'current_verdict' && execution.rounds[0].summary === 'A 的独立裁决', '旧任务只显示当前裁决，不伪造历史');
check(!fs.existsSync(path.join(WS_A, '.ai/rsi')), '浏览执行记录不会触发收集或创建 RSI 目录');
check((await get(executionRoute, new URLSearchParams({task: 'AAA-1', root: WS_B}))).status === 404, '另一个已登记工作区没有该任务时仍返回 404');
check((await get(executionRoute, 'task=../AAA-1')).status === 400, '执行记录拒绝任务路径穿越');
makeWorkspace(WS_B, 'AAA-1', 'B 的同名任务', '2026-10-28T10:00:00Z');
const second = await (await get(executionRoute, new URLSearchParams({task: 'AAA-1', root: WS_B}))).json();
check(second.repoRoot === WS_B && second.rounds.length === 0, '同名任务缺少裁决时不会借用 A 的记录');
console.log('\n== Issue 2: 同一清单支撑列表与裁决详情，旧记录不冒充完整验收 ==');
{
  const acDir=path.join(WS_A,'.ai/tasks/AC-CASE');fs.mkdirSync(acDir,{recursive:true});
  const criteria=[{id:'AC-001',text:'金额正确'},{id:'AC-002',text:'并发不重复'},{id:'AC-003',text:'失败回滚'}];
  const spec='## Acceptance Criteria\n'+criteria.map(c=>`- ${c.id}: ${c.text}`).join('\n')+'\n';
  const acceptance={version:1,id:'registered-v1',spec_path:'spec.md',spec_sha256:createHash('sha256').update(spec).digest('hex'),criteria,registered_at:'2026-11-02T00:00:00Z',registered_by:'fixture'};
  const doc={schema_version:3,task:'AC-CASE',acceptance,criteria:criteria.map(c=>`${c.id}: ${c.text}`),additional_criteria:[],verdict:{status:'approve',findings:[],criteria_results:[{criterion_id:'AC-001',result:'met',evidence:'fixture'}]}};
  fs.writeFileSync(path.join(acDir,'state.yaml'),JSON.stringify({task:'AC-CASE',title:'验收覆盖夹具',status:'VERIFYING',created:'2026-11-02T00:00:00Z',updated:'2026-11-02T00:00:00Z',artifacts:{spec:'spec.md',verification:'verification.json'},history:[],acceptance}));
  fs.writeFileSync(path.join(acDir,'spec.md'),spec);fs.writeFileSync(path.join(acDir,'verification.json'),JSON.stringify(doc));
  const listing=(await (await get(tasksRoute,'')).json()).tasks.find(t=>t.id==='AC-CASE');
  const detail=await (await get(artifactRoute,new URLSearchParams({task:'AC-CASE',root:WS_A,file:'verification.json'}))).json();
  check(listing.acceptance.expected===3&&listing.acceptance.answered===1&&listing.acceptance.status==='incomplete','任务列表显示应验 3 项、已答 1 项，不能把 approve 当完整通过');
  check(JSON.stringify(listing.acceptance)===JSON.stringify(detail.acceptance),'列表与裁决详情使用同一套完整性计算');
  check(detail.acceptance.missing.join(',')==='AC-002,AC-003','详情明确点名缺少的两项');
  check(detail.criteria.map(c=>c.id).join(',')==='AC-001,AC-002,AC-003','新裁决读取显式 ID，不重新生成内容哈希');
  doc.verdict.criteria_results=criteria.map(c=>({criterion_id:c.id,result:'met',evidence:'fixture'})).reverse();
  fs.writeFileSync(path.join(acDir,'verification.json'),JSON.stringify(doc));
  const valid=await (await get(artifactRoute,new URLSearchParams({task:'AC-CASE',root:WS_A,file:'verification.json'}))).json();
  check(valid.acceptance.status==='verified'&&valid.acceptance.met===3,'完整结果重排仍按编号核对通过');
  fs.appendFileSync(path.join(acDir,'spec.md'),'\n说明变更\n');
  const changed=(await (await get(tasksRoute,'')).json()).tasks.find(t=>t.id==='AC-CASE');
  check(changed.acceptance.status==='changed','说明文字改变也显示登记版本已失效');
  check(nestedBody.acceptance.status==='unregistered'&&nestedBody.acceptance.errors.some(x=>x.includes('历史裁决')),'旧任务保留原始裁决，同时明确完整验收范围未确认');
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
