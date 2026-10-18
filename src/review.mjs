export const DEFAULT_GUIDE=Object.freeze({version:1,thresholds:Object.freeze({repeatedFailures:3,maxConcurrentAgents:3,maxDepth:3,slowToolMs:30000,maxSessionTokens:100000,maxSessionCost:5})});
export function validateGuide(guide=DEFAULT_GUIDE){
  if(!guide||typeof guide!=='object'||Array.isArray(guide)||guide.version!==1||Object.keys(guide).some(key=>!['version','thresholds'].includes(key)))throw new Error('Invalid review guide version or fields');
  const supplied=guide.thresholds??{};
  if(!supplied||typeof supplied!=='object'||Array.isArray(supplied)||Object.keys(supplied).some(key=>!Object.hasOwn(DEFAULT_GUIDE.thresholds,key)))throw new Error('Invalid guide thresholds');
  const thresholds={...DEFAULT_GUIDE.thresholds,...supplied};
  for(const [key,value]of Object.entries(thresholds))if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>1e12||(['repeatedFailures','maxConcurrentAgents','maxDepth','maxSessionTokens'].includes(key)&&!Number.isInteger(value)))throw new Error(`Invalid threshold ${key}`);
  return {version:1,thresholds};
}

/** Heuristics over incremental metadata counters, never a semantic quality score. */
export async function review(events,{guide=DEFAULT_GUIDE,coverage}={}){
  const {thresholds}=validateGuide(guide);
  const findings=[],active=new Set(),activeBySession=new Map(),parents=new Map(),sessions=new Map(),failures=new Map(),tools=new Map();
  const metrics={events:0,toolCalls:0,failedToolCalls:0,inputTokens:0,outputTokens:0,cost:0,maxConcurrentAgents:0,maxDepth:0,slowToolCalls:0,deniedToolCalls:0,uncertainToolCalls:0,counterCoverage:{inputTokens:0,outputTokens:0,cost:0}};
  const add=(code,evidence,message)=>findings.push({code,ruleVersion:1,severity:'warning',evidence,message});
  for await(const event of events){
    if(++metrics.events>10000)throw new Error('Review exceeds 10000-event limit');
    if(!event||typeof event!=='object'||typeof event.event!=='string')throw new Error('Invalid review event');
    const session=event.session??'unspecified';
    if(!sessions.has(session))sessions.set(session,{tokens:0,cost:0});
    const totals=sessions.get(session);
    for(const key of ['inputTokens','outputTokens','cost'])if(event[key]!==undefined){if(typeof event[key]!=='number'||!Number.isFinite(event[key])||event[key]<0)throw new Error('Invalid incremental metric');metrics[key]+=event[key];metrics.counterCoverage[key]++;if(key==='cost')totals.cost+=event[key];else totals.tokens+=event[key];}
    if(event.event==='agent_start'&&event.agent){
      const agentKey=JSON.stringify([session,event.agent]);
      if(!active.has(agentKey)){active.add(agentKey);activeBySession.set(session,(activeBySession.get(session)??0)+1);}
      if(event.parent)parents.set(agentKey,event.parent);
      metrics.maxConcurrentAgents=Math.max(metrics.maxConcurrentAgents,activeBySession.get(session)??0);
      const seen=new Set([event.agent]);let parent=event.parent,depth=1;
      while(parent){if(seen.has(parent)){add('parent_cycle',{agent:event.agent,knownAncestors:seen.size},'Recorded parent relationships contain a cycle; inspect agent registration.');break;}seen.add(parent);depth++;parent=parents.get(JSON.stringify([session,parent]));if(depth>10000)break;}
      metrics.maxDepth=Math.max(metrics.maxDepth,depth);
    }
    if(event.event==='agent_end'&&event.agent){
      if(active.delete(JSON.stringify([session,event.agent])))activeBySession.set(session,Math.max(0,(activeBySession.get(session)??0)-1));
    }
    if(event.event!=='tool_end')continue;
    metrics.toolCalls++;
    const tool=event.tool??'unspecified',key=JSON.stringify([session,event.agent??'unspecified',tool]);
    const counts=tools.get(tool)??{calls:0,failures:0,durationMs:0,slowCalls:0};counts.calls++;
    if(event.durationMs!==undefined){if(typeof event.durationMs!=='number'||!Number.isFinite(event.durationMs)||event.durationMs<0)throw new Error('Invalid duration metric');counts.durationMs+=event.durationMs;if(event.durationMs>thresholds.slowToolMs){counts.slowCalls++;metrics.slowToolCalls++;}}
    if(event.status==='denied')metrics.deniedToolCalls++;
    if(event.status==='uncertain')metrics.uncertainToolCalls++;
    if(['error','timeout'].includes(event.status)){
      counts.failures++;metrics.failedToolCalls++;
      const streak=(failures.get(key)??0)+1;failures.set(key,streak);
      if(streak===thresholds.repeatedFailures)add('repeated_failures',{session,agent:event.agent??null,tool,consecutiveFailures:streak},'Repeated failures are recorded for the same agent and tool; inspect retry policy before another attempt.');
    }else if(event.status==='ok')failures.set(key,0);
    tools.set(tool,counts);
  }
  if(metrics.uncertainToolCalls)add('uncertain_outcomes',{calls:metrics.uncertainToolCalls},'Some actions have uncertain outcomes; verify their effects before retrying. This report does not authorize a retry.');
  if(metrics.maxConcurrentAgents>thresholds.maxConcurrentAgents)add('concurrency_budget',{observed:metrics.maxConcurrentAgents,limit:thresholds.maxConcurrentAgents},'Observed active-agent count within one session exceeded the configured budget; missing end events can inflate this count.');
  if(metrics.maxDepth>thresholds.maxDepth)add('depth_budget',{observed:metrics.maxDepth,limit:thresholds.maxDepth},'Recorded agent nesting exceeded the configured depth budget.');
  for(const [tool,counts]of tools)if(counts.slowCalls)add('slow_tool',{tool,calls:counts.slowCalls,thresholdMs:thresholds.slowToolMs,totalRecordedDurationMs:counts.durationMs},'Tool duration exceeded the configured threshold; metadata alone does not establish wasted work.');
  for(const [session,totals]of sessions){
    if(totals.tokens>thresholds.maxSessionTokens)add('token_budget',{session,observed:totals.tokens,limit:thresholds.maxSessionTokens},'Recorded incremental token counts exceeded the session budget.');
    if(totals.cost>thresholds.maxSessionCost)add('cost_budget',{session,observed:totals.cost,limit:thresholds.maxSessionCost},'Recorded incremental cost exceeded the session budget; units are supplied by the host.');
  }
  for(const finding of findings)finding.evidence={...finding.evidence,observedEvents:metrics.events,observedToolCalls:metrics.toolCalls,window:typeof coverage?.window==='string'?coverage.window:'unspecified',retainedWindowTruncated:coverage?.truncated??null};
  return {reviewVersion:2,guideVersion:guide.version,metrics,findings,tools:Object.fromEntries(tools),limitations:['Heuristic metadata review; no prompts, tool arguments or outputs are inspected.','Counters must be increments, not cumulative snapshots; missing events and retention affect findings.','No semantic quality, correctness, security verdict or LLM judgment is inferred.','Cost units and completeness are defined by the producer; absent counters are unavailable, not evidence of zero usage.']};
}
