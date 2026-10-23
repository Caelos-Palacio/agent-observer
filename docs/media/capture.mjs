/**
 * Capture REAL Agent Observer output for the demo GIF (docs/media/demo.py reads capture.json).
 * Runs the real CLI in a temporary directory with synthetic events and fake credentials.
 * The broker export comes from the real Agent Credential Broker audit writer/exporter.
 * Usage: node docs/media/capture.mjs [path/to/agent-credential-broker]   (needs its .venv)
 */
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const broker=resolve(process.argv[2]??join(root,'../agent-credential-broker'));
const cli=join(root,'src/cli.mjs');
const dir=await mkdtemp(join(tmpdir(),'observer-demo-'));
const run=(program,args)=>{const c=spawnSync(program,args,{encoding:'utf8',timeout:20000});assert.equal(c.status,0,c.stderr);return c.stdout;};
const obs=(...args)=>run(process.execPath,[cli,...args]);
const FAKE='sk-demo-FAKE-0000';
try{
  const logs=join(dir,'logs');
  // 1) neutral log: unknown / sensitive fields are dropped on append
  const dirty=JSON.stringify({event:'tool_end',tool:'bash',status:'error',durationMs:912,prompt:'rm -rf demo',apiKey:FAKE});
  const appendOut=[];
  for(let i=0;i<3;i++)appendOut.push(obs('append',dirty,'--directory',logs).trim());
  obs('append',JSON.stringify({event:'tool_end',tool:'bash',status:'ok',durationMs:41000}),'--directory',logs);
  // 2) review (abridged to the fields shown in the demo)
  const full=JSON.parse(obs('review','--directory',logs));
  const rep=(f)=>({code:f.code,severity:f.severity,tool:f.evidence.tool,...(f.evidence.consecutiveFailures?{consecutiveFailures:f.evidence.consecutiveFailures}:{thresholdMs:f.evidence.thresholdMs})});
  const reviewLines=[
    `{"metrics":{"toolCalls":${full.metrics.toolCalls},"failedToolCalls":${full.metrics.failedToolCalls},"slowToolCalls":${full.metrics.slowToolCalls}},`,
    ' "findings":[',
    ...full.findings.map((f,i)=>'  '+JSON.stringify(rep(f))+(i<full.findings.length-1?',':'')),
    ' ],',
    ` "limitations":[${JSON.stringify(full.limitations[0])}, …]}`,
  ];
  // 3) broker audit export -> import -> review, using the real broker exporter
  const audit=join(dir,'custodian'),file=join(dir,'export.jsonl'),database=join(dir,'observer','broker.sqlite');
  await mkdir(audit,{mode:0o700});
  const py=`import sys\nsys.path.insert(0,sys.argv[1])\nfrom credential_broker.host import AuditLog\nfrom credential_broker.audit_export import export_audit\naudit=AuditLog(sys.argv[2])\nfor event,status in [('intent','intent'),('outcome','ok'),('execute','denied')]:\n audit({'event':event,'status':status,'actionIdHash':'a'*16,'durationMs':20,'password':'${FAKE}','body':{'key':'${FAKE}'}})\nprint(export_audit(sys.argv[2]),end='')`;
  const exported=run(join(broker,'.venv/bin/python'),['-I','-c',py,broker,audit]);
  assert.ok(!exported.includes(FAKE),'fake key must not reach the export');
  await writeFile(file,exported,{mode:0o600});
  const importOut=obs('import-broker-audit','--file',file,'--database',database).trim();
  const b=JSON.parse(obs('review','--source','broker','--database',database));
  const brokerLines=[
    `{"metrics":{"events":${b.metrics.events},"toolCalls":${b.metrics.toolCalls},"deniedToolCalls":${b.metrics.deniedToolCalls}},`,
    ` "coverage":{"executionTimestampsAvailable":${b.coverage.executionTimestampsAvailable}},`,
    ` "limitations":[${JSON.stringify(b.limitations.at(-1))}]}`,
  ];
  assert.ok(!(await readFile(database)).includes(Buffer.from(FAKE)));
  const capture={
    fake:FAKE,
    appendCommand:`node src/cli.mjs append '${dirty}' --directory LOGS`,
    appendOut:appendOut[0],
    reviewCommand:'node src/cli.mjs review --directory LOGS',
    reviewLines,
    exportFirstLine:exported.split('\n')[0],
    importCommand:'node src/cli.mjs import-broker-audit --file export.jsonl --database broker.sqlite',
    importOut,
    reimportOut:obs('import-broker-audit','--file',file,'--database',database).trim(),
    brokerCommand:'node src/cli.mjs review --source broker --database broker.sqlite',
    brokerLines,
  };
  await writeFile(join(root,'docs/media/capture.json'),JSON.stringify(capture,null,1)+'\n');
  console.log('ok',importOut,capture.reimportOut);
}finally{await rm(dir,{recursive:true,force:true});}
