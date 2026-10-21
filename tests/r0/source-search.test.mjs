import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {Catalog,StateStore} from '../../packages/catalog/dist/index.js';
import {createAlphaProfile,GenerationBuilder} from '../../packages/generations/dist/index.js';
import {ReaderPool,SourceSearch,SearchSessions} from '../../packages/search/dist/index.js';
const root=resolve(import.meta.dirname,'../..'),engineRoot=join(root,'.local/qmd-upstream'),modelRoot=join(root,'.local/models');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function complete(sessions,id){for(let i=0;i<500;i++){const value=sessions.get(id);if(['completed','failed','cancelled'].includes(value.state))return value;await sleep(10);}throw new Error('Search did not finish');}
test('real lexical and literal sessions return verified source evidence, keep leases and reject stale reads',async t=>{
 await mkdir(join(root,'.local/alpha'),{recursive:true});const folder=await mkdtemp(join(root,'.local/alpha/search-')),dir=join(folder,'sources');await mkdir(dir);
 const original='---\nrole: concept\n---\n# Generated heading\n\nSigning and signed input bytes.\n\n한글 😀 공개키 수학과 e\u0301를 설명한다.\n\n정확한 [a-z]+ 기호와 Q=dG를 기록한다.';
 await writeFile(join(dir,'one.md'),original);await writeFile(join(dir,'copy.md'),original);await writeFile(join(dir,'unrelated.md'),'# Other\n\nUnrelated material about gardens.');
 const state=await StateStore.open(join(folder,'data')),catalog=new Catalog(state),collection=await catalog.addCollection({name:'actual-folder',root:dir}),profile=await createAlphaProfile(engineRoot);
 const builder=new GenerationBuilder(catalog,{engineRoot,modelRoot,profile:profile.manifest,embedRole:'embed'}),built=await builder.start().completion;
 const pool=new ReaderPool(catalog,{engineRoot,modelRoot,profile_fp:profile.fingerprint}),source=new SourceSearch(catalog),sessions=new SearchSessions(source,pool);
 const request={query:'signs',purpose:'find',mode:'lexical',rerank:false,collections:[collection.collection_id],limit:10,candidate_limit:40,allow_degraded:false};
 try{
  await t.test('English stemming and normalized CJK positions come from actual FTS matches',async()=>{
   const accepted=sessions.createKeyword(request),result=await complete(sessions,accepted.search_id);assert.equal(result.state,'completed');assert.equal(result.results.length,2);assert.notEqual(result.results[0].doc_id,result.results[1].doc_id);
   assert.ok(result.results[0].evidence[0].excerpt.includes('Signing'));assert.equal(result.results[0].evidence[0].locator.start.line,6);
   const cjk=await complete(sessions,sessions.createKeyword({...request,query:'공개키'}).search_id);assert.equal(cjk.results.length,2);assert.ok(cjk.results[0].evidence[0].excerpt.includes('한글 😀 공개키'));assert.equal(cjk.results[0].evidence[0].locator.start.line,8);
   for(const doc of cjk.results){const evidence=doc.evidence[0];
    const value=await catalog.read({doc_id:doc.doc_id,revision_id:doc.revision_id,locator:evidence.locator});assert.ok(value.text.includes('공개키'));}
   assert.equal(JSON.stringify(result).includes('qmd://'),false);assert.equal(JSON.stringify(result).includes('"body"'),false);
  });
  await t.test('generated metadata and repeated context alone do not produce source-body evidence',async()=>{
   const result=await complete(sessions,sessions.createKeyword({...request,query:'concept'}).search_id);assert.equal(result.results.length,0);assert.ok(result.counts.generated_only_omitted>=2);
  });
  await t.test('metadata filters compile into the pinned SDK predicate shape',async()=>{
   const result=await complete(sessions,sessions.createKeyword({...request,filter:{field:'metadata.role',operator:'eq',value:'concept'}}).search_id);assert.equal(result.results.length,2);
   const none=await complete(sessions,sessions.createKeyword({...request,filter:{field:'metadata.role',operator:'eq',value:'lesson'}}).search_id);assert.equal(none.results.length,0);
  });
  await t.test('literal metacharacters are data and new files are discovered without an embedding build',async()=>{
   await writeFile(join(dir,'new.md'),'# New\n\n[a-z]+ exactly and [a-z]+ again.');
   const result=await complete(sessions,sessions.createLiteral({query:'[a-z]+',collections:request.collections}).search_id);assert.equal(result.state,'completed');assert.equal(result.matches.length,4);assert.equal(result.partial,false);assert.ok(result.matches.some(m=>m.relative_path==='new.md'));
   const insensitive=await complete(sessions,sessions.createLiteral({query:'SIGNING',ignore_case:true,collections:request.collections}).search_id);assert.equal(insensitive.matches.length,2);
   const matches=await complete(sessions,sessions.createLiteral({query:'[a-z]+',limit:1,collections:request.collections}).search_id);assert.equal(matches.matches.length,1);assert.equal(matches.partial,true);assert.equal(matches.stop_reason,'match_limit');
  });
  await t.test('a source changed behind the watcher is omitted and old revision reads fail',async()=>{
   const doc=catalog.documents(collection.collection_id).find(d=>d.relative_path==='one.md'&&d.present);await writeFile(join(dir,'one.md'),'# Changed\n\nDifferent bytes');
   const result=await complete(sessions,sessions.createKeyword(request).search_id);assert.equal(result.counts.stale_omitted,1);assert.ok(result.results.every(r=>r.doc_id!==doc.doc_id));
   await assert.rejects(catalog.read({doc_id:doc.doc_id,revision_id:doc.latest_revision_id,locator:{kind:'markdown',start:{line:1,column_utf16:0},end:{line:1,column_utf16:0}}}),{code:'STALE_REVISION'});
   await writeFile(join(dir,'one.md'),original);await catalog.reconcile(collection.collection_id);
  });
  await t.test('an existing lease retains the old generation while a new one is published',async()=>{
   const lease=pool.reserve();await lease.ready;const second=await builder.start().completion;assert.equal(second.epoch,2);
   const old=await source.keyword(request,'old-lease',lease,new AbortController().signal,()=>{});assert.equal(old.generation_id,built.generation_id);lease.release();
   const fresh=await complete(sessions,sessions.createKeyword(request).search_id);assert.equal(fresh.generation_id,second.generation_id);assert.throws(()=>pool.reserve(1),{code:'STALE_EPOCH'});
  });
  await t.test('queued cancellation and in-memory query storage are explicit',async()=>{
   const done=await complete(sessions,sessions.createKeyword({...request,query:'private-query-sentinel-DoNotPersist-2026'}).search_id);assert.equal(done.state,'completed');
   const literal=await complete(sessions,sessions.createLiteral({query:'private-literal-sentinel-DoNotPersist-2026',collections:request.collections}).search_id);assert.equal(literal.state,'completed');
   const accepted=sessions.createKeyword({...request,query:'cancelled-query-sentinel-2026'});const cancelled=sessions.cancel(accepted.search_id);assert.equal(cancelled.state,'cancelled');assert.equal(sessions.get(accepted.search_id).state,'cancelled');
   const active=pool.active();
   for(const file of ['state.sqlite','state.sqlite-wal','generations/'+active.generation_id+'/qmd.sqlite']){try{const bytes=await readFile(join(state.root,file));for(const value of ['private-query-sentinel-DoNotPersist-2026','private-literal-sentinel-DoNotPersist-2026'])assert.equal(bytes.includes(Buffer.from(value)),false);}catch(e){if(e.code!=='ENOENT')throw e;}}
   catalog.setEnabled(collection.collection_id,false);assert.throws(()=>sessions.createKeyword(request),{code:'SCOPE_DENIED'});
  });
 }finally{await sessions.close();state.close();await rm(folder,{recursive:true,force:true});}
});
