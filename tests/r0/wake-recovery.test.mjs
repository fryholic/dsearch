import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createApplication} from '../../apps/daemon/dist/index.js';
import {PreferenceStore} from '../../apps/daemon/dist/management.js';
import {verifySeal,generationPins} from '../../packages/generations/dist/index.js';
const root=resolve(import.meta.dirname,'../..'),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const terminal=state=>['completed','failed','cancelled'].includes(state);
async function until(read){for(let i=0;i<2000;i++){const value=read();if(value)return value;await sleep(10);}throw new Error('Wake recovery timed out');}
async function fixture(){
 await mkdir(join(root,'.local/alpha'),{recursive:true});const folder=await mkdtemp(join(root,'.local/alpha/wake-')),source=join(folder,'source'),dataRoot=join(folder,'data');
 await mkdir(source);await mkdir(dataRoot,{mode:0o700});const texts=['# Project owner\n\nRecord the owner before the milestone review.','# Review\n\nThe team reviews project milestones together.'];
 for(let i=0;i<texts.length;i++)await writeFile(join(source,i+'.md'),texts[i]);
 const preferences=new PreferenceStore(dataRoot);await preferences.load();await preferences.set({auto_sync:false});let now=Date.now();
 const app=await createApplication({dataRoot,synchronization:{now:()=>now,stableMs:50,maxDelayMs:150,pollMs:250,retryMs:10}}),collection=await app.catalog.addCollection({name:'Projects',root:source});
 await app.builder.start().completion;
 const token=(await readFile(join(dataRoot,'credentials/device-token'),'utf8')).trim();
 const api=async(method,path,value)=>{const response=await fetch(app.url+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(value===undefined?{}:{body:JSON.stringify(value)})});return {status:response.status,packet:await response.json()};};
 const request={query:'identify the project owner before its review',purpose:'find',mode:'hybrid',rerank:false,collections:[collection.collection_id]};
 const done=accepted=>until(()=>{const result=app.sessions.get(accepted.search_id);return terminal(result.state)&&result;});
 return {app,folder,source,texts,api,request,done,jump:()=>{now+=5000;},close:async()=>{await app.close();await rm(folder,{recursive:true,force:true});}};
}
for(const automatic of [false,true])test('a clock gap replaces a genuinely stopped reader while auto_sync='+automatic+' and preserves source evidence',{timeout:60000},async()=>{
 const f=await fixture(),{app}=f;let worker;
 try{
  if(automatic){const changed=await f.api('PUT','/v1/settings',{auto_sync:true});assert.equal(changed.packet.ok,true);await until(()=>app.status().synchronization.state==='idle');}
  const warm=await f.done(app.sessions.createKeyword(f.request));assert.equal(warm.state,'completed',JSON.stringify(warm));assert.ok(warm.results.length);
  const before=app.sessions.readers.active(),lease=app.sessions.readers.reserve(),reader=await lease.ready;worker=reader.worker;lease.release();
  process.kill(worker.process.pid,'SIGSTOP');
  const running=app.sessions.createKeyword({...f.request,rerank:true});await until(()=>worker.process.state==='running');
  const queued=app.sessions.createKeyword(f.request),cancelled=app.sessions.createKeyword(f.request);app.sessions.cancel(cancelled.search_id);
  f.jump();const started=performance.now(),status=await f.api('GET','/v1/status');assert.equal(status.packet.ok,true);assert.equal(status.packet.data.synchronization.enabled,automatic);assert.equal(status.packet.data.busy,true);assert.ok(performance.now()-started<1000);
  assert.equal(terminal(app.sessions.get(running.search_id).state),false,'do not claim terminal before native exit');
  const rejected=await f.api('POST','/v1/searches',f.request);assert.equal(rejected.status,503);assert.equal(rejected.packet.error.retryable,true);
  const jobs=app.status().jobs.length;assert.throws(()=>app.builder.start(),{code:'SERVICE_UNAVAILABLE'});assert.throws(()=>app.profiles.prepare(app.profiles.profile.profile_id),{code:'SERVICE_UNAVAILABLE'});assert.equal(app.status().jobs.length,jobs);
  const recovering=await f.api('GET','/v1/status');assert.ok(recovering.packet.data.execution.resident_workers>=1,'count invalidating workers until their actual exit');
  const doc=warm.results[0],evidence=doc.evidence[0],read=await f.api('POST','/v1/documents/read',{doc_id:doc.doc_id,revision_id:doc.revision_id,locator:evidence.locator});assert.equal(read.packet.ok,true);assert.ok(read.packet.data.text.includes(evidence.excerpt));
  await until(()=>!app.synchronization.recovering);assert.ok(performance.now()-started<10000);
  for(const accepted of [running,queued]){const value=await f.done(accepted);assert.equal(value.state,'failed');assert.equal(value.error.code,'SERVICE_UNAVAILABLE');assert.equal(value.error.retryable,true);}
  assert.equal(app.sessions.get(cancelled.search_id).state,'cancelled');assert.equal(worker.process.state,'stopped');assert.throws(()=>process.kill(worker.process.pid,0),{code:'ESRCH'});
  const recovered=await f.done(app.sessions.createKeyword(f.request));assert.equal(recovered.state,'completed',JSON.stringify(recovered));assert.equal(recovered.generation_id,before.generation_id);assert.equal(recovered.epoch,before.epoch);
  assert.deepEqual(recovered.results.map(d=>[d.doc_id,d.revision_id]),warm.results.map(d=>[d.doc_id,d.revision_id]));
  assert.equal((await f.api('GET','/v1/settings')).packet.data.auto_sync,automatic);await verifySeal(before.directory_path,before.manifest_sha256);
  for(let i=0;i<f.texts.length;i++)assert.equal(await readFile(join(f.source,i+'.md'),'utf8'),f.texts[i]);
 }finally{if(worker&&worker.process.state!=='stopped')process.kill(worker.process.pid,'SIGKILL');await f.close();}
});
test('wake interrupts manual checkpoint builds without turning infrastructure failures into user cancellation',{timeout:60000},async t=>{
 const f=await fixture(),{app}=f;
 try{
  for(const cancelled of [false,true])await t.test(cancelled?'explicit cancellation wins over wake':'wake leaves a resumable failed checkpoint',async()=>{
   const builder=app.builder,before=app.sessions.readers.active();let entered=false,release;const gate=new Promise(resolve=>release=resolve);
   builder.options.fault=async phase=>{if(phase==='checkpoint-initial'){entered=true;await gate;}};
   const build=builder.start({full:true});
   try{
    await until(()=>entered);if(cancelled)builder.cancel(build.job_id);app.synchronization.notify('wake',true);release();
    await assert.rejects(build.completion,{code:cancelled?'CANCELLED':'WORKER_EXITED'});await until(()=>!app.synchronization.recovering);
    const job=builder.getJob(build.job_id);assert.equal(job.state,cancelled?'cancelled':'failed');assert.equal(job.retryable,true);
    assert.equal(app.status().generation.generation_id,before.generation_id);await verifySeal(before.directory_path,before.manifest_sha256);
    builder.options.fault=undefined;await app.profiles.resume(build.job_id).completion;
   }finally{release();builder.options.fault=undefined;await build.completion.catch(()=>{});}
  });
 }finally{await f.close();}
});
test('invalidating an opening reader prevents a late worker and holds its generation pin until lease release',async()=>{
 const f=await fixture(),{app}=f;
 try{
  const pool=app.sessions.readers,lease=pool.reserve(),opening=lease.ready,invalidating=pool.invalidate();
  await assert.rejects(opening,{code:'SERVICE_UNAVAILABLE'});await invalidating;assert.equal(pool.residentWorkers,0);assert.ok(generationPins(app.catalog.state,lease.snapshot.generation_id).length>0);
  await assert.rejects(lease.ready,{code:'SERVICE_UNAVAILABLE'});lease.release();await until(()=>generationPins(app.catalog.state,lease.snapshot.generation_id).length===0);
  const found=await f.done(app.sessions.createKeyword(f.request));assert.equal(found.state,'completed',JSON.stringify(found));
 }finally{await f.close();}
});
test('wake terminates a stopped idle context without waiting for an unanswerable close RPC',{timeout:30000},async()=>{
 const f=await fixture(),{app}=f;let worker;
 try{
  await f.done(app.sessions.createKeyword(f.request));const before=app.sessions.readers.active(),lease=app.sessions.readers.reserve();worker=(await lease.ready).worker;lease.release();assert.equal(worker.process.state,'idle');
  process.kill(worker.process.pid,'SIGSTOP');const start=performance.now();app.synchronization.notify('wake',true);await until(()=>!app.synchronization.recovering);
  assert.ok(performance.now()-start<5000,'wake must bypass the five-second close RPC timeout');assert.equal(worker.process.state,'stopped');assert.throws(()=>process.kill(worker.process.pid,0),{code:'ESRCH'});
  const found=await f.done(app.sessions.createKeyword(f.request));assert.equal(found.state,'completed');assert.equal(found.generation_id,before.generation_id);
 }finally{if(worker&&worker.process.state!=='stopped')process.kill(worker.process.pid,'SIGKILL');await f.close();}
});
