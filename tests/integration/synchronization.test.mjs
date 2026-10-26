import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {StateStore,Catalog} from '../../packages/catalog/dist/index.js';
import {DsearchError} from '../../packages/contracts/dist/index.js';
import {Synchronization} from '../../apps/daemon/dist/synchronization.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(read){for(let i=0;i<500;i++){const value=read();if(value)return value;await sleep(10);}throw new Error('Synchronization did not reach the expected state');}
async function fixture(t,options={}){
 const folder=await mkdtemp(join(tmpdir(),'dsearch-sync-')),source=join(folder,'source');await mkdir(source);await writeFile(join(source,'guide.md'),'# Guide\n\nRecord the owner.');const state=await StateStore.open(join(folder,'data')),catalog=new Catalog(state),collection=await catalog.addCollection({name:'Projects',root:source}),fp='a'.repeat(64);state.db.prepare("INSERT INTO profiles VALUES ('fixture',?,'{}','validated',?)").run(fp,new Date().toISOString());
 const controls={enabled:true,busy:false,ready:true,model:'one',beforePublish:undefined,error:undefined},calls=[],watches=new Map(),aborts=new Map();let published=0;
 const host={catalog,enabled:()=>controls.enabled,busy:()=>controls.busy,profile:()=>fp,models:async()=>({ready:controls.ready,fingerprint:controls.model}),published:()=>published++,cancel:id=>aborts.get(id)?.abort(),build:()=>{
  const job_id=randomUUID(),generation_id=randomUUID(),seq=state.sourceSeq,at=new Date().toISOString(),controller=new AbortController();aborts.set(job_id,controller);calls.push({seq,job_id,at:Date.now()});
  state.db.prepare("INSERT INTO generations VALUES (?, 'fixture',?,'building',?,?,NULL,'{}',?,NULL)").run(generation_id,fp,join(state.root,'generations',generation_id),seq,at);state.db.prepare("INSERT INTO jobs VALUES (?,?,'full-build',?,'running','embedding','{}','{}',0,0,NULL,NULL,NULL,?)").run(job_id,job_id,generation_id,at);
  const completion=Promise.resolve().then(async()=>{if(controls.beforePublish)await Promise.race([controls.beforePublish(),new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new DsearchError('CANCELLED')),{once:true}))]);if(controller.signal.aborted)throw new DsearchError('CANCELLED');if(controls.error)throw new DsearchError(controls.error);
   state.transaction(()=>{state.db.prepare("UPDATE generations SET state='retired' WHERE state='active'").run();state.db.prepare("UPDATE generations SET state='active' WHERE generation_id=?").run(generation_id);const epoch=Number(state.db.prepare('SELECT epoch FROM active_slot').get()?.epoch??0)+1;state.db.prepare('INSERT INTO active_slot VALUES (1,?,?,?) ON CONFLICT(slot) DO UPDATE SET generation_id=excluded.generation_id,epoch=excluded.epoch,changed_at=excluded.changed_at').run(generation_id,epoch,at);state.db.prepare("UPDATE jobs SET state='succeeded' WHERE job_id=?").run(job_id);});return {generation_id,epoch:1,coverage:[],published:true,manifest_sha256:'b'.repeat(64)};
  });void completion.catch(()=>{});return {job_id,generation_id,completion};
 }};
 const sync=new Synchronization(host,{stableMs:60,maxDelayMs:180,pollMs:5000,retryMs:10,watch:(root,changed,failed)=>{const handle={changed,failed,closed:false,on(){return this;},close(){this.closed=true;}};watches.set(root,handle);return handle;},...options});
 t.after(async()=>{await sync.close();state.close();await rm(folder,{recursive:true,force:true});});sync.start();return {sync,controls,calls,state,source:collection.root_path,catalog,collection,watches,get published(){return published;}};
}
test('changes are coalesced after stable saves and models are never downloaded implicitly',async t=>{
 const f=await fixture(t);await until(()=>f.calls.length===1&&f.sync.info().state==='idle');const changed=f.watches.get(f.source).changed;
 await writeFile(join(f.source,'guide.md'),'# Guide\n\nRevision A.');changed();await sleep(20);await writeFile(join(f.source,'guide.md'),'# Guide\n\nRevision B.');changed();const last=Date.now();
 await until(()=>f.calls.length===2&&f.sync.info().state==='idle');assert.ok(f.calls[1].at-last>=55);await sleep(100);assert.equal(f.calls.length,2);
 f.controls.ready=false;await writeFile(join(f.source,'guide.md'),'# Guide\n\nRevision C.');changed();await until(()=>f.sync.info().state==='blocked');assert.equal(f.sync.info().error_code,'MODEL_NOT_INSTALLED');assert.equal(f.calls.length,2);f.controls.ready=true;f.sync.notify('models',true);await until(()=>f.calls.length===3&&f.sync.info().state==='idle');
});
test('periodic complete reconciliation discovers event loss and reconnects the same root identity',async t=>{
 const f=await fixture(t,{pollMs:80});await until(()=>f.calls.length===1&&f.sync.info().state==='idle');await writeFile(join(f.source,'missed.md'),'# Missed event\n\nA new project.');await until(()=>f.calls.length===2);assert.ok(f.catalog.documents(f.collection.collection_id).some(d=>d.relative_path==='missed.md'&&d.present));
 const moved=f.source+'-away';await rename(f.source,moved);f.watches.get(f.source).failed();await until(()=>f.sync.info().state==='blocked');await rename(moved,f.source);await until(()=>f.sync.info().state==='idle');assert.equal(f.sync.info().error_code,null);
});
test('edits during a busy build remain pending and converge after it finishes',async t=>{
 const f=await fixture(t);await until(()=>f.calls.length===1&&f.sync.info().state==='idle');let release;const gate=new Promise(r=>release=r);f.controls.beforePublish=()=>gate;
 await writeFile(join(f.source,'guide.md'),'# Guide\n\nFirst change.');f.watches.get(f.source).changed();await until(()=>f.sync.info().state==='indexing');await writeFile(join(f.source,'guide.md'),'# Guide\n\nSecond change.');for(let i=0;i<1000;i++)f.watches.get(f.source).changed();assert.equal(f.sync.info().pending,true);f.controls.beforePublish=undefined;release();await until(()=>f.calls.length===3&&f.sync.info().state==='idle');const current=f.state.db.prepare('SELECT g.source_seq FROM active_slot a JOIN generations g USING(generation_id)').get();assert.equal(current.source_seq,f.state.sourceSeq);
});
test('failed identical inputs do not create retry storms; explicit model changes allow a new attempt',async t=>{
 const f=await fixture(t,{pollMs:90});await until(()=>f.calls.length===1&&f.sync.info().state==='idle');f.controls.error='MODEL_UNAVAILABLE';await writeFile(join(f.source,'guide.md'),'# Guide\n\nChanged.');f.watches.get(f.source).changed();await until(()=>f.calls.length===2&&f.sync.info().state==='blocked');await sleep(300);assert.equal(f.calls.length,2);assert.equal(f.sync.info().error_code,'MODEL_UNAVAILABLE');f.controls.error=undefined;f.controls.model='two';f.sync.notify('models',true);await until(()=>f.calls.length===3&&f.sync.info().state==='idle');
});
test('disabling cancels only its automatic build and closes watches without blocking readers',async t=>{
 const f=await fixture(t);await until(()=>f.calls.length===1&&f.sync.info().state==='idle');f.controls.beforePublish=()=>new Promise(()=>{});await writeFile(join(f.source,'guide.md'),'# Guide\n\nChanged.');f.watches.get(f.source).changed();await until(()=>f.sync.info().state==='indexing');f.controls.enabled=false;f.sync.refresh();await until(()=>f.sync.info().state==='disabled'&&!f.sync.info().pending);assert.equal(f.watches.get(f.source).closed,true);assert.equal(f.calls.length,2);assert.ok(f.state.db.prepare('SELECT generation_id FROM active_slot').get());
});
test('an occupied mutation lane defers full reconciliation and one pending hint survives the delay',async t=>{
 const f=await fixture(t);await until(()=>f.calls.length===1&&f.sync.info().state==='idle');f.controls.busy=true;await writeFile(join(f.source,'guide.md'),'# Guide\n\nChanged.');f.watches.get(f.source).changed();await until(()=>f.sync.info().state==='queued');assert.equal(f.calls.length,1);f.controls.busy=false;await until(()=>f.calls.length===2&&f.sync.info().state==='idle');
});

test('continuous event hints are bounded by the maximum coalescing window',async t=>{
 const f=await fixture(t);await until(()=>f.calls.length===1&&f.sync.info().state==='idle');await writeFile(join(f.source,'guide.md'),'# Guide\n\nChanged.');const changed=f.watches.get(f.source).changed,start=Date.now();changed();const timer=setInterval(changed,15);
 try{await until(()=>f.calls.length===2);const elapsed=f.calls[1].at-start;assert.ok(elapsed>=170&&elapsed<600,'maximum coalescing window: '+elapsed);}finally{clearInterval(timer);}
});

test('a delayed or reversed clock tick requests wake reconciliation before native readers are reused',async t=>{
 let now=Date.now(),wakes=0;const f=await fixture(t,{pollMs:50,now:()=>now});f.sync.host.onWake=async()=>{wakes++;};await until(()=>f.calls.length===1&&f.sync.info().state==='idle');now+=5000;await until(()=>wakes===1&&f.sync.info().state==='idle');now-=10000;await until(()=>wakes===2&&f.sync.info().state==='idle');assert.equal(f.calls.length,1);
});
