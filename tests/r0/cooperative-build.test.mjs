import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createApplication} from '../fixtures/application.mjs';
import {QmdWorker} from '../../packages/engine-qmd/dist/index.js';
import {verifySeal} from '../../packages/generations/dist/index.js';
const root=resolve(import.meta.dirname,'../..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(read){for(let i=0;i<6000;i++){const value=read();if(value)return value;await sleep(10);}throw new Error('Timed out waiting for verified native boundary');}
const terminal=state=>['completed','failed','cancelled'].includes(state);
test('bounded indexing releases real native contexts for search and resumes only verified checkpoints',async t=>{
 await mkdir(join(root,'.local/alpha'),{recursive:true});const folder=await mkdtemp(join(root,'.local/alpha/cooperative-')),source=join(folder,'source');await mkdir(source);
 for(let i=0;i<9;i++)await writeFile(join(source,i+'.md'),'# Project '+i+'\n\nRecord the owner before the milestone review '+i+'.');
 const app=await createApplication({dataRoot:join(folder,'data')}),catalog=app.catalog,state=catalog.state,open=QmdWorker.prototype.open,opened=[];let releaseGate;
 const done=async accepted=>until(()=>{const value=app.sessions.get(accepted.search_id);return terminal(value.state)&&value;});
 try{
  const collection=await catalog.addCollection({name:'Projects',root:source});await app.builder.start().completion;
  const request={query:'identify who owns the project before its review',purpose:'find',mode:'hybrid',rerank:false,collections:[collection.collection_id]};
  QmdWorker.prototype.open=async function(options){opened.push({pid:this.process.pid,role:options.role});return open.call(this,options);};
  await t.test('hybrid and literal searches finish before publication; builder and reader models never overlap',async()=>{
   const before=app.sessions.readers.active(),builder=app.builder;let accepted,result,once=false,yielded=false;
   builder.options.fault=async phase=>{
    if(phase==='checkpoint-batch'&&!once){once=true;accepted=app.sessions.createKeyword(request);await sleep(0);assert.equal(builder.options.lane.interactiveQueued,1);}
    if(phase==='yield-released'){
     yielded=true;const writer=opened.filter(o=>o.role==='builder').at(-1);assert.throws(()=>process.kill(writer.pid,0),{code:'ESRCH'});
     result=await done(accepted);assert.equal(result.state,'completed',JSON.stringify(result));assert.equal(result.generation_id,before.generation_id);assert.ok(result.telemetry.embedding_calls>0);assert.equal(app.status().generation.generation_id,before.generation_id);
    }
    if(phase==='yield-resumed'){assert.equal(app.sessions.readers.residentWorkers,0);for(const reader of opened.filter(o=>o.role==='reader'))assert.throws(()=>process.kill(reader.pid,0),{code:'ESRCH'});}
   };
   const build=builder.start({full:true});await build.completion;assert.equal(yielded,true);assert.equal(builder.getJob(build.job_id).progress.yields,1);assert.notEqual(app.status().generation.generation_id,before.generation_id);await verifySeal(before.directory_path,before.manifest_sha256);
   const token=(await readFile(join(app.root,'credentials/device-token'),'utf8')).trim(),lane=builder.options.lane,release=await lane.acquire(new AbortController().signal,'background');
   try{
    const blocked=app.sessions.createKeyword(request);await sleep(0);assert.equal(lane.interactiveQueued,1);
    const literal=app.sessions.createLiteral({query:'milestone',collections:[collection.collection_id]});const found=await done(literal);assert.equal(found.state,'completed',JSON.stringify(found));assert.ok(found.matches.length>0);assert.equal(terminal(app.sessions.get(blocked.search_id).state),false);
    const start=performance.now(),response=await fetch(app.url+'/v1/status',{headers:{authorization:'Bearer '+token}});assert.equal(response.status,200);assert.ok(performance.now()-start<300);app.sessions.cancel(blocked.search_id);
   }finally{release();builder.options.fault=undefined;}
  });
  await t.test('cancellation while waiting for search does not release its native lane or publish a generation',async()=>{
   const builder=app.builder,before=app.status().generation.generation_id,lane=builder.options.lane,gate=new Promise(r=>releaseGate=r);let blocker,once=false,yielded=false,entered=false;
   builder.options.fault=async phase=>{
    if(phase==='checkpoint-batch'&&!once){once=true;blocker=lane.run(new AbortController().signal,async()=>{entered=true;await gate;});await sleep(0);}
    if(phase==='yield-released')yielded=true;
   };
   const build=builder.start({full:true});
   try{await until(()=>yielded&&entered&&lane.queued===1);builder.cancel(build.job_id);await assert.rejects(build.completion,{code:'CANCELLED'});assert.equal(lane.busy,true);assert.equal(lane.queued,0);assert.equal(app.status().generation.generation_id,before);}
   finally{releaseGate();await blocker;builder.options.fault=undefined;builder.cancel(build.job_id);await build.completion.catch(()=>{});}
  });
  await t.test('a corrupted persisted snapshot cannot be used after search yields back',async()=>{
   const builder=app.builder,before=app.status().generation.generation_id;let once=false,accepted;
   builder.options.fault=async phase=>{
    if(phase==='checkpoint-batch'&&!once){once=true;accepted=app.sessions.createKeyword({...request,mode:'lexical',query:'milestone'});await sleep(0);}
    if(phase==='yield-released'){const job=state.db.prepare("SELECT * FROM jobs WHERE state='running' AND kind='full-build' ORDER BY updated_at DESC").get(),cursor=JSON.parse(job.cursor_json),directory=join(state.root,'generations',job.generation_id),checkpoint=JSON.parse(await readFile(join(directory,cursor.checkpoint),'utf8'));await writeFile(join(directory,checkpoint.database),'damaged-checkpoint');await done(accepted);}
   };
   const build=builder.start({full:true});try{await assert.rejects(build.completion,{code:'COMPATIBILITY_FAILED'});assert.equal(app.status().generation.generation_id,before);}finally{builder.options.fault=undefined;}
  });
  await t.test('unreported source changes during search stop resumption instead of publishing stale projections',async()=>{
   const builder=app.builder,before=app.status().generation.generation_id;let once=false,accepted;
   builder.options.fault=async phase=>{
    if(phase==='checkpoint-batch'&&!once){once=true;accepted=app.sessions.createKeyword({...request,mode:'lexical',query:'milestone'});await sleep(0);}
    if(phase==='yield-released'){await done(accepted);await writeFile(join(source,'0.md'),'# Changed project\n\nA newer source revision.');}
   };
   const build=builder.start({full:true});try{await assert.rejects(build.completion,{code:'STALE_REVISION'});assert.equal(app.status().generation.generation_id,before);}finally{builder.options.fault=undefined;}
  });
 }finally{releaseGate?.();QmdWorker.prototype.open=open;await app.close();await rm(folder,{recursive:true,force:true});}
});
