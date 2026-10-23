import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {fileDigest} from '../packages/runtime/dist/index.js';
import {QmdWorker} from '../packages/engine-qmd/dist/index.js';
import {scoreRanking,percentile} from '../packages/evaluation/dist/index.js';
import {createFixture,hitName} from './lib/r0-fixture.mjs';
import {r0Fingerprint} from './lib/r0-fingerprint.mjs';
const root=resolve(import.meta.dirname,'..');await mkdir(join(root,'.local/r0'),{recursive:true});await mkdir(join(root,'artifacts/r0'),{recursive:true});
const folder=await mkdtemp(join(root,'.local/r0/matrix-'));const fixture=await createFixture(folder);
const base={purpose:'find',collections:['probe'],limit:40,candidate_limit:40,allow_degraded:false};
const report={schema_version:1,engine_artifact:JSON.parse(await readFile(join(root,'.local/qmd-upstream/dsearch-artifact.json'),'utf8')),reference_artifact:JSON.parse(await readFile(join(root,'.local/qmd-reference/dsearch-artifact.json'),'utf8')),worker_sha256:await fileDigest(join(root,'packages/engine-qmd/dist/worker.js')),scope:'Synthetic development comparison; not representative quality/performance acceptance',corpus_sha256:fixture.manifest.corpus_sha256,documents:fixture.corpus.documents.length,tuning_queries:20,holdout_executed:false,source_map_checks:fixture.sourceMapChecks,runs:[],environment:{node:process.version,platform:process.platform,arch:process.arch,model_file_cache:'not flushed; model cold start is a new isolated process',swap_before:execFileSync('sysctl',['-n','vm.swapusage'],{encoding:'utf8'}).trim()}};
report.input_fingerprint=await r0Fingerprint();
function aggregate(rows){return {queries:rows.length,top1_direct:rows.filter(x=>x.metrics.top1Direct).length/rows.length,ndcg10:rows.reduce((s,x)=>s+x.metrics.ndcg10,0)/rows.length,mrr10:rows.reduce((s,x)=>s+x.metrics.mrr10,0)/rows.length,recall40:rows.reduce((s,x)=>s+x.metrics.recall40,0)/rows.length,p50_ms:percentile(rows.map(x=>x.duration_ms),0.5),p95_ms:percentile(rows.map(x=>x.duration_ms),0.95),max_rss_bytes:Math.max(...rows.map(x=>x.rss_bytes))};}
function mappedRanking(hits,map){const result=[];for(const hit of hits){const source=map[hitName(hit.file)];if(!source)throw new Error('Unmapped engine hit: '+hit.file);if(!result.includes(source.docId))result.push(source.docId);}return result;}
for(const sourceMode of ['raw','projection'])for(const model of ['reference','embed']){
 const strict=sourceMode==='projection',engineRoot=join(root,strict?'.local/qmd-upstream':'.local/qmd-reference');
 const worker=new QmdWorker();const run={source:sourceMode,embedding:model,strict,preflight:[],results:[],summaries:{}};const start=performance.now();
 try{
  await worker.open({engineRoot,dbPath:join(folder,sourceMode+'-'+model+'.sqlite'),collectionPath:join(folder,sourceMode),modelRoot:join(root,'.local/models'),embedRole:model,strict});
  const probe=await worker.invoke('embedding',{text:'백업 보관 기간과 복구',title:'초기 계측',isQuery:true});run.model_cold_embedding_ms=probe.duration_ms;run.startup_including_integrity_ms=performance.now()-start;run.dimension=probe.result.dimension;
  await worker.invoke('update');
  if(strict)for(const [name,projection] of Object.entries(fixture.mapping.projection)){
   const inspect=(await worker.invoke('inspect',{text:projection.text,title:projection.title,file:name})).result;if(!inspect.safe)throw new Error('Projection rejected by actual engine: '+name);run.preflight.push({file:name,...inspect});
  }
  run.indexing=await worker.invoke('embed');
  if(run.indexing.result.errors!==0)throw new Error('Embedding failures in comparison');
  for(const configuration of [{name:'lexical',mode:'lexical',rerank:false},{name:'hybrid',mode:'hybrid',rerank:false},{name:'reranked',mode:'hybrid',rerank:true}]){
   const rows=[];
   for(const query of fixture.corpus.queries){
    if(strict)await worker.invoke('clear_cache');
    const response=await worker.search({...base,query:query.query,mode:configuration.mode,rerank:configuration.rerank});
    const ranking=mappedRanking(response.result.hits,fixture.mapping[sourceMode]);
    const labels=Object.fromEntries(fixture.corpus.documents.map(doc=>[doc.id,query.relevance[doc.id]??0]));
    const metrics=scoreRanking(ranking,labels);if(metrics.provisional)throw new Error('Unjudged synthetic result');
    if(strict&&(response.stats.truncatedInputs!==0||response.stats.fallbackUsed))throw new Error('Silent truncation or fallback');
    rows.push({query_id:query.id,ranking,metrics,duration_ms:response.duration_ms,rss_bytes:response.rss_bytes,actual_candidates:strict?response.stats.actualCandidates:response.result.hits.length,returned_hits:response.result.hits.length,stats:response.stats});
   }
   run.results.push({mode:configuration.name,rows});run.summaries[configuration.name]=aggregate(rows);
  }
  run.device=(await worker.invoke('device')).result;
  const require=createRequire(join(engineRoot,'package.json')),Database=require('better-sqlite3');const db=new Database(join(folder,sourceMode+'-'+model+'.sqlite'),{readonly:true});
  try{run.persistent_cache_rows=db.prepare('SELECT count(*) FROM llm_cache').pluck().get();}finally{db.close();}
  if(strict&&run.persistent_cache_rows!==0)throw new Error('Product cache persisted');
  report.runs.push(run);await writeFile(join(root,'artifacts/r0/benchmark.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({source:sourceMode,model,dimension:run.dimension,cold_ms:run.model_cold_embedding_ms,summaries:run.summaries,persistent_cache_rows:run.persistent_cache_rows}));
 }finally{await worker.close();}
}
report.environment.swap_after=execFileSync('sysctl',['-n','vm.swapusage'],{encoding:'utf8'}).trim();
await writeFile(join(root,'artifacts/r0/benchmark.json'),JSON.stringify(report,null,2)+'\n');
console.log('Engine comparison complete; four source/model combinations, 240 requests.');
