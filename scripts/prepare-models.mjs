import {readFile,mkdir,rename,open} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyModel} from '../packages/runtime/dist/index.js';
const root=resolve(import.meta.dirname,'..');const folder=join(root,'.local/models');await mkdir(folder,{recursive:true});
const {models}=JSON.parse(await readFile(join(root,'vendor/models/registry.json'),'utf8'));
for(const model of models) {
 if(!/^[\w.-]+\/[\w.-]+$/.test(model.repository)||!/^\w[\w.-]*\.gguf$/.test(model.filename)||! /^[a-f0-9]{40}$/.test(model.revision))throw new Error('Invalid model registry');
 const path=join(folder,model.filename);
 if(await verifyModel(path,model).then(()=>true,()=>false)){console.log(model.role+': checksum verified');continue;}
 const response=await fetch('https://huggingface.co/'+model.repository+'/resolve/'+model.revision+'/'+model.filename,{signal:AbortSignal.timeout(120000)});
 if(!response.ok||!response.body)throw new Error('Model download failed: '+response.status);
 const partial=path+'.part';const file=await open(partial,'w',0o600);let bytes=0;const hash=createHash('sha256');
 try {for await(const chunk of response.body){bytes+=chunk.length;if(bytes>model.bytes)throw new Error('Oversized model');hash.update(chunk);await file.write(chunk);}}
 finally{await file.close();}
 if(bytes!==model.bytes||hash.digest('hex')!==model.sha256)throw new Error('Model integrity check failed');
 await rename(partial,path);console.log(model.role+': downloaded and checksum verified');
}
