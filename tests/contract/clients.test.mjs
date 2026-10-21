import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCLIClient} from '../../apps/cli/dist/index.js';
import {createWebClient} from '../../apps/web/dist/index.js';
test('CLI and web consume the same validated DTO through a fixture adapter',async()=>{
 const bodies=[];const transport=async(path,body)=>{
  assert.equal(path,'/v1/searches');bodies.push(JSON.stringify(body));
  return {schema_version:1,request_id:'req',ok:true,data:{search_id:'search-one',state:'queued',status_url:'/v1/searches/search-one',events_url:'/v1/searches/search-one/events'}};
 };
 const request={purpose:'find',query:'바이트열과 서명',mode:'hybrid',rerank:true,collections:['fixture'],filter:{field:'metadata.type',operator:'eq',value:'concept'}};
 assert.deepEqual(await createCLIClient(transport)(request),await createWebClient(transport)(request));assert.equal(bodies[0],bodies[1]);
 await assert.rejects(createCLIClient(transport)({...request,unexpected:true}),{code:'INVALID_REQUEST'});
 await assert.rejects(createWebClient(async()=>({schema_version:2}))(request),{code:'UNSUPPORTED_VERSION'});
});
