import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {importBrokerAudit,readBrokerAudit} from '../src/broker.mjs';
test('Node bridge returns the entire 10000-event broker v2 retained window',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'observer-full-v2-')),file=join(directory,'export.jsonl'),database=join(directory,'private','broker.sqlite');
  try{
    for(let batch=0;batch<4;batch++){
      const rows=Array.from({length:2500},(_,i)=>({schemaVersion:2,source:'agent-credential-broker',
        eventId:(batch*2500+i+1).toString(16).padStart(64,'0'),event:'execute',actionIdHash:'a'.repeat(16),status:'ok',durationMs:60000,
        executionId:(batch*2500+i+1).toString(16).padStart(64,'0'),sequence:batch*2500+i+1,producerId:'b'.repeat(32),
        occurredAtUTC:'2026-10-17T00:00:00.000Z',observedAtUTC:'2026-10-17T00:00:00.001Z'}));
      await writeFile(file,rows.map(row=>JSON.stringify(row)+'\n').join(''),{mode:0o600});
      assert.equal((await importBrokerAudit({file,database})).imported,2500);
    }
    const snapshot=await readBrokerAudit({database});
    assert.equal(snapshot.events.length,10000);assert.equal(snapshot.coverage.returnedEvents,10000);
    assert.equal(snapshot.coverage.eventsWithExecutionMetadata,10000);
    assert.equal(snapshot.events.at(-1).sequence,10000);
    assert.equal(snapshot.coverage.requestCorrelationAvailable,true);
  }finally{await rm(directory,{recursive:true,force:true});}
});
