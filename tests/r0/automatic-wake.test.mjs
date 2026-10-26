import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createApplication} from '../../apps/daemon/dist/index.js';
import {verifySeal} from '../../packages/generations/dist/index.js';
const root=resolve(import.meta.dirname,'../..'),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read){for(let i=0;i<3000;i++){const value=read();if(value)return value;await sleep(10);}throw new Error('Automatic wake recovery timed out');}
test('automatic wake interruption retries once while a user cancellation during reset stays blocked',{timeout:60000},async t=>{
 await mkdir(join(root,'.local/alpha'),{recursive:true});const folder=await mkdtemp(join(root,'.local/alpha/automatic-wake-')),source=join(folder,'source');await mkdir(source);
 await writeFile(join(source,'owner.md'),'# Owner\n\nRecord the project owner.');const app=await createApplication({dataRoot:join(folder,'data'),synchronization:{stableMs:50,maxDelayMs:150,pollMs:250,retryMs:10}});
 const token=(await readFile(join(app.root,'credentials/device-token'),'utf8')).trim();
 const settled=()=>until(()=>{const s=app.status();return s.generation&&!s.needs_rebuild&&s.synchronization.state==='idle'&&s;});
 try{
  await app.catalog.addCollection({name:'Projects',root:source});app.synchronization.notify('configuration',true);await settled();
  for(const cancel of [false,true])await t.test(cancel?'explicit cancellation after wake begins is not retried':'infrastructure interruption recovers without user cancellation metadata',async()=>{
   const builder=app.builder,before=app.sessions.readers.active();let entered=false,release;const gate=new Promise(resolve=>release=resolve);
   builder.options.fault=async phase=>{if(phase==='checkpoint-initial'){entered=true;await gate;}};
   const text='# Owner\n\nChanged owner during wake '+cancel+'.';await writeFile(join(source,'owner.md'),text);app.synchronization.notify('filesystem',true);
   try{
    await until(()=>entered);const id=app.synchronization.info().job_id;app.synchronization.notify('wake',true);if(cancel)builder.cancel(id);builder.options.fault=undefined;release();
    await until(()=>!app.synchronization.recovering);const row=app.catalog.state.db.prepare('SELECT * FROM jobs WHERE job_id=?').get(id),cursor=JSON.parse(row.cursor_json);
    assert.equal(row.state,cancel?'cancelled':'failed');assert.equal(row.error_code,cancel?'CANCELLED':'WORKER_EXITED');assert.equal(row.cancel_requested,cancel?1:0);assert.equal(cursor.automatic_retry_allowed===true,!cancel);
    await verifySeal(before.directory_path,before.manifest_sha256);
    if(cancel){
     await until(()=>app.status().synchronization.state==='blocked');const count=app.status().jobs.length;await sleep(600);assert.equal(app.status().jobs.length,count);assert.equal(app.status().generation.generation_id,before.generation_id);
     let recovered=false;for(let attempt=0;attempt<150;attempt++){
      const response=await fetch(app.url+'/v1/jobs/'+id+'/retry',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'{}'}),packet=await response.json();
      if(!packet.ok&&packet.error.code==='BUSY'){await sleep(20);continue;}assert.equal(packet.ok,true,JSON.stringify(packet.error));recovered=true;break;
     }assert.equal(recovered,true,'explicit retry must eventually acquire the mutation barrier');
    }
    await settled();assert.notEqual(app.status().generation.generation_id,before.generation_id);assert.equal(await readFile(join(source,'owner.md'),'utf8'),text);
   }finally{release();builder.options.fault=undefined;}
  });
 }finally{await app.close();await rm(folder,{recursive:true,force:true});}
});
