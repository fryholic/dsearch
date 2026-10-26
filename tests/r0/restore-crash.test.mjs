import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {StateStore,Catalog} from '../../packages/catalog/dist/index.js';
import {GenerationBuilder,createAlphaProfile,BackupStore,verifySeal,readBackup} from '../../packages/generations/dist/index.js';
import {restoreBackup} from '../../apps/daemon/dist/index.js';
import {createApplication} from '../fixtures/application.mjs';
import {fileDigest} from '../../packages/runtime/dist/index.js';
const root=resolve(import.meta.dirname,'../..'),engineRoot=join(root,'.local/qmd-audited'),modelRoot=join(root,'.local/models');
test('SIGKILL during restore cannot turn a valid data root into an empty or mixed installation',async t=>{
 await mkdir(join(root,'.local/alpha'),{recursive:true});const folder=await mkdtemp(join(root,'.local/alpha/restore-kill-')),source=join(folder,'source'),target=join(folder,'restored');await mkdir(source);await writeFile(join(source,'guide.md'),'# Project guide\n\nRecord the owner before the milestone review.');
 for(let i=0;i<20;i++)await writeFile(join(source,'note-'+i+'.md'),'# Project note '+i+'\n\nRecord the milestone owner for work item '+i+'.');
 const state=await StateStore.open(join(folder,'original')),catalog=new Catalog(state);await catalog.addCollection({name:'Projects',root:source});const profile=(await createAlphaProfile(engineRoot)).manifest;await new GenerationBuilder(catalog,{engineRoot,modelRoot,profile,embedRole:'embed'}).start().completion;const backup=await new BackupStore(catalog).create();state.close();const hash=await fileDigest(join(source,'guide.md'));
 try{
  assert.ok((await readBackup(backup.path)).manifest.files.length>16,'exercise an interrupted multi-batch restore');
  const first=await restoreBackup({backupPath:backup.path,targetRoot:target});await restoreBackup({backupPath:backup.path,targetRoot:target,apply:true,planId:first.plan_id});
  for(const phase of ['restore-preparing','restore-copy-batch','restore-before-swap','restore-after-old-move','restore-after-install'])await t.test(phase,async()=>{
   const preview=await restoreBackup({backupPath:backup.path,targetRoot:target}),child=fork(join(root,'tests/fixtures/restore-crash.mjs'),[backup.path,target,preview.plan_id,phase],{stdio:['ignore','ignore','ignore','ipc'],execArgv:[]}),exited=once(child,'exit'),[message]=await once(child,'message'),[code,signal]=await exited;assert.equal(message.phase,phase,JSON.stringify(message));assert.equal(code,null);assert.equal(signal,'SIGKILL');
   const app=await createApplication({dataRoot:target,engineRoot,modelRoot});try{assert.equal(app.status().needs_rebuild,false);const slot=app.catalog.state.db.prepare('SELECT g.* FROM active_slot a JOIN generations g USING(generation_id)').get();assert.ok(slot);await verifySeal(slot.directory_path,slot.manifest_sha256);assert.equal(app.catalog.state.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(await fileDigest(join(source,'guide.md')),hash);}finally{await app.close();}
  });
 }finally{await rm(folder,{recursive:true,force:true});}
});
