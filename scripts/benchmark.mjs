/** Local synthetic benchmark. No network, models, user logs or secrets. */
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createObserver} from '../integrations/pi-observer.ts';
const self=fileURLToPath(import.meta.url);
const percentile=(values,p)=>values.sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))];
if(process.argv[2]==='--worker'){
  const mode=process.argv[3],directory=process.argv[4],module=process.argv[5];
  const hooks=new Map(),host={on:(name,fn)=>hooks.set(name,fn),registerTool:()=>{}};
  const enabled=mode!=='disabled';
  const {createStore}=await import(module?pathToFileURL(module).href:new URL('../src/store.mjs',import.meta.url).href);
  const store=createStore({directory});
  const observer=createObserver(host,{enabled,env:{},store});
  await observer.ready;
  const cpu=process.cpuUsage(),started=performance.now(),latencies=[];const calls=200;
  for(let i=0;i<calls;i++){
    const before=performance.now();hooks.get('tool_call')?.({toolName:'read',toolCallId:String(i)});
    hooks.get('tool_result')?.({toolName:'read',toolCallId:String(i),isError:false});latencies.push(performance.now()-before);
    if(i%25===24)await observer.flush();
  }
  await observer.flush();const wallMs=performance.now()-started,used=process.cpuUsage(cpu);
  let bytes=0;try{for(const name of await readdir(directory))if(name.endsWith('.jsonl'))bytes+=(await stat(join(directory,name))).size;}catch{}
  console.log(JSON.stringify({mode,calls,expectedEvents:enabled?calls*2:0,wallMs,cpuMs:(used.user+used.system)/1000,
    enqueuePairP50Ms:percentile(latencies,.5),enqueuePairP95Ms:percentile(latencies,.95),maxRssKiB:process.resourceUsage().maxRSS,
    bytes,bytesPerEvent:enabled?bytes/(calls*2):0,droppedEvents:observer.health?.droppedEvents??0}));
}else{
  const directory=await mkdtemp(join(tmpdir(),'observer-benchmark-'));const results=[];
  try{
    const baseline=fileURLToPath(new URL('../fixtures/baseline-store-v0.3.mjs',import.meta.url));
    for(const mode of ['disabled','baseline','enabled'])for(let repetition=0;repetition<3;repetition++){
      const args=[self,'--worker',mode,join(directory,`${mode}-${repetition}`),...(mode==='baseline'?[baseline]:[])];
      const child=spawnSync(process.execPath,args,{encoding:'utf8',timeout:15000,maxBuffer:16384});
      if(child.error||child.status!==0)throw new Error('Synthetic benchmark failed');
      results.push(JSON.parse(child.stdout));
    }
    console.log(JSON.stringify({benchmarkVersion:1,node:process.version,platform:process.platform,baseline:'bundled v0.3 store with current Pi hooks',
      note:'Synthetic 200 calls, 400 metadata events, flush each 25 calls, 3 isolated repetitions per mode. Baseline strips v2 fields; enhanced mode stores them. Peak RSS includes runtime. No production performance claim.',
      results},null,2));
  }finally{await rm(directory,{recursive:true,force:true});}
}
