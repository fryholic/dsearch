import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,link,unlink,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {QmdWorker} from '../../packages/engine-qmd/dist/index.js';

test('a sealed lexical-only worker needs no model files and rejects every model or mutation entry point',async()=>{
 const root=resolve(import.meta.dirname,'../..');await mkdir(join(root,'.local/alpha'),{recursive:true});
 const folder=await mkdtemp(join(root,'.local/alpha','lexical-reader-')),source=join(folder,'source'),modelRoot=join(folder,'models');
 await mkdir(source);await mkdir(modelRoot);await writeFile(join(source,'owner.md'),'# Delivery owner\n\nRecord the project owner before the next milestone.');
 const registry=JSON.parse(await readFile(join(root,'vendor/models/registry.json'),'utf8'));
 const models=registry.models.filter(m=>['embed','rerank'].includes(m.role));
 for(const model of models)await link(join(root,'.local/models',model.filename),join(modelRoot,model.filename));
 const options={engineRoot:join(root,'.local/qmd-audited'),modelRoot,collectionPath:source,dbPath:join(folder,'qmd.sqlite'),embedRole:'embed',strict:true,generationId:'lexical-only-fixture',collections:{documents:{path:source,pattern:'**/*.md'}}};
 let worker=new QmdWorker();const hash=async()=>createHash('sha256').update(await readFile(options.dbPath)).digest('hex');
 try{
  await worker.open({...options,role:'builder'});await worker.invoke('update');await worker.close();
  for(const model of models)await unlink(join(modelRoot,model.filename));
  const before=await hash();worker=new QmdWorker();await worker.open({...options,role:'lexical-reader'});
  const request={query:'owner',purpose:'find',mode:'lexical',rerank:false,collections:['documents'],limit:10,candidate_limit:40};
  const result=await worker.invoke('search_receipt',request);assert.equal(result.result.hits.length,1);
  assert.deepEqual(Object.keys(result.result.hits[0]).sort(),['file','score']);assert.equal(result.result.candidate_receipt.stage,'bm25');
  assert.equal(result.stats.embeddingCalls,0);assert.equal(result.stats.rerankingCalls,0);
  for(const method of ['update','embed','embed_step','embedding','rerank','inspect','inspect_rerank','query_tokens','device','snapshot','index_audit','cache_audit','clear_cache'])
   await assert.rejects(worker.invoke(method,{text:'owner',query:'owner',target:join(folder,'forbidden.sqlite')}),{code:'SCOPE_DENIED'});
  for(const method of ['search','search_receipt'])for(const mode of ['hybrid','deep'])
   await assert.rejects(worker.invoke(method,{...request,mode,allow_degraded:true}),{code:'SCOPE_DENIED'});
  await worker.close();worker=new QmdWorker();await worker.open({...options,role:'reader'});
  const baseline=await worker.invoke('search_receipt',request);
  assert.deepEqual(result.result.hits,baseline.result.hits);assert.deepEqual(result.result.candidate_receipt,baseline.result.candidate_receipt);
  assert.equal(baseline.stats.embeddingCalls,0);assert.equal(baseline.stats.rerankingCalls,0);
  await worker.close();assert.equal(await hash(),before);
 }finally{await worker.close();await rm(folder,{recursive:true,force:true});}
});
