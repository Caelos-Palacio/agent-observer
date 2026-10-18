import {constants} from 'node:fs';
import {open,lstat,mkdir,rename,rmdir,unlink,opendir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

/** POSIX lock publication: a prepared NONEMPTY directory is renamed atomically.
 * Reclaim/release remove only their unique owner filename, never a replacement's.
 * The dedicated directory and its ancestors must be trusted; not a same-UID sandbox.
 */
export function createDirectoryLock(directory,{timeoutMs=3000}={}){
  const target=join(directory,'.writer-lock.d'),legacy=join(directory,'.writer.lock');
  async function checkRoot(){
    const info=await lstat(directory);
    if(!info.isDirectory()||info.isSymbolicLink()||(process.getuid&&info.uid!==process.getuid())||(info.mode&0o077))throw new Error('Unsafe lock directory');
    try{await lstat(legacy);throw new Error('Legacy writer lock requires manual inspection');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  async function ownerFile(path){
    const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
      const info=await handle.stat();if(!info.isFile()||info.nlink!==1||(process.getuid&&info.uid!==process.getuid())||(info.mode&0o077)||info.size>256)throw new Error('Unsafe writer owner');
      const bytes=Buffer.alloc(257);const {bytesRead}=await handle.read(bytes,0,257,0);return JSON.parse(bytes.subarray(0,bytesRead));
    }finally{await handle.close();}
  }
  async function removeOwned(name,{afterUnlink}={}){
    try{await unlink(join(target,name));}catch(error){if(error.code==='ENOENT')return false;throw error;}
    await afterUnlink?.(); // Trusted-host test barrier; not a log/CLI parameter.
    // A new nonempty publication can occur before this rmdir. Never remove it.
    try{await rmdir(target);}catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code))throw error;}
    return true;
  }
  return {
    async acquire(){
      await checkRoot();let count=0,entries=0;
      const listing=await opendir(directory);
      for await(const entry of listing){if(++entries>128)throw new Error('Dedicated lock directory entry limit');if(/^\.writer-candidate-[a-f0-9]{32}$/.test(entry.name)&&++count>=32)throw new Error('Inspect interrupted writer candidates');}
      const token=randomBytes(16).toString('hex'),candidate=join(directory,'.writer-candidate-'+token),name=`owner-${process.pid}-${token}`;
      await mkdir(candidate,{mode:0o700});let published=false;
      try{
        const handle=await open(join(candidate,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
        try{await handle.writeFile(JSON.stringify({version:2,pid:process.pid,token}));}finally{await handle.close();}
        const deadline=Date.now()+timeoutMs;
        for(;;){
          try{await rename(candidate,target);published=true;break;}catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;if(Date.now()>=deadline)throw new Error('Store is locked; inspect its writer');await delay(15);}
        }
        let released=false;
        return {async release(options){if(released)return;released=true;await removeOwned(name,options);}};
      }finally{
        if(!published){try{await unlink(join(candidate,name));}catch(error){if(error.code!=='ENOENT')throw error;}try{await rmdir(candidate);}catch(error){if(error.code!=='ENOENT')throw error;}}
      }
    },
    async reclaim({beforeUnlink}={}){
      await checkRoot();
      let info;try{info=await lstat(target);}catch(error){if(error.code==='ENOENT')return false;throw error;}
      if(!info.isDirectory()||info.isSymbolicLink()||(process.getuid&&info.uid!==process.getuid())||(info.mode&0o077))throw new Error('Unsafe writer lock');
      const names=[];
      for await(const entry of await opendir(target)){names.push(entry.name);if(names.length>1)throw new Error('Unverifiable writer lock');}
      if(!names.length)return false; // Release/reclaim left an empty directory; acquire can replace it.
      if(names.length!==1||!/^owner-[1-9][0-9]*-[a-f0-9]{32}$/.test(names[0]))throw new Error('Unverifiable writer lock');
      let owner;try{owner=await ownerFile(join(target,names[0]));}catch(error){if(error.code==='ENOENT')return false;throw error;}
      if(!owner||Object.keys(owner).sort().join(',')!=='pid,token,version'||owner.version!==2||!Number.isInteger(owner.pid)||owner.pid<1||!/^[a-f0-9]{32}$/.test(owner.token)||names[0]!==`owner-${owner.pid}-${owner.token}`)throw new Error('Unverifiable writer lock');
      try{process.kill(owner.pid,0);throw new Error('Writer is alive; recovery refused');}catch(error){if(error.code!=='ESRCH')throw error;}
      await beforeUnlink?.(); // Optional trusted-host test barrier, never a log/CLI parameter.
      return removeOwned(names[0]);
    },
  };
}
