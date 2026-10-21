import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HeavyLane} from '../../packages/runtime/dist/index.js';
import {relatedQuery,selectionRange} from '../../packages/search/dist/query-builder.js';
test('shared native lane admits one build/search, cancels queued work and releases after failure',async()=>{
 const lane=new HeavyLane(),a=new AbortController(),b=new AbortController(),order=[];let release;
 const first=lane.run(a.signal,async()=>{order.push('build');await new Promise(r=>release=r);throw new Error('build-failed');});await new Promise(r=>setImmediate(r));
 const cancelled=lane.run(b.signal,async()=>assert.fail('cancelled operation ran'));b.abort();await assert.rejects(cancelled,{code:'CANCELLED'});
 const next=lane.run(a.signal,async()=>{order.push('search');assert.equal(lane.busy,true);});assert.equal(lane.queued,1);release();await assert.rejects(first,/build-failed/);await next;assert.deepEqual(order,['build','search']);assert.equal(lane.busy,false);
});
test('related query fits real-tokenizer callback and reports exact used/omitted source spans',async()=>{
 const text='# 제목\n\n## 정의\n\n첫 정의와 비밀값. 😀\n\n'+('수식 $Q=dG$와 `key_id`의 조건.\n'.repeat(900));const selected={start:text.indexOf('첫 정의'),end:text.length};
 let calls=0;const plan=await relatedQuery(text,selected,async q=>{calls++;return [...q].length;});assert.ok(calls>1);assert.ok([...plan.query].length<=512);assert.ok(plan.query.includes('첫 정의'));assert.ok(plan.used_spans.length);assert.ok(plan.omitted_spans.length);
 for(const locator of [...plan.used_spans,...plan.omitted_spans]){const span=selectionRange(text,locator);assert.ok(span.start>=0&&span.end<=text.length);}
 assert.throws(()=>selectionRange(text,{start:{line:9999,column_utf16:0},end:{line:9999,column_utf16:0}}),{code:'INVALID_LOCATOR'});
});
