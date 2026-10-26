import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {StateStore,Catalog} from '../../packages/catalog/dist/index.js';
import {DsearchError} from '../../packages/contracts/dist/index.js';
import {GenerationBuilder,createAlphaProfile,verifySeal} from '../../packages/generations/dist/index.js';
const root=resolve(import.meta.dirname,'../..'),engineRoot=join(root,'.local/qmd-recovery'),modelRoot=join(root,'.local/models');
test('classified memory failures retry once from a verified checkpoint with smaller bounded calls',async t=>{
 await mkdir(join(root,'.local/alpha'),{recursive:true});const folder=await mkdtemp(join(root,'.local/alpha/resource-retry-')),source=join(folder,'source');await mkdir(source);for(let i=0;i<7;i++)await writeFile(join(source,i+'.md'),'# Project '+i+'\n\nRecord the milestone owner and review date '+i+'.');const state=await StateStore.open(join(folder,'data')),catalog=new Catalog(state);await catalog.addCollection({name:'Projects',root:source});const profile=(await createAlphaProfile(engineRoot)).manifest,options={engineRoot,modelRoot,profile,embedRole:'embed'};
 try{
  const baseline=await new GenerationBuilder(catalog,options).start().completion;
  await t.test('one boundary failure reduces every subsequent SDK call to at most two documents',async()=>{
   let injected=false,handle;const counts=[],builder=new GenerationBuilder(catalog,{...options,fault:phase=>{if(phase==='batch-before-native'&&!injected){injected=true;throw new DsearchError('RESOURCE_EXHAUSTED');}if(phase==='checkpoint-batch')counts.push(builder.getJob(handle.job_id).progress.completed);}});handle=builder.start({full:true});const built=await handle.completion;assert.deepEqual(counts,[2,4,6,7]);assert.equal(builder.getJob(handle.job_id).progress.resource_retries,1);assert.equal(builder.getJob(handle.job_id).progress.embedding_call_count_incomplete,0);assert.equal(built.coverage.filter(d=>d.state==='included').length,7);await verifySeal(join(state.root,'generations',baseline.generation_id),baseline.manifest_sha256);
  });
  await t.test('a repeated failure stops instead of looping and preserves the previous active generation',async()=>{
   const active=state.db.prepare('SELECT generation_id FROM active_slot').get().generation_id;let failures=0;const builder=new GenerationBuilder(catalog,{...options,fault:phase=>{if(phase==='batch-before-native'){failures++;throw new DsearchError('RESOURCE_EXHAUSTED');}}}),handle=builder.start({full:true});await assert.rejects(handle.completion,{code:'RESOURCE_EXHAUSTED'});assert.equal(failures,2);assert.equal(state.db.prepare('SELECT generation_id FROM active_slot').get().generation_id,active);const cursor=JSON.parse(state.db.prepare('SELECT cursor_json FROM jobs WHERE job_id=?').get(handle.job_id).cursor_json);assert.equal(cursor.resource_retries,1);const resumedBuilder=new GenerationBuilder(catalog,options),resumed=resumedBuilder.start({resume:handle.job_id});await resumed.completion;assert.equal(resumedBuilder.getJob(resumed.job_id).progress.resource_retries,1);
  });
 }finally{state.close();await rm(folder,{recursive:true,force:true});}
});
