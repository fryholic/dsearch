import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {StateStore,Catalog} from '../../packages/catalog/dist/index.js';
import {GenerationBuilder,createAlphaProfile,BackupStore,readBackup,atomicFile,sealFiles,verifySeal} from '../../packages/generations/dist/index.js';
import {restoreBackup,createApplication} from '../../apps/daemon/dist/index.js';
import {fileDigest} from '../../packages/runtime/dist/index.js';
import {canonicalJSON} from '../../packages/catalog/dist/index.js';
const root=resolve(import.meta.dirname,'../..'),engineRoot=join(root,'.local/qmd-recovery'),modelRoot=join(root,'.local/models');
test('offline restore validates models, rebases SDK paths and preserves newer state and original documents',async t=>{
 await mkdir(join(root,'.local/alpha'),{recursive:true});const folder=await mkdtemp(join(root,'.local/alpha/restore-')),source=join(folder,'source'),original=join(folder,'original'),target=join(folder,'restored');await mkdir(source);
 for(let i=0;i<2;i++)await writeFile(join(source,i+'.md'),'# Project '+i+'\n\nRecord the owner before the milestone review '+i+'.');
 const state=await StateStore.open(original),catalog=new Catalog(state);await catalog.addCollection({name:'Projects',root:source});const profile=(await createAlphaProfile(engineRoot)).manifest,options={engineRoot,modelRoot,profile,embedRole:'embed'};await new GenerationBuilder(catalog,options).start().completion;await atomicFile(join(original,'preferences.json'),'{}\n');await mkdir(join(original,'credentials'));await writeFile(join(original,'credentials','device-token'),'sentinel-auth-material');const backup=await new BackupStore(catalog).create();state.close();const hashes=await Promise.all([0,1].map(i=>fileDigest(join(source,i+'.md'))));
 try{
  await t.test('preview is read-only and applied restore serves the same original source with fresh credentials',async()=>{
   const preview=await restoreBackup({backupPath:backup.path,targetRoot:target});assert.equal(preview.applied,false);assert.equal(preview.rebuild_required,false);await assert.rejects(access(target));
   const applied=await restoreBackup({backupPath:backup.path,targetRoot:target,apply:true,planId:preview.plan_id});assert.equal(applied.applied,true);const repeated=await restoreBackup({backupPath:backup.path,targetRoot:target,apply:true,planId:preview.plan_id});assert.equal(repeated.plan_id,applied.plan_id);assert.equal(repeated.applied,true);
   const app=await createApplication({dataRoot:target,engineRoot,modelRoot});try{
    const token=(await readFile(join(target,'credentials/device-token'),'utf8')).trim();assert.notEqual(token,'sentinel-auth-material');const api=async(method,path,value)=>{const r=await fetch(app.url+path,{method,headers:{authorization:'Bearer '+token,...(value===undefined?{}:{'content-type':'application/json'})},...(value===undefined?{}:{body:JSON.stringify(value)})});const p=await r.json();assert.equal(p.ok,true,JSON.stringify(p.error));return p.data;};
    const status=await api('GET','/v1/status');assert.equal(status.needs_rebuild,false);const cols=await api('GET','/v1/collections'),accepted=await api('POST','/v1/searches',{query:'milestone',purpose:'find',mode:'lexical',rerank:false,collections:[cols[0].collection_id]});let found;for(let i=0;i<100;i++){found=await api('GET',accepted.status_url);if(found.state==='completed')break;await new Promise(r=>setTimeout(r,20));}assert.equal(found.state,'completed');assert.equal(found.results.length,2);const d=found.results[0],e=d.evidence[0],read=await api('POST','/v1/documents/read',{doc_id:d.doc_id,revision_id:d.revision_id,locator:e.locator});assert.ok(read.text.includes('milestone'));
    await assert.rejects(restoreBackup({backupPath:backup.path,targetRoot:target}),{code:'BUSY'});
   }finally{await app.close();}
  });
  await t.test('replacing existing state preserves later decisions in a verified previous backup',async()=>{
   const current=await StateStore.open(target),docs=current.db.prepare('SELECT doc_id,latest_revision_id FROM source_documents ORDER BY doc_id').all();current.db.prepare("INSERT INTO decisions VALUES (?,?,?,?,?,'keep','{}',?)").run(randomUUID(),docs[0].doc_id,docs[1].doc_id,docs[0].latest_revision_id,docs[1].latest_revision_id,new Date().toISOString());current.close();
   const preview=await restoreBackup({backupPath:backup.path,targetRoot:target});assert.equal(preview.current_history.decisions,1);const applied=await restoreBackup({backupPath:backup.path,targetRoot:target,apply:true,planId:preview.plan_id});assert.ok(applied.previous_archive);assert.ok(applied.previous_backup);await readBackup(applied.previous_backup);const previousDb=new DatabaseSync(join(applied.previous_archive,'state.sqlite'),{readOnly:true});try{assert.equal(previousDb.prepare('SELECT count(*) AS n FROM decisions').get().n,1);}finally{previousDb.close();}
  });
  await t.test('in-place restore preserves its source backup and retries after the archive moved',async()=>{
   const destination=join(folder,'in-place'),first=await restoreBackup({backupPath:backup.path,targetRoot:destination});await restoreBackup({backupPath:backup.path,targetRoot:destination,apply:true,planId:first.plan_id});
   const current=await StateStore.open(destination),local=await new BackupStore(new Catalog(current)).create();current.close();
   const preview=await restoreBackup({backupPath:local.path,targetRoot:destination}),applied=await restoreBackup({backupPath:local.path,targetRoot:destination,apply:true,planId:preview.plan_id});
   assert.equal(applied.applied,true);assert.ok(applied.backup_path.startsWith(applied.previous_archive+'/backups/'));await readBackup(applied.backup_path);await assert.rejects(access(local.path));
   const repeated=await restoreBackup({backupPath:local.path,targetRoot:destination,apply:true,planId:preview.plan_id});assert.equal(repeated.plan_id,applied.plan_id);assert.equal(repeated.backup_path,applied.backup_path);
  });
  await t.test('empty or corrupt targets are replaced only after preview and retain a previous archive',async()=>{
   for(const damaged of [false,true]){
    const destination=join(folder,damaged?'corrupt':'empty');await mkdir(destination,{mode:0o700});if(damaged)await writeFile(join(destination,'state.sqlite'),'corrupt-state-sentinel');
    const preview=await restoreBackup({backupPath:backup.path,targetRoot:destination});assert.equal(preview.target_exists,true);assert.equal(preview.current_history,null);
    const applied=await restoreBackup({backupPath:backup.path,targetRoot:destination,apply:true,planId:preview.plan_id});assert.ok(applied.previous_archive);if(damaged)assert.equal(await readFile(join(applied.previous_archive,'state.sqlite'),'utf8'),'corrupt-state-sentinel');
    const restored=await StateStore.open(destination);try{assert.equal(restored.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{restored.close();}
   }
  });
  await t.test('backup-supplied engine paths cannot import executable code',async()=>{
   const current=await StateStore.open(original),slot=current.db.prepare('SELECT * FROM generations WHERE state=\'active\'').get(),generation=join(original,'generations',slot.generation_id),configFile=join(generation,'engine-config.json'),saved=await readFile(configFile,'utf8'),seal=await verifySeal(generation,slot.manifest_sha256),evil=join(folder,'untrusted-engine'),sentinel=join(folder,'executed');await mkdir(join(evil,'dist'),{recursive:true});await writeFile(join(evil,'package.json'),'{}');await writeFile(join(evil,'dist/index.js'),'require("node:fs").writeFileSync('+JSON.stringify(sentinel)+',"executed"); throw new Error("UNTRUSTED_ENGINE");');
   try{
    const config=JSON.parse(saved);config.engineRoot=evil;await atomicFile(configFile,canonicalJSON(config)+'\n');const {files,...header}=seal,resealed=await sealFiles(generation,header,files.map(f=>f.path));current.db.prepare('UPDATE generations SET manifest_sha256=? WHERE generation_id=?').run(resealed.sha256,slot.generation_id);
    const altered=await new BackupStore(new Catalog(current)).create(),destination=join(folder,'trusted-engine'),preview=await restoreBackup({backupPath:altered.path,targetRoot:destination});assert.equal(preview.rebuild_required,false);await restoreBackup({backupPath:altered.path,targetRoot:destination,apply:true,planId:preview.plan_id});await assert.rejects(access(sentinel));const restoredConfig=JSON.parse(await readFile(join(destination,'generations',slot.generation_id,'engine-config.json'),'utf8'));assert.equal(restoredConfig.engineRoot,engineRoot);
   }finally{await atomicFile(configFile,saved);current.db.prepare('UPDATE generations SET manifest_sha256=? WHERE generation_id=?').run((await sealFiles(generation,Object.fromEntries(Object.entries(seal).filter(([key])=>key!=='files')),seal.files.map(f=>f.path))).sha256,slot.generation_id);current.close();}
  });
  await t.test('relocated missing models preserve the backup but require a fresh runtime generation',async()=>{
   const current=await StateStore.open(original),slot=current.db.prepare("SELECT * FROM generations WHERE state='active'").get(),generation=join(original,'generations',slot.generation_id),configFile=join(generation,'engine-config.json'),saved=await readFile(configFile,'utf8'),seal=await verifySeal(generation,slot.manifest_sha256),{files,...header}=seal;
   try{
    const config=JSON.parse(saved);config.modelRoot=join(folder,'missing-models');await atomicFile(configFile,canonicalJSON(config)+'\n');current.db.prepare('UPDATE generations SET manifest_sha256=? WHERE generation_id=?').run((await sealFiles(generation,header,files.map(f=>f.path))).sha256,slot.generation_id);
    const altered=await new BackupStore(new Catalog(current)).create(),destination=join(folder,'relocated-models'),preview=await restoreBackup({backupPath:altered.path,targetRoot:destination});assert.equal(preview.models_ready,false);assert.equal(preview.rebuild_required,true);await restoreBackup({backupPath:altered.path,targetRoot:destination,apply:true,planId:preview.plan_id});const restored=await StateStore.open(destination);try{const row=restored.db.prepare('SELECT g.state,a.epoch FROM active_slot a JOIN generations g USING(generation_id)').get();assert.equal(row.state,'retired');assert.equal(row.epoch,1);}finally{restored.close();}
   }finally{await atomicFile(configFile,saved);current.db.prepare('UPDATE generations SET manifest_sha256=? WHERE generation_id=?').run((await sealFiles(generation,header,files.map(f=>f.path))).sha256,slot.generation_id);current.close();}
  });
  await t.test('changed original content invalidates a preview and is preserved instead of overwritten',async()=>{
   const destination=join(folder,'changed'),preview=await restoreBackup({backupPath:backup.path,targetRoot:destination});await writeFile(join(source,'0.md'),'# Project 0\n\nA newer project milestone and owner.');await assert.rejects(restoreBackup({backupPath:backup.path,targetRoot:destination,apply:true,planId:preview.plan_id}),{code:'STALE_EPOCH'});await assert.rejects(access(destination));const fresh=await restoreBackup({backupPath:backup.path,targetRoot:destination});assert.equal(fresh.source_changes,1);assert.equal(fresh.rebuild_required,true);const applied=await restoreBackup({backupPath:backup.path,targetRoot:destination,apply:true,planId:fresh.plan_id});assert.equal(applied.applied,true);assert.ok((await readFile(join(source,'0.md'),'utf8')).includes('A newer'));const restored=await StateStore.open(destination);try{assert.equal(restored.db.prepare("SELECT g.state FROM active_slot a JOIN generations g USING(generation_id)").get().state,'retired');}finally{restored.close();}
  });
  assert.equal(await fileDigest(join(source,'1.md')),hashes[1]);
 }finally{await rm(folder,{recursive:true,force:true});}
});
