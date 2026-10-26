import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {StateStore,Catalog} from '../../packages/catalog/dist/index.js';
import {GenerationBuilder,createAlphaProfile,BackupStore,verifySeal} from '../../packages/generations/dist/index.js';
import {restoreBackup} from '../../apps/daemon/dist/index.js';
const root=resolve(import.meta.dirname,'../..'),engineRoot=join(root,'.local/qmd-recovery'),modelRoot=join(root,'.local/models');
test('a backed-up interrupted build resumes after restoring its verified paths and source mappings',async()=>{
 await mkdir(join(root,'.local/alpha'),{recursive:true});const folder=await mkdtemp(join(root,'.local/alpha/restored-checkpoint-')),source=join(folder,'source'),target=join(folder,'restored');await mkdir(source);for(let i=0;i<11;i++)await writeFile(join(source,i+'.md'),'# Guide '+i+'\n\nRecord the milestone owner and review date '+i+'.');
 let state=await StateStore.open(join(folder,'original')),catalog=new Catalog(state);await catalog.addCollection({name:'Projects',root:source});const profile=(await createAlphaProfile(engineRoot)).manifest,options={engineRoot,modelRoot,profile,embedRole:'embed'};
 try{
  await new GenerationBuilder(catalog,options).start().completion;const failedBuilder=new GenerationBuilder(catalog,{...options,fault:phase=>{if(phase==='checkpoint-batch')throw new Error('interrupted');}}),failed=failedBuilder.start({full:true});await assert.rejects(failed.completion);const backup=await new BackupStore(catalog).create();state.close();state=undefined;
  const preview=await restoreBackup({backupPath:backup.path,targetRoot:target});await restoreBackup({backupPath:backup.path,targetRoot:target,apply:true,planId:preview.plan_id});state=await StateStore.open(target);catalog=new Catalog(state);const builder=new GenerationBuilder(catalog,options),resumed=builder.start({resume:failed.job_id}),result=await resumed.completion;assert.equal(result.generation_id,failed.generation_id);assert.ok(builder.getJob(resumed.job_id).progress.embedding_calls<14);assert.equal(result.coverage.filter(d=>d.state==='included').length,11);await verifySeal(join(target,'generations',result.generation_id),result.manifest_sha256);
 }finally{state?.close();await rm(folder,{recursive:true,force:true});}
});
