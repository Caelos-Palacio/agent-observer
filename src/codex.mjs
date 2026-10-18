import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const helper=fileURLToPath(new URL('./codex_import.py',import.meta.url));
function run(args){
  return new Promise((resolve,reject)=>{
    execFile('/usr/bin/python3',['-I',helper,...args],{
      encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,
      env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},
    },(error,stdout)=>{
      if(error){reject(new Error('Codex metadata operation failed; source content withheld'));return;}
      try{resolve(JSON.parse(stdout));}catch{reject(new Error('Invalid Codex metadata response'));}
    });
  });
}
export function importCodex({file,threadId,database}){
  if(![file,threadId,database].every(value=>typeof value==='string'&&value&&value.length<4096))throw new Error('Explicit Codex file, thread ID and database required');
  return run(['import','--file',file,'--thread-id',threadId,'--database',database]);
}
export function readCodex({database}){
  if(typeof database!=='string'||!database||database.length>=4096)throw new Error('Explicit Codex metadata database required');
  return run(['read','--database',database]);
}
