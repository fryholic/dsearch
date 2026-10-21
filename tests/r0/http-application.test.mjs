import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {request} from 'node:http';
import {createApplication} from '../../apps/daemon/dist/index.js';
const root=resolve(import.meta.dirname,'../..');
test('actual application API registers, builds, searches, streams, reads and blocks stale or disabled sources',async t=>{
 await mkdir(join(root,'.local/alpha'),{recursive:true});const folder=await mkdtemp(join(root,'.local/alpha/http-')),sources=join(folder,'sources');await mkdir(sources);
 await writeFile(join(sources,'문서.md'),'# Signature\n\n한글 😀 서명 입력과 canonical encoding.\n\n리터럴 [a-z]+ 기호를 읽는다.');
 const app=await createApplication({dataRoot:join(folder,'data'),engineRoot:join(root,'.local/qmd-upstream'),modelRoot:join(root,'.local/models')});
 const token=(await readFile(join(app.root,'credentials/device-token'),'utf8')).trim();
 const api=async(method,path,data,extra={})=>{const response=await fetch(app.url+path,{method,headers:{authorization:'Bearer '+token,...(data!==undefined?{'content-type':'application/json'}:{}),...extra},...(data!==undefined?{body:JSON.stringify(data)}:{})});return{status:response.status,headers:response.headers,body:await response.json()};};
 const wait=async path=>{for(let i=0;i<1000;i++){const value=await api('GET',path);const s=value.body.data?.state;if(['completed','succeeded','failed','cancelled'].includes(s))return value;await new Promise(r=>setTimeout(r,10));}throw new Error('API operation timed out');};
 try{
  await t.test('loopback authentication, Host/Origin checks and private runtime files',async()=>{
   assert.equal((await fetch(app.url+'/v1/status')).status,401);assert.equal((await api('GET','/v1/status',undefined,{origin:'https://example.invalid'})).status,403);
   const badHost=await new Promise((resolve,reject)=>{const req=request(app.url+'/v1/status',{headers:{host:'wrong.example',authorization:'Bearer '+token}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});assert.equal(badHost,403);
   assert.equal(new URL(app.url).hostname,'127.0.0.1');assert.equal((await stat(join(app.root,'runtime.json'))).mode&0o777,0o600);assert.equal((await stat(join(app.root,'credentials/device-token'))).mode&0o777,0o600);
   await assert.rejects(createApplication({dataRoot:app.root}),{code:'BUSY'});
  });
  const added=await api('POST','/v1/collections',{name:'실제 폴더',root:sources});assert.equal(added.status,201);const collection=added.body.data.collection_id;
  const job=await api('POST','/v1/reconcile',{});assert.equal(job.status,202);const built=await wait('/v1/jobs/'+job.body.data.job_id);assert.equal(built.body.data.state,'succeeded');
  const created=await api('POST','/v1/searches',{query:'서명',purpose:'find',mode:'lexical',rerank:false,collections:[collection]});assert.equal(created.status,202);
  const done=await wait(created.body.data.status_url);assert.equal(done.body.data.state,'completed');assert.equal(done.body.data.results.length,1);const document=done.body.data.results[0],evidence=document.evidence[0];
  await t.test('SSE and source reading use the same completed document revision and locator',async()=>{
   const response=await fetch(app.url+created.body.data.events_url,{headers:{authorization:'Bearer '+token}});assert.equal(response.headers.get('content-type'),'text/event-stream; charset=utf-8');const events=await response.text();assert.ok(events.includes('event: state'));assert.ok(events.includes(document.doc_id));
   const value=await api('POST','/v1/documents/read',{doc_id:document.doc_id,revision_id:document.revision_id,locator:evidence.locator});assert.equal(value.status,200);assert.ok(value.body.data.text.includes('한글 😀 서명'));
   const arbitrary=await api('POST','/v1/documents/read',{doc_id:document.doc_id,revision_id:document.revision_id,locator:evidence.locator,path:join(folder,'not-registered')});assert.equal(arbitrary.status,422);
   const pdf=await api('POST','/v1/documents/read',{doc_id:document.doc_id,revision_id:document.revision_id,locator:{kind:'pdf',page:1}});assert.equal(pdf.body.error.code,'UNSUPPORTED_LOCATOR');
  });
  await t.test('single-use GUI exchange creates HttpOnly sessions protected by Origin and CSRF',async()=>{
   const issued=await api('POST','/v1/ui/code'),code=new URL(issued.body.data.url).hash.slice('#code='.length);
   const exchange=await fetch(app.url+'/v1/ui/exchange',{method:'POST',headers:{origin:app.url,'content-type':'application/json'},body:JSON.stringify({code})});assert.equal(exchange.status,200);const cookie=exchange.headers.get('set-cookie');assert.ok(cookie.includes('HttpOnly'));assert.ok(cookie.includes('SameSite=Strict'));const csrf=(await exchange.json()).data.csrf_token;
   const replay=await fetch(app.url+'/v1/ui/exchange',{method:'POST',headers:{origin:app.url,'content-type':'application/json'},body:JSON.stringify({code})});assert.equal(replay.status,401);
   const headers={cookie:cookie.split(';')[0],origin:app.url,'content-type':'application/json'};
   const blocked=await fetch(app.url+'/v1/literal-searches',{method:'POST',headers,body:JSON.stringify({query:'[a-z]+',collections:[collection]})});assert.equal(blocked.status,403);
   const allowed=await fetch(app.url+'/v1/literal-searches',{method:'POST',headers:{...headers,'x-dsearch-csrf':csrf},body:JSON.stringify({query:'[a-z]+',collections:[collection]})});assert.equal(allowed.status,202);const result=await wait((await allowed.json()).data.status_url);assert.equal(result.body.data.matches.length,1);
  });
  await t.test('malformed and oversized JSON cannot terminate the application',async()=>{
   const bad=await fetch(app.url+'/v1/searches',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:Uint8Array.of(255)});assert.equal(bad.status,422);
   const large=await fetch(app.url+'/v1/searches',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'x'.repeat(262145)});assert.equal(large.status,413);assert.equal((await api('GET','/v1/status')).status,200);
   const staticAsset=await fetch(app.url+'/app.js.map');assert.notEqual(staticAsset.status,200);
  });
  await writeFile(join(sources,'문서.md'),'# Changed\n\n새로운 바이트');const stale=await api('POST','/v1/documents/read',{doc_id:document.doc_id,revision_id:document.revision_id,locator:evidence.locator});assert.equal(stale.status,409);assert.equal(stale.body.error.code,'STALE_REVISION');
  const disabled=await api('PATCH','/v1/collections/'+collection,{enabled:false});assert.equal(disabled.status,200);assert.equal((await api('GET',created.body.data.status_url)).status,410);assert.equal((await api('POST','/v1/documents/read',{doc_id:document.doc_id,revision_id:document.revision_id,locator:evidence.locator})).status,403);
 }finally{await app.close();await assert.rejects(readFile(join(app.root,'runtime.json')),{code:'ENOENT'});await rm(folder,{recursive:true,force:true});}
});
