import {constants} from 'node:fs';
import {open,mkdir,lstat,rename,unlink,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join,parse,relative} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

export const EVENT_TYPES=Object.freeze(['session_start','session_end','agent_start','agent_end','tool_start','tool_end','error','checkpoint']);
const STATUS=new Set(['ok','error','cancelled','timeout','running']);
const MAX_EVENT=2048;
const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,16);
const integer=(value,min,max,name)=>{if(!Number.isInteger(value)||value<min||value>max)throw new Error(`Invalid ${name}`);return value;};

export function normalizeEvent(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||!EVENT_TYPES.includes(input.event))throw new Error('Invalid observer event');
  const event={timestamp:input.timestamp??new Date().toISOString(),event:input.event};
  if(typeof event.timestamp!=='string'||event.timestamp.length>40||!Number.isFinite(Date.parse(event.timestamp)))throw new Error('Invalid timestamp');
  event.timestamp=new Date(event.timestamp).toISOString();
  for(const key of ['session','agent','parent','taskId'])if(input[key]!==undefined){
    if(typeof input[key]!=='string'||!input[key]||input[key].length>512)throw new Error(`Invalid ${key}`);
    event[key]=hash(input[key]);
  }
  if(input.tool!==undefined){if(typeof input.tool!=='string'||!/^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/.test(input.tool)||/^(?:sk-|xai-|gh[pousr]_)/i.test(input.tool))throw new Error('Invalid tool identifier');event.tool=input.tool;}
  if(input.status!==undefined){if(!STATUS.has(input.status))throw new Error('Invalid event status');event.status=input.status;}
  for(const key of ['durationMs','inputTokens','outputTokens','cost'])if(input[key]!==undefined){
    if(typeof input[key]!=='number'||!Number.isFinite(input[key])||input[key]<0||input[key]>1e12||(['inputTokens','outputTokens'].includes(key)&&!Number.isInteger(input[key])))throw new Error(`Invalid ${key}`);
    event[key]=input[key];
  }
  if(Buffer.byteLength(JSON.stringify(event))>MAX_EVENT)throw new Error('Event exceeds 2 KiB');
  return event;
}

/** Metadata only. Directory must be private and owned by this process user.
 * O_EXCL locks coordinate cooperating processes; crash locks need manual removal.
 */
export function createStore({directory,maxFileBytes=1024*1024,retain=5,maxReadBytes=10*1024*1024,maxReadEvents=10000}={}){
  if(typeof directory!=='string'||!directory)throw new Error('Store directory is required');
  integer(maxFileBytes,1024,1024*1024,'maxFileBytes');integer(retain,0,5,'retain');integer(maxReadBytes,1024,10*1024*1024,'maxReadBytes');integer(maxReadEvents,1,10000,'maxReadEvents');
  const root=resolve(directory),current=join(root,'events.jsonl'),lock=join(root,'.writer.lock');
  if(root===parse(root).root)throw new Error('Use a dedicated store directory');
  let pending=Promise.resolve();
  const serial=task=>{const result=pending.then(task,task);pending=result.catch(()=>{});return result;};
  async function prepare(){
    const base=parse(root).root;
    let path=base;
    for(const component of relative(base,root).split(/[\\/]/).filter(Boolean)){
      path=join(path,component);
      try{await mkdir(path,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
      const stat=await lstat(path);
      if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Store path cannot contain symlinks');
      if(path===root&&((process.getuid&&stat.uid!==process.getuid())||(process.platform!=='win32'&&(stat.mode&0o077))))throw new Error('Store directory must be private (0700) and owned by the current user');
    }
  }
  async function withLock(task){
    await prepare();
    let handle;
    const deadline=Date.now()+3000;
    while(!handle){
      try{handle=await open(lock,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
      catch(error){if(error.code!=='EEXIST')throw error;if(Date.now()>=deadline)throw new Error('Store is locked; a crashed writer lock requires manual inspection');await delay(15);}
    }
    try{return await task();}finally{await handle.close();await unlink(lock);}
  }
  async function safeFile(path,flags){
    try{if((await lstat(path)).isSymbolicLink())throw new Error('Store files cannot be symlinks');}catch(error){if(error.code!=='ENOENT')throw error;}
    const file=await open(path,flags|constants.O_NOFOLLOW,0o600);
    const stat=await file.stat();
    if(!stat.isFile()||stat.nlink!==1||(process.getuid&&stat.uid!==process.getuid())||(process.platform!=='win32'&&(stat.mode&0o077))){await file.close();throw new Error('Store files must be private regular files without links');}
    return file;
  }
  const archive=index=>join(root,`events.${index}.jsonl`);
  async function existing(path){try{const handle=await safeFile(path,constants.O_RDONLY);await handle.close();return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
  async function rotate(){
    if(retain===0){await unlink(current);return;}
    if(await existing(archive(retain)))await unlink(archive(retain));
    for(let index=retain-1;index>=1;index--)if(await existing(archive(index)))await rename(archive(index),archive(index+1));
    await rename(current,archive(1));
  }
  const store={
    append(input){return serial(async()=>{
      const event=normalizeEvent(input),line=JSON.stringify(event)+'\n';
      if(Buffer.byteLength(line)>maxFileBytes)throw new Error('Event exceeds configured file limit');
      return withLock(async()=>{
        for(let index=5;index>retain;index--)if(await existing(archive(index)))await unlink(archive(index));
        let handle=await safeFile(current,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND);
        try{
          if((await handle.stat()).size+Buffer.byteLength(line)>maxFileBytes){await handle.close();handle=null;await rotate();handle=await safeFile(current,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND);}
          await handle.writeFile(line);return {accepted:true,event};
        }finally{await handle?.close();}
      });
    });},
    async snapshot(){
      // A ring bounds memory while retaining the latest events in storage order.
      return serial(()=>withLock(async()=>{
        const rows=[];let bytes=0,readEvents=0,next=0;
        const names=(await readdir(root)).filter(name=>/^events(?:\.[1-5])?\.jsonl$/.test(name)).sort((a,b)=>{
          const index=name=>Number(name.match(/\.(\d)\./)?.[1]??0);return index(b)-index(a);
        });
        for(const name of names){
          const handle=await safeFile(join(root,name),constants.O_RDONLY);
          try{
            if((await handle.stat()).size>1024*1024)throw new Error('Store file exceeds hard read limit');
            let rest='';
            for await(const chunk of handle.createReadStream({autoClose:false,highWaterMark:4096})){
              bytes+=chunk.length;if(bytes>maxReadBytes)throw new Error('Store read exceeds byte limit');
              rest+=chunk.toString('utf8');let newline;
              while((newline=rest.indexOf('\n'))!==-1){
                const line=rest.slice(0,newline);rest=rest.slice(newline+1);
                if(!line)continue;if(Buffer.byteLength(line)>MAX_EVENT)throw new Error('Invalid oversized stored event');
                let value;try{value=JSON.parse(line);}catch{throw new Error('Invalid event log JSON');}
                // Revalidate allowlist without hashing IDs a second time.
                const validated=normalizeEvent(value);for(const key of ['session','agent','parent','taskId'])if(value[key]!==undefined){if(!/^[a-f0-9]{16}$/.test(value[key]))throw new Error('Invalid stored identifier');validated[key]=value[key];}
                readEvents++;
                if(rows.length<maxReadEvents)rows.push(validated);
                else{rows[next]=validated;next=(next+1)%maxReadEvents;}
              }
              if(Buffer.byteLength(rest)>MAX_EVENT)throw new Error('Invalid oversized stored event');
            }
            if(rest)throw new Error('Incomplete event log; inspect interrupted append');
          }finally{await handle.close();}
        }
        const events=readEvents>maxReadEvents?[...rows.slice(next),...rows.slice(0,next)]:rows;
        return {events,coverage:{truncated:readEvents>maxReadEvents,readBytes:bytes,readEvents,returnedEvents:events.length,eventLimit:maxReadEvents,byteLimit:maxReadBytes,window:'latest-retained'}};
      }));
    },
    async *events(){
      yield*(await store.snapshot()).events;
    },
  };
  return store;
}
