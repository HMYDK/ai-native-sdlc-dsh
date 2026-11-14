#!/usr/bin/env node
/**
 * 在隔离 profile 中启动真实 App 运行时，检查模式、工具调用与面板路由。
 * 先用 App 自带 CLI 把 npm pack 的 tarball 安装进去，再运行：
 * DSH_HOME=/tmp/sdlc-check node tools/profile-runtime-check.mjs /tmp/sdlc-check/profiles/web
 * 不调用模型；状态查询使用真实 live Session，验证者只检查组合与归还。
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const app=process.env.DSH_APP??'/Applications/DeepSeek Harness.app';
// 只接受显式的隔离 HOME。启动器会写 profile 根配置，不能用用户的桌面 profile。
assert.ok(process.env.DSH_HOME && process.argv[2], '设置隔离 DSH_HOME，并传入已经装好 tarball 的 profile 目录');
const checkHome=path.resolve(process.env.DSH_HOME);
assert.notEqual(checkHome,path.join(os.homedir(),'.dsh'),'不能对用户默认 DSH_HOME 运行此测试');
const profileDir=path.resolve(process.argv[2]);
const relative=path.relative(path.join(checkHome,'profiles'),profileDir);
assert.ok(relative && relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative),'profile 必须位于隔离 HOME 的 profiles 目录内');
if(process.env.ELECTRON_RUN_AS_NODE!=='1') {
 try {
  execFileSync(path.join(app,'Contents/MacOS/DeepSeek Harness'),['--expose-internals',fileURLToPath(import.meta.url),profileDir],{
   stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:'1',DSH_TELEMETRY_DISABLED:'1'},
  });
  process.exit(0);
 }catch(error){process.exit(typeof error.status==='number'?error.status:1);}
}
const modules=path.join(app,'Contents/Resources/app.asar/dsh/node_modules');
const require=createRequire(path.join(modules,'noop.js'));
const {loadLayeredEnv,loadProfileDirectory}=require('@deepseek-ai/dsh-app-boot');
const {runProfile}=require('@deepseek-ai/dsh/profile-boot');
const installAnchor=path.join(modules,'@deepseek-ai/dsh/package.json');
const profile=loadProfileDirectory('dsh',profileDir,installAnchor);
assert.equal(profile.skippedBundles.length,0,JSON.stringify(profile.skippedBundles));
const {ctx}=await runProfile({environment:loadLayeredEnv('dsh'),profile:'web',resolvedProfile:{profile,installAnchor},patchFiles:[],args:['--no-open','--host','127.0.0.1','--port','0']});
let failed=false;
try {
 const rows=await ctx.agentPresets.list();
 const sdlc=rows.find(row=>row.id==='sdlc');
 console.log('SDLC_ROSTER',JSON.stringify(sdlc));
 assert.ok(sdlc);assert.equal(sdlc.broken,undefined);
 const plugins=await ctx.pluginManager.listPlugins();
 const ours=plugins.filter(row=>['sdlc-ui','preset-sdlc'].includes(row.patchId));
 console.log('SDLC_PLUGINS',JSON.stringify(ours.map(row=>({id:row.patchId,fiberPhase:row.fiberPhase,enabled:row.enabled}))));
 assert.equal(ours.length,2);assert.ok(ours.every(row=>row.fiberPhase==='active'));
 const {createScope}=require('@deepseek-ai/dsh-scope');
 const session=ctx.sessions.create('upgrade-probe',{meta:{cwd:process.env.DSH_HOME}});
 const agent={id:session.id,session};
 const scope=createScope(ctx,agent);agent.ctx=scope.ctx;
 try {
  await ctx.agentPresets.mount(scope.ctx,'sdlc');
  const names=ctx.tools.definitions(agent).map(t=>t.name);
  console.log('SDLC_TOOLS',JSON.stringify({total:names.length,sdlc:names.filter(n=>n.startsWith('sdlc_')).length}));
  for(const n of ['read','bash','skill','sdlc_task_create','sdlc_verify','sdlc_status'])assert.ok(names.includes(n),n);
  const batch=await ctx.tools.execute({agent,signal:new AbortController().signal,calls:[{id:'status-probe',name:'sdlc_status',arguments:'{}'}]});
  console.log('SDLC_STATUS',JSON.stringify(batch.results.map(r=>({isError:r.result.isError,error:r.result.error}))));
  assert.equal(batch.results[0].result.isError,false);
 }finally{await scope.dispose();}
 const standard={},standardScope=createScope(ctx,standard);standard.ctx=standardScope.ctx;
 try{await ctx.agentPresets.mount(standardScope.ctx,'standard');assert.ok(!ctx.tools.definitions(standard).some(t=>t.name.startsWith('sdlc_')));console.log('STANDARD_ISOLATION','pass');}finally{await standardScope.dispose();}
 const base=`${ctx.webServer.protocol}//127.0.0.1:${ctx.webServer.port}`;
 const auth=await fetch(ctx.connection.authenticatedUrl(base+'/'),{redirect:'manual'});
 const cookie=auth.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
 assert.ok(cookie);
 const res=await fetch(base+'/api/sdlc-ui.tasks',{headers:{cookie}});console.log('SDLC_BOARD_HTTP',res.status);assert.equal(res.status,200);
 // 形态存活探针（2026-11-14）：DSH 0.2.2-rc.2 起 SubagentActivationSpec 把请求字段
 // 拍平到顶层。用插件真实会发的形状打到真实 subagents 服务；假 parent 应当得到
 // UNAUTHORIZED（说明形状被接受），而不是 TypeError（说明还在用旧的 request 包装）。
 if(ctx.get('agents')!==undefined){
  try{
   await ctx.subagents.startActivation({provider:'spawn',label:'sdlc-verify',prompt:[{type:'text',text:'shape probe'}],parent:agent,agentPreset:'sdlc-verifier',signal:new AbortController().signal,delivery:'caller'});
   assert.fail('shape probe unexpectedly started a child');
  }catch(error){
   const message=error instanceof Error?error.message:String(error);
   assert.ok(!/Cannot read properties of undefined/.test(message),`activation spec 形状已过期：${message}`);
   console.log('SUBAGENT_SPEC_SHAPE',error&&error.code?error.code:'no-code');
  }
 }else console.log('SUBAGENT_SPEC_SHAPE','skip (no agents service)');
 const {VERIFIER_PRESET}=await import(pathToFileURL(path.join(profileDir,'node_modules/@ai-native-sdlc-plugin/dsh-sdlc/lib/verify/preset.js')));
 const release=await ctx.agentPresets.register(VERIFIER_PRESET);
 try{
  const verifier=await ctx.agentPresets.resolve('sdlc-verifier');
  console.log('VERIFIER_ROSTER',JSON.stringify(verifier));assert.equal(verifier.broken,undefined);
  const actor={},verifierScope=createScope(ctx,actor);actor.ctx=verifierScope.ctx;
  try{
   await ctx.agentPresets.mount(verifierScope.ctx,'sdlc-verifier');
   const visible=ctx.tools.definitions(actor).map(t=>t.name);
   for(const name of ['read','grep','bash','skill'])assert.ok(visible.includes(name),name);
   assert.ok(!visible.some(name=>name.startsWith('sdlc_')||['write','edit','apply_patch','subagent','plugin_manager'].includes(name)));
   console.log('VERIFIER_TOOL_BOUNDARY','pass');
  }finally{await verifierScope.dispose();}
 }finally{await release();}
 assert.ok(!(await ctx.agentPresets.list()).some(p=>p.id==='sdlc-verifier'));console.log('VERIFIER_RELEASE','pass');
} catch(error){failed=true;console.error(error);}
finally{await ctx.fiber.dispose();}
process.exit(failed?1:0);
