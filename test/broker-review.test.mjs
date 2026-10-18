import test from 'node:test';
import assert from 'node:assert/strict';
import {brokerReviewSnapshot} from '../src/broker.mjs';
import {review} from '../src/review.mjs';
const event=(sequence,status='ok',extra={})=>({event:'tool_end',brokerStage:'outcome',producerId:'a'.repeat(32),requestId:'b'.repeat(64),sequence,
  tool:'broker.'+'c'.repeat(16),durationMs:25,timestamp:'2026-10-17T00:00:00Z',status,...extra});
const snapshot=events=>({events,coverage:{source:'broker',returnedEvents:events.length,window:'latest-retained'}});
async function report(events){const view=brokerReviewSnapshot(snapshot(events));return {...await review(view.events,{coverage:view.coverage}),coverage:view.coverage};}
test('later denied or uncertain correction replaces success in the review view only',async()=>{
  for(const status of ['denied','uncertain']){
    const raw=snapshot([event(1),event(2,status)]),saved=JSON.stringify(raw),view=brokerReviewSnapshot(raw),result=await review(view.events);
    assert.equal(result.metrics.toolCalls,1);assert.equal(result.metrics[status==='denied'?'deniedToolCalls':'uncertainToolCalls'],1);
    assert.equal(view.coverage.brokerReview.correctedExecutionGroups,1);assert.equal(view.coverage.rawReturnedEvents,2);
    assert.equal(JSON.stringify(raw),saved);assert.equal(raw.events[0].status,'ok');
  }
});
test('latest producer sequence wins despite reordering and interleaved executions',async()=>{
  const second='d'.repeat(64),result=await report([event(5,'uncertain'),event(4,'ok',{requestId:second}),event(1),event(3,'denied'),event(2,'ok',{requestId:second})]);
  assert.equal(result.metrics.toolCalls,2);assert.equal(result.metrics.uncertainToolCalls,1);
  assert.equal(result.coverage.brokerReview.correctedExecutionGroups,2);assert.equal(result.coverage.brokerReview.supersededTerminalEvents,3);
});
test('identical final sequence duplicates collapse but conflicting final sequence is one unknown outcome',async()=>{
  const identical=await report([event(2),event(2, 'ok',{timestamp:'2026-10-18T00:00:00Z'})]);
  assert.equal(identical.metrics.toolCalls,1);assert.equal(identical.coverage.brokerReview.duplicateFinalEvents,1);
  for(const changed of [{status:'uncertain'},{durationMs:26},{tool:'broker.'+'e'.repeat(16)}]){
    const raw=snapshot([event(2),event(2,'ok',changed)]),view=brokerReviewSnapshot(raw),result=await review(view.events);
    assert.equal(result.metrics.toolCalls,1);assert.equal(result.metrics.uncertainToolCalls,0);assert.equal(result.metrics.deniedToolCalls,0);
    assert.equal(view.coverage.brokerReview.ambiguousExecutionGroups,1);assert.equal(view.coverage.brokerReview.finalStatusComplete,false);
    assert.equal(view.events[0].status,undefined);assert.equal(view.events[0].durationMs,undefined);
  }
});
test('producer boundaries, v1 records and incomplete identities never merge heuristically',async()=>{
  const v1=event(1);delete v1.producerId;delete v1.requestId;delete v1.sequence;
  const result=await report([event(1),event(2,'ok',{producerId:'e'.repeat(32)}),v1,{...v1},event(3,'ok',{requestId:'invalid'}),event(4,'ok',{sequence:undefined})]);
  assert.equal(result.metrics.toolCalls,6);assert.equal(result.coverage.brokerReview.uncorrelatedTerminalEvents,4);
  assert.equal(result.coverage.brokerReview.correlatedExecutionGroups,2);assert.equal(result.coverage.brokerReview.finalStatusComplete,false);
});
test('intents alone are not completed calls and unknown source coverage disables normalization',async()=>{
  const intent=event(1,'intent',{event:'checkpoint',brokerStage:'intent'}),result=await report([intent]);
  assert.equal(result.metrics.toolCalls,0);assert.equal(result.coverage.brokerReview.correlatedExecutionGroups,0);
  const raw={events:[event(1),event(2,'uncertain')]},view=brokerReviewSnapshot(raw);
  assert.equal(view.events.length,2);assert.equal(view.coverage.brokerReview.applied,false);
  assert.equal(view.coverage.brokerReview.reason,'unknown-source');
});
