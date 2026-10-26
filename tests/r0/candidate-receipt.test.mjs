import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {QmdWorker} from '../../packages/engine-qmd/dist/index.js';
import {createApplication} from '../fixtures/application.mjs';

const root=resolve(import.meta.dirname,'../..');
const engineRoot=join(root,'.local/qmd-audited'),modelRoot=join(root,'.local/models');
const documents=[
 ['owners.md','# Project owners\n\nRecord the project owner and review the next milestone before approving the delivery.'],
 ['backups.md','# Project backups\n\nKeep a verified backup of project files before updating the installed application.'],
 ['meetings.md','# Project meetings\n\nReview project milestones and assign a meeting owner to record the delivery decisions.'],
];
async function fixture(prefix){
 await mkdir(join(root,'.local/alpha'),{recursive:true});
 const folder=await mkdtemp(join(root,'.local/alpha',prefix)),source=join(folder,'source');await mkdir(source);
 for(const [name,text] of documents)await writeFile(join(source,name),text);
 return {folder,source};
}
function assertReceipt(response,stage){
 const receipt=response.result.candidate_receipt;
 assert.equal(receipt.stage,stage);
 assert.equal(receipt.candidates.length,response.stats.actualCandidates);
 assert.equal(new Set(receipt.candidates.map(c=>c.file)).size,receipt.candidates.length);
 for(const [index,candidate] of receipt.candidates.entries()){
  assert.deepEqual(Object.keys(candidate).sort(),['file','rank','score']);
  assert.equal(candidate.rank,index+1);assert.ok(Number.isFinite(candidate.score));
 }
 return receipt;
}

test('actual SDK receipt precedes reranking and output limit, and remains observational',async t=>{
 const {folder,source}=await fixture('candidate-sdk-');let worker=new QmdWorker();
 const options={engineRoot,modelRoot,collectionPath:source,dbPath:join(folder,'qmd.sqlite'),embedRole:'embed',strict:true,generationId:'candidate-receipt',collections:{documents:{path:source,pattern:'**/*.md'}},semanticCollections:['documents']};
 const request={query:'project owner milestone',purpose:'find',mode:'hybrid',rerank:true,collections:['documents'],candidate_limit:3,limit:1};
 try{
  const opened=await worker.open({...options,role:'builder'});assert.equal(opened.capabilities.candidateReceipt,true);
  await worker.invoke('update');await worker.invoke('embed');await worker.close();worker=new QmdWorker();await worker.open({...options,role:'reader'});
  const captured=await worker.invoke('search_receipt',request),receipt=assertReceipt(captured,'rrf_before_chunk_selection');
  assert.equal(receipt.candidates.length,3);assert.equal(captured.result.hits.length,1);
  assert.ok(captured.stats.rerankingCalls>0);assert.equal(captured.stats.rerankedCandidates,3);
  const normal=await worker.invoke('search',request);assert.deepEqual(normal.result.hits,captured.result.hits);assert.equal('candidate_receipt' in normal.result,false);
  const noRerank=await worker.invoke('search_receipt',{...request,rerank:false});
  assert.deepEqual(assertReceipt(noRerank,'rrf_before_chunk_selection').candidates,receipt.candidates);assert.equal(noRerank.stats.rerankingCalls,0);
  const empty=await worker.invoke('search_receipt',{...request,filter:{field:'document_key',operator:'eq',value:'absent-document'}});
  assert.deepEqual(assertReceipt(empty,'rrf_before_chunk_selection').candidates,[]);assert.deepEqual(empty.result.hits,[]);
  const lexical=await worker.invoke('search_receipt',{...request,query:'project',mode:'lexical',rerank:false,limit:3});
  assert.equal(assertReceipt(lexical,'bm25').candidates.length,3);
  const fallback=await worker.invoke('search_receipt',{...request,mode:'deep',allow_degraded:true});
  assert.equal(fallback.result.effective_mode,'hybrid');assert.deepEqual(assertReceipt(fallback,'rrf_before_chunk_selection').candidates,receipt.candidates);
  await t.test('older pinned SDK remains usable and rejects unsupported receipt requests',async()=>{
   await worker.close();worker=new QmdWorker();
   // The sealed config contains the engine-specific expansion path, even when absent.
   await assert.rejects(worker.open({...options,engineRoot:join(root,'.local/qmd-recovery'),role:'reader'}),{code:'COMPATIBILITY_FAILED'});
   await worker.close();worker=new QmdWorker();
   const legacy={...options,engineRoot:join(root,'.local/qmd-recovery'),dbPath:join(folder,'legacy.sqlite')};
   await worker.open({...legacy,role:'builder'});await worker.invoke('update');await worker.invoke('embed');
   await worker.close();worker=new QmdWorker();await worker.open({...legacy,role:'reader'});
   assert.deepEqual((await worker.invoke('search',request)).result.hits.map(h=>h.file),captured.result.hits.map(h=>h.file));
   await assert.rejects(worker.invoke('search_receipt',request),{code:'COMPATIBILITY_FAILED'});
  });
 }finally{await worker.close();await rm(folder,{recursive:true,force:true});}
});

test('trusted application sink maps the full candidate pool while public results stay bounded',async()=>{
 const {folder,source}=await fixture('candidate-app-'),receipts=[];
 const app=await createApplication({dataRoot:join(folder,'data'),engineRoot,modelRoot,onCandidateReceipt:r=>receipts.push(r)});
 try{
  const token=(await readFile(join(app.root,'credentials/device-token'),'utf8')).trim();
  const api=async(method,path,value)=>{
   const response=await fetch(app.url+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(value===undefined?{}:{body:JSON.stringify(value)})});
   const packet=await response.json();assert.ok(packet.ok,JSON.stringify(packet));return packet.data;
  };
  const collection=await api('POST','/v1/collections',{name:'Project guides',root:source});
  const built=app.builder.start();await built.completion;assert.equal(app.status().jobs.find(j=>j.job_id===built.job_id).state,'succeeded');
  const request={query:'project owner milestone',purpose:'find',mode:'hybrid',rerank:true,collections:[collection.collection_id],candidate_limit:3,limit:1};
  const accepted=await api('POST','/v1/searches',request);
  let result;
  for(let i=0;i<6000;i++){
   result=await api('GET',accepted.status_url);
   if(['completed','failed','cancelled'].includes(result.state))break;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(result.state,'completed',JSON.stringify(result));assert.equal(result.results.length,1);
  assert.equal(receipts.length,1);const receipt=receipts[0];
  assert.equal(receipt.search_id,result.search_id);assert.equal(receipt.generation_id,result.generation_id);
  assert.equal(receipt.epoch,result.epoch);assert.equal(receipt.profile_fp,result.profile_fp);
  assert.equal(receipt.stage,'rrf_before_chunk_selection');assert.equal(receipt.budget,3);
  assert.equal(receipt.candidates.length,3);assert.equal(receipt.candidates.length,result.telemetry.actual_candidates);
  const lease=app.sessions.readers.reserve();
  try{
   const reader=await lease.ready;
   for(const candidate of receipt.candidates){
    const passage=[...reader.mappings.values()].find(p=>p.passage_id===candidate.passage_id);
    assert.ok(passage);assert.equal(candidate.doc_id,passage.doc_id);assert.equal(candidate.revision_id,passage.revision_id);
    assert.equal(app.catalog.document(candidate.doc_id).latest_revision_id,candidate.revision_id);
    assert.deepEqual(Object.keys(candidate).sort(),['doc_id','passage_id','rank','revision_id','score']);
   }
  }finally{lease.release();}
  assert.equal('candidate_receipt' in result,false);assert.equal('candidates' in result,false);
  const rejected=await fetch(app.url+'/v1/searches',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({...request,capture_candidates:true})});
  const packet=await rejected.json();assert.equal(packet.ok,false);assert.equal(packet.error.code,'INVALID_REQUEST');assert.equal(receipts.length,1);
 }finally{await app.close();await rm(folder,{recursive:true,force:true});}
});
