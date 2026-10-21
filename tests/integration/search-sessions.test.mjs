import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SearchSessions} from '../../packages/search/dist/index.js';
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
