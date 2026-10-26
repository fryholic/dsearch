import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scoreRetrieval} from '../../packages/evaluation/dist/index.js';

const pool={stage:'rrf_before_chunk_selection',budget:40,candidates:[
 {document_id:'a',passage_id:'a1',rank:1},
 {document_id:'a',passage_id:'a2',rank:2},
 {document_id:'b',passage_id:'b1',rank:3},
]};
const reference={kind:'pooled',complete:true,answerability:'answerable',grades:{a:2,b:1,c:2}};

test('candidate recall uses the full observed pool and counts relevant documents once',()=>{
 const result=scoreRetrieval(pool,['a'],reference);
 assert.equal(result.candidateRecall,1/2);assert.equal(result.anyRelevantCandidateRecall,2/3);assert.equal(result.recallRelevanceThreshold,2);
 assert.equal(result.observedCandidatePassages,3);assert.equal(result.observedCandidateDocuments,2);
 assert.equal(result.candidateBudget,40);assert.equal(result.budgetUnit,'passages');
 assert.equal(result.referenceKind,'pooled');assert.equal(result.provisional,false);
 assert.ok(Math.abs(result.ndcg10-3/(3+3/Math.log2(3)+1/Math.log2(4)))<1e-12);
 assert.equal(result.directMrr10,1);
});

test('unjudged candidates outside the final ten cannot certify release quality',()=>{
 const missing=scoreRetrieval(pool,['a'],{...reference,grades:{a:2,c:2}});
 assert.deepEqual(missing.unjudgedCandidates,['b']);assert.equal(missing.provisional,true);
 assert.equal(missing.candidateRecall,null);assert.equal(missing.ndcg10,null);
 const incomplete=scoreRetrieval(pool,['a'],{...reference,complete:false});assert.equal(incomplete.candidateRecall,null);
 const unknown=scoreRetrieval(pool,['a'],{...reference,answerability:'unknown'});assert.equal(unknown.ndcg10,null);
});

test('negative queries remain a separate result, never perfect recall from an empty denominator',()=>{
 const negative=scoreRetrieval(pool,['a'],{kind:'exhaustive',complete:true,answerability:'no_answer',grades:{a:0,b:0}});
 assert.equal(negative.provisional,false);assert.equal(negative.candidateRecall,null);assert.equal(negative.ndcg10,null);
 assert.equal(negative.noAnswerReturnedDocuments,1);
 assert.throws(()=>scoreRetrieval(pool,['a'],{...reference,answerability:'no_answer'}),/Conflicting/);
});

test('replayed final results and malformed receipts cannot masquerade as the observed candidate pool',()=>{
 assert.throws(()=>scoreRetrieval(pool,['c'],reference),/subset/);
 assert.throws(()=>scoreRetrieval(pool,['a','a'],reference),/unique/);
 assert.throws(()=>scoreRetrieval({...pool,budget:2},['a'],reference),/observation/);
 assert.throws(()=>scoreRetrieval({...pool,candidates:[pool.candidates[0],{...pool.candidates[0],rank:2}]},['a'],reference),/observation/);
 assert.throws(()=>scoreRetrieval({...pool,candidates:[{...pool.candidates[0],rank:2}]},['a'],reference),/observation/);
});
