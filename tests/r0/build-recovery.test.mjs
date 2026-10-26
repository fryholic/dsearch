import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {StateStore,Catalog} from '../../packages/catalog/dist/index.js';
import {GenerationBuilder,createAlphaProfile,verifySeal,reconcileInterruptedBuilds} from '../../packages/generations/dist/index.js';
const root=resolve(import.meta.dirname,'../..'),engineRoot=join(root,'.local/qmd-recovery'),modelRoot=join(root,'.local/models');
test('durable bounded-build checkpoints resume verified database snapshots and reject stale or corrupt input',async t=>{
 await mkdir(join(root,'.local/alpha'),{recursive:true});const folder=await mkdtemp(join(root,'.local/alpha/recovery-')),source=join(folder,'source');await mkdir(source);
 for(let i=0;i<11;i++)await writeFile(join(source,i+'.md'),'# Project guide '+i+'\n\nKeep the milestone owner and expected review date '+i+'.');
 const state=await StateStore.open(join(folder,'data')),catalog=new Catalog(state);await catalog.addCollection({name:'Projects',root:source});const profile=(await createAlphaProfile(engineRoot)).manifest,options={engineRoot,modelRoot,profile,embedRole:'embed'};
 try{
  const baseline=await new GenerationBuilder(catalog,options).start().completion,active=()=>String(state.db.prepare('SELECT generation_id FROM active_slot').get().generation_id);
  for(const phase of ['checkpoint-initial','checkpoint-batch','batch-before-checkpoint','after-index','before-publish'])await t.test('resumes interruption at '+phase,async()=>{
   const before=active(),builder=new GenerationBuilder(catalog,{...options,fault:p=>{if(p===phase)throw new Error('injected crash boundary');}}),handle=builder.start({full:true});await assert.rejects(handle.completion,{code:'INTERNAL_ERROR'});assert.equal(active(),before);
   const resumedBuilder=new GenerationBuilder(catalog,options),resumed=resumedBuilder.start({resume:handle.job_id}),result=await resumed.completion;assert.equal(result.generation_id,handle.generation_id);assert.equal(active(),result.generation_id);assert.equal(result.coverage.filter(d=>d.state==='included').length,11);await verifySeal(join(state.root,'generations',baseline.generation_id),baseline.manifest_sha256);
   const job=resumedBuilder.getJob(resumed.job_id);if(phase==='checkpoint-batch'||phase==='after-index'||phase==='before-publish')assert.ok(job.progress.embedding_calls<14);
   assert.equal(state.db.prepare('SELECT lease_owner FROM jobs WHERE job_id=?').get(resumed.job_id).lease_owner,null);
  });
  await t.test('changed raw source blocks resume and leaves the current active slot intact',async()=>{
   const builder=new GenerationBuilder(catalog,{...options,fault:p=>{if(p==='checkpoint-batch')throw new Error('stop');}}),handle=builder.start({full:true});await assert.rejects(handle.completion);const before=active();await writeFile(join(source,'0.md'),'# Changed\n\nA newer source revision.');const resumed=new GenerationBuilder(catalog,options).start({resume:handle.job_id});await assert.rejects(resumed.completion,{code:'STALE_EPOCH'});assert.equal(builder.getJob(resumed.job_id).retryable,false);assert.equal(active(),before);
  });
  await t.test('a damaged snapshot is rejected before the old active generation can be replaced',async()=>{
   const builder=new GenerationBuilder(catalog,{...options,fault:p=>{if(p==='checkpoint-batch')throw new Error('stop');}}),handle=builder.start({full:true});await assert.rejects(handle.completion);const before=active(),cursor=JSON.parse(state.db.prepare('SELECT cursor_json FROM jobs WHERE job_id=?').get(handle.job_id).cursor_json),dir=join(state.root,'generations',handle.generation_id),checkpoint=JSON.parse(await readFile(join(dir,cursor.checkpoint),'utf8'));await writeFile(join(dir,checkpoint.database),'damaged');const resumed=new GenerationBuilder(catalog,options).start({resume:handle.job_id});await assert.rejects(resumed.completion,{code:'COMPATIBILITY_FAILED'});assert.equal(active(),before);
  });
  await t.test('exclusive startup reconciles interrupted state without publishing a prepared generation',async()=>{
   const builder=new GenerationBuilder(catalog,{...options,fault:p=>{if(p==='checkpoint-batch')throw new Error('stop');}}),handle=builder.start({full:true});await assert.rejects(handle.completion);state.db.prepare("UPDATE jobs SET state='running',error_code=NULL WHERE job_id=?").run(handle.job_id);state.db.prepare("UPDATE generations SET state='building' WHERE generation_id=?").run(handle.generation_id);const before=active();reconcileInterruptedBuilds(state);assert.equal(builder.getJob(handle.job_id).state,'obsolete');assert.equal(builder.getJob(handle.job_id).error_code,'WORKER_EXITED');assert.equal(active(),before);const next=new GenerationBuilder(catalog,options).start({resume:handle.job_id});await next.completion;
  });
 }finally{state.close();await rm(folder,{recursive:true,force:true});}
});
