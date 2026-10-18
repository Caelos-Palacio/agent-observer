/** Review projection only: original imported records and readBrokerAudit stay intact. */
const semanticFields=['brokerStage','tool','status','durationMs','occurredAt','observedAt','inputTokens','outputTokens','cost','session','agent'];
const opaque=(value,length)=>typeof value==='string'&&new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const terminal=event=>event?.event==='tool_end'&&['execute','outcome'].includes(event.brokerStage);
const identity=event=>opaque(event.producerId,32)&&opaque(event.requestId,64)&&Number.isSafeInteger(event.sequence)&&event.sequence>0;
const signature=event=>JSON.stringify(semanticFields.map(key=>[key,event[key]??null]));
export function brokerReviewSnapshot(snapshot){
  if(!snapshot||!Array.isArray(snapshot.events)||snapshot.events.length>10000)throw new Error('Invalid bounded broker review snapshot');
  const raw=snapshot.events;
  if(snapshot.coverage?.source!=='broker')return {...snapshot,coverage:{...snapshot.coverage,brokerReview:{applied:false,reason:'unknown-source',rawEvents:raw.length}}};
  const groups=new Map();let uncorrelatedTerminalEvents=0;
  for(const event of raw){
    if(!terminal(event))continue;
    if(!identity(event)){uncorrelatedTerminalEvents++;continue;}
    const key=JSON.stringify([event.producerId,event.requestId]);
    let group=groups.get(key);
    if(!group){group={latestSequence:event.sequence,final:[],rawCount:0,sequences:new Set()};groups.set(key,group);}
    group.rawCount++;group.sequences.add(event.sequence);
    if(event.sequence>group.latestSequence){group.latestSequence=event.sequence;group.final=[];}
    if(event.sequence===group.latestSequence)group.final.push(event);
  }
  let correctedExecutionGroups=0,supersededTerminalEvents=0,duplicateFinalEvents=0,ambiguousExecutionGroups=0;
  for(const group of groups.values()){
    if(group.sequences.size>1)correctedExecutionGroups++;
    supersededTerminalEvents+=group.rawCount-group.final.length;
    const first=group.final[0],ambiguous=group.final.some(event=>signature(event)!==signature(first));
    if(ambiguous){
      ambiguousExecutionGroups++;
      group.view={event:'tool_end',tool:'broker.ambiguous',timestamp:first.timestamp,
        producerId:first.producerId,requestId:first.requestId,sequence:first.sequence,
        brokerResolution:'ambiguous-final-sequence'};
    }else{duplicateFinalEvents+=group.final.length-1;group.view=first;}
  }
  const emitted=new Set(),events=[];
  for(const event of raw){
    if(!terminal(event)||!identity(event)){events.push(event);continue;}
    const key=JSON.stringify([event.producerId,event.requestId]);
    if(!emitted.has(key)){events.push(groups.get(key).view);emitted.add(key);}
  }
  return {events,coverage:{...snapshot.coverage,sourceCoverageBasis:'raw-retained-audit-metadata',rawReturnedEvents:snapshot.coverage.returnedEvents??raw.length,returnedEvents:events.length,
    brokerReview:{applied:true,version:1,coverageBasis:'normalized-terminal-execution-view',rawEvents:raw.length,reviewedEvents:events.length,correlatedExecutionGroups:groups.size,
      correctedExecutionGroups,supersededTerminalEvents,duplicateFinalEvents,ambiguousExecutionGroups,uncorrelatedTerminalEvents,
      collapsedTerminalEvents:raw.length-events.length,
      callMetricMeaning:'one terminal view per valid v2 producer/execution identity, plus uncorrelated terminal records; not provider request count',
      finalStatusComplete:groups.size+uncorrelatedTerminalEvents===0?null:ambiguousExecutionGroups===0&&uncorrelatedTerminalEvents===0,
      ordering:'group position follows first retained terminal record; final selection uses producer sequence, not import order',
      limitation:'Retained-window projection only. Earlier corrections/intents may be unavailable; IDs and sequence are source claims, never authorization or authenticated evidence.'}}};
}
