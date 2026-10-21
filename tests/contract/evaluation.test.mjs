import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scoreRanking,percentile,validateEvaluationSplit} from '../../packages/evaluation/dist/index.js';
test('document ranking metrics deduplicate passages and preserve unjudged/no-answer distinctions',()=>{
 const labels={a:2,b:1,c:0};const ideal=scoreRanking(['a','a','b','c'],labels);assert.equal(ideal.ndcg10,1);assert.equal(ideal.recall40,1);assert.equal(ideal.mrr10,1);assert.equal(ideal.uniqueCandidates,3);
 const reversed=scoreRanking(['b','a'],labels);assert.ok(Math.abs(reversed.ndcg10-((1+3/Math.log2(3))/(3+1/Math.log2(3))))<1e-12);assert.equal(reversed.mrr10,0.5);
 assert.equal(scoreRanking(['missing'],labels).provisional,true);assert.equal(scoreRanking(['missing'],labels).ndcg10,null);
 assert.equal(scoreRanking(['a'],{a:0}).recall40,null);assert.equal(scoreRanking(['a'],{a:0}).ndcg10,null);
 assert.equal(percentile([2,100,1,3],0.95),100);
});
test('evaluation split refuses duplicate identities and cross-split source-family leakage',()=>{
 const one={id:'tune',groups:['source-family'],split:'tuning'};
 assert.deepEqual(validateEvaluationSplit([one],false),{tuning:1,holdout:0,sourceGroups:1});
 assert.throws(()=>validateEvaluationSplit([one,{id:'fixed',groups:['source-family'],split:'holdout'}],false),/leakage/);
 assert.throws(()=>validateEvaluationSplit([one,one],false));assert.throws(()=>validateEvaluationSplit([one]),/Incomplete/);
});
