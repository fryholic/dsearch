import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {StateStore,Catalog} from '../../packages/catalog/dist/index.js';
import {ModelManager} from '../../apps/daemon/dist/models.js';
import {ManagedJobs} from '../../apps/daemon/dist/jobs.js';
async function fixture(t){const folder=await realpath(await mkdtemp(join(tmpdir(),'dsearch-p5-')));t.after(()=>rm(folder,{recursive:true,force:true}));return folder;}
const bytes=Buffer.from('verified-model-fixture'),model={role:'embed',repository:'test/model',revision:'a'.repeat(40),filename:'fixture.gguf',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
test('model preparation verifies fixed downloads, preserves files on failure and cleans cancelled partials',async t=>{
 const folder=await fixture(t),root=join(folder,'models');let requests=0;const models=new ModelManager(root,[model],async(url)=>{requests++;assert.equal(url,'https://huggingface.co/test/model/resolve/'+model.revision+'/fixture.gguf');return new Response(bytes);});
 assert.equal((await models.list())[0].state,'missing');await models.prepare(['embed'],new AbortController().signal,()=>{});assert.deepEqual(await readFile(join(root,model.filename)),bytes);assert.equal((await models.list())[0].state,'verified');await models.prepare(['embed'],new AbortController().signal,()=>{});assert.equal(requests,1);
 await writeFile(join(root,model.filename),'bad-model');const broken=new ModelManager(root,[model],async()=>new Response(Buffer.alloc(bytes.length)));
 await assert.rejects(broken.prepare(['embed'],new AbortController().signal,()=>{}),{code:'MODEL_UNAVAILABLE'});assert.equal(await readFile(join(root,model.filename),'utf8'),'bad-model');assert.ok((await readdir(root)).every(p=>!p.endsWith('.part')));
 const controller=new AbortController(),cancelled=new ModelManager(root,[model],async()=>new Response(new ReadableStream({start(c){c.enqueue(bytes.subarray(0,5));c.enqueue(bytes.subarray(5));c.close();}})));
 await assert.rejects(cancelled.prepare(['embed'],controller.signal,(phase,p)=>{if(phase==='downloading-model'&&p.bytes>0)controller.abort();}),{code:'CANCELLED'});assert.equal(await readFile(join(root,model.filename),'utf8'),'bad-model');assert.ok((await readdir(root)).every(p=>!p.endsWith('.part')));
});
test('collection preview leaves registration/source unchanged and excludes product data; unregister revives stable IDs',async t=>{
 const folder=await fixture(t),state=await StateStore.open(join(folder,'data')),catalog=new Catalog(state);try{
 await writeFile(join(folder,'one.md'),'# One\n\nOriginal source.');await writeFile(join(state.root,'private.md'),'# Product data must be excluded');const original=await readFile(join(folder,'one.md'));
 const before=state.sourceSeq,preview=await catalog.preview({name:'preview',root:folder});assert.equal(catalog.listCollections().length,0);assert.equal(state.sourceSeq,before);assert.equal(preview.counts.eligible,1);assert.equal(preview.partial,false);assert.deepEqual(await readFile(join(folder,'one.md')),original);
 const col=await catalog.addCollection({name:'first',root:folder});await catalog.reconcile(col.collection_id);const doc=catalog.documents(col.collection_id).find(d=>d.relative_path==='one.md');
 catalog.unregister(col.collection_id);assert.equal(catalog.listCollections().length,0);await assert.rejects(catalog.readDocument(doc.doc_id,doc.latest_revision_id),{code:'SCOPE_DENIED'});assert.throws(()=>catalog.setEnabled(col.collection_id,true),{code:'SCOPE_DENIED'});
 const revived=await catalog.addCollection({name:'restored',root:folder});assert.equal(revived.collection_id,col.collection_id);await catalog.reconcile(revived.collection_id);assert.equal(catalog.documents(revived.collection_id).find(d=>d.relative_path==='one.md').doc_id,doc.doc_id);assert.deepEqual(await readFile(join(folder,'one.md')),original);
 }finally{state.close();}
});
test('state v3 migration preserves identities and collection updates are atomic',async t=>{
 const folder=await fixture(t),source=join(folder,'source');await mkdir(source);await writeFile(join(source,'a.md'),'# A');let state=await StateStore.open(join(folder,'data'));const catalog=new Catalog(state),col=await catalog.addCollection({name:'original',root:source});await catalog.reconcile(col.collection_id);const doc=catalog.documents(col.collection_id)[0];
 assert.throws(()=>catalog.patch(col.collection_id,{name:'should-not-save',preset:'invalid'}),{code:'INVALID_REQUEST'});assert.equal(catalog.collection(col.collection_id).name,'original');
 state.db.exec('DROP TABLE collection_registrations; PRAGMA user_version=3;');state.close();state=await StateStore.open(join(folder,'data'));try{assert.equal(state.db.prepare('PRAGMA user_version').get().user_version,5);const migrated=new Catalog(state);assert.equal(migrated.documents(col.collection_id)[0].doc_id,doc.doc_id);assert.equal(migrated.documents(col.collection_id)[0].latest_revision_id,doc.latest_revision_id);}finally{state.close();}
});
test('managed cancellation remains pending until real cleanup and interrupted jobs become obsolete',async t=>{
 const folder=await fixture(t),state=await StateStore.open(join(folder,'data')),jobs=new ManagedJobs(state);let release;
 try{const accepted=jobs.start('model-check',async(signal,progress)=>{progress('verifying-model');await new Promise(r=>{release=r;});if(signal.aborted)throw Object.assign(new Error(),{code:'CANCELLED'});});await new Promise(r=>setImmediate(r));jobs.cancel(accepted.job_id);assert.equal(jobs.info(accepted.job_id).state,'cancel_requested');release();await jobs.close();assert.equal(jobs.info(accepted.job_id).state,'cancelled');
 state.db.prepare("UPDATE jobs SET state='running',cancel_requested=0 WHERE job_id=?").run(accepted.job_id);const reopened=new ManagedJobs(state);assert.equal(reopened.info(accepted.job_id).state,'obsolete');await reopened.close();
 }finally{state.close();}
});
