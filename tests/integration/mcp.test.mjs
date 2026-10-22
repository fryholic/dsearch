import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer,boundedResult} from '../../apps/mcp/dist/index.js';
const packet=data=>({schema_version:1,request_id:'request',ok:true,data});
async function linked(call,options){const bridge=createMcpServer(call,options),client=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await bridge.server.connect(b);await client.connect(a);return{bridge,client,close:async()=>{bridge.abort();await client.close();await bridge.server.close();}};}
test('MCP publishes strict read-only schemas and rejects unknown fields before daemon access',async()=>{
 let calls=0;const c=await linked(async()=>{calls++;return packet({});});
 try{const list=await c.client.listTools();assert.equal(list.tools.length,8);for(const t of list.tools){assert.equal(t.inputSchema.additionalProperties,false);assert.equal(t.annotations.readOnlyHint,true);assert.equal(t.annotations.destructiveHint,false);}
  const invalid=await c.client.callTool({name:'search_documents',arguments:{query:'key',collection_ids:['scope'],unknown:true}});assert.equal(invalid.isError,true);assert.equal(calls,0);
  assert.ok(!list.tools.some(t=>/sync|export|write|model|activate/.test(t.name)));
 }finally{await c.close();}
});
test('MCP timeout propagates HTTP cancellation and waits past cancel_requested for terminal state',async()=>{
 let cancelled=false,polls=0;const c=await linked(async(method,path)=>{
  if(method==='POST')return packet({status_url:'/v1/searches/one',search_id:'one',state:'queued'});
  if(method==='DELETE'){cancelled=true;return packet({search_id:'one',state:'cancel_requested',phase:'cancel-requested'});}
  polls++;return packet({search_id:'one',state:cancelled&&polls>3?'cancelled':'running',phase:cancelled&&polls>3?'cancelled':'reranking'});
 },{timeoutMs:10});
 try{const result=await c.client.callTool({name:'search_documents',arguments:{query:'key',collection_ids:['scope']}});assert.equal(result.isError,true);assert.equal(result.structuredContent.error.code,'CANCELLED');assert.equal(cancelled,true);assert.ok(polls>3);assert.equal(c.bridge.activeCalls,0);}finally{await c.close();}
});
test('MCP result cap describes omissions, preserves source DTO and updates returned counts',()=>{
 const original=packet({purpose:'find',counts:{returned_documents:50},has_more:false,results:Array.from({length:50},(_,i)=>({doc_id:String(i),evidence:[{excerpt:'한글😀'.repeat(800)}]})),supplemental_results:[]});
 const result=boundedResult(original);assert.ok(Buffer.byteLength(JSON.stringify(result))<=65536);assert.equal(result.structuredContent.transport.truncated,true);assert.equal(result.structuredContent.data.counts.returned_documents,result.structuredContent.data.results.length);assert.equal(result.structuredContent.data.has_more,true);assert.equal(original.data.results.length,50);
 const read=boundedResult(packet({start_line:5,end_line:6,text:('한글😀\\\"'.repeat(9000))+'\nnext'}));assert.ok(Buffer.byteLength(JSON.stringify(read))<=65536);assert.equal(read.structuredContent.data.truncated,true);assert.equal(read.structuredContent.data.end_line,5+read.structuredContent.data.text.split('\n').length-1);
});
