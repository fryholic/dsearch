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
test('related query heading ancestry respects code, YAML, Setext and ATX syntax',async()=>{
 const text='---\nexample: |\n  # YAML comment\n---\n\nActual topic\n============\n\n```sh\n# Install Python dependencies\n```\n\n#not-a-heading\n\n## Real section\n\nSelected ECDH definition.';
 const plan=await relatedQuery(text,{start:text.indexOf('Selected'),end:text.length});
 assert.ok(plan.query.includes('Actual topic'));assert.ok(plan.query.includes('Real section'));assert.ok(plan.query.includes('Selected ECDH'));
 assert.ok(!plan.query.includes('Python'));assert.ok(!plan.query.includes('YAML'));assert.ok(!plan.query.includes('not-a-heading'));
});
test('related query never spends its entire budget on heading context',async()=>{
 const text=Array.from({length:6},(_,i)=>'#'.repeat(i+1)+' '+String.fromCharCode(65+i).repeat(200)).join('\n\n')+'\n\nSelected ECDH definition.';
 const selected={start:text.indexOf('Selected'),end:text.length};
 for(const counter of [undefined,async q=>[...q].length]){const plan=await relatedQuery(text,selected,counter);assert.ok(plan.query.includes('Selected ECDH definition.'));assert.ok(plan.used_spans.some(l=>selectionRange(text,l).start===selected.start));}
 await assert.rejects(relatedQuery('# Heading\n\n   ',{start:11,end:14}),{code:'INVALID_QUERY'});
});
