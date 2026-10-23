import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,copyFile,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {QmdWorker} from '../../packages/engine-qmd/dist/index.js';
const root=resolve(import.meta.dirname,'../..'),hash=bytes=>createHash('sha256').update(bytes).digest('hex');

test('pinned SDK snapshots reuse vectors across new generation paths without changing the sealed reader',async t=>{
 await mkdir(join(root,'.local/alpha'),{recursive:true});const folder=await mkdtemp(join(root,'.local/alpha/snapshot-reuse-')),original=join(folder,'original'),next=join(folder,'next');
 const options=(directory,role)=>({engineRoot:join(root,'.local/qmd-upstream'),modelRoot:join(root,'.local/models'),dbPath:join(directory,'qmd.sqlite'),collectionPath:join(directory,'projection'),embedRole:'embed',strict:true,role,generationId:directory===original?'original':'next',collections:{s_test:{path:join(directory,'projection'),pattern:'**/*.md'}},semanticCollections:['s_test']});
 let worker=new QmdWorker();const reader=new QmdWorker();
 try{
  for(const directory of [original,next])await mkdir(join(directory,'projection'),{recursive:true});
  for(const [file,text] of [['backup.md','# Backup retention\n\nKeep daily snapshots for seven days.'],['handoff.md','# Project handoff\n\nRecord owners and unresolved decisions.']])await writeFile(join(original,'projection',file),text);
  await worker.open(options(original,'builder'));await worker.invoke('update');const initial=await worker.invoke('embed');assert.equal(initial.result.results[0].docsProcessed,2);assert.ok(initial.stats.embeddingCalls>=2);await worker.close();
  const originalHash=hash(await readFile(join(original,'qmd.sqlite')));
  await reader.open(options(original,'reader'));await reader.invoke('snapshot',{target:join(next,'qmd.sqlite')});
  for(const file of ['backup.md','handoff.md'])await copyFile(join(original,'projection',file),join(next,'projection',file));
  worker=new QmdWorker();await worker.open(options(next,'builder'));await worker.invoke('update');
  await t.test('unchanged content embeds no documents in a relocated generation',async()=>{const result=await worker.invoke('embed');assert.equal(result.stats.embeddingCalls,0);assert.equal(result.result.results[0].errors,0);});
  await t.test('only changed content is embedded and a removed document leaves active search',async()=>{
   await writeFile(join(next,'projection','backup.md'),'# Backup retention\n\nKeep daily snapshots for fourteen days.');await rm(join(next,'projection','handoff.md'));await worker.invoke('update');const result=await worker.invoke('embed');assert.equal(result.result.results[0].docsProcessed,1);assert.ok(result.stats.embeddingCalls>=1&&result.stats.embeddingCalls<=2);const audit=(await worker.invoke('index_audit')).result;assert.equal(audit.documents.length,1);assert.equal(audit.documents[0].path,'backup.md');assert.equal(audit.documents[0].vector_chunks,1);
  });
  await t.test('a file move preserves content vectors and updates its current engine path',async()=>{
   await mkdir(join(next,'projection','archive'));await rename(join(next,'projection','backup.md'),join(next,'projection','archive','backup.md'));await worker.invoke('update');const result=await worker.invoke('embed');assert.equal(result.stats.embeddingCalls,0);const audit=(await worker.invoke('index_audit')).result;assert.equal(audit.documents.length,1);assert.equal(audit.documents[0].path,'archive/backup.md');assert.equal(audit.documents[0].vector_chunks,1);
  });
  const before=(await reader.invoke('index_audit')).result;assert.equal(before.documents.length,2);assert.ok(before.documents.every(d=>d.vector_chunks===1));await reader.close();assert.equal(hash(await readFile(join(original,'qmd.sqlite'))),originalHash);
 }finally{await worker.close();await reader.close();await rm(folder,{recursive:true,force:true});}
});
