import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {StateStore,Catalog} from '../../packages/catalog/dist/index.js';
import {BackupStore,readBackup,GenerationGC,pinGeneration} from '../../packages/generations/dist/index.js';
async function fixture(t){const temporary=await mkdtemp(join(tmpdir(),'dsearch-backup-')),state=await StateStore.open(temporary),root=state.root,catalog=new Catalog(state);t.after(async()=>{state.close();await rm(root,{recursive:true,force:true});});state.db.prepare("INSERT INTO profiles VALUES ('profile',?,'{}','validated',?)").run('a'.repeat(64),new Date().toISOString());const id=randomUUID(),generation=join(root,'generations',id);await mkdir(generation,{recursive:true,mode:0o700});await writeFile(join(generation,'fixture.md'),'original index bytes');state.db.prepare("INSERT INTO generations VALUES (?,?,?,'invalid',?,0,NULL,'{}',?,NULL)").run(id,'profile','a'.repeat(64),generation,new Date().toISOString());return {root,state,catalog,id};}
test('consistent backups include committed WAL, generation bytes and preferences while excluding credentials',async t=>{
 const {root,state,catalog,id}=await fixture(t);await mkdir(join(root,'credentials'));await writeFile(join(root,'credentials','device-token'),'never-copy-this-token');await writeFile(join(root,'preferences.json'),'{}\n');state.advance();
 const store=new BackupStore(catalog),info=await store.create(),{manifest}=await readBackup(info.path);assert.equal(manifest.source_seq,1);assert.equal(manifest.generations[0].generation_id,id);assert.ok(manifest.files.some(f=>f.path==='preferences.json'));assert.ok(manifest.files.every(f=>!f.path.includes('credentials')));await assert.rejects(access(join(info.path,'credentials')));assert.equal((await stat(join(info.path,'state.sqlite'))).mode&0o777,0o600);
 const db=new DatabaseSync(join(info.path,'state.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT source_seq FROM catalog_meta').get().source_seq,1);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{db.close();}
 const gc=new GenerationGC(catalog,{backupReferences:()=>store.generationReferences()}),view=await gc.preview({keep_retired:0,min_age_seconds:0});assert.ok(view.protected[0].reasons.includes('backup'));assert.equal((await readFile(join(root,'generations',id,'fixture.md'),'utf8')),'original index bytes');
});
test('checksum verification catches damaged copies and maintenance cannot overlap a live builder',async t=>{
 const {state,catalog,id}=await fixture(t),store=new BackupStore(catalog),release=pinGeneration(state,id,'builder');await assert.rejects(store.create(),{code:'BUSY'});release();const info=await store.create();await writeFile(join(info.path,'state.sqlite'),'damaged');await assert.rejects(readBackup(info.path),{code:'COMPATIBILITY_FAILED'});
});
test('an unpublished failed backup cannot replace a successful one and retention preserves migration files',async t=>{
 const {root,catalog}=await fixture(t),store=new BackupStore(catalog,{keep:2}),first=await store.create();await writeFile(join(root,'backups','state-before-test.sqlite'),'preserved migration fixture');const faulty=new BackupStore(catalog,{fault:phase=>{if(phase==='backup-before-publish')throw new Error('injected');}});await assert.rejects(faulty.create(),/injected/);assert.equal((await store.list()).length,1);await readBackup(first.path);await store.create();await store.create();assert.equal((await store.list()).length,2);await access(join(root,'backups','state-before-test.sqlite'));
});
test('a completed backup survives loss of its acknowledgement',async t=>{
 const {catalog}=await fixture(t),store=new BackupStore(catalog,{fault:phase=>{if(phase==='backup-after-publish')throw new Error('lost acknowledgement');}});await assert.rejects(store.create(),/lost acknowledgement/);const list=await store.list();assert.equal(list.length,1);await readBackup(list[0].path);
});
