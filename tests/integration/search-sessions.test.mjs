import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SearchSessions} from '../../packages/search/dist/index.js';
import {HeavyLane} from '../../packages/runtime/dist/index.js';
const sleep=()=>new Promise(r=>setImmediate(r));
test('search sessions enforce TTL/LRU, running cancellation confirmation, scope invalidation and reader release',async()=>{
 let now=0,released=0,finish;const source={validateCollections:()=>{},keyword:async()=>{await new Promise(r=>finish=r);throw new Error('cancel test');},literal:async()=>{throw Object.assign(new Error(),{code:'INVALID_QUERY'});}};
 const readers={reserve:()=>({release:()=>released++}),close:async()=>{}};
 const sessions=new SearchSessions(source,readers,{ttlMs:100,maxSessions:2,now:()=>now});
 const query={query:'search',purpose:'find',mode:'lexical',rerank:false,collections:['scope']};
 try{
  const first=sessions.createKeyword(query);await sleep();assert.equal(sessions.get(first.search_id).state,'running');assert.equal(sessions.cancel(first.search_id).state,'cancel_requested');assert.equal(released,0);finish();await sleep();assert.equal(sessions.get(first.search_id).state,'cancelled');assert.equal(released,1);
  const second=sessions.createLiteral({query:'x',collections:['scope']});await sleep();assert.equal(sessions.get(second.search_id).state,'failed');assert.equal(sessions.get(second.search_id).error.code,'INVALID_QUERY');now=1;sessions.get(second.search_id);
  const third=sessions.createLiteral({query:'x',collections:['scope']});assert.throws(()=>sessions.get(first.search_id),{code:'RESULT_EXPIRED'});await sleep();sessions.invalidateCollection('scope');assert.throws(()=>sessions.get(second.search_id),{code:'RESULT_EXPIRED'});assert.throws(()=>sessions.get(third.search_id),{code:'RESULT_EXPIRED'});
  const last=sessions.createLiteral({query:'x',collections:['scope']});await sleep();now=101;assert.throws(()=>sessions.get(last.search_id),{code:'RESULT_EXPIRED'});
 }finally{await sessions.close();}assert.equal(released,1);
});

test('restricted lexical leases have an independent queue while the model lane is occupied',async()=>{
 const lane=new HeavyLane(),release=await lane.acquire(new AbortController().signal,'background');
 let lexicalCalls=0,nativeCalls=0,lexicalReleased=0,closed=0;
 const readers={reserve:()=>({snapshot:{generation_id:'heavy'},release:()=>{}}),close:async()=>{closed++;}};
 const lexicalReaders={reserve:()=>({snapshot:{generation_id:'light'},release:()=>{lexicalReleased++;}}),close:async()=>{closed++;}};
 const source={validateCollections:()=>{},keyword:async(request,id,lease)=>{
  if(request.mode==='lexical'){lexicalCalls++;assert.equal(lease.snapshot.generation_id,'light');}
  else nativeCalls++;
  throw Object.assign(new Error(),{code:'INVALID_QUERY'});
 }};
 const sessions=new SearchSessions(source,readers,{lane,lexicalReaders});
 const request={query:'owner',purpose:'find',mode:'hybrid',rerank:false,collections:['scope']};
 try{
  const heavy=sessions.createKeyword(request);await sleep();assert.equal(lane.interactiveQueued,1);
  const light=sessions.createKeyword({...request,mode:'lexical'});await sleep();
  assert.equal(sessions.get(light.search_id).state,'failed');assert.equal(sessions.get(light.search_id).error.code,'INVALID_QUERY');
  assert.equal(lexicalCalls,1);assert.equal(lexicalReleased,1);assert.equal(nativeCalls,0);assert.equal(lane.busy,true);
  sessions.cancel(heavy.search_id);
 }finally{release();await sessions.close();}
 assert.equal(closed,2);
});

test('wake distinguishes interrupted native work from explicit cancellation and keeps literal requests available',async()=>{
 let finish,released=0,calls=0;
 const source={validateCollections:()=>{},keyword:async()=>{if(++calls===1)await new Promise((_,reject)=>finish=()=>reject(Object.assign(new Error(),{code:'WORKER_EXITED'})));throw Object.assign(new Error(),{code:'INVALID_QUERY'});},literal:async()=>{throw Object.assign(new Error(),{code:'INVALID_QUERY'});}};
 const readers={reserve:()=>({release:()=>released++}),close:async()=>{}};
 const sessions=new SearchSessions(source,readers),request={query:'owner',purpose:'find',mode:'hybrid',rerank:false,collections:['scope']};
 try{
  const running=sessions.createKeyword(request);await sleep();const queued=sessions.createKeyword(request),cancelled=sessions.createKeyword(request);sessions.cancel(cancelled.search_id);
  const recovery=sessions.interruptForWake();assert.equal(sessions.get(running.search_id).state,'running');assert.equal(sessions.get(queued.search_id).error.code,'SERVICE_UNAVAILABLE');assert.equal(sessions.get(cancelled.search_id).state,'cancelled');
  assert.throws(()=>sessions.createKeyword(request),{code:'SERVICE_UNAVAILABLE'});
  const literal=sessions.createLiteral({query:'owner',collections:['scope']});await sleep();assert.equal(sessions.get(literal.search_id).error.code,'INVALID_QUERY');
  finish();await recovery;assert.equal(sessions.get(running.search_id).state,'failed');assert.equal(sessions.get(running.search_id).error.code,'SERVICE_UNAVAILABLE');assert.equal(sessions.get(running.search_id).error.retryable,true);
  sessions.resumeAfterWake();const next=sessions.createKeyword(request);await sleep();assert.equal(sessions.get(next.search_id).error.code,'INVALID_QUERY');assert.equal(released,4);
 }finally{finish?.();await sessions.close();}
});
test('explicit cancellation during wake recovery retains user intent until the native operation finishes',async()=>{
 let finish;
 const source={validateCollections:()=>{},keyword:async()=>new Promise((_,reject)=>finish=()=>reject(Object.assign(new Error(),{code:'WORKER_EXITED'})))};
 const readers={reserve:()=>({release:()=>{}}),close:async()=>{}},sessions=new SearchSessions(source,readers);
 try{
  const search=sessions.createKeyword({query:'owner',purpose:'find',mode:'hybrid',rerank:false,collections:['scope']});await sleep();
  const recovery=sessions.interruptForWake();assert.equal(sessions.cancel(search.search_id).state,'cancel_requested');finish();await recovery;assert.equal(sessions.get(search.search_id).state,'cancelled');
 }finally{finish?.();await sessions.close();}
});
