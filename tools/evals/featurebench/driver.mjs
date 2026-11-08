import { readFileSync, writeFileSync } from 'node:fs';
const [cdpPort, presetLabel, promptFile, outFile] = process.argv.slice(2);
const webPort = process.env.WEB_PORT || '3113';
const text = readFileSync(promptFile, 'utf8');
const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const target = list.find(t => t.type === 'page' && t.url.includes('127.0.0.1:' + webPort));
if (!target) { console.error('NO TARGET'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const call = (method, params={}) => new Promise(res => { const i=++id; pending.set(i,res); ws.send(JSON.stringify({id:i,method,params})); });
const evalJS = async expr => { const r = await call('Runtime.evaluate', {expression: expr, awaitPromise: true, returnByValue: true, timeout: 180000}); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0,500)); return r.result?.result?.value; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
await call('Page.bringToFront');
await call('Emulation.setFocusEmulationEnabled', {enabled: true}).catch(()=>{});
// 1. 等前端 boot 出 composer
let ready = false;
for (let i = 0; i < 120; i++) {
  const has = await evalJS(`!!document.querySelector('[data-composer-input]')`);
  if (has) { ready = true; break; }
  await sleep(1000);
}
if (!ready) { console.error('COMPOSER TIMEOUT'); process.exit(4); }
// 2. 关掉引导弹层（最多 3 次）
for (let i = 0; i < 3; i++) {
  const clicked = await evalJS(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='继续');if(b){b.click();return true}return false})()`);
  if (!clicked) break;
  await sleep(800);
}
// 3. 新会话（欢迎页没有该按钮时跳过）
const news = await evalJS(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'')==='新建会话');if(b){b.click();return true}return false})()`);
console.log('NEWSESSION', news);
await sleep(1200);
await evalJS(`(()=>{document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true})()`);
await sleep(300);
// 3.5 DSH 0.2.2：引导弹层可能在「新建会话」之后才出现，挡住 preset 菜单。
// 先在 preset 选择前把弹层关掉（最多 20 次），否则点击 preset 触发按钮不会弹出菜单，
// 会得到 'no item 标准模式'（本仓库 0.2.2 升级后实测）。
for (let i = 0; i < 20; i++) {
  const clicked = await evalJS(`(()=>{const labels=['继续','开始使用','我知道了','知道了'];const b=[...document.querySelectorAll('button')].find(x=>labels.includes((x.innerText||'').trim()));if(b){b.click();return true}return false})()`);
  if (clicked) { await sleep(700); continue; }
  const gone = await evalJS(`!document.body.innerText.includes('预览版说明')`);
  if (gone) break;
  await sleep(500);
}
console.log('PRESET_PRE_MODAL_GONE', await evalJS(`!document.body.innerText.includes('预览版说明')`));

// 4. 选 preset（菜单开/关重试；并发跑多个实例时页面可能没有完全就绪）
let sel = '';
for (let attempt = 0; attempt < 3; attempt++) {
  await evalJS(`(()=>{const labels=['继续','开始使用','我知道了','知道了'];const b=[...document.querySelectorAll('button')].find(x=>labels.includes((x.innerText||'').trim()));if(b){b.click();return true}return false})()`);
  await sleep(400);
  sel = await evalJS(`(async (want)=>{const labels=['标准模式','AI 原生 SDLC','PTC 模式','极简模式','创造模式'];const all=()=>[...document.querySelectorAll('button')];const open=()=>all().find(b=>labels.includes((b.innerText||'').trim()));const items=()=>[...document.querySelectorAll('[role=menuitem]')];if(!open()) return 'no preset button';open().click();await new Promise(r=>setTimeout(r,900));let it=items();if(!it.length){open()?.click();await new Promise(r=>setTimeout(r,900));it=items();}const hit=it.find(e=>(e.innerText||'').includes(want));if(!hit) return 'no item '+want;hit.click();await new Promise(r=>setTimeout(r,700));return all().some(b=>(b.innerText||'').trim()===want)?('selected '+want):('select-failed');})(${JSON.stringify(presetLabel)})`);
  console.log('PRESET', sel, 'attempt', attempt + 1);
  if (String(sel).startsWith('selected')) break;
  await sleep(1500);
}
if (!String(sel).startsWith('selected')) {
  const body = await evalJS(`document.body.innerText.slice(0,1500)`);
  console.error('PRESET SELECT FAILED body:', JSON.stringify(body));
  process.exit(3);
}
// 4.2 工作区选择页：偶发会停在「选择一个工作区开始」，不点进去就没有 composer。
// 这是 App 启动竞态（不是 workspace 配置错），点「默认工作区」后继续。
for (let i = 0; i < 20; i++) {
  const clicked = await evalJS(`(()=>{const el=[...document.querySelectorAll('button,[role=button],li,div')].find(x=>((x.innerText||'').trim()==='默认工作区'));if(el){el.click();return true}return false})()`);
  if (clicked) { console.log('WORKSPACE selected'); await sleep(1200); break; }
  const needs = await evalJS(`document.body.innerText.includes('选择一个工作区开始')`);
  if (!needs) break;
  await sleep(500);
}

// 4.5 等页面真正就绪：composer 元素出现 ≠ React 已挂载，引导弹层也可能晚到。
// pytest 镜像首跑两次都 INSERT_LEN 0，body 里能看到「预览版说明 … 继续」弹层。
// 这里循环关弹层 + 等 composer 可编辑，两者同时满足才继续。
let appReady = false; let modalSeen = 0;
for (let i = 0; i < 90; i++) {
  const clicked = await evalJS(`(()=>{const labels=['继续','我知道了','开始使用','知道了','关闭'];const b=[...document.querySelectorAll('button')].find(x=>labels.includes((x.innerText||'').trim()));if(b){b.click();return true}return false})()`);
  if (clicked) { modalSeen++; await sleep(800); continue; }
  appReady = await evalJS(`(()=>{const ed=document.querySelector('[data-composer-input]');return !!(ed && ed.isContentEditable && !document.body.innerText.includes('预览版说明'))})()`);
  if (appReady) break;
  await sleep(1000);
}
console.log('APP_READY', appReady, 'MODALS_DISMISSED', modalSeen);
await sleep(1200);
// 5. 点击 composer 取得焦点
const rect = JSON.parse(await evalJS(`(()=>{const ed=document.querySelector('[data-composer-input]');const r=ed.getBoundingClientRect();ed.focus();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,f:document.activeElement===ed})})()`));
for (let i = 0; i < 3; i++) {
  await call('Input.dispatchMouseEvent', {type:'mousePressed', x:rect.x, y:rect.y, button:'left', clickCount:1});
  await call('Input.dispatchMouseEvent', {type:'mouseReleased', x:rect.x, y:rect.y, button:'left', clickCount:1});
  await sleep(400);
  if (await evalJS(`document.activeElement===document.querySelector('[data-composer-input]')`)) break;
}
// 6. 插入 prompt 并校验
let insertedLen = 0;
for (let i = 0; i < 5; i++) {
  await evalJS(`(()=>{const labels=['继续','我知道了','开始使用','知道了','关闭'];const b=[...document.querySelectorAll('button')].find(x=>labels.includes((x.innerText||'').trim()));if(b){b.click();return true}return false})()`);
  await evalJS(`document.querySelector('[data-composer-input]').focus()`);
  await sleep(300);
  await call('Input.insertText', {text});
  await sleep(1500);
  insertedLen = await evalJS(`(document.querySelector('[data-composer-input]')||{}).innerText.length||0`);
  if (insertedLen >= Math.min(10, text.length)) break;
  await evalJS(`(()=>{const ed=document.querySelector('[data-composer-input]');ed.focus();ed.innerHTML='';return true})()`);
  await sleep(600);
}
console.log('INSERT_LEN', insertedLen, 'WANT', text.length);
if (insertedLen < Math.min(10, text.length)) {
  const body = await evalJS(`document.body.innerText.slice(0,1200)`);
  console.error('INSERT FAILED body:', JSON.stringify(body));
  process.exit(2);
}
// 7. 发送
await call('Input.dispatchKeyEvent', {type:'rawKeyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, nativeVirtualKeyCode:13});
await call('Input.dispatchKeyEvent', {type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, nativeVirtualKeyCode:13});
const t0 = Date.now();
const maxTokens = Number(process.env.MAX_TOKENS || '0');
let lastBody = ''; let idleSince = 0; let done = false; let aborted = null; let usageSeen = ''; let turnError = false;
const parseUsage = (body) => {
  // 实测 UI 有时显示「用量 12.3M tok」，有时底部只显示「12.3M tok·缓存命中…」；
  // 兼容两种格式（第二个模式要求带 K/M/G 单位，避免误匹配 195 tok/s 这类速率）。
  const m = body.match(/用量\s*([\d.]+)\s*([KMG]?) tok/) ||
            body.match(/([\d.]+)\s*([KMG])\s*tok/);
  if (!m) return null;
  const mult = m[2] === 'K' ? 1e3 : m[2] === 'M' ? 1e6 : m[2] === 'G' ? 1e9 : 1;
  return Math.round(parseFloat(m[1]) * mult);
};
while (Date.now() - t0 < 3 * 60 * 60 * 1000) {
  await sleep(5000);
  // 自动批准一次危险操作（官方镜像里 workspace-write 沙箱无可用后端）
  await evalJS(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>['允许一次','允许本次操作','允许'].includes((x.innerText||'').trim()));if(b){b.click();return 'approved'}return ''})()`);
  const state = await evalJS(`JSON.stringify({body:document.body.innerText.slice(-8000)})`);
  const st = JSON.parse(state);
  const used = parseUsage(st.body);
  if (used !== null) usageSeen = String(used);
  if (maxTokens > 0 && used !== null && used > maxTokens) { aborted = 'over_budget'; break; }
  // 不能只看「已完成」：todo 控件里的 "0/5 已完成" 会误判（实测 B 组被提前截断，
  // 产出 1.5MB 垃圾 patch）。真实完成标记是 turn 尾部的「已完成，用时 N 秒」。
  // 另外 turn 可能以错误结束（实测 DeepSeek stream 在 message_stop 前断开），页面
  // 不会再出现完成标记，只能靠「无『深度求索中』且页面静止 30s」判定回合结束，
  // 并标记 turn_error 交给上层按基础设施失败处理（允许重试一次）。
  const generating = st.body.includes('深度求索中');
  const completed = st.body.includes('已完成，用时');
  if (completed && !generating) { done = true; break; }
  if (st.body === lastBody) idleSince += 5000; else { idleSince = 0; lastBody = st.body; }
  if (!generating && idleSince >= 30000 && st.body.length > 0) {
    done = true; turnError = !completed; break;
  }
}
const finalState = JSON.parse(await evalJS(`JSON.stringify({body:document.body.innerText, editor:((document.querySelector('[data-composer-input]')||{}).innerText||'')})`));
const payload = {preset: presetLabel, done, turn_error: turnError, aborted, usage_tokens: usageSeen ? Number(usageSeen) : null,
                 elapsed_s: Math.round((Date.now()-t0)/1000), body: finalState.body};
writeFileSync(outFile, JSON.stringify(payload, null, 2));
console.log('DONE', done, 'elapsed', payload.elapsed_s, 'bodyTail:', finalState.body.slice(-500).replace(/\n/g,' | '));
ws.close();
