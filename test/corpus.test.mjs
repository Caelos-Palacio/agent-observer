import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {review} from '../src/review.mjs';
const corpus=JSON.parse(await readFile(new URL('../fixtures/review-corpus-v1.json',import.meta.url),'utf8'));
test('versioned labelled corpus catches operational false positives and missed rules',async()=>{
  for(const fixture of corpus.cases){
    const report=await review(fixture.events,{guide:fixture.guide,coverage:{window:'synthetic',truncated:false}});
    assert.deepEqual([...new Set(report.findings.map(f=>f.code))].sort(),[...fixture.expected].sort(),fixture.id);
    assert.equal(report.reviewVersion,2);
    for(const finding of report.findings){assert.equal(finding.ruleVersion,1);assert.equal(finding.evidence.observedEvents,fixture.events.length);}
  }
});
