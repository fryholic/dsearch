import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat,access,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync,backup as sqliteBackup} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {StateStore,Catalog} from '../../packages/catalog/dist/index.js';
import {BackupStore,readBackup,GenerationGC,pinGeneration,copyBackupFiles} from '../../packages/generations/dist/index.js';
async function fixture(t){const temporary=await mkdtemp(join(tmpdir(),'dsearch-backup-')),state=await StateStore.open(temporary),root=state.root,catalog=new Catalog(state);t.after(async()=>{state.close();await rm(root,{recursive:true,force:true});});state.db.prepare("INSERT INTO profiles VALUES ('profile',?,'{}','validated',?)").run('a'.repeat(64),new Date().toISOString());const id=randomUUID(),generation=join(root,'generations',id);await mkdir(generation,{recursive:true,mode:0o700});await writeFile(join(generation,'fixture.md'),'original index bytes');state.db.prepare("INSERT INTO generations VALUES (?,?,?,'invalid',?,0,NULL,'{}',?,NULL)").run(id,'profile','a'.repeat(64),generation,new Date().toISOString());return {root,state,catalog,id};}
test('a failed file batch drains every started durable copy and does not start a later batch',async t=>{
 const {root}=await fixture(t),from=join(root,'from'),to=join(root,'to');await mkdir(from,{mode:0o700});await mkdir(to,{mode:0o700});
 const names=Array.from({length:32},(_,i)=>i+'.md');for(const name of names)await writeFile(join(from,name),'content '+name);
 const entries=[{path:names[0],bytes:Buffer.byteLength('content '+names[0]),sha256:'0'.repeat(64)},...names.slice(1)];
 await assert.rejects(copyBackupFiles(from,entries,to),{code:'COMPATIBILITY_FAILED'});assert.equal((await readdir(to)).length,15);
 for(const name of names.slice(1,16)){assert.equal(await readFile(join(to,name),'utf8'),'content '+name);assert.equal((await stat(join(to,name))).mode&0o777,0o600);}
 for(const name of names.slice(16))await assert.rejects(access(join(to,name)),{code:'ENOENT'});
 await rm(to,{recursive:true});await new Promise(resolve=>setTimeout(resolve,30));await assert.rejects(access(to),{code:'ENOENT'});
});
for(const cancel of [false,true])test('a '+(cancel?'cancelled':'failed')+' backup batch leaves no late staging writes and preserves existing archives',async t=>{
 const {root,catalog,id}=await fixture(t),store=new BackupStore(catalog),first=await store.create(),generation=join(root,'generations',id),controller=new AbortController();
 for(let i=0;i<40;i++)await writeFile(join(generation,i+'.md'),'unchanged index fixture '+i);
 let batches=0;const faulty=new BackupStore(catalog,{fault:phase=>{if(phase==='backup-copy-batch'){batches++;if(cancel)controller.abort();else throw new Error('copy boundary failure');}}});
 if(cancel)await assert.rejects(faulty.create(controller.signal),{code:'CANCELLED'});else await assert.rejects(faulty.create(),/copy boundary failure/);
 assert.equal(batches,1);assert.equal((await store.list()).length,1);await readBackup(first.path);assert.equal((await readdir(join(root,'backups'))).filter(name=>name.endsWith('.tmp')).length,0);
 for(let i=0;i<40;i++)assert.equal(await readFile(join(generation,i+'.md'),'utf8'),'unchanged index fixture '+i);
 assert.ok((await new GenerationGC(catalog).preview({keep_retired:0,min_age_seconds:0})).candidates.some(g=>g.generation_id===id));
});
test('consistent backups include committed WAL, generation bytes and preferences while excluding credentials',async t=>{
 const {root,state,catalog,id}=await fixture(t);await mkdir(join(root,'credentials'));await writeFile(join(root,'credentials','device-token'),'never-copy-this-token');await writeFile(join(root,'preferences.json'),'{}\n');state.advance();
 const store=new BackupStore(catalog),info=await store.create(),{manifest}=await readBackup(info.path);assert.equal(manifest.source_seq,1);assert.equal(manifest.generations[0].generation_id,id);assert.ok(manifest.files.some(f=>f.path==='preferences.json'));assert.ok(manifest.files.every(f=>!f.path.includes('credentials')));await assert.rejects(access(join(info.path,'credentials')));assert.equal((await stat(join(info.path,'state.sqlite'))).mode&0o777,0o600);
 const db=new DatabaseSync(join(info.path,'state.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT source_seq FROM catalog_meta').get().source_seq,1);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{db.close();}
 const gc=new GenerationGC(catalog,{backupReferences:()=>store.generationReferences()}),view=await gc.preview({keep_retired:0,min_age_seconds:0});assert.equal(manifest.generation_storage,'self-contained-v1');assert.ok(view.candidates.some(c=>c.generation_id===id));assert.equal((await readFile(join(root,'generations',id,'fixture.md'),'utf8')),'original index bytes');
});
test('checksum verification catches damaged copies and maintenance cannot overlap a live builder',async t=>{
 const {state,catalog,id}=await fixture(t),store=new BackupStore(catalog),release=pinGeneration(state,id,'builder');await assert.rejects(store.create(),{code:'BUSY'});release();const info=await store.create();await writeFile(join(info.path,'state.sqlite'),'damaged');await assert.rejects(readBackup(info.path),{code:'COMPATIBILITY_FAILED'});assert.ok((await store.generationReferences()).includes(id));
});
test('an unpublished failed backup cannot replace a successful one and retention preserves migration files',async t=>{
 const {root,catalog}=await fixture(t),store=new BackupStore(catalog,{keep:2}),first=await store.create();await writeFile(join(root,'backups','state-before-test.sqlite'),'preserved migration fixture');const faulty=new BackupStore(catalog,{fault:phase=>{if(phase==='backup-before-publish')throw new Error('injected');}});await assert.rejects(faulty.create(),/injected/);assert.equal((await store.list()).length,1);await readBackup(first.path);await store.create();await store.create();assert.equal((await store.list()).length,2);await access(join(root,'backups','state-before-test.sqlite'));
});
test('a completed backup survives loss of its acknowledgement',async t=>{
 const {catalog}=await fixture(t),store=new BackupStore(catalog,{fault:phase=>{if(phase==='backup-after-publish')throw new Error('lost acknowledgement');}});await assert.rejects(store.create(),/lost acknowledgement/);const list=await store.list();assert.equal(list.length,1);await readBackup(list[0].path);
});

test('backups are self-contained for recorded scope-migration snapshots',async t=>{
 const {root,state,catalog}=await fixture(t),source=await mkdtemp(join(tmpdir(),'dsearch-migration-source-'));t.after(()=>rm(source,{recursive:true,force:true}));await writeFile(join(source,'guide.md'),'# Guide\n\nDocument the project owner.');const collection=await catalog.addCollection({name:'Projects',root:source}),row=state.db.prepare('SELECT scope_json,scope_fp FROM collections WHERE collection_id=?').get(collection.collection_id),relative='backups/state-before-policy-v2-'+randomUUID()+'.sqlite';await mkdir(join(root,'backups'),{recursive:true,mode:0o700});await sqliteBackup(state.db,join(root,relative));state.db.prepare("INSERT INTO scope_migrations VALUES (?,?,?,?, 'matched',0,1,1)").run(collection.collection_id,row.scope_json,row.scope_fp,relative);
 const info=await new BackupStore(catalog).create(),{manifest}=await readBackup(info.path);assert.ok(manifest.files.some(f=>f.path===relative));const copied=new DatabaseSync(join(info.path,relative),{readOnly:true});try{assert.equal(copied.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(copied.prepare('SELECT name FROM collections WHERE collection_id=?').get(collection.collection_id).name,'Projects');}finally{copied.close();}
});

test('a self-consistent backup cannot inject credentials or runtime ownership files',async t=>{
 const {catalog}=await fixture(t),info=await new BackupStore(catalog).create(),{manifest}=await readBackup(info.path),sha=text=>createHash('sha256').update(text).digest('hex');
 for(const path of ['credentials/device-token','runtime.json','daemon.lock.sqlite','generations/'+randomUUID()+'/engine-config.json']){
  const changed={...manifest,files:[...manifest.files,{path,bytes:0,sha256:sha('')}]},json=JSON.stringify(changed);await writeFile(join(info.path,'manifest.json'),json);await writeFile(join(info.path,'manifest.sha256'),sha(json)+'\n');await assert.rejects(readBackup(info.path,false),{code:'COMPATIBILITY_FAILED'});
 }
});

test('legacy or unverified archives retain raw references; verified self-contained archives do not',async t=>{
 const {catalog,id}=await fixture(t),store=new BackupStore(catalog),info=await store.create();assert.deepEqual(await store.generationReferences(),[]);const {manifest}=await readBackup(info.path);delete manifest.generation_storage;const json=JSON.stringify(manifest);await writeFile(join(info.path,'manifest.json'),json);await writeFile(join(info.path,'manifest.sha256'),createHash('sha256').update(json).digest('hex')+'\n');assert.ok((await store.generationReferences()).includes(id));
});
