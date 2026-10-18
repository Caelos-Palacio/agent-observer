import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createDirectoryLock} from '../src/directory-lock.mjs';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'observer-dirlock-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}
async function deadPid(){const child=spawn(process.execPath,['-e',''],{stdio:'ignore'});await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});return child.pid;}
async function deadLock(directory){const pid=await deadPid(),token='a'.repeat(32),target=join(directory,'.writer-lock.d');await mkdir(target,{mode:0o700});await writeFile(join(target,`owner-${pid}-${token}`),JSON.stringify({version:2,pid,token}),{mode:0o600});return target;}

test('two reclaimers cannot unlink a newly published live writer lock',async t=>{
  const directory=await fixture(t),target=await deadLock(directory),both=deferred(),continueSecond=deferred();
  let arrived=0;
  const first=createDirectoryLock(directory).reclaim({beforeUnlink:async()=>{if(++arrived===2)both.resolve();await both.promise;}});
  const second=createDirectoryLock(directory).reclaim({beforeUnlink:async()=>{if(++arrived===2)both.resolve();await both.promise;await continueSecond.promise;}});
  assert.equal(await first,true);
  const live=await createDirectoryLock(directory).acquire(),owners=await readdir(target);
  continueSecond.resolve();assert.equal(await second,false);
  assert.deepEqual(await readdir(target),owners);
  await assert.rejects(createDirectoryLock(directory,{timeoutMs:30}).acquire(),/locked/);
  await live.release();assert.equal(await createDirectoryLock(directory).reclaim(),false);
});
test('release of an old directory cannot remove a replacement writer directory',async t=>{
  const directory=await fixture(t),afterUnlink=deferred(),continueRelease=deferred();
  const old=await createDirectoryLock(directory).acquire();
  const releasing=old.release({afterUnlink:async()=>{afterUnlink.resolve();await continueRelease.promise;}});
  await afterUnlink.promise;
  const live=await createDirectoryLock(directory).acquire(),target=join(directory,'.writer-lock.d'),owners=await readdir(target);
  continueRelease.resolve();await releasing;
  assert.deepEqual(await readdir(target),owners);
  await assert.rejects(createDirectoryLock(directory,{timeoutMs:30}).acquire(),/locked/);
  await live.release();
});
test('recovery rejects a live owner and refuses unverifiable directory contents',async t=>{
  const directory=await fixture(t),lock=createDirectoryLock(directory),live=await lock.acquire();
  await assert.rejects(lock.reclaim(),/alive/);await live.release();
  const target=join(directory,'.writer-lock.d');await mkdir(target,{mode:0o700});await writeFile(join(target,'unknown'),'',{mode:0o600});
  await assert.rejects(lock.reclaim(),/Unverifiable/);
});
