import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createApplication} from '../fixtures/application.mjs';
import {verifySeal} from '../../packages/generations/dist/index.js';
const root=resolve(import.meta.dirname,'../..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function done(app,accepted){for(let i=0;i<6000;i++){const result=app.sessions.get(accepted.search_id);if(['completed','failed','cancelled'].includes(result.state))return result;await sleep(10);}throw new Error('Interactive search did not finish while projection copies were paused');}

test('search can finish while incremental projection copies are paused without reserving the inference lane',async()=>{
  await mkdir(join(root,'.local/alpha'),{recursive:true});
  const folder=await mkdtemp(join(root,'.local/alpha/preparation-lane-')),source=join(folder,'source');await mkdir(source);
  for(let i=0;i<20;i++)await writeFile(join(source,i+'.md'),'# Project '+i+'\n\nRecord the delivery milestone and review owner for project '+i+'.');
  const app=await createApplication({dataRoot:join(folder,'data')});
  try{
    const collection=await app.catalog.addCollection({name:'Projects',root:source});await app.builder.start().completion;
    const before=app.sessions.readers.active(),unchanged=await readFile(join(source,'1.md'),'utf8');let checked=false,observedBusy;
    await writeFile(join(source,'0.md'),'# Project zero\n\nThe revised delivery milestone has a new owner.');
    app.builder.options.fault=async phase=>{
      if(phase!=='reuse-copy-batch'||checked)return;checked=true;
      observedBusy=app.builder.options.lane.busy;if(observedBusy)return;
      const result=await done(app,app.sessions.createKeyword({query:'delivery milestone review owner',purpose:'find',mode:'hybrid',rerank:false,collections:[collection.collection_id],limit:10,candidate_limit:40}));
      assert.equal(result.state,'completed',JSON.stringify(result));assert.equal(result.degraded,false);
      assert.equal(result.generation_id,before.generation_id);assert.ok(result.results.length>0);
      assert.equal(app.status().generation.generation_id,before.generation_id);
    };
    const build=app.builder.start();await build.completion;assert.equal(checked,true);
    assert.equal(observedBusy,false,'Pure projection copies must not reserve the inference lane');
    assert.equal(app.builder.getJob(build.job_id).progress.reused_documents,19);
    assert.notEqual(app.status().generation.generation_id,before.generation_id);
    await verifySeal(before.directory_path,before.manifest_sha256);
    assert.equal(await readFile(join(source,'1.md'),'utf8'),unchanged);
  }finally{app.builder.options.fault=undefined;await app.close();await rm(folder,{recursive:true,force:true});}
});
