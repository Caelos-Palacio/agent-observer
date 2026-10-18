import {readFile} from 'node:fs/promises';
import {review} from '../src/review.mjs';
const corpus=JSON.parse(await readFile(new URL('../fixtures/review-corpus-v1.json',import.meta.url),'utf8'));
let truePositives=0,falsePositives=0,falseNegatives=0;
const cases=[];
for(const item of corpus.cases){
  const result=await review(item.events,{guide:item.guide,coverage:{window:'synthetic-labelled-corpus',truncated:false}});
  const observed=new Set(result.findings.map(f=>f.code)),expected=new Set(item.expected);
  const fp=[...observed].filter(code=>!expected.has(code)),fn=[...expected].filter(code=>!observed.has(code));
  truePositives+=[...observed].filter(code=>expected.has(code)).length;falsePositives+=fp.length;falseNegatives+=fn.length;
  cases.push({id:item.id,passed:!fp.length&&!fn.length,falsePositives:fp,falseNegatives:fn});
}
const report={corpusVersion:corpus.corpusVersion,ruleVersion:1,reviewVersion:2,cases:cases.length,truePositives,falsePositives,falseNegatives,
  precision:truePositives+falsePositives?truePositives/(truePositives+falsePositives):null,
  recall:truePositives+falseNegatives?truePositives/(truePositives+falseNegatives):null,
  results:cases,limitation:'Synthetic operational cases only; not a measure of semantic task quality or real-world accuracy.'};
console.log(JSON.stringify(report,null,2));if(falsePositives||falseNegatives)process.exitCode=1;
