import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {Catalog,StateStore} from '../../packages/catalog/dist/index.js';
import {GenerationBuilder,createAlphaProfile,verifySeal} from '../../packages/generations/dist/index.js';
const root=resolve(import.meta.dirname,'../..'),engineRoot=join(root,'.local/qmd-upstream'),modelRoot=join(root,'.local/models');
test('manual generation publishes only fully verified sources and preserves the old active slot on failure/cancellation',async()=>{
 await mkdir(join(root,'.local/alpha'),{recursive:true});const folder=await mkdtemp(join(root,'.local/alpha/builder-')),source=join(folder,'source');await mkdir(source);
 await writeFile(join(source,'one.md'),'---\nrole: concept\n---\n# Canonical encoding\n\n같은 바이트열을 서명한다. Canonical encoding fixes signing input bytes.');
 await writeFile(join(source,'two.md'),'# Code\n\n설명\n\n```text\n'+('x'.repeat(2700))+'\n```\n\n조건');
 await writeFile(join(source,'bad.md'),'---\nrole: [bad]\n---\n# Invalid metadata');
 const state=await StateStore.open(join(folder,'data')),catalog=new Catalog(state),col=await catalog.addCollection({name:'manual',root:source}),profile=await createAlphaProfile(engineRoot);
 const options={engineRoot,modelRoot,profile:profile.manifest,embedRole:'embed'};
 try{
  const builder=new GenerationBuilder(catalog,options),handle=builder.start();assert.equal(builder.getJob(handle.job_id).state,'queued');assert.throws(()=>builder.start(),{code:'BUSY'});
  const built=await handle.completion;assert.equal(built.epoch,1);assert.equal(builder.getJob(handle.job_id).state,'succeeded');assert.equal(builder.busy,false);
  assert.equal(built.coverage.find(d=>catalog.document(d.doc_id).relative_path==='bad.md').state,'failed');assert.equal(built.coverage.filter(d=>d.state==='included').length,1);assert.equal(built.coverage.filter(d=>d.state==='lexical_only').length,1);
  const slot=state.db.prepare('SELECT * FROM active_slot').get();assert.equal(slot.generation_id,built.generation_id);const directory=join(state.root,'generations',built.generation_id);const manifest=await verifySeal(directory,built.manifest_sha256);assert.equal(manifest.passages,2);
  const mappings=JSON.parse(await readFile(join(directory,'mappings.json'),'utf8'));assert.equal(mappings.length,2);assert.ok(mappings.every(p=>!('text' in p)));assert.ok(mappings.every(p=>p.revision_id));
  assert.equal(state.db.prepare('SELECT status FROM profiles').get().status,'validated');
  // An injected build failure must not expose an incomplete generation.
  const failed=new GenerationBuilder(catalog,{...options,fault:phase=>{if(phase==='after-index')throw new Error('synthetic injected failure');}}),failure=failed.start();await assert.rejects(failure.completion,{code:'INTERNAL_ERROR'});assert.equal(failed.getJob(failure.job_id).state,'failed');assert.equal(state.db.prepare('SELECT generation_id FROM active_slot').get().generation_id,built.generation_id);
  // Change bytes after indexing, without a catalog watcher update.
  const changed=new GenerationBuilder(catalog,{...options,fault:async phase=>{if(phase==='before-publish')await writeFile(join(source,'one.md'),'# Changed\n\nnew bytes');}}),stale=changed.start();await assert.rejects(stale.completion,{code:'STALE_REVISION'});assert.equal(state.db.prepare('SELECT generation_id FROM active_slot').get().generation_id,built.generation_id);
  // A queued cancellation becomes terminal only after all owned workers exit.
  const cancelled=new GenerationBuilder(catalog,options),cancel=cancelled.start();cancelled.cancel(cancel.job_id);assert.equal(cancelled.getJob(cancel.job_id).state,'cancel_requested');await assert.rejects(cancel.completion,{code:'CANCELLED'});assert.equal(cancelled.getJob(cancel.job_id).state,'cancelled');
  assert.equal(state.db.prepare('SELECT generation_id FROM active_slot').get().generation_id,built.generation_id);
  await catalog.reconcile(col.collection_id);const fresh=new GenerationBuilder(catalog,options),second=await fresh.start().completion;assert.equal(second.epoch,2);assert.equal(state.db.prepare('SELECT state FROM generations WHERE generation_id=?').get(built.generation_id).state,'retired');
 }finally{state.close();await rm(folder,{recursive:true,force:true});}
});
