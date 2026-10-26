import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createApplication} from '../fixtures/application.mjs';
import {canonicalJSON,digest} from '../../packages/catalog/dist/index.js';
const root=resolve(import.meta.dirname,'../..'),entry=join(root,'apps/cli/dist/main.js'),exec=promisify(execFile);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

test('general document rules, typed metadata and native retrieval agree across HTTP, CLI and MCP',async t=>{
 await mkdir(join(root,'.local/alpha'),{recursive:true});const folder=await mkdtemp(join(root,'.local/alpha/general-policy-')),source=join(folder,'source'),data=join(folder,'data');
 await cp(join(root,'examples/documents'),source,{recursive:true});
 const paths=['operations/backup-policy.md','operations/recovery-guide.md','engineering/onboarding.md','drafts/release-checklist.md'];
 const before=await Promise.all(paths.map(async p=>[p,hash(await readFile(join(source,p)))]));
 let app=await createApplication({dataRoot:data,port:0}),token=(await readFile(join(data,'credentials/device-token'),'utf8')).trim();
 const api=async(method,path,value)=>{const res=await fetch(app.url+path,{method,headers:{authorization:'Bearer '+token,...(value===undefined?{}:{'content-type':'application/json'})},...(value===undefined?{}:{body:JSON.stringify(value)})});const packet=await res.json();assert.equal(packet.ok,true,JSON.stringify(packet.error));return packet.data;};
 const wait=async path=>{for(let i=0;i<2000;i++){const job=await api('GET',path);if(['succeeded','completed'].includes(job.state))return job;if(['failed','cancelled','obsolete'].includes(job.state))assert.fail(JSON.stringify(job));await new Promise(r=>setTimeout(r,10));}assert.fail('native operation timed out');};
 const cli=async args=>JSON.parse((await exec(process.execPath,[entry,...args,'--data-root',data,'--json'],{cwd:root,maxBuffer:4*1024*1024})).stdout).data;
 const search=async filter=>wait((await api('POST','/v1/searches',{query:'운영',purpose:'find',mode:'lexical',rerank:false,collections:[id],...(filter?{filter}:{})})).status_url);
 let id;
 try {
  await t.test('CLI registers arbitrary folders with explicit, optional metadata conditions',async()=>{
   const scope={metadata_filter:{not:{field:'metadata.status',operator:'eq',value:'draft'}},navigation_headings:[]};
   const col=await cli(['collection','add',source,'--name','Public examples','--scope-json',JSON.stringify(scope)]);id=col.collection_id;assert.equal(col.preset,'general');assert.equal(col.policy_version,2);
   await cli(['reconcile']);assert.equal((await api('GET','/v1/status')).coverage.included,3);
  });
  await t.test('scalar/list metadata and independent role/type/custom fields use real engine filters',async()=>{
   const author=await search({field:'metadata.role',operator:'eq',value:'author'});assert.deepEqual(author.results.map(d=>d.relative_path),['engineering/onboarding.md']);
   const guides=await search({field:'metadata.type',operator:'eq',value:'guide'});assert.equal(guides.results.length,3);
   const operations=await search({field:'metadata.topics',operator:'in',value:['operations']});assert.equal(operations.results.length,2);
   const custom=await search({field:'metadata.project.team',operator:'eq',value:'infrastructure'});assert.deepEqual(custom.results.map(d=>d.relative_path),['operations/backup-policy.md']);
   const missing=await search({field:'metadata.missing',operator:'ne',value:'x'});assert.equal(missing.results.length,0);
   const cliResult=await cli(['search','운영','--mode','lexical','--filter-json',JSON.stringify({field:'metadata.role',operator:'eq',value:'author'})]);assert.deepEqual(cliResult.results,author.results);
  });
  await t.test('generic semantic requests run real embedding/reranking and preserve source evidence',async()=>{
   const cases=JSON.parse(await readFile(join(root,'fixtures/synthetic/general-evaluation.json'),'utf8')).cases;
   for(const c of cases.slice(0,2)){
    const done=await wait((await api('POST','/v1/searches',{query:c.query,purpose:'find',mode:'hybrid',rerank:true,collections:[id]})).status_url);
    assert.equal(done.effective_mode,'hybrid');assert.equal(done.rank_stage,'qmd_reranked_blend');assert.ok(done.results.some(d=>c.relevant_paths.includes(d.relative_path)));
    const doc=done.results.find(d=>c.relevant_paths.includes(d.relative_path)),evidence=doc.evidence[0];
    const read=await api('POST','/v1/documents/read',{doc_id:doc.doc_id,revision_id:doc.revision_id,locator:evidence.locator});assert.ok(read.text.includes(evidence.excerpt));
   }
  });
  await t.test('MCP launched outside the checkout returns the same filtered documents and revisions',async()=>{
   const client=new Client({name:'general-policy-regression',version:'1.0'});
   try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:[entry,'mcp','--data-root',data],cwd:folder,stderr:'pipe'}));
    const result=await client.callTool({name:'search_documents',arguments:{query:'운영',mode:'lexical',collection_ids:[id],filter:{field:'metadata.role',operator:'eq',value:'author'}}});assert.ok(!result.isError,JSON.stringify(result));
    const direct=await search({field:'metadata.role',operator:'eq',value:'author'});assert.deepEqual(result.structuredContent.data.results,direct.results);
   }finally{await client.close();}
  });
  await t.test('existing-command preview discloses scope expansion without changing IDs or applying it',async()=>{
   const scope={metadata_filter:null};const preview=await cli(['collection','preview',id,'--scope-json',JSON.stringify(scope)]);assert.deepEqual(preview.changes,{added:1,removed:0,unchanged:3});
   assert.equal((await api('GET','/v1/collections'))[0].metadata_filter.not.value,'draft');
   await cli(['collection','update',id,'--scope-json',JSON.stringify(scope)]);await cli(['reconcile']);assert.equal((await api('GET','/v1/status')).coverage.included,4);
  });
  await t.test('v4 upgrade requires reindex, preserves source identity, and candidate preparation alone does not switch',async()=>{
   await app.close();
   const db=new DatabaseSync(join(data,'state.sqlite')),row=db.prepare('SELECT scope_json FROM collections WHERE collection_id=?').get(id),current=JSON.parse(row.scope_json);
   const old={preset:'general',include:current.include,exclude:current.exclude,root_file_key:current.root_file_key},oldJSON=canonicalJSON(old);
   // Use ordinary valid legacy metadata in this historical-state fixture.
   const legacy='# Legacy document\n\n운영 백업 보관과 복구 절차.\n';await writeFile(join(source,'operations/backup-policy.md'),legacy);
   db.prepare('UPDATE collections SET scope_json=?,scope_fp=? WHERE collection_id=?').run(oldJSON,digest(oldJSON),id);db.exec('DROP TABLE scope_migrations; PRAGMA user_version=4;');
   const identities=db.prepare('SELECT relative_path,doc_id FROM source_documents ORDER BY relative_path').all();db.close();
   app=await createApplication({dataRoot:data,port:0});token=(await readFile(join(data,'credentials/device-token'),'utf8')).trim();
   const pending=await api('GET','/v1/status');assert.equal(pending.policy_upgrade_pending,true);assert.equal(pending.modes.hybrid,false);
   const candidate=await api('POST','/v1/profiles/qwen-local/prepare',{});await wait('/v1/jobs/'+candidate.job_id);assert.equal((await api('GET','/v1/status')).policy_upgrade_pending,true);
   const profiles=await api('GET','/v1/profiles');await wait('/v1/jobs/'+(await api('POST','/v1/profiles/qwen-local/activate',{generation_id:candidate.generation_id,expected_epoch:profiles.active_epoch})).job_id);
   const ready=await api('GET','/v1/status');assert.equal(ready.policy_upgrade_pending,false);assert.equal(ready.modes.hybrid,true);
   const after=new DatabaseSync(join(data,'state.sqlite'),{readOnly:true});try{assert.deepEqual(after.prepare('SELECT relative_path,doc_id FROM source_documents ORDER BY relative_path').all(),identities);}finally{after.close();}
   await writeFile(join(source,'operations/backup-policy.md'),await readFile(join(root,'examples/documents/operations/backup-policy.md')));
  });
  for(const [path,expected] of before)assert.equal(hash(await readFile(join(source,path))),expected);
 }finally{await app.close();await rm(folder,{recursive:true,force:true});}
});
