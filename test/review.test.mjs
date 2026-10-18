import test from'node:test';
import assert from'node:assert/strict';
import {review,validateGuide}from'../src/review.mjs';
test('findings derive from recorded counters and explicit guide budgets',async()=>{
  const events=[{event:'agent_start',agent:'root'},{event:'agent_start',agent:'child',parent:'root'},...Array.from({length:3},()=>({event:'tool_end',agent:'child',session:'s',tool:'fetch',status:'error',durationMs:30,inputTokens:5,cost:1}))];
  const result=await review(events,{guide:{version:1,thresholds:{repeatedFailures:3,maxConcurrentAgents:1,maxDepth:1,slowToolMs:20,maxSessionTokens:10,maxSessionCost:2}}});
  assert.equal(result.metrics.toolCalls,3);assert.equal(result.metrics.failedToolCalls,3);assert.equal(result.metrics.inputTokens,15);
  assert.deepEqual(new Set(result.findings.map(f=>f.code)),new Set(['repeated_failures','concurrency_budget','depth_budget','slow_tool','token_budget','cost_budget']));
  assert.equal(result.findings.find(f=>f.code==='repeated_failures').evidence.consecutiveFailures,3);
});
test('successful calls reset failure streak, cancellations do not count as errors',async()=>{
  const statuses=['error','ok','error','cancelled','error'];
  const result=await review(statuses.map(status=>({event:'tool_end',tool:'read',status})));
  assert.equal(result.metrics.failedToolCalls,3);assert.equal(result.findings.length,0);
});
test('typed guides reject unknown fields and invalid thresholds',()=>{
  for(const guide of [{version:2},{version:1,prompt:'hidden instructions'},{version:1,thresholds:{fake:1}},{version:1,thresholds:{repeatedFailures:0}},{version:1,thresholds:{maxDepth:1.5}}])assert.throws(()=>validateGuide(guide),/Invalid/);
});
test('review accepts async streams and never infers semantic failure',async()=>{
  async function* events(){yield {event:'checkpoint'};yield {event:'tool_end',tool:'read',status:'ok'};}
  const result=await review(events());assert.equal(result.metrics.events,2);assert.equal(result.findings.length,0);assert.ok(result.limitations.some(text=>text.includes('No semantic')));
});
test('concurrency and parent identities never leak across sessions',async()=>{
  const report=await review([
    {event:'agent_start',session:'one',agent:'same'},
    {event:'agent_start',session:'two',agent:'same'},
    {event:'agent_start',session:'two',agent:'child',parent:'same'},
    {event:'agent_end',session:'one',agent:'same'},
  ]);
  assert.equal(report.metrics.maxConcurrentAgents,2);
  assert.equal(report.metrics.maxDepth,2);
});
test('broker denial, uncertain outcome and intent remain distinct from technical failures',async()=>{
  const report=await review([
    {event:'checkpoint',status:'intent'},
    {event:'tool_end',status:'denied'},
    {event:'tool_end',status:'uncertain'},
  ]);
  assert.equal(report.metrics.events,3);assert.equal(report.metrics.toolCalls,2);
  assert.equal(report.metrics.failedToolCalls,0);assert.equal(report.metrics.deniedToolCalls,1);
  assert.equal(report.metrics.uncertainToolCalls,1);
  assert.deepEqual(report.findings.map(f=>f.code),['uncertain_outcomes']);
});
