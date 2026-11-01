/** FLOW-1 R1-R4, derived from DEMO-22149 / 23846 / 23882 and the historical gate audit. */
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileMerged,runCase,sh} from './lib.mjs';
export async function main({json=false}={}){
 return runCase({id:'FLOW-1',title:'问题、裁决与历史记录不能在流程中消失',baselineRev:'ec1f3ed',fixedRev:'HEAD',moduleType:'module',json,
  compile:(rev,work)=>compileMerged(rev,work),
  judge:lib=>JSON.parse(sh('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',['--expose-internals',path.join(import.meta.dirname,'flow-probe.mjs'),lib],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}}).split('\n').find(s=>s.startsWith('FLOW_PROBE ')).slice(11))});
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){const r=await main();process.exitCode=r.ok?0:1;}
