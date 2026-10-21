import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {r0Fingerprint} from './lib/r0-fingerprint.mjs';
const root=resolve(import.meta.dirname,'..'),folder=join(root,'artifacts/r0');
await mkdir(folder,{recursive:true});
const start=new Date().toISOString(),fingerprint=await r0Fingerprint();
const report={schema_version:1,status:'running',checkpoint:'P0-P1 / R0',started_at:start,input_fingerprint:fingerprint,steps:[]};
const save=()=>writeFile(join(folder,'verification.json'),JSON.stringify(report,null,2)+'\n');
const json=async name=>JSON.parse(await readFile(join(folder,name),'utf8'));
await save();
try{
 for(const command of ['check','r0:inspect','test:r0','r0:benchmark']){
  console.log('R0 verification: '+command);
  const result=spawnSync('pnpm',[command],{cwd:root,stdio:'inherit'});
  report.steps.push({command,exit_code:result.status});await save();
  if(result.error||result.status!==0)throw new Error('Verification command failed: '+command);
 }
 assert.equal(await r0Fingerprint(),fingerprint,'Sources changed during verification');
 const metadata=await json('model-metadata.json'),native=await json('native-tests.json'),benchmark=await json('benchmark.json');
 for(const result of [metadata,native,benchmark])assert.equal(result.input_fingerprint,fingerprint,'Evidence belongs to another source state');
 const required=['native-model','two-chunkers','actual-title-preflight','document-token-budget','query-token-budget','lexical-scope','optional-expansion','ranking-template-budget','memory-cache','search-and-snapshot','embedding-batch-cancellation','native-cancellation','explicit-rerank-fallback','activation-negative-controls'];
 const checked=new Set(native.checks.map(c=>c.name));for(const name of required)assert.ok(checked.has(name),'Missing native gate: '+name);
 const get=name=>native.checks.find(c=>c.name===name);
 assert.equal(get('native-model').embedding.dimension,1024);assert.equal(get('native-model').device.gpu,'metal');
 assert.equal(get('memory-cache').databaseCacheTouches,0);assert.equal(get('memory-cache').cacheRowsAfter,0);
 assert.equal(get('search-and-snapshot').snapshot_integrity,'ok');assert.equal(get('native-cancellation').worker_reusable,true);
 for(const name of ['document-token-budget','query-token-budget','ranking-template-budget'])assert.equal(get(name).native_calls_on_rejection,0);
 assert.equal(benchmark.runs.length,4);assert.equal(benchmark.documents,54);assert.equal(benchmark.tuning_queries,20);assert.equal(benchmark.holdout_executed,false);assert.ok(benchmark.source_map_checks>=54);
 let requests=0;
 for(const run of benchmark.runs){
  assert.equal(run.dimension,run.embedding==='embed'?1024:768);assert.equal(run.results.length,3);assert.equal(run.indexing.result.errors,0);
  if(run.strict){assert.equal(run.persistent_cache_rows,0);assert.ok(run.preflight.every(p=>p.safe&&p.embeddingChunks===1&&p.searchChunks===1));}
  for(const mode of run.results){assert.equal(mode.rows.length,20);for(const row of mode.rows){requests++;assert.equal(row.metrics.provisional,false);assert.ok(row.returned_hits<=40);if(run.strict){assert.equal(row.stats.truncatedInputs,0);assert.equal(row.stats.fallbackUsed,false);assert.ok(row.actual_candidates<=40);}}}
 }
 assert.equal(requests,240);
 const upstream=JSON.parse(await readFile(join(root,'vendor/qmd-upstream.json'),'utf8'));
 assert.equal(benchmark.engine_artifact.artifact_sha256,upstream.engineArtifactSha256);assert.equal(benchmark.engine_artifact.patch_digest,upstream.patchSha256);
 report.status='passed';report.completed_at=new Date().toISOString();report.native_checks=checked.size;report.comparison_requests=requests;
 report.scope='Engineering compatibility on synthetic development fixtures. R1 fixed evaluation, installation, production catalog and product UI are subsequent checkpoints.';
 await save();console.log('First checkpoint passed: P0/P1 compatibility evidence is complete and matches the current source fingerprint.');
}catch(error){report.status='failed';report.completed_at=new Date().toISOString();report.failure=error.message;await save();throw error;}
