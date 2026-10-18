import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
test('CLI records allowlisted metadata, reviews and exports a guide pack locally',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'observer-cli-'));const logs=join(dir,'logs');
  const call=args=>{const child=spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});assert.ifError(child.error);assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout);};
  try{
    const saved=call(['append',JSON.stringify({event:'tool_end',tool:'read',session:'s',agent:'a',durationMs:25,status:'ok',prompt:'NEVER_RETAIN_THIS'}),'--directory',logs]);
    assert.ok(!JSON.stringify(saved).includes('NEVER_RETAIN_THIS'));
    const report=call(['review','--directory',logs]);assert.equal(report.metrics.toolCalls,1);assert.equal(report.coverage.returnedEvents,1);
    const pack=call(['pack','--directory',logs]);assert.equal(pack.report.metrics.events,1);assert.equal(pack.guide.version,1);
    const guide=join(dir,'guide.json');await writeFile(guide,JSON.stringify({version:1,thresholds:{slowToolMs:10}}));
    assert.ok(call(['review','--directory',logs,'--guide',guide]).findings.some(f=>f.code==='slow_tool'));
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('CLI imports Codex increment metadata once and reviews its own database',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'observer-codex-'));const file=join(dir,'fixture.jsonl'),database=join(dir,'private','metadata.sqlite');
  const call=args=>{const child=spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});assert.ifError(child.error);assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout);};
  try{
    await writeFile(file,JSON.stringify({type:'token_usage_record',timestamp:'2026-10-16T00:00:00Z',payload:{thread_id:'fixture-thread',response_id:'fixture-response',usage:{input_tokens:25,output_tokens:4},secret:'DO_NOT_RETAIN'}})+'\n');
    const args=['import-codex','--file',file,'--thread-id','fixture-thread','--database',database];
    assert.equal(call(args).imported,1);assert.equal(call(args).imported,0);
    const report=call(['review','--source','codex','--database',database]);
    assert.equal(report.metrics.inputTokens,25);assert.equal(report.metrics.outputTokens,4);
    assert.equal(report.metrics.counterCoverage.cost,0);assert.equal(report.coverage.costAvailable,false);
    assert.ok(!JSON.stringify(report).includes('DO_NOT_RETAIN'));
    assert.equal(call(['pack','--source','codex','--database',database]).report.metrics.events,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('CLI imports broker audit metadata with stable deduplication and explicit coverage',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'observer-broker-'));const file=join(dir,'export.jsonl'),database=join(dir,'private','metadata.sqlite');
  const call=args=>{const child=spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});assert.ifError(child.error);assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout);};
  try{
    const dto=(event,status,id)=>({schemaVersion:1,source:'agent-credential-broker',eventId:id.repeat(64),event,actionIdHash:'c'.repeat(16),status,durationMs:25});
    await writeFile(file,[dto('intent','intent','a'),dto('outcome','uncertain','b'),dto('execute','denied','d')].map(x=>JSON.stringify(x)+'\n').join(''));
    const args=['import-broker-audit','--file',file,'--database',database];
    assert.equal(call(args).imported,3);assert.equal(call(args).imported,0);
    const report=call(['review','--source','broker','--database',database]);
    assert.equal(report.metrics.toolCalls,2);assert.equal(report.metrics.deniedToolCalls,1);assert.equal(report.metrics.uncertainToolCalls,1);
    assert.equal(report.coverage.executionTimestampsAvailable,false);assert.equal(report.metrics.counterCoverage.inputTokens,0);
    assert.ok(report.findings.some(f=>f.code==='uncertain_outcomes'));
    assert.equal(call(['pack','--source','broker','--database',database]).report.metrics.events,3);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('CLI errors never echo user paths, guide content or child failure details',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'observer-errors-'));
  try{
    const missing=join(dir,'PRIVATE_SENTINEL_MISSING');
    const guide=join(dir,'guide.json');await writeFile(guide,'PRIVATE_SENTINEL_GUIDE');
    const oversized=join(dir,'oversized.json');await writeFile(oversized,'PRIVATE_SENTINEL'.repeat(2000));
    for(const args of [
      ['review','--guide',missing],['review','--guide',guide],['review','--guide',oversized],
      ['import-broker-audit','--file',missing,'--database',join(dir,'private','data.sqlite')],
      ['review','--source','broker','--database',missing],
    ]){
      const child=spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});assert.ifError(child.error);assert.equal(child.status,1);
      assert.ok(!(child.stdout+child.stderr).includes('PRIVATE_SENTINEL'));
      assert.equal(child.stderr,'Agent Observer: operation failed; input withheld\n');
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});
