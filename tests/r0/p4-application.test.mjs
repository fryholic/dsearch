import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,link} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {ReaderPool,SourceSearch} from '../../packages/search/dist/index.js';
import {SearchRequest} from '../../packages/contracts/dist/index.js';
import {createApplication} from '../../apps/daemon/dist/index.js';
const root=resolve(import.meta.dirname,'../..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('P4 actual product hybrid, rerank, supplemental evidence, related/compare, model fallback and cancellation',async t=>{
 await mkdir(join(root,'.local/alpha'),{recursive:true});const folder=await mkdtemp(join(root,'.local/alpha/p4-')),sources=join(folder,'source'),models=join(folder,'models');await mkdir(sources);await mkdir(models);
 const registry=JSON.parse(await readFile(join(root,'vendor/models/registry.json'),'utf8')).models;
 for(const model of registry.filter(m=>m.role!=='reference'))await link(join(root,'.local/models',model.filename),join(models,model.filename));
 await writeFile(join(sources,'agreement.md'),'# Elliptic curve Diffie Hellman\n\nEach peer multiplies a public curve point by its secret scalar. Both parties compute an identical shared secret without disclosing their private keys.');
 await writeFile(join(sources,'encoding.md'),'# Canonical representation\n\nCanonical encoding ensures identical byte sequences before hashing and digital signature verification.');
 await writeFile(join(sources,'gardens.md'),'# Gardening\n\nGarden irrigation delivers water to green vegetables and flowers.');
 await writeFile(join(sources,'code.md'),'# Atomic code\n\n```text\nlexicalonlysentinel '+ 'x'.repeat(2800)+'\n```');
 const app=await createApplication({dataRoot:join(folder,'data'),engineRoot:join(root,'.local/qmd-upstream'),modelRoot:models});
 const token=(await readFile(join(app.root,'credentials/device-token'),'utf8')).trim();
 const api=async(method,path,value)=>{const response=await fetch(app.url+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(value!==undefined?{body:JSON.stringify(value)}:{})});const packet=await response.json();assert.ok(packet.ok,JSON.stringify(packet));return packet.data;};
 const wait=async path=>{for(let i=0;i<6000;i++){const s=await api('GET',path);if(['completed','succeeded','failed','cancelled'].includes(s.state))return s;await sleep(10);}throw new Error('P4 operation timed out');};
 const search=async request=>wait((await api('POST','/v1/searches',request)).status_url);
 let col,base;
 try{
  col=await api('POST','/v1/collections',{name:'P4 synthetic',root:sources});const job=await api('POST','/v1/reconcile',{});assert.equal((await wait('/v1/jobs/'+job.job_id)).state,'succeeded');
  base={query:'서로 비밀을 보내지 않고 같은 값을 만드는 방법',purpose:'find',collections:[col.collection_id],mode:'hybrid',rerank:false,candidate_limit:40,limit:50};
  await t.test('semantic-only hits carry exact primary source quotes and real lex/vec candidate telemetry',async()=>{
   const done=await search(base);assert.equal(done.state,'completed',JSON.stringify(done));assert.equal(done.rank_stage,'qmd_rrf');assert.equal(done.degraded,false);assert.ok(done.telemetry.vector_contributors>0);assert.ok(done.telemetry.embedding_calls>0);assert.equal(done.telemetry.truncated_inputs,0);assert.ok(done.counts.retrieved_passages<=40);
   const agreed=done.results.find(d=>d.relative_path==='agreement.md');assert.ok(agreed);assert.equal(agreed.evidence[0].match_type,'semantic');
   for(const d of done.results){assert.ok(d.evidence.length<=2);for(const e of d.evidence){const read=await api('POST','/v1/documents/read',{doc_id:d.doc_id,revision_id:d.revision_id,locator:e.locator});assert.ok(read.text.includes(e.excerpt));assert.ok(!e.excerpt.includes('document_key'));}}
  });
  await t.test('rerank and candidate budgets report actual execution; lexical-only score stays separate',async()=>{
   const done=await search({...base,query:'canonical encoding',rerank:true,candidate_limit:2});assert.equal(done.state,'completed',JSON.stringify(done));assert.equal(done.rank_stage,'qmd_reranked_blend');assert.ok(done.counts.reranked_passages>0&&done.counts.reranked_passages<=2);assert.equal(done.telemetry.fallback_used,false);
   const extra=await search({...base,query:'lexicalonlysentinel'});assert.equal(extra.state,'completed');assert.ok(extra.supplemental_results.some(d=>d.relative_path==='code.md'));assert.ok(extra.results.every(d=>d.relative_path!=='code.md'));
  });
  await t.test('deep requires explicit expansion; permitted fallback executes actual structured hybrid',async()=>{
   const denied=await search({...base,mode:'deep'});assert.equal(denied.state,'failed');assert.equal(denied.error.code,'MODEL_NOT_INSTALLED');
   const fallback=await search({...base,mode:'deep',allow_degraded:true});assert.equal(fallback.state,'completed');assert.equal(fallback.effective_mode,'hybrid');assert.equal(fallback.degraded,true);assert.ok(fallback.warnings.includes('EXPANSION_MODEL_NOT_INSTALLED'));
   const tooLong=await search({...base,query:'비밀 곡선 입력 문자열 '.repeat(160),allow_degraded:true});assert.equal(tooLong.state,'failed');assert.equal(tooLong.error.code,'INPUT_TOO_LONG');
  });
  await t.test('related excludes its source and compare pins independent expected revisions',async()=>{
   const docs=(await search({...base,query:'shared secret'})).results,agreement=docs.find(d=>d.relative_path==='agreement.md'),encoding=docs.find(d=>d.relative_path==='encoding.md');assert.ok(agreement&&encoding);
   const related=await wait((await api('POST','/v1/related-searches',{source:{doc_id:agreement.doc_id,revision_id:agreement.revision_id,locator:agreement.evidence[0].locator},collections:base.collections,mode:'hybrid',rerank:false})).status_url);assert.equal(related.state,'completed',JSON.stringify(related));assert.equal(related.purpose,'related');assert.ok(related.results.every(d=>d.doc_id!==agreement.doc_id));assert.ok(related.query_plan.used_spans.length);assert.equal(related.query_plan.derived_query,true);
   const refs={left:{doc_id:agreement.doc_id,revision_id:agreement.revision_id},right:{doc_id:encoding.doc_id,revision_id:encoding.revision_id}};
   const comparison=await wait((await api('POST','/v1/comparisons',{...refs,query:'cryptographic input',mode:'hybrid',rerank:false})).status_url);assert.equal(comparison.state,'completed',JSON.stringify(comparison));assert.equal(comparison.purpose,'compare');for(const side of ['left','right']){assert.deepEqual(comparison[side].source,refs[side]);assert.ok(comparison[side].result.results.every(d=>d.doc_id===refs[side].doc_id&&d.revision_id===refs[side].revision_id));}
   const stale=await wait((await api('POST','/v1/comparisons',{...refs,right:{...refs.right,revision_id:'a'.repeat(64)},query:'input',mode:'hybrid',rerank:false})).status_url);assert.equal(stale.error.code,'STALE_REVISION');
  });
  await t.test('long related input is deterministically budgeted by the installed tokenizer with omissions disclosed',async()=>{
   const file=join(sources,'agreement.md'),original=await readFile(file,'utf8');
   try{const long=original+'\n\n'+('수학 조건과 비밀 키를 검증하는 첫 번째 정의. '.repeat(1000));await writeFile(file,long);await app.catalog.reconcile(col.collection_id);const doc=app.catalog.documents(col.collection_id).find(d=>d.relative_path==='agreement.md');
    const done=await wait((await api('POST','/v1/related-searches',{source:{doc_id:doc.doc_id,revision_id:doc.latest_revision_id,locator:{kind:'markdown',start:{line:1,column_utf16:0},end:{line:long.split('\n').length+1,column_utf16:0}}},collections:base.collections,mode:'hybrid',rerank:false})).status_url);assert.equal(done.state,'completed',JSON.stringify(done));assert.ok(done.query_plan.omitted_spans.length);const lease=app.sessions.readers.reserve();try{assert.ok((await lease.run('query_tokens',{query:done.query_plan.query})).result<=512);}finally{lease.release();}
   }finally{await writeFile(file,original);await app.catalog.reconcile(col.collection_id);}
  });
  await t.test('build and search share one lane; a queued search retains its prepublication generation',async()=>{
   assert.equal(app.builder.options.lane,app.sessions.settings.lane);const before=app.status().generation.generation_id;
   const build=app.builder.start(),accepted=await api('POST','/v1/searches',base);await build.completion;
   const done=await wait(accepted.status_url);assert.equal(done.state,'completed',JSON.stringify(done));assert.equal(done.generation_id,before);assert.notEqual(app.status().generation.generation_id,before);assert.ok(app.status().execution.resident_workers<=1);assert.ok(done.telemetry.queue_ms>0);
   const fresh=await search(base);assert.equal(fresh.generation_id,app.status().generation.generation_id);
  });
  await t.test('idle workers really exit and the same sealed generation can reload',async()=>{
   await app.sessions.readers.unloadExcept();const pool=new ReaderPool(app.catalog,{engineRoot:join(root,'.local/qmd-upstream'),modelRoot:models,profile_fp:app.status().profile.profile_fp,idleMs:40});
   try{const lease=pool.reserve();const reader=await lease.ready;const pid=reader.worker.process.pid;await new SourceSearch(app.catalog).keyword(SearchRequest.parse(base),'idle-test',lease,new AbortController().signal,()=>{});lease.release();for(let i=0;i<200&&reader.worker.process.state!=='stopped';i++)await sleep(10);assert.equal(reader.worker.process.state,'stopped');assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});const reloaded=pool.reserve();await reloaded.ready;reloaded.release();}finally{await pool.close();}
  });
  await t.test('a running rerank confirms cancellation and preserves daemon responsiveness',async()=>{
   const accepted=await api('POST','/v1/searches',{...base,query:'private-query-sentinel-p4-cancel',rerank:true});let cancel;
   const unsubscribe=app.sessions.subscribe(accepted.search_id,status=>{if(status.state==='running'&&status.phase==='reranking'&&!cancel)cancel=api('DELETE',accepted.status_url);});
   try{const done=await wait(accepted.status_url);assert.ok(cancel,'native rerank progress reached');await cancel;assert.equal(done.state,'cancelled');assert.equal((await api('GET','/v1/status')).execution.heavy_busy,false);}finally{unsubscribe();}
  });
  await t.test('missing/corrupt models do not prevent lexical use; allowed fallback is explicit and staged',async()=>{
   await app.sessions.readers.unloadExcept();const reranker=registry.find(m=>m.role==='rerank'),embedder=registry.find(m=>m.role==='embed');await rm(join(models,reranker.filename));
   const denied=await search({...base,rerank:true});assert.equal(denied.state,'failed');assert.equal(denied.error.code,'RERANK_UNAVAILABLE');
   const fallback=await search({...base,rerank:true,allow_degraded:true});assert.equal(fallback.rank_stage,'qmd_rrf');assert.equal(fallback.degraded,true);assert.ok(fallback.warnings.includes('RERANK_MODEL_NOT_INSTALLED'));assert.equal(fallback.counts.reranked_passages,0);
   await app.sessions.readers.unloadExcept();await rm(join(models,embedder.filename));await writeFile(join(models,embedder.filename),'bad model bytes');
   const corrupted=await search(base);assert.equal(corrupted.state,'failed');assert.equal(corrupted.error.code,'MODEL_UNAVAILABLE');
   const lexical=await search({...base,query:'shared',rerank:true,allow_degraded:true});assert.equal(lexical.state,'completed',JSON.stringify(lexical));assert.equal(lexical.effective_mode,'lexical');assert.equal(lexical.rank_stage,'bm25');assert.equal(lexical.degraded,true);assert.ok(lexical.warnings.includes('MODEL_UNAVAILABLE'));assert.equal(lexical.counts.reranked_passages,0);
  });
  const generation=app.sessions.readers.active();for(const file of ['state.sqlite','state.sqlite-wal','generations/'+generation.generation_id+'/qmd.sqlite']){try{const bytes=await readFile(join(app.root,file));assert.equal(bytes.includes(Buffer.from('private-query-sentinel-p4-cancel')),false);}catch(e){if(e.code!=='ENOENT')throw e;}}
 }finally{await app.close();await rm(folder,{recursive:true,force:true});}
});
