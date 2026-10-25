import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {StateStore,Catalog} from '../../packages/catalog/dist/index.js';
import {GenerationBuilder,createAlphaProfile,GenerationGC,generationPins,verifySeal} from '../../packages/generations/dist/index.js';
import {ReaderPool} from '../../packages/search/dist/index.js';
const root=resolve(import.meta.dirname,'../..'),engineRoot=join(root,'.local/qmd-upstream'),modelRoot=join(root,'.local/models'),policy={keep_retired:0,min_age_seconds:0};
test('GC waits for real reader workers and a live incremental builder base before deleting retired files',async()=>{
 await mkdir(join(root,'.local/alpha'),{recursive:true});const folder=await mkdtemp(join(root,'.local/alpha/gc-leases-')),source=join(folder,'source');await mkdir(source);await writeFile(join(source,'guide.md'),'# Milestone\n\nRecord the project owner before the milestone review.');
 const state=await StateStore.open(join(folder,'data')),catalog=new Catalog(state);await catalog.addCollection({name:'Projects',root:source});const profile=(await createAlphaProfile(engineRoot)).manifest,options={engineRoot,modelRoot,profile,embedRole:'embed'},readers=new ReaderPool(catalog,{engineRoot,modelRoot});
 try{
  const first=await new GenerationBuilder(catalog,options).start().completion,lease=readers.reserve();await lease.ready;assert.ok(generationPins(state,first.generation_id).includes('reader'));
  let arrived,proceed;const atBoundary=new Promise(resolve=>arrived=resolve),gate=new Promise(resolve=>proceed=resolve),builder=new GenerationBuilder(catalog,{...options,fault:async phase=>{if(phase==='after-index'){arrived();await gate;}}}),handle=builder.start();await atBoundary;
  assert.ok(generationPins(state,first.generation_id).includes('builder-base'));const gc=new GenerationGC(catalog),during=await gc.preview(policy);await assert.rejects(gc.apply(during.plan_id,policy),{code:'BUSY'});proceed();await handle.completion;readers.sweep();
  const held=await gc.preview(policy);assert.ok(held.protected.find(p=>p.generation_id===first.generation_id).reasons.includes('lease:reader'));assert.deepEqual((await gc.apply(held.plan_id,policy)).removed,[]);await verifySeal(join(state.root,'generations',first.generation_id),first.manifest_sha256);
  lease.release();await readers.close();assert.deepEqual(generationPins(state,first.generation_id),[]);const next=await gc.preview(policy);assert.ok((await gc.apply(next.plan_id,policy)).removed.includes(first.generation_id));await assert.rejects(access(join(state.root,'generations',first.generation_id)));
 }finally{await readers.close();state.close();await rm(folder,{recursive:true,force:true});}
});
