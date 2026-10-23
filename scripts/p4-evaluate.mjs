import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Catalog,StateStore,digest} from '../packages/catalog/dist/index.js';
import {GenerationBuilder,createAlphaProfile} from '../packages/generations/dist/index.js';
import {ReaderPool,SourceSearch,SearchSessions} from '../packages/search/dist/index.js';
import {HeavyLane} from '../packages/runtime/dist/index.js';
import {scoreRanking,percentile} from '../packages/evaluation/dist/index.js';
import {r0Fingerprint} from './lib/r0-fingerprint.mjs';
const root=resolve(import.meta.dirname,'..'),artifacts=join(root,'artifacts/p4'),exec=promisify(execFile);
await mkdir(artifacts,{recursive:true});await mkdir(join(root,'.local/alpha'),{recursive:true});
const folder=await mkdtemp(join(root,'.local/alpha/p4-evaluation-')),sourceRoot=join(folder,'source');await mkdir(sourceRoot);
const corpusBytes=await readFile(join(root,'fixtures/synthetic/r0/corpus.json')),corpus=JSON.parse(corpusBytes);assert.equal(corpus.queries.length,20);
for(const doc of corpus.documents)await writeFile(join(sourceRoot,doc.id+'.md'),doc.body);
const report={schema_version:1,status:'running',scope:'Production pipeline, synthetic development evaluation only; not representative quality/performance acceptance',started_at:new Date().toISOString(),source_fingerprint:await r0Fingerprint(),corpus_sha256:digest(corpusBytes),documents:corpus.documents.length,tuning_queries:20,holdout_executed:false,holdout_required_count:40,negative_probes:['Quantum gravity black hole evaporation temperature','중세 프랑스 왕조의 상속 분쟁','허브 버터 감자 요리 조리 시간'],runs:[],environment:{node:process.version,platform:process.platform,arch:process.arch,swap_before:execFileSync('sysctl',['-n','vm.swapusage'],{encoding:'utf8'}).trim(),measurement:'End-to-end session latency includes load, integrity verification, queue, native engine and source verification. OS model file cache is not flushed. 100ms process-tree RSS sampling; RSS does not account for all Metal allocations.'}};
const save=()=>writeFile(join(artifacts,'evaluation.json'),JSON.stringify(report,null,2)+'\n');await save();
const mean=values=>values.reduce((s,v)=>s+v,0)/values.length;
let sampledRSS=0,sampling=false;
const sampler=setInterval(async()=>{if(sampling)return;sampling=true;try{const {stdout}=await exec('ps',['-axo','pid=,ppid=,rss=']);const rows=stdout.trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));const pids=new Set([process.pid]);for(let i=0;i<4;i++)for(const [pid,ppid]of rows)if(pids.has(ppid))pids.add(pid);sampledRSS=Math.max(sampledRSS,rows.filter(([pid])=>pids.has(pid)).reduce((s,r)=>s+r[2]*1024,0));}finally{sampling=false;}},100);sampler.unref();
const wait=async(sessions,id)=>{for(;;){const s=sessions.get(id);if(['completed','failed','cancelled'].includes(s.state))return s;await new Promise(r=>setTimeout(r,5));}};
try{
 for(const embedRole of ['reference','embed']){
  const state=await StateStore.open(join(folder,embedRole)),catalog=new Catalog(state),col=await catalog.addCollection({name:'Synthetic tuning',root:sourceRoot}),profile=await createAlphaProfile(join(root,'.local/qmd-upstream'),embedRole),lane=new HeavyLane();
  const readers=new ReaderPool(catalog,{engineRoot:join(root,'.local/qmd-upstream'),modelRoot:join(root,'.local/models'),profile_fp:profile.fingerprint});
  const builder=new GenerationBuilder(catalog,{engineRoot:join(root,'.local/qmd-upstream'),modelRoot:join(root,'.local/models'),embedRole,profile:profile.manifest,lane,beforeWork:()=>readers.unloadExcept()}),sessions=new SearchSessions(new SourceSearch(catalog),readers,{lane});
  try{
   const buildStart=performance.now(),build=await builder.start().completion;
   const run={embedding:embedRole,profile_fp:profile.fingerprint,profile:profile.manifest,generation_id:build.generation_id,build_ms:performance.now()-buildStart,coverage:build.coverage.reduce((a,d)=>(a[d.state]=(a[d.state]??0)+1,a),{}),configurations:[]};report.runs.push(run);
   for(const [name,mode,rerank] of [['lexical','lexical',false],['hybrid','hybrid',false],['reranked','hybrid',true]]){
    const rows=[];sampledRSS=0;
    for(const [index,q]of corpus.queries.entries()){
     const start=performance.now(),request={query:q.query,purpose:'find',collections:[col.collection_id],mode,rerank,candidate_limit:40,limit:40,allow_degraded:false};
     const response=await wait(sessions,sessions.createKeyword(request).search_id);assert.equal(response.state,'completed',JSON.stringify(response));assert.equal(response.degraded,false);assert.equal(response.telemetry.truncated_inputs,0);
     const ranking=response.results.map(d=>basename(d.relative_path,'.md')),labels=Object.fromEntries(corpus.documents.map(d=>[d.id,q.relevance[d.id]??0])),metrics=scoreRanking(ranking,labels);assert.equal(metrics.provisional,false);
     const durationMs = performance.now() - start;
     // Every displayed span is independently checked through the same source-read contract.
     for(const d of response.results)for(const e of d.evidence){const read=await catalog.read({doc_id:d.doc_id,revision_id:d.revision_id,locator:e.locator});assert.ok(read.text.includes(e.excerpt));}
     rows.push({query_id:q.id,ranking,supplemental_ranking:response.supplemental_results.map(d=>basename(d.relative_path,'.md')),metrics,duration_ms:durationMs,retrieval_fp:response.retrieval_fp,telemetry:response.telemetry});
     if((index+1)%5===0)console.log(`${embedRole} ${name}: ${index+1}/20`);
    }
    const negative=[];for(const query of report.negative_probes){const s=await wait(sessions,sessions.createKeyword({query,purpose:'find',collections:[col.collection_id],mode,rerank,candidate_limit:40,limit:10}).search_id);assert.equal(s.state,'completed');negative.push({query,returned_documents:s.results.length});}
    const summary={recall40:mean(rows.map(r=>r.metrics.recall40)),ndcg10:mean(rows.map(r=>r.metrics.ndcg10)),mrr10:mean(rows.map(r=>r.metrics.mrr10)),top1_direct:mean(rows.map(r=>Number(r.metrics.top1Direct))),p50_ms:percentile(rows.map(r=>r.duration_ms),.5),p95_ms:percentile(rows.map(r=>r.duration_ms),.95),first_request_ms:rows[0].duration_ms,max_worker_rss_bytes:Math.max(...rows.map(r=>r.telemetry.worker_rss_bytes)),sampled_process_tree_peak_rss_bytes:sampledRSS,negative_probe_nonempty:negative.filter(n=>n.returned_documents>0).length};
    run.configurations.push({name,rows,negative_probes:negative,summary});await save();console.log(JSON.stringify({embedding:embedRole,configuration:name,...summary}));
   }
   const lease=readers.reserve();try{run.index_audit=(await lease.run('index_audit',{})).result;run.device=(await lease.run('device',{})).result;assert.equal(run.index_audit.cache.rows,0);}finally{lease.release();}
  }finally{await builder.close();await sessions.close();state.close();}
 }
 assert.equal(await r0Fingerprint(),report.source_fingerprint,'Sources changed while evaluating');report.status='passed';report.completed_at=new Date().toISOString();report.environment.swap_after=execFileSync('sysctl',['-n','vm.swapusage'],{encoding:'utf8'}).trim();await save();
}catch(error){report.status='failed';report.failure=error.message;await save();throw error;}finally{clearInterval(sampler);}
