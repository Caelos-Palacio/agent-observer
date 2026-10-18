/** Optional cross-project check; only synthetic metadata in temporary directories. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const broker=resolve(process.argv[2]??'../agent-credential-broker');
const python=join(broker,'.venv/bin/python');
const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
const dir=await mkdtemp(join(tmpdir(),'observer-broker-e2e-'));
function run(program,args){const child=spawnSync(program,args,{encoding:'utf8',timeout:10000,maxBuffer:2*1024*1024});assert.ifError(child.error);assert.equal(child.status,0,child.stderr);return child.stdout;}
try{
  const audit=join(dir,'custodian'),file=join(dir,'export.jsonl'),database=join(dir,'observer','metadata.sqlite');
  await mkdir(audit,{mode:0o700});
  const code=`import sys\nsys.path.insert(0,sys.argv[1])\nfrom credential_broker.gui import AuditLog\nfrom credential_broker.audit_export import export_audit\naudit=AuditLog(sys.argv[2])\nfor event,status in [('intent','intent'),('outcome','ok'),('execute','denied')]:\n audit({'event':event,'status':status,'actionIdHash':'a'*16,'durationMs':20,'password':'SYNTHETIC_NEVER_PERSIST','body':{'key':'SYNTHETIC_NEVER_PERSIST'}})\nprint(export_audit(sys.argv[2]),end='')`;
  const metadata=run(python,['-I','-c',code,broker,audit]);
  assert.ok(!metadata.includes('SYNTHETIC_NEVER_PERSIST'));
  await writeFile(file,metadata,{mode:0o600});
  const command=['import-broker-audit','--file',file,'--database',database];
  assert.equal(JSON.parse(run(process.execPath,[cli,...command])).imported,3);
  assert.equal(JSON.parse(run(process.execPath,[cli,...command])).imported,0);
  const report=JSON.parse(run(process.execPath,[cli,'review','--source','broker','--database',database]));
  assert.equal(report.metrics.events,3);assert.equal(report.metrics.toolCalls,2);assert.equal(report.metrics.deniedToolCalls,1);
  assert.equal(report.coverage.executionTimestampsAvailable,false);
  assert.ok(!(await readFile(database)).includes(Buffer.from('SYNTHETIC_NEVER_PERSIST')));
  const metadataV2=run(python,['-I','-c',`import sys\nsys.path.insert(0,sys.argv[1])\nfrom credential_broker.audit_export import export_audit\nprint(export_audit(sys.argv[2],schema_version=2),end='')`,broker,audit]);
  const fileV2=join(dir,'export-v2.jsonl'),databaseV2=join(dir,'observer-v2','metadata.sqlite');
  await writeFile(fileV2,metadataV2,{mode:0o600});
  assert.equal(JSON.parse(run(process.execPath,[cli,'import-broker-audit','--file',fileV2,'--database',databaseV2])).imported,3);
  const reportV2=JSON.parse(run(process.execPath,[cli,'review','--source','broker','--database',databaseV2]));
  assert.equal(reportV2.coverage.eventsWithExecutionMetadata,3);assert.equal(reportV2.coverage.requestCorrelationAvailable,true);
  assert.equal(reportV2.coverage.authenticatedAudit,false);
  console.log(JSON.stringify({ok:true,imported:3,reimported:0,toolCalls:2,denied:1,v2Events:3,realVaultOpened:false}));
}finally{await rm(dir,{recursive:true,force:true});}
