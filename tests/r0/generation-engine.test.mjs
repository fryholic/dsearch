import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {QmdWorker} from '../../packages/engine-qmd/dist/index.js';
const root=resolve(import.meta.dirname,'../..'),engineRoot=join(root,'.local/qmd-upstream'),modelRoot=join(root,'.local/models');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
test('generation workers embed only semantic collections and sealed readers never migrate or mutate the index',async()=>{
 await mkdir(join(root,'.local/alpha'),{recursive:true});const dir=await mkdtemp(join(root,'.local/alpha/roles-'));await mkdir(join(dir,'semantic'));await mkdir(join(dir,'lexical'));await mkdir(join(dir,'semantic2'));
 await writeFile(join(dir,'semantic/one.md'),'# Canonical encoding\n\nCanonical encoding fixes signing input bytes. 같은 바이트열을 서명에 사용한다.');
 await writeFile(join(dir,'lexical/two.md'),'# Large code\n\n```text\n'+('noembedding '.repeat(600))+'\n```');
 await writeFile(join(dir,'semantic2/three.md'),'# Restore guide\n\nUse a backup to recover a deleted file.');
 const collections={semantic2:{path:join(dir,'semantic2'),pattern:'**/*.md'},semantic:{path:join(dir,'semantic'),pattern:'**/*.md'},lexical:{path:join(dir,'lexical'),pattern:'**/*.md'}};
 const options={engineRoot,modelRoot,dbPath:join(dir,'qmd.sqlite'),collectionPath:dir,embedRole:'embed',strict:true,generationId:'generation-test',collections,semanticCollections:['semantic','semantic2']};
 const builder=new QmdWorker();let reader;
 try{
  await builder.open({...options,role:'builder'});await builder.invoke('update');const progress=[];const embedded=(await builder.invoke('embed',{}, {timeoutMode:'idle',onProgress:e=>{if(e.phase==='embedding-batch')progress.push(e.completed);}})).result;assert.equal(embedded.results.length,2);assert.ok(embedded.results.every(r=>r.errors===0));assert.deepEqual(progress,[0,1]);
  await builder.close();
  const require=createRequire(join(engineRoot,'package.json')),Database=require('better-sqlite3'),db=new Database(options.dbPath,{readonly:true});
  try{const rows=db.prepare('SELECT d.collection,count(v.hash) AS vectors FROM documents d LEFT JOIN content_vectors v ON v.hash=d.hash GROUP BY d.collection ORDER BY d.collection').all();assert.deepEqual(rows,[{collection:'lexical',vectors:0},{collection:'semantic',vectors:1},{collection:'semantic2',vectors:1}]);}finally{db.close();}
  const before=hash(await readFile(options.dbPath));reader=new QmdWorker();await reader.open({...options,role:'reader'});
  await assert.rejects(reader.invoke('update'),{code:'SCOPE_DENIED'});await assert.rejects(reader.invoke('embed'),{code:'SCOPE_DENIED'});
  const request={query:'canonical',purpose:'find',mode:'lexical',rerank:false,collections:['semantic','lexical'],candidate_limit:40,limit:10,allow_degraded:false};
  const lexical=await reader.search(request);assert.ok(lexical.result.hits[0].file.startsWith('qmd://semantic/'));
  const hybrid=await reader.search({...request,query:'same bytes before signing',mode:'hybrid',rerank:true,collections:['semantic']});assert.equal(hybrid.stats.rerankSucceeded,true);assert.equal(hybrid.result.rank_stage,'qmd_reranked_blend');
  await reader.close();assert.equal(hash(await readFile(options.dbPath)),before);
  const wrong=new QmdWorker();try{await assert.rejects(wrong.open({...options,role:'reader',semanticCollections:[],collections:{...collections,semantic:{...collections.semantic,path:join(dir,'wrong')}}}),{code:'COMPATIBILITY_FAILED'});}finally{await wrong.close();}
  assert.equal(hash(await readFile(options.dbPath)),before);
 }finally{await builder.close();if(reader)await reader.close();await rm(dir,{recursive:true,force:true});}
});
