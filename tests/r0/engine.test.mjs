import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,stat,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {QmdWorker} from '../../packages/engine-qmd/dist/index.js';
import {EngineProcess,verifyModel} from '../../packages/runtime/dist/index.js';
import {createDiagnosticServer} from '../../apps/daemon/dist/index.js';
import {r0Fingerprint} from '../../scripts/lib/r0-fingerprint.mjs';
const root=resolve(import.meta.dirname,'../..'),engineRoot=join(root,'.local/qmd-upstream'),modelRoot=join(root,'.local/models');
const evidence={schema_version:1,input_fingerprint:await r0Fingerprint(),scope:'R0 native compatibility gates, not R1 acceptance',checks:[]};
const record=(name,value)=>evidence.checks.push({name,...value});
const options=(dir,extra={})=>({engineRoot,dbPath:join(dir,'index.sqlite'),collectionPath:join(dir,'docs'),modelRoot,embedRole:'embed',strict:true,...extra});
const search={query:'canonical encoding bytes',purpose:'find',mode:'hybrid',rerank:true,collections:['probe'],limit:5,candidate_limit:40,allow_degraded:false};
async function fixture(){const dir=await mkdtemp(join(root,'.local/r0/native-'));await mkdir(join(dir,'docs'));await writeFile(join(dir,'docs/encoding.md'),'# Canonical encoding\n\n같은 값을 같은 바이트열로 인코딩한 후 해시와 서명을 계산한다. Canonical encoding fixes identical bytes before signing.\n');await writeFile(join(dir,'docs/kdf.md'),'# KDF\n\nECDH 공유 비밀과 문맥에서 애플리케이션 키를 도출한다. Key derivation uses shared secret material.\n');return dir;}
await mkdir(join(root,'.local/r0'),{recursive:true});await mkdir(join(root,'artifacts/r0'),{recursive:true});

test('pinned native Qwen engine passes compatibility boundaries',async t=>{
 const dir=await fixture(),worker=new QmdWorker();
 try{
  const opened=await worker.open(options(dir));assert.ok(['EP-01','EP-02','EP-03','EP-04'].every(k=>opened.capabilities[k]===true));
  await worker.invoke('update');
  await t.test('real GGUF model emits 1024-dimensional embeddings on Metal',async()=>{
   const value=await worker.invoke('embedding',{text:'같은 바이트열을 서명 입력으로 만드는 이유',title:'시험',isQuery:true});
   assert.equal(value.result.dimension,1024);assert.ok(Number.isFinite(value.result.norm)&&value.result.norm>0);assert.equal(value.stats.embeddingCalls,1);
   const device=(await worker.invoke('device')).result;assert.equal(device.gpu,'metal');assert.equal(device.gpuOffloading,true);
   record('native-model',{embedding:value.result,device,rss_bytes:value.rss_bytes,first_embedding_ms:value.duration_ms});
  });
  await t.test('both actual chunkers accept a short projection as one chunk',async()=>{
   const value=(await worker.invoke('inspect',{text:'# 입력\n\n서명 전에 같은 바이트열을 만든다.\n',title:'입력',file:'input.md'})).result;
   assert.equal(value.safe,true);assert.equal(value.embeddingChunks,1);assert.equal(value.searchChunks,1);assert.ok(value.embeddingTokens<=800);
   record('two-chunkers',{...value});
  });
  await t.test('projection preflight counts the actual engine-extracted title instead of trusting the caller',async()=>{
   const text='# '+'가 '.repeat(400)+'\n\n본문';
   const value=(await worker.invoke('inspect',{text,title:'short',file:'title-boundary.md'})).result;
   assert.ok(value.actualTitle.length>400);assert.ok(value.embeddingTokens>800);assert.equal(value.safe,false);
   await assert.rejects(worker.invoke('embedding',{text,title:value.actualTitle,isQuery:false}),{code:'INPUT_TOO_LONG'});
   record('actual-title-preflight',{safe:value.safe,embeddingTokens:value.embeddingTokens,actual_title_utf16:value.actualTitle.length});
  });
  await t.test('tokenizer-based document and query limits reject before native embedding without truncation',async()=>{
   for(const kind of ['document','query']){
    let low=1,high=1800;
    const tokens=async n=>kind==='query'?(await worker.invoke('query_tokens',{query:'가 '.repeat(n)})).result:(await worker.invoke('inspect',{text:'가 '.repeat(n),title:'',file:'boundary.md'})).result.embeddingTokens;
    const cap=kind==='query'?512:800;
    while(low+1<high){const mid=Math.floor((low+high)/2);if(await tokens(mid)<=cap)low=mid;else high=mid;}
    const before=await tokens(low),after=await tokens(high);assert.ok(before<=cap&&after>cap);
    const title=kind==='query'?'':(await worker.invoke('inspect',{text:'가 '.repeat(low),title:'',file:'boundary.md'})).result.actualTitle;
    const accepted=await worker.invoke('embedding',{text:'가 '.repeat(low),title,isQuery:kind==='query'});assert.equal(accepted.stats.embeddingCalls,1);
    let rejected;try{await worker.invoke('embedding',{text:'가 '.repeat(high),title,isQuery:kind==='query'});}catch(error){rejected=error;}
    assert.equal(rejected?.code,'INPUT_TOO_LONG');assert.equal(rejected.telemetry.embeddingCalls,0);assert.equal(rejected.telemetry.truncatedInputs,0);
    record(kind+'-token-budget',{cap,accepted_tokens:before,rejected_tokens:after,native_calls_on_rejection:rejected.telemetry.embeddingCalls,truncated:0});
   }
  });
  await t.test('lexical adapter preserves document locations and enforces the configured scope',async()=>{
   const value=await worker.search({...search,query:'canonical',mode:'lexical',rerank:false});
   assert.ok(value.result.hits[0].file.endsWith('/encoding.md'));assert.equal(value.stats.actualCandidates,value.result.hits.length);
   await assert.rejects(worker.search({...search,mode:'lexical',rerank:false,collections:['unregistered']}),{code:'SCOPE_DENIED'});
   record('lexical-scope',{rank_stage:value.result.rank_stage,actual_candidates:value.stats.actualCandidates,unregistered_scope_rejected:true});
  });
  await t.test('deep without the optional expansion model fails explicitly without downloading',async()=>{
   await assert.rejects(worker.search({...search,query:'unmatched-expansion-sentinel-zeta',mode:'deep'}),{code:'MODEL_NOT_INSTALLED'});
   record('optional-expansion',{missing_model_rejected:true,native_expansion_model_tested:false});
  });
  await t.test('actual ranking template budget is enforced before native scoring',async()=>{
   const query='canonical encoding';let low=1,high=6000;
   const tokens=async n=>(await worker.invoke('inspect_rerank',{query,text:'word '.repeat(n)})).result.tokens;
   while(low+1<high){const mid=Math.floor((low+high)/2);if(await tokens(mid)<=4096)low=mid;else high=mid;}
   const before=await tokens(low),after=await tokens(high);assert.ok(before<=4096&&after>4096);
   const accepted=await worker.invoke('rerank',{query,documents:[{file:'fits',text:'word '.repeat(low)}]});assert.equal(accepted.stats.rerankingCalls,1);
   let rejected;try{await worker.invoke('rerank',{query,documents:[{file:'overflow',text:'word '.repeat(high)}]});}catch(error){rejected=error;}
   assert.equal(rejected?.code,'INPUT_TOO_LONG');assert.equal(rejected.telemetry.rerankingCalls,0);assert.equal(rejected.telemetry.truncatedInputs,0);
   record('ranking-template-budget',{cap:4096,accepted_tokens:before,rejected_tokens:after,native_calls_on_rejection:0,truncated:0});
  });
  await t.test('native reranking and expansion cache path never read or write SQLite cache',async()=>{
   const value=await worker.invoke('cache_audit');assert.equal(value.result.databaseCacheTouches,0);assert.equal(value.result.cacheRowsBefore,0);assert.equal(value.result.cacheRowsAfter,0);assert.equal(value.result.sqlGuardConfirmed,true);assert.equal(value.result.expansionStubCalls,1);assert.ok(value.stats.rerankingCalls>0);
   record('memory-cache',{...value.result,stats:value.stats});
  });
  await t.test('search executes real reranking and consistent snapshot includes live WAL data',async()=>{
   await worker.invoke('embed');const value=await worker.search(search);assert.equal(value.result.rank_stage,'qmd_reranked_blend');assert.equal(value.stats.rerankSucceeded,true);assert.equal(value.stats.fallbackUsed,false);assert.equal(value.stats.truncatedInputs,0);assert.ok(value.result.hits[0].file.endsWith('/encoding.md'));
   assert.ok((await stat(join(dir,'index.sqlite-wal'))).size>0);const target=join(dir,'snapshot.sqlite');await worker.invoke('snapshot',{target});
   const require=createRequire(join(engineRoot,'package.json')),Database=require('better-sqlite3');
   const snapshot=new Database(target,{readonly:true});try{assert.equal(snapshot.prepare('PRAGMA integrity_check').pluck().get(),'ok');assert.equal(snapshot.prepare('SELECT count(*) FROM documents').pluck().get(),2);assert.equal(snapshot.prepare('SELECT count(*) FROM llm_cache').pluck().get(),0);}finally{snapshot.close();}
   record('search-and-snapshot',{rank_stage:value.result.rank_stage,top_document:value.result.hits[0].file,stats:value.stats,snapshot_integrity:'ok',snapshot_documents:2});
  });
  await t.test('embedding cancellation yields between bounded batches and resumes remaining documents',async()=>{
   for(let i=0;i<20;i++)await writeFile(join(dir,'docs','batch-'+i+'.md'),'# Batch '+i+'\n\n공유 비밀과 키 도출을 설명하는 합성 구간 '+i+'이다.\n');
   await worker.invoke('update');const controller=new AbortController();let sawBoundary=false;
   let rejected;try{await worker.invoke('embed',{}, {signal:controller.signal,onProgress:event=>{if(event.phase==='embedding-batch'&&event.completed>=4){sawBoundary=true;controller.abort();}}});}catch(error){rejected=error;}
   assert.equal(sawBoundary,true);assert.equal(rejected?.code,'CANCELLED');assert.equal(worker.process.state,'idle');
   const resumed=await worker.invoke('embed');assert.equal(resumed.result.errors,0);assert.ok(resumed.result.docsProcessed>0&&resumed.result.docsProcessed<20);
   record('embedding-batch-cancellation',{cooperative:true,resumed_documents:resumed.result.docsProcessed,remaining_errors:resumed.result.errors,telemetry:rejected.telemetry});
  });
  await t.test('status remains responsive during native work and cooperative cancellation stops remaining documents',async()=>{
   const controller=new AbortController();let ready;const started=new Promise(resolve=>ready=resolve);
   const service=await createDiagnosticServer(()=>({worker:worker.process.state}));
   const docs=Array.from({length:200},(_,i)=>({file:'candidate-'+i,text:'Canonical encoding signing input bytes, distinct candidate '+i}));
   const work=worker.invoke('rerank',{query:'same bytes before signing',documents:docs},{signal:controller.signal,onProgress:event=>{if(event.phase==='rerank-document')ready();}});
   let rejected;const observed=work.catch(error=>{rejected=error;});
   const latencies=[];let sawRunning=false;
   try{
    let startTimer;try{await Promise.race([started,new Promise((_,reject)=>startTimer=setTimeout(()=>reject(new Error('No native progress')),10000))]);}finally{clearTimeout(startTimer);}
    for(let i=0;i<10;i++){const start=performance.now();const response=await fetch(service.url+'/v1/status',{headers:{authorization:'Bearer '+service.token}});const status=await response.json();latencies.push(performance.now()-start);sawRunning ||= status.data.worker==='running';}
    controller.abort();assert.equal(worker.process.state,'cancel_requested');await observed;
    assert.equal(rejected?.code,'CANCELLED');assert.equal(worker.process.state,'idle');assert.ok(sawRunning);assert.ok(Math.max(...latencies)<300);
    await worker.invoke('query_tokens',{query:'worker remains usable'});
    record('native-cancellation',{status_latency_ms:latencies,status_max_ms:Math.max(...latencies),cooperative:true,worker_reusable:true,telemetry:rejected.telemetry});
   }finally{controller.abort();await observed;await service.close();}
  });
 }finally{await worker.close();assert.throws(()=>process.kill(worker.process.pid,0),{code:'ESRCH'});}
});

test('missing reranker is explicit and allowed degradation reruns real RRF search',async()=>{
 const dir=await fixture();const processWorker=new EngineProcess(new URL('../../packages/engine-qmd/dist/worker.js',import.meta.url),{env:{QMD_EMBED_PARALLELISM:'1'}});
 try{
  await processWorker.invoke({method:'open',...options(dir),embedModel:join(modelRoot,'Qwen3-Embedding-0.6B-Q8_0.gguf'),rerankModel:join(dir,'missing-reranker.gguf')});
  await processWorker.invoke({method:'update'});
  await assert.rejects(processWorker.invoke({method:'search',args:search}),{code:'RERANK_UNAVAILABLE'});
  const value=await processWorker.invoke({method:'search',args:{...search,allow_degraded:true}});
  assert.equal(value.result.rank_stage,'qmd_rrf');assert.equal(value.result.effective_mode,'hybrid');assert.equal(value.result.degraded,true);assert.equal(value.stats.fallbackUsed,true);assert.equal(value.stats.rerankSucceeded,false);assert.ok(value.result.hits.length>0);
  record('explicit-rerank-fallback',{rank_stage:value.result.rank_stage,effective_mode:value.result.effective_mode,stats:value.stats});
  await processWorker.invoke({method:'close'});
 }finally{await processWorker.close();}
});
test('unpatched SDK cannot enter strict mode and model integrity failures cannot activate',async()=>{
 const dir=await fixture();const worker=new EngineProcess(new URL('../../packages/engine-qmd/dist/worker.js',import.meta.url));
 try{await assert.rejects(worker.invoke({method:'open',...options(dir,{engineRoot:join(root,'.local/qmd-reference')}),embedModel:join(modelRoot,'Qwen3-Embedding-0.6B-Q8_0.gguf'),rerankModel:join(modelRoot,'qwen3-reranker-0.6b-q8_0.gguf')}),{code:'COMPATIBILITY_FAILED'});}finally{await worker.close();}
 const file=join(dir,'invalid.gguf');await writeFile(file,'GGUF-invalid');await assert.rejects(verifyModel(file,{bytes:12,sha256:'a'.repeat(64)}),{code:'MODEL_UNAVAILABLE'});
 await assert.rejects(verifyModel(join(dir,'missing.gguf'),{bytes:12,sha256:'a'.repeat(64)}),{code:'MODEL_NOT_INSTALLED'});
 record('activation-negative-controls',{unpatched_rejected:true,invalid_model_rejected:true,missing_model_rejected:true});
});
// The runner writes evidence after the test suite, without changing its pass/fail result.
import {after} from 'node:test';
after(async()=>{await writeFile(join(root,'artifacts/r0/native-tests.json'),JSON.stringify(evidence,null,2)+'\n');});
