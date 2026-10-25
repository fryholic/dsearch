import {execFileSync} from 'node:child_process';
import {StateStore,Catalog} from '../../packages/catalog/dist/index.js';
import {GenerationBuilder,createAlphaProfile} from '../../packages/generations/dist/index.js';
const [dataRoot,engineRoot,modelRoot,phase]=process.argv.slice(2);
try{
 const state=await StateStore.open(dataRoot),catalog=new Catalog(state),profile=(await createAlphaProfile(engineRoot)).manifest;
 let handle;const builder=new GenerationBuilder(catalog,{engineRoot,modelRoot,profile,embedRole:'embed',fault:async point=>{
  if(point!==phase)return;const workerPids=execFileSync('pgrep',['-P',String(process.pid)],{encoding:'utf8'}).trim().split(/\s+/).map(Number);
  await new Promise(resolve=>process.send({phase:point,job_id:handle.job_id,generation_id:handle.generation_id,workerPids},resolve));process.kill(process.pid,'SIGKILL');
 }});handle=builder.start({full:true});await handle.completion;process.exit(3);
}catch(error){process.send?.({error:error.code??'unexpected'});process.exit(2);}
