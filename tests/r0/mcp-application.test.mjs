import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createApplication} from '../fixtures/application.mjs';
const root=resolve(import.meta.dirname,'../..');
test('MCP stdio uses real product search/read/related/compare DTOs and rejects stale revisions',async()=>{
 await mkdir(join(root,'.local/alpha'),{recursive:true});const folder=await mkdtemp(join(root,'.local/alpha/mcp-')),source=join(folder,'source');await mkdir(source);
 await writeFile(join(source,'agreement.md'),'# Key agreement\n\nECDH derives a shared secret without sending private keys.');
 await writeFile(join(source,'signing.md'),'# Digital signature\n\nECDSA checks message integrity and authenticates the signing key.');
 const long=Array.from({length:6},(_,i)=>'#'.repeat(i+1)+' '+('타원곡선 공개키 검증과 인증서 발급 과정의 정의 조건 설명 '+i+' ').repeat(35)).join('\n\n')+'\n\nECDH derives a shared secret without sending private keys.';
 await writeFile(join(source,'long.md'),long);
 const app=await createApplication({dataRoot:join(folder,'data')}),client=new Client({name:'dsearch-test',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[join(root,'apps/cli/dist/main.js'),'mcp','--data-root',app.root,'--no-start'],stderr:'pipe'});let stderr='';transport.stderr?.on('data',v=>stderr+=v);
 try{const col=await app.catalog.addCollection({name:'MCP source',root:source});await app.builder.start().completion;
  await client.connect(transport);const listed=await client.callTool({name:'list_collections',arguments:{}});assert.equal(listed.structuredContent.data[0].collection_id,col.collection_id);assert.ok(!JSON.stringify(listed).includes(source));
  const token=(await readFile(join(app.root,'credentials/device-token'),'utf8')).trim();const api=async(method,path,value)=>{const response=await fetch(app.url+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(value?{body:JSON.stringify(value)}:{})});return (await response.json()).data;};
  const request={query:'private keys',purpose:'find',collections:[col.collection_id],mode:'hybrid',rerank:false};
  const found=await client.callTool({name:'search_documents',arguments:{query:request.query,collection_ids:request.collections,mode:request.mode,rerank:false}});assert.ok(!found.isError,JSON.stringify(found));const done=found.structuredContent.data;
  const accepted=await api('POST','/v1/searches',request);let direct;for(let i=0;i<1000;i++){direct=await api('GET',accepted.status_url);if(direct.state==='completed')break;await new Promise(r=>setTimeout(r,10));}assert.deepEqual(done.results,direct.results);
  const doc=done.results.find(d=>d.relative_path==='agreement.md');assert.ok(doc);const ref={doc_id:doc.doc_id,revision_id:doc.revision_id,locator:doc.evidence[0].locator};
  const read=await client.callTool({name:'read_document',arguments:ref});assert.deepEqual(read.structuredContent.data,await api('POST','/v1/documents/read',ref));
  const longDoc=app.catalog.documents(col.collection_id).find(d=>d.relative_path==='long.md');const related=await client.callTool({name:'find_related',arguments:{source:{doc_id:longDoc.doc_id,revision_id:longDoc.latest_revision_id,locator:{kind:'markdown',start:{line:13,column_utf16:0},end:{line:14,column_utf16:0}}},collections:[col.collection_id],mode:'hybrid',rerank:false}});assert.ok(!related.isError,JSON.stringify(related));const plan=related.structuredContent.data.query_plan;assert.ok(plan.query.includes('ECDH derives'));assert.ok(plan.used_spans.some(s=>s.start.line===13));assert.ok(related.structuredContent.data.results.every(d=>d.doc_id!==longDoc.doc_id));
  const signing=done.results.find(d=>d.relative_path==='signing.md');const compare=await client.callTool({name:'compare_documents',arguments:{left:{doc_id:doc.doc_id,revision_id:doc.revision_id},right:{doc_id:signing.doc_id,revision_id:signing.revision_id},query:'key',mode:'hybrid',rerank:false}});assert.ok(!compare.isError,JSON.stringify(compare));assert.equal(compare.structuredContent.data.purpose,'compare');
  const literal=await client.callTool({name:'search_literal',arguments:{query:'private keys',collection_ids:[col.collection_id]}});assert.ok(!literal.isError);assert.ok(literal.structuredContent.data.matches.some(m=>m.doc_id===doc.doc_id));
  await writeFile(join(source,'agreement.md'),'# Changed\n\nNew source revision.');const stale=await client.callTool({name:'read_document',arguments:ref});assert.equal(stale.isError,true);assert.equal(stale.structuredContent.error.code,'STALE_REVISION');assert.ok(!stderr.includes(token));
 }finally{await client.close();await app.close();await rm(folder,{recursive:true,force:true});}
});
