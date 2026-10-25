import {StateStore,Catalog} from '../../packages/catalog/dist/index.js';
import {GenerationGC} from '../../packages/generations/dist/index.js';
const [root,phase]=process.argv.slice(2);
try{const state=await StateStore.open(root),gc=new GenerationGC(new Catalog(state),{fault:async point=>{if(point!==phase)return;await new Promise(resolve=>process.send({phase:point},resolve));process.kill(process.pid,'SIGKILL');}}),policy={keep_retired:0,min_age_seconds:0},preview=await gc.preview(policy);await gc.apply(preview.plan_id,policy);process.exit(3);}catch(error){process.send?.({error:error.code??'unexpected'});process.exit(2);}
