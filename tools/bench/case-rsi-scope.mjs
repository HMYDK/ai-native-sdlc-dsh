/** Regression from DEMO-22149: verifier logs vanished across sibling preset scopes. */
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileMerged,runCase,REPO} from './lib.mjs';
export async function main({json=false}={}) {
  return runCase({id:'RSI-SCOPE-1',title:'真实任务的验证日志必须进入 RSI，而不是只留下裁决',
    baselineRev:'0025acf',fixedRev:'working-tree build',json,moduleType:'module',
    compile:(revision,work)=>revision==='0025acf'?compileMerged(revision,work):path.join(REPO,'packages/sdlc/lib'),
    judge:async lib=>{
      const runtime=path.join(process.env.DSH_APP??'/Applications/DeepSeek Harness.app','Contents/MacOS/DeepSeek Harness');
      const output=execFileSync(runtime,['--expose-internals',path.join(REPO,'packages/sdlc/smoke/rsi-scopes.mjs')],{
        encoding:'utf8',maxBuffer:8*1024*1024,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',RSI_BENCH_LIB:lib,RSI_BENCH_ONLY:'1'},
      });
      const line=output.split('\n').find(line=>line.startsWith('RSI_SCOPE_RESULT '));
      if(!line)throw new Error('实际运行没有返回观测结果');
      const value=JSON.parse(line.slice('RSI_SCOPE_RESULT '.length));
      return [
        ['保存验证者的真实配置',value.configs===1,`configs=${value.configs}`],
        ['保存跨 preset 工具结果',value.tool_results===1,`tool_results=${value.tool_results}`],
        ['补齐漏发通知并与原始日志对账',value.source_verified&&value.missing_event_recovered,JSON.stringify(value)],
        ['完整证据具有独立的健康状态',value.evidence_complete,`evidence_complete=${value.evidence_complete}`],
      ];
    },
  });
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(await main({json:process.argv.includes('--json')}),null,2));
