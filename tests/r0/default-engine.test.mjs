import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createApplication} from '../fixtures/application.mjs';
import {createAlphaProfile} from '../../packages/generations/dist/index.js';
import {QmdWorker} from '../../packages/engine-qmd/dist/index.js';
import {SearchRequest} from '../../packages/contracts/dist/index.js';
const root=resolve(import.meta.dirname,'../..'),delay=ms=>new Promise(r=>setTimeout(r,ms));

test('default application uses the bounded SDK and can index, search and read with default model paths',async()=>{
  await mkdir(join(root,'.local/alpha'),{recursive:true});
  const folder=await mkdtemp(join(root,'.local/alpha/default-engine-')),source=join(folder,'source');await mkdir(source);
  const text='# Project handoff\n\nRecord the review owner and delivery milestone before the project handoff. 🧭\n';
  await writeFile(join(source,'project.md'),text);
  const expected=await createAlphaProfile(join(root,'.local/qmd-audited'));
  const probe=new QmdWorker();let app;
  try{
    // The public daemon entry also omits engineRoot/modelRoot. The default must
    // select the SDK used for bounded indexing and reproducible candidate pools.
    app=await createApplication({dataRoot:join(folder,'data')});
    assert.equal(app.status().profile.profile_fp,expected.fingerprint,'Ordinary startup must use the same bounded SDK as release evaluation');
    const opened=await probe.open({engineRoot:app.builder.options.engineRoot,modelRoot:join(root,'.local/models'),dbPath:join(folder,'capabilities.sqlite'),collectionPath:source,embedRole:'embed',strict:true,role:'probe'});
    assert.equal(opened.capabilities.boundedEmbedCalls,true);assert.equal(opened.capabilities.candidateReceipt,true);await probe.close();
    const collection=await app.catalog.addCollection({name:'Project handoff',root:source});
    await app.builder.start().completion;
    const accepted=app.sessions.createKeyword(SearchRequest.parse({query:'review owner delivery milestone',purpose:'find',mode:'hybrid',rerank:false,collections:[collection.collection_id],limit:10,candidate_limit:40}));
    let result;for(let i=0;i<6000;i++){result=app.sessions.get(accepted.search_id);if(['completed','failed','cancelled'].includes(result.state))break;await delay(10);}
    assert.equal(result.state,'completed',JSON.stringify(result.error));assert.equal(result.degraded,false);assert.equal(result.telemetry.truncated_inputs,0);
    assert.equal(result.results.length,1);const doc=result.results[0],read=await app.catalog.readDocument(doc.doc_id,doc.revision_id);assert.equal(read.text,text);
    assert.equal(await readFile(join(source,'project.md'),'utf8'),text);
  }finally{await probe.close();await app?.close();await rm(folder,{recursive:true,force:true});}
});
