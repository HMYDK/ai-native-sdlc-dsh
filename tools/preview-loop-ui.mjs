#!/usr/bin/env node
/** Render the shipped client with deterministic fixtures, without accessing a DSH service. */
import fs from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {apply} from '../packages/sdlc/lib/ui/index.js';

const repo = path.resolve(import.meta.dirname, '..');
const home = path.join(repo, '.verify-home');
const workspace = path.join(home, 'loop-workspace');
const output = path.join(home, 'loop-preview');
if (!process.env.SDLC_REACT_ROOT || !process.env.SDLC_ESBUILD_MODULE) throw new Error('Set SDLC_REACT_ROOT (node_modules with react/react-dom) and SDLC_ESBUILD_MODULE (esbuild entry).');
const {build} = await import(pathToFileURL(process.env.SDLC_ESBUILD_MODULE).href);
process.env.DSH_HOME = home;
process.chdir('/private/tmp');
const routes = new Map();
const fileSystem = {
  async resolve(value, options) {
    let resolved = path.resolve(options.cwd, value);
    try { resolved = realpathSync(resolved); } catch { /* missing fixture */ }
    return {targetKey: 'file:' + resolved, displayPath: resolved};
  },
  contains(parent, child) { const relative = path.relative(parent.displayPath, child.displayPath); return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative)); },
  async listDir(target) { return (await fs.readdir(target.displayPath, {withFileTypes: true})).map(e => ({name: e.name, type: e.isDirectory() ? 'directory' : 'file'})); },
  async readText(target) { return fs.readFile(target.displayPath, 'utf8'); },
  async readBytes(target, _signal, cap) { const bytes = await fs.readFile(target.displayPath); if (bytes.length > cap) throw new Error('over limit'); return bytes; },
  async stat(target) { try { const s = await fs.stat(target.displayPath); return {type: s.isFile() ? 'file' : 'directory', size: s.size}; } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } },
};
apply({fs: fileSystem, connection: {fetch: {register(route) { routes.set(route.path, route.fetch); return () => {}; }}}, effect(fn) { fn(); }}, {tasksDir: '.ai/tasks'});
const request = async (route, params = {}) => (await routes.get('/api/sdlc-ui.' + route)(new Request('http://fixture.local/api/sdlc-ui.' + route + '?' + new URLSearchParams(params)))).json();
const data = {tasks: await request('tasks'), executions: {}, pages: {}, artifacts: {}};
data.tasks.tasks = data.tasks.tasks.filter(t => t.repoRoot === workspace);
for (const task of data.tasks.tasks) {
  data.executions[task.id] = await request('execution', {task: task.id, root: workspace});
  for (const filter of ['all','active','submitted','deferred','resolved']) {
    let page = filter === 'all' ? data.executions[task.id] : await request('execution', {task:task.id,root:workspace,findingFilter:filter});
    if (filter !== 'all') data.pages[task.id+'/'+filter+'/0'] = page;
    while (page.findingNext !== null) {
      page = await request('execution', {task:task.id,root:workspace,findingFilter:filter,findingOffset:String(page.findingNext)});
      data.pages[task.id+'/'+filter+'/'+page.findingOffset] = page;
    }
  }
  for (const artifact of task.artifacts) data.artifacts[task.id + '/' + artifact.file] = await request('artifact', {task: task.id, root: workspace, file: artifact.file});
}
const fixtureJSON = JSON.stringify(data).replaceAll('<', '\\u003c');
const source = await fs.readFile(path.join(repo, 'packages/sdlc/src/ui/client.js'), 'utf8');
const checks = await fs.readFile(path.join(repo, 'tools/loop-preview-checks.js'), 'utf8');
const entry = `
import React from ${JSON.stringify(path.join(process.env.SDLC_REACT_ROOT, 'react/index.js'))};
import * as runtime from ${JSON.stringify(path.join(process.env.SDLC_REACT_ROOT, 'react/jsx-runtime.js'))};
import {createRoot} from ${JSON.stringify(path.join(process.env.SDLC_REACT_ROOT, 'react-dom/client.js'))};
const data = ${fixtureJSON};
window.__LOOP_FIXTURE__ = data;
window.__LOOP_ERRORS__ = [];
window.addEventListener('error', e => window.__LOOP_ERRORS__.push(e.message));
window.fetch = async url => {
  const parsed = new URL(String(url), 'http://fixture.local/'), q = parsed.searchParams;
  const filter = q.get('findingFilter') || 'all', offset = q.get('findingOffset') || '0';
  const execution = filter === 'all' && offset === '0' ? data.executions[q.get('task')] : data.pages[q.get('task')+'/'+filter+'/'+offset];
  const body = parsed.pathname.endsWith('.tasks') ? data.tasks : parsed.pathname.endsWith('.execution') ? execution : data.artifacts[q.get('task') + '/' + q.get('file')];
  return new Response(JSON.stringify(body || {error: 'fixture not found'}), {status: body ? 200 : 404, headers: {'content-type': 'application/json'}});
};
window.__ModuleLoader__ = {load({factory}) {
  const plugin = factory(name => name === 'react' ? React : runtime);
  plugin.apply({slots: {inject(_name, fn) { for (const item of fn()) {} }, register(options, Component) {
    if (options.name === 'main') createRoot(document.getElementById('root')).render(React.createElement(Component));
    return () => {};
  }}});
}};
${source}
${checks}
`;
const bundle = await build({stdin: {contents: entry, resolveDir: repo, loader: 'js'}, bundle: true, write: false, minify: true, define: {'process.env.NODE_ENV': '"production"'}, platform: 'browser'});
await fs.mkdir(output, {recursive: true});
await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SDLC 循环工作台 · 本地示例</title><link rel="icon" href="data:,"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}</style><div id="root"></div><script>' + bundle.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script></html>');
console.log(path.join(output, 'index.html'));
