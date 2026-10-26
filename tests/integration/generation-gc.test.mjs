import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {StateStore,Catalog} from '../../packages/catalog/dist/index.js';
import {GenerationGC,reconcileGC,pinGeneration,generationPins,beginMaintenance,maintenanceActive,canResumeBuild} from '../../packages/generations/dist/index.js';
async function fixture(t){const temporary=await mkdtemp(join(tmpdir(),'dsearch-gc-')),state=await StateStore.open(temporary),root=state.root,catalog=new Catalog(state);t.after(async()=>{state.close();await rm(root,{recursive:true,force:true});});state.db.prepare("INSERT INTO profiles VALUES ('profile',?,'{}','validated',?)").run('a'.repeat(64),new Date().toISOString());
 const add=async(status)=>{await mkdir(join(root,'generations'),{recursive:true,mode:0o700});const id=randomUUID(),folder=join(root,'generations',id);await mkdir(folder,{recursive:true});await writeFile(join(folder,'fixture.md'),'original index fixture');state.db.prepare('INSERT INTO generations VALUES (?,?,?,?,?,?,NULL,?,?,NULL)').run(id,'profile','a'.repeat(64),status,folder,0,'{}',new Date(Date.now()-172800000).toISOString());return id;};return {root,state,catalog,add};}
const policy={keep_retired:0,min_age_seconds:0};
test('GC previews protect active, prepared, live pins, recovery and backup references',async t=>{
 const {state,catalog,add}=await fixture(t),active=await add('active'),ready=await add('ready'),reader=await add('retired'),base=await add('retired'),backup=await add('retired'),resume=await add('invalid'),garbage=await add('invalid');state.db.prepare('INSERT INTO active_slot VALUES (1,?,1,?)').run(active,new Date().toISOString());
 state.db.prepare("INSERT INTO jobs VALUES (?,?,?,?,'obsolete','interrupted',?,'{}',0,0,NULL,NULL,'WORKER_EXITED',?)").run(randomUUID(),randomUUID(),'full-build',resume,JSON.stringify({checkpoint:'.checkpoints/'+randomUUID()+'.json',sha256:'b'.repeat(64)}),new Date().toISOString());
 const releaseReader=pinGeneration(state,reader,'reader'),releaseBase=pinGeneration(state,base,'builder-base'),gc=new GenerationGC(catalog,{backupReferences:async()=>[backup]}),view=await gc.preview(policy);assert.deepEqual(view.candidates.map(c=>c.generation_id),[garbage]);assert.ok(view.protected.find(r=>r.generation_id===reader).reasons.includes('lease:reader'));assert.ok(view.protected.find(r=>r.generation_id===base).reasons.includes('lease:builder-base'));
 await assert.rejects(gc.apply(view.plan_id,policy),{code:'BUSY'});releaseBase();const preview=await gc.preview(policy),result=await gc.apply(preview.plan_id,policy);assert.ok(result.removed.includes(garbage));assert.ok(!result.removed.includes(reader));releaseReader();releaseReader();assert.deepEqual(generationPins(state,reader),[]);
});
test('GC rejects stale previews and rolls back a moved directory before a failed state commit',async t=>{
 const {root,state,catalog,add}=await fixture(t),id=await add('invalid'),gc=new GenerationGC(catalog),preview=await gc.preview(policy),release=pinGeneration(state,id,'reader');await assert.rejects(gc.apply(preview.plan_id,policy),{code:'STALE_EPOCH'});release();
 const faulty=new GenerationGC(catalog,{fault:phase=>{if(phase==='gc-after-rename')throw new Error('interrupted');}}),next=await faulty.preview(policy);await assert.rejects(faulty.apply(next.plan_id,policy),/interrupted/);await access(join(root,'generations',id));assert.ok(state.db.prepare('SELECT generation_id FROM generations WHERE generation_id=?').get(id));await reconcileGC(catalog);const final=await gc.preview(policy);await gc.apply(final.plan_id,policy);assert.equal(state.db.prepare('SELECT generation_id FROM generations WHERE generation_id=?').get(id),undefined);await assert.rejects(access(join(root,'generations',id)));
});
test('a committed deletion remains recoverable if directory cleanup is interrupted',async t=>{
 const {root,state,catalog,add}=await fixture(t),id=await add('invalid'),gc=new GenerationGC(catalog,{fault:phase=>{if(phase==='gc-after-state-commit')throw new Error('interrupted cleanup');}}),preview=await gc.preview(policy);await assert.rejects(gc.apply(preview.plan_id,policy),/interrupted cleanup/);assert.equal(state.db.prepare('SELECT generation_id FROM generations WHERE generation_id=?').get(id),undefined);await assert.rejects(access(join(root,'generations',id)));assert.equal(maintenanceActive(state),false);await reconcileGC(catalog);
});
test('maintenance excludes new builders and releases on an error',async t=>{
 const {state,catalog,add}=await fixture(t),id=await add('retired'),done=beginMaintenance(state);assert.equal(maintenanceActive(state),true);assert.throws(()=>pinGeneration(state,id,'builder'),{code:'BUSY'});const reader=pinGeneration(state,id,'reader');reader();done();assert.equal(maintenanceActive(state),false);assert.ok((await new GenerationGC(catalog).preview(policy)).candidates.some(c=>c.generation_id===id));
});

import {fork} from 'node:child_process';
import {once} from 'node:events';
test('a killed GC process is reconciled from its durable journal at both commit boundaries',async t=>{
 for(const phase of ['gc-after-rename','gc-after-state-commit'])await t.test(phase,async t=>{
  const {root,state,catalog,add}=await fixture(t),id=await add('invalid'),child=fork(new URL('../fixtures/gc-crash.mjs',import.meta.url),[root,phase],{stdio:['ignore','ignore','ignore','ipc'],execArgv:[]}),exited=once(child,'exit'),[message]=await once(child,'message'),[code,signal]=await exited;assert.equal(message.phase,phase);assert.equal(code,null);assert.equal(signal,'SIGKILL');await reconcileGC(catalog);
  if(phase==='gc-after-rename'){assert.ok(state.db.prepare('SELECT generation_id FROM generations WHERE generation_id=?').get(id));await access(join(root,'generations',id));}else{assert.equal(state.db.prepare('SELECT generation_id FROM generations WHERE generation_id=?').get(id),undefined);await assert.rejects(access(join(root,'generations',id)));}
 });
});

test('stale checkpoints become collectible and cleaned automatic jobs retain their origin without a retry action',async t=>{
 const {state,catalog,add}=await fixture(t),id=await add('invalid'),job=randomUUID(),cursor={origin:'automatic',checkpoint:'.checkpoints/'+randomUUID()+'.json',sha256:'b'.repeat(64)};state.db.prepare("INSERT INTO jobs VALUES (?,?, 'full-build',?,'cancelled','stopped',?,'{}',1,0,NULL,NULL,'CANCELLED',?)").run(job,job,id,JSON.stringify(cursor),new Date().toISOString());const gc=new GenerationGC(catalog);assert.equal(canResumeBuild(state,job),true);assert.ok((await gc.preview(policy)).protected.find(g=>g.generation_id===id).reasons.includes('resume_checkpoint'));state.advance();assert.equal(canResumeBuild(state,job),false);const preview=await gc.preview(policy);assert.ok(preview.candidates.some(g=>g.generation_id===id));await gc.apply(preview.plan_id,policy);const row=state.db.prepare('SELECT generation_id,cursor_json FROM jobs WHERE job_id=?').get(job);assert.equal(row.generation_id,null);assert.deepEqual(JSON.parse(row.cursor_json),{origin:'automatic'});assert.equal(canResumeBuild(state,job),false);
});
