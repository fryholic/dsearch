import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createApplication} from '../fixtures/application.mjs';
import {SourceSearch} from '../../packages/search/dist/index.js';
import {SearchRequest} from '../../packages/contracts/dist/index.js';
import {spawn} from 'node:child_process';
const root=resolve(import.meta.dirname,'../..');
test('profile preparation stays private, explicit activation pins models and restart restores the selected generation',async()=>{
 await mkdir(join(root,'.local/alpha'),{recursive:true});const folder=await mkdtemp(join(root,'.local/alpha/p5-profiles-')),source=join(folder,'source'),data=join(folder,'data');await mkdir(source);
 await writeFile(join(source,'agreement.md'),'# Key agreement\n\nECDH derives a shared secret without sending private keys.');await writeFile(join(source,'signature.md'),'# Signature\n\nECDSA authenticates the signing key and message integrity.');
 let app=await createApplication({dataRoot:data}),call;
 const cli=args=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[join(root,'apps/cli/dist/main.js'),...args,'--data-root',data,'--json'],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.once('error',reject);child.once('exit',code=>{try{assert.equal(code,0,err);assert.equal(out.trim().split('\n').length,1);const packet=JSON.parse(out);assert.equal(packet.ok,true);resolve(packet.data);}catch(error){reject(error);}});});
 const connect=async()=>{const token=(await readFile(join(data,'credentials/device-token'),'utf8')).trim();call=async(method,path,value)=>{const response=await fetch(app.url+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(value!==undefined?{body:JSON.stringify(value)}:{})});const packet=await response.json();assert.ok(packet.ok,JSON.stringify(packet));return packet.data;};};
 const wait=async accepted=>{for(let i=0;i<2000;i++){const state=await call('GET','/v1/jobs/'+accepted.job_id);if(['succeeded','failed','cancelled'].includes(state.state))return state;await new Promise(r=>setTimeout(r,10));}throw new Error('job timed out');};
 try{await connect();const col=await call('POST','/v1/collections',{name:'P5',root:source});const initial=await wait(await call('POST','/v1/reconcile',{}));assert.equal(initial.state,'succeeded');
  const before=app.status(),catalog=await call('GET','/v1/profiles'),reference=catalog.profiles.find(p=>p.alias==='qmd-reference'),qwen=catalog.profiles.find(p=>p.alias==='qwen-local');const oldLease=app.sessions.readers.reserve();
  const checked=await wait(await call('POST','/v1/models/check',{profile_id:reference.profile_id}));assert.equal(checked.state,'succeeded');assert.ok((await call('GET','/v1/models')).filter(m=>reference.model_roles.includes(m.role)).every(m=>m.state==='verified'));
  const prepared=await cli(['profile','prepare',reference.profile_id,'--wait']);assert.equal(prepared.state,'succeeded',JSON.stringify(prepared));assert.equal(prepared.kind,'profile-build');assert.equal(app.status().generation.generation_id,before.generation.generation_id);assert.equal(app.status().profile.profile_id,qwen.profile_id);assert.equal((await call('GET','/v1/profiles')).generations.find(g=>g.generation_id===prepared.generation_id).state,'ready');
  const activated=await cli(['profile','activate',reference.profile_id,'--generation',prepared.generation_id,'--expected-epoch',String(before.generation.epoch),'--wait']);assert.equal(activated.state,'succeeded',JSON.stringify(activated));assert.equal(app.status().profile.profile_id,reference.profile_id);assert.equal(app.status().generation.profile_fp,reference.profile_fp);
  try{const old=await new SourceSearch(app.catalog).keyword(SearchRequest.parse({purpose:'find',query:'private keys',collections:[col.collection_id],mode:'hybrid',rerank:false}),'old-profile',oldLease,new AbortController().signal,()=>{});assert.equal(old.profile_fp,qwen.profile_fp);assert.equal(old.epoch,before.generation.epoch);assert.ok(old.results.length);}finally{oldLease.release();}
  const wrongEpoch=await wait(await call('POST','/v1/profiles/'+qwen.profile_id+'/activate',{generation_id:before.generation.generation_id,expected_epoch:before.generation.epoch}));assert.equal(wrongEpoch.state,'failed');assert.equal(wrongEpoch.error_code,'STALE_EPOCH');assert.equal(app.status().profile.profile_id,reference.profile_id);
  await app.close();app=await createApplication({dataRoot:data});await connect();assert.equal(app.status().profile.profile_id,reference.profile_id);assert.equal(app.status().needs_rebuild,false);
  const reversed=await cli(['generation','rollback',before.generation.generation_id,'--expected-epoch',String(app.status().generation.epoch),'--wait']);assert.equal(reversed.state,'succeeded',JSON.stringify(reversed));assert.equal(app.status().profile.profile_id,qwen.profile_id);
  await writeFile(join(source,'agreement.md'),'# Changed\n\nThe original file has changed.');const stale=await wait(await call('POST','/v1/profiles/'+reference.profile_id+'/activate',{generation_id:prepared.generation_id,expected_epoch:app.status().generation.epoch}));assert.equal(stale.state,'failed');assert.equal(stale.error_code,'STALE_REVISION');assert.equal(app.status().profile.profile_id,qwen.profile_id);
 }finally{await app.close();await rm(folder,{recursive:true,force:true});}
});
