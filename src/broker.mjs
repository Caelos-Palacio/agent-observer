import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const helper=fileURLToPath(new URL('./broker_import.py',import.meta.url));
function run(args){
  return new Promise((resolve,reject)=>{
    execFile('/usr/bin/python3',['-I',helper,...args],{
      encoding:'utf8',timeout:10000,maxBuffer:8*1024*1024,
      env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},
    },(error,stdout)=>{
      if(error){reject(new Error('Broker metadata operation failed; input withheld'));return;}
      try{resolve(JSON.parse(stdout));}catch{reject(new Error('Invalid broker metadata response'));}
    });
  });
}
function path(value){if(typeof value!=='string'||!value||value.length>=4096)throw new Error('Explicit broker metadata path required');return value;}
export function importBrokerAudit({file,database}){return run(['import','--file',path(file),'--database',path(database)]);}
export function readBrokerAudit({database}){return run(['read','--database',path(database)]);}
export {brokerReviewSnapshot} from './broker_review.mjs';
