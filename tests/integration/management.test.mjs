import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PreferenceStore,exportSearch,openRegisteredDocument} from '../../apps/daemon/dist/management.js';
import {StateStore,Catalog} from '../../packages/catalog/dist/index.js';
import {createApplication} from '../fixtures/application.mjs';
const artifact={repository:'test/model',filename:'model.gguf',repository_revision:'a'.repeat(40),sha256:'b'.repeat(64),quantization:'Q8_0'};
const profile={schema_version:2,profile_id:'test-profile',engine:{repository:'https://github.com/tobi/qmd',source_version:'2.8.3',upstream_commit:'c'.repeat(40),patch_digest:'d'.repeat(64),artifact_sha256:'e'.repeat(64)},models:{embed:{...artifact,dimension:1024},rerank:artifact,expansion:null},input_policy:{compiler_version:'test',projection_utf16_cap:2400,embedding_input_token_cap:800,query_token_cap:512,rerank_context_tokens:4096,strict_no_truncation:true,cache_mode:'memory'},runtime:{node_exact:'24.21.0',node_llama_cpp:'3.20.0',platform:'darwin-arm64',heavy_concurrency:1,embed_parallelism:1,idle_worker_shutdown_seconds:300}};
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'dsearch-management-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('preferences persist only strict non-query settings and refuse symlinked input',async t=>{
 const root=await fixture(t),store=new PreferenceStore(root),defaults=await store.load();assert.equal(defaults.search.rerank,false);
 const changed={...defaults,theme:'dark'};await store.set(changed);assert.deepEqual(await new PreferenceStore(root).load(),changed);assert.equal((await stat(join(root,'preferences.json'))).mode&0o777,0o600);
 await assert.rejects(store.set({...changed,query:'private-query'}),{code:'INVALID_REQUEST'});
 await rm(join(root,'preferences.json'));await writeFile(join(root,'outside.json'),JSON.stringify(changed));await symlink(join(root,'outside.json'),join(root,'preferences.json'));await assert.rejects(new PreferenceStore(root).load(),{code:'COMPATIBILITY_FAILED'});
});
test('explicit exports omit query plans on both comparison sides and never mutate RAM results',()=>{
 const side={result:{query_plan:{query:'private-query',semantic_query:'private-query'},results:[{doc_id:'doc',revision_id:'revision',evidence:[{excerpt:'source'}]}]}};
 const original={purpose:'compare',state:'completed',left:side,right:structuredClone(side)};
 assert.ok(!JSON.stringify(exportSearch(original,false)).includes('private-query'));assert.ok(JSON.stringify(exportSearch(original,true)).includes('private-query'));assert.ok(original.left.result.query_plan);
 assert.throws(()=>exportSearch({state:'running'},false),{code:'BUSY'});
});
test('opening a document resolves only registered sources and refuses changed revisions before OS launch',async t=>{
 const root=await fixture(t),source=join(root,'source');await mkdir(source);await writeFile(join(source,'note.md'),'# Source\n\nOriginal text.');
 const state=await StateStore.open(join(root,'data')),catalog=new Catalog(state);try{const col=await catalog.addCollection({root:source,name:'Source'});await catalog.reconcile(col.collection_id);const doc=catalog.documents(col.collection_id)[0];let opened;
 await openRegisteredDocument(catalog,doc.doc_id,doc.latest_revision_id,async path=>opened=path);assert.equal(opened,join(col.root_path,'note.md'));opened=undefined;await writeFile(join(source,'note.md'),'# Source\n\nChanged text.');await assert.rejects(openRegisteredDocument(catalog,doc.doc_id,doc.latest_revision_id,async path=>opened=path),{code:'STALE_REVISION'});assert.equal(opened,undefined);
 }finally{state.close();}
});
test('management HTTP routes retain auth, private diagnostics and collection coverage boundaries',async t=>{
 const root=await fixture(t),source=join(root,'private-source');await mkdir(source);await writeFile(join(source,'private-title.md'),'# private-body\n\nprivate-body');
 const app=await createApplication({dataRoot:join(root,'data'),profile});try{
 const token=(await readFile(join(app.root,'credentials/device-token'),'utf8')).trim();
 const api=async(method,path,value)=>{const response=await fetch(app.url+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(value!==undefined?{body:JSON.stringify(value)}:{})});return {status:response.status,packet:await response.json()};};
 assert.equal((await fetch(app.url+'/v1/settings')).status,401);
 const settings=(await api('GET','/v1/settings')).packet.data;assert.equal((await api('PUT','/v1/settings',{...settings,theme:'dark'})).packet.data.theme,'dark');assert.equal((await api('PUT','/v1/settings',{...settings,query:'private-query'})).status,422);
 const col=(await api('POST','/v1/collections',{name:'private-collection',root:source})).packet.data;await app.catalog.reconcile(col.collection_id);
 const coverage=(await api('POST','/v1/collections/'+col.collection_id+'/coverage',{})).packet.data;assert.equal(coverage.total,1);assert.equal(coverage.documents[0].relative_path,'private-title.md');
 const diag=JSON.stringify((await api('POST','/v1/diagnostics',{})).packet.data);for(const sentinel of [source,'private-title','private-body','private-collection','private-query',token])assert.ok(!diag.includes(sentinel),sentinel);
 assert.equal((await fetch(app.url+'/settings')).status,200);assert.equal((await fetch(app.url+'/diagnostics')).status,200);
 const jobsBefore=app.status().jobs.length;
 for(const invalid of [{expected_epoch:0,generation_id:'conflicting-id'},{expected_epoch:0,extra:true},{},null,[]]){
  const rejected=await api('POST','/v1/generations/unknown-generation/rollback',invalid);assert.equal(rejected.status,422);assert.equal(rejected.packet.error.code,'INVALID_REQUEST');
 }
 assert.equal(app.status().jobs.length,jobsBefore);
 }finally{await app.close();}
});
