import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir,stat,symlink}from'node:fs/promises';
import {tmpdir}from'node:os';
import {join}from'node:path';
import {createStore}from'../src/store.mjs';
import {spawn}from'node:child_process';
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'observer-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}
async function collect(store){const events=[];for await(const event of store.events())events.push(event);return events;}
test('allowlist drops contents and hashes identifiers; files are private',async t=>{
  const directory=await fixture(t),store=createStore({directory});
  await store.append({event:'tool_end',tool:'read',agent:'private-agent-path',session:'/private/session',status:'ok',prompt:'do not store',output:'secret output',args:{token:'secret'},inputTokens:3});
  const raw=await readFile(join(directory,'events.jsonl'),'utf8');
  assert.equal(/private-agent|private\/session|do not store|secret output|token/.test(raw),false);
  const [event]=await collect(store);assert.equal(event.inputTokens,3);assert.match(event.session,/^[a-f0-9]{32}$/);
  if(process.platform!=='win32')assert.equal((await stat(join(directory,'events.jsonl'))).mode&0o777,0o600);
});
test('two cooperating stores serialize appends without loss',async t=>{
  const directory=await fixture(t),first=createStore({directory}),second=createStore({directory});
  await Promise.all(Array.from({length:80},(_,i)=>(i%2?first:second).append({event:'checkpoint',inputTokens:i})));
  const events=await collect(first);assert.equal(events.length,80);assert.equal(events.reduce((total,event)=>total+event.inputTokens,0),3160);
});
test('rotation retains configured archive count and reads bounded events',async t=>{
  const directory=await fixture(t),store=createStore({directory,maxFileBytes:1024,retain:2});
  for(let i=0;i<80;i++)await store.append({event:'tool_end',tool:'fixture',durationMs:i,status:'ok',session:'session'});
  const files=(await readdir(directory)).filter(name=>name.endsWith('.jsonl'));
  assert.equal(files.length,3);for(const name of files)assert.ok((await stat(join(directory,name))).size<=1024);
  const events=await collect(store);assert.ok(events.length<80&&events.length>0);assert.equal(events.at(-1).durationMs,79);
  const latest=await createStore({directory,maxReadEvents:1}).snapshot();
  assert.equal(latest.events[0].durationMs,79);assert.equal(latest.coverage.truncated,true);
});
test('rejects invalid metadata and linked log files',async t=>{
  const directory=await fixture(t),store=createStore({directory});
  await assert.rejects(store.append({event:'tool_end',inputTokens:-1}),/Invalid/);
  await assert.rejects(store.append({event:'tool_end',tool:'/sensitive/path'}),/Invalid/);
  await assert.rejects(store.append({event:'unknown'}),/Invalid/);
  const target=join(directory,'target');await symlink(target,join(directory,'events.jsonl'));
  await assert.rejects(store.append({event:'checkpoint'}));
});
test('independent processes coordinate rotation and append without lost events',async t=>{
  const directory=await fixture(t);
  const moduleUrl=new URL('../src/store.mjs',import.meta.url).href;
  const worker=offset=>new Promise((resolve,reject)=>{
    const code=`import {createStore}from ${JSON.stringify(moduleUrl)};const store=createStore({directory:${JSON.stringify(directory)},maxFileBytes:1024,retain:5});for(let i=0;i<10;i++)await store.append({event:'checkpoint',inputTokens:i+${offset}});`;
    const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','pipe']});
    child.stderr.resume();child.on('error',reject);child.on('close',status=>status===0?resolve():reject(new Error('Fixture writer failed')));
  });
  await Promise.all([worker(0),worker(10),worker(20)]);
  const events=await collect(createStore({directory,maxFileBytes:1024,retain:5}));
  assert.equal(events.length,30);assert.equal(new Set(events.map(event=>event.inputTokens)).size,30);
});
test('lowering retention removes older archives on the next append',async t=>{
  const directory=await fixture(t),store=createStore({directory,maxFileBytes:1024,retain:5});
  for(let i=0;i<80;i++)await store.append({event:'checkpoint',agent:'agent',session:'session',inputTokens:i});
  assert.ok((await readdir(directory)).some(name=>name==='events.3.jsonl'));
  await createStore({directory,maxFileBytes:1024,retain:0}).append({event:'checkpoint'});
  assert.deepEqual((await readdir(directory)).filter(name=>name.endsWith('.jsonl')),['events.jsonl']);
});
test('snapshot returns the latest bounded window with explicit coverage',async t=>{
  const directory=await fixture(t),store=createStore({directory,maxReadEvents:3});
  for(let i=0;i<6;i++)await store.append({event:'checkpoint',inputTokens:i});
  const snapshot=await store.snapshot();
  assert.deepEqual(snapshot.events.map(event=>event.inputTokens),[3,4,5]);
  assert.equal(snapshot.coverage.truncated,true);assert.equal(snapshot.coverage.readEvents,6);
  assert.equal(snapshot.coverage.returnedEvents,3);assert.equal(snapshot.coverage.eventLimit,3);
  assert.ok(snapshot.coverage.readBytes>0);assert.equal(snapshot.coverage.window,'latest-retained');
  assert.deepEqual(await collect(store),snapshot.events);
});
test('snapshot handles valid retention above 10000 events and keeps hard byte limits',async t=>{
  const directory=await fixture(t),store=createStore({directory});
  // Fixture metadata is written through the same normalized serialization format.
  const event={timestamp:'2026-10-16T00:00:00.000Z',event:'checkpoint'};
  const file=await import('node:fs/promises');
  const lines=Array.from({length:10005},(_,i)=>JSON.stringify({...event,inputTokens:i})+'\n').join('');
  await file.writeFile(join(directory,'events.jsonl'),lines,{mode:0o600});
  const snapshot=await store.snapshot();assert.equal(snapshot.events.length,10000);
  assert.equal(snapshot.events[0].inputTokens,5);assert.equal(snapshot.events.at(-1).inputTokens,10004);
  assert.equal(snapshot.coverage.readEvents,10005);assert.equal(snapshot.coverage.truncated,true);
  await assert.rejects(createStore({directory,maxReadBytes:1024}).snapshot(),/byte limit/);
});
test('opaque identities unlink stores and unregistered tool names cannot carry private text',async t=>{
  const directory=await fixture(t),store=createStore({directory});
  await store.append({event:'tool_end',session:'predictable-session',agent:'predictable-agent',tool:'PRIVATE_SENTINEL'});
  await store.append({event:'tool_end',session:'predictable-session',agent:'predictable-agent',tool:'read'});
  const events=await collect(store);
  assert.equal(events[0].tool,'other');assert.equal(events[0].session,events[1].session);
  const raw=await readFile(join(directory,'events.jsonl'),'utf8');assert.doesNotMatch(raw,/PRIVATE_SENTINEL|predictable/);
  await createStore({directory}).append({event:'checkpoint',session:'predictable-session'});
  assert.notEqual((await collect(store)).at(-1).session,events[0].session);
});
test('explicit recovery preserves complete events and removes only bounded partial tail',async t=>{
  const directory=await fixture(t),store=createStore({directory});
  await store.append({event:'checkpoint',inputTokens:7});
  const {appendFile}=await import('node:fs/promises');await appendFile(join(directory,'events.jsonl'),'{"event":"check');
  await assert.rejects(store.snapshot(),/Incomplete/);
  const result=await store.recover();assert.equal(result.discardedTailBytes,15);assert.equal(result.reclaimedLock,false);
  assert.equal((await collect(store))[0].inputTokens,7);
});
test('recovery refuses legacy locks without deleting them',async t=>{
  const directory=await fixture(t),store=createStore({directory});const {writeFile}=await import('node:fs/promises');
  await writeFile(join(directory,'.writer.lock'),'',{mode:0o600});
  await assert.rejects(store.recover(),/Legacy/);
  assert.equal((await readFile(join(directory,'.writer.lock'))).length,0);
});
test('bounded batch validates before writing and preserves order through rotation',async t=>{
  const directory=await fixture(t),store=createStore({directory,maxFileBytes:1024,retain:5});
  await assert.rejects(store.appendBatch([{event:'checkpoint'},{event:'checkpoint',inputTokens:-1}]));
  assert.equal((await collect(store)).length,0);
  await store.appendBatch(Array.from({length:20},(_,inputTokens)=>({event:'checkpoint',inputTokens})));
  assert.deepEqual((await collect(store)).map(event=>event.inputTokens),Array.from({length:20},(_,i)=>i));
  await assert.rejects(store.appendBatch(Array(101).fill({event:'checkpoint'})));
});
test('neutral SDK supports a host-defined tool without Pi or a provider adapter',async t=>{
  const {createStore:coreStore}=await import('../src/index.mjs');
  const directory=await fixture(t),store=coreStore({directory,registeredTools:['inventory']});
  await store.append({event:'tool_end',tool:'inventory',status:'denied'});
  const [event]=await collect(store);assert.equal(event.tool,'inventory');assert.equal(event.status,'denied');
});
