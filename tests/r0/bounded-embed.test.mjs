import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {QmdWorker} from '../../packages/engine-qmd/dist/index.js';
const root=resolve(import.meta.dirname,'../..');
test('recovery SDK returns after at most four documents and resumes missing vectors without truncation',async()=>{
 await mkdir(join(root,'.local/alpha'),{recursive:true});const folder=await mkdtemp(join(root,'.local/alpha/bounded-')),docs=join(folder,'projection');await mkdir(docs);for(let i=0;i<11;i++)await writeFile(join(docs,i+'.md'),'# Guide '+i+'\n\nRecord the project owner and document the next milestone '+i+'.');
 const options={engineRoot:join(root,'.local/qmd-recovery'),modelRoot:join(root,'.local/models'),dbPath:join(folder,'qmd.sqlite'),collectionPath:docs,embedRole:'embed',strict:true,role:'builder',generationId:'bounded-test',collections:{semantic:{path:docs,pattern:'**/*.md'}},semanticCollections:['semantic']},worker=new QmdWorker();
 try{const opened=await worker.open(options);assert.equal(opened.capabilities.boundedEmbedCalls,true);await worker.invoke('update');const counts=[];let remaining=11;
 while(remaining){const value=await worker.invoke('embed_step',{collection:'semantic'});assert.equal(value.result.errors,0);assert.equal(value.stats.truncatedInputs,0);assert.ok(value.result.docsProcessed>0&&value.result.docsProcessed<=4);assert.ok(value.result.remainingDocs<remaining);counts.push(value.result.docsProcessed);remaining=value.result.remainingDocs;}
 assert.deepEqual(counts,[4,4,3]);const empty=await worker.invoke('embed_step',{collection:'semantic'});assert.equal(empty.stats.embeddingCalls,0);assert.equal(empty.result.remainingDocs,0);const audit=(await worker.invoke('index_audit')).result;assert.ok(audit.documents.every(d=>d.vector_chunks===1));
 }finally{await worker.close();await rm(folder,{recursive:true,force:true});}
});
