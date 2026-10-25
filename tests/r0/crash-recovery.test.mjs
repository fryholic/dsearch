import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {StateStore,Catalog} from '../../packages/catalog/dist/index.js';
import {GenerationBuilder,createAlphaProfile,reconcileInterruptedBuilds,verifySeal} from '../../packages/generations/dist/index.js';
const root=resolve(import.meta.dirname,'../..'),engineRoot=join(root,'.local/qmd-recovery'),modelRoot=join(root,'.local/models');
test('SIGKILL at a committed batch releases native workers and restarts from the last verified checkpoint',async()=>{
 await mkdir(join(root,'.local/alpha'),{recursive:true});const folder=await mkdtemp(join(root,'.local/alpha/kill-')),source=join(folder,'source');await mkdir(source);
 for(let i=0;i<13;i++)await writeFile(join(source,i+'.md'),'# Guide '+i+'\n\nReview the next milestone and record the responsible project owner '+i+'.');
 const state=await StateStore.open(join(folder,'data')),catalog=new Catalog(state);await catalog.addCollection({name:'Projects',root:source});const profile=(await createAlphaProfile(engineRoot)).manifest,options={engineRoot,modelRoot,profile,embedRole:'embed'};
 try{
  const initial=await new GenerationBuilder(catalog,options).start().completion;
  const child=fork(join(root,'tests/fixtures/build-crash.mjs'),[state.root,engineRoot,modelRoot,'checkpoint-batch'],{stdio:['ignore','ignore','ignore','ipc'],execArgv:[]}),exit=once(child,'exit'),[message]=await once(child,'message');
  const [code,signal]=await exit;assert.equal(code,null);assert.equal(signal,'SIGKILL');assert.equal(message.phase,'checkpoint-batch');assert.ok(message.workerPids.length);
  for(const pid of message.workerPids){let alive=true;for(let i=0;i<150&&alive;i++){try{process.kill(pid,0);await new Promise(r=>setTimeout(r,20));}catch(error){if(error.code!=='ESRCH')throw error;alive=false;}}assert.equal(alive,false,'native worker must exit on parent disconnect');}
  assert.equal(state.db.prepare('SELECT state FROM jobs WHERE job_id=?').get(message.job_id).state,'running');reconcileInterruptedBuilds(state);
  assert.equal(state.db.prepare('SELECT generation_id FROM active_slot').get().generation_id,initial.generation_id);await verifySeal(join(state.root,'generations',initial.generation_id),initial.manifest_sha256);
  const builder=new GenerationBuilder(catalog,options),handle=builder.start({resume:message.job_id}),result=await handle.completion;assert.equal(result.generation_id,message.generation_id);assert.ok(builder.getJob(handle.job_id).progress.embedding_calls<17);await verifySeal(join(state.root,'generations',result.generation_id),result.manifest_sha256);
 }finally{state.close();await rm(folder,{recursive:true,force:true});}
});
