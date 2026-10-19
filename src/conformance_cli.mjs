import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {evaluateConformance} from './conformance.mjs';

/** Explicit bounded file only; never discover or append to telemetry sources. */
export async function evaluateFile(args){
  if(args.length!==2||args[0]!=='--file'||!args[1])throw new Error('Explicit evaluation file required');
  const handle=await open(args[1],constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let data;
  try{
    const info=await handle.stat();
    if(!info.isFile()||info.nlink!==1||info.size>524288)throw new Error('Invalid evaluation file');
    const buffer=Buffer.alloc(524289);
    const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
    if(bytesRead>524288)throw new Error('Evaluation file exceeds bound');
    data=JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));
  }finally{await handle.close();}
  if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(key=>!['rubric','runs'].includes(key)))throw new Error('Invalid evaluation envelope');
  const encoded=JSON.stringify(evaluateConformance(data),null,2);
  if(Buffer.byteLength(encoded)>2097152)throw new Error('Evaluation output exceeds bound');
  return encoded+'\n';
}
