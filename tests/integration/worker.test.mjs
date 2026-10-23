import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EngineProcess} from '../../packages/runtime/dist/index.js';
const entry=new URL('../fixtures/worker.mjs',import.meta.url);
test('worker isolates a native-like event loop stall; forced cancellation waits for real exit',async()=>{
 const worker=new EngineProcess(entry,{cancelGraceMs:80});const controller=new AbortController();
 const result=worker.invoke({op:'stall'},{signal:controller.signal});
 const start=performance.now();await new Promise(r=>setTimeout(r,100));assert.ok(performance.now()-start<500);
 controller.abort();assert.equal(worker.state,'cancel_requested');
 await assert.rejects(result,{code:'CANCELLED'});assert.equal(worker.state,'stopped');
 assert.throws(()=>process.kill(worker.pid,0),{code:'ESRCH'});await worker.close();
});
test('cooperative cancellation preserves worker reuse, rejects concurrent native work and redacts streams',async()=>{
 const worker=new EngineProcess(entry);try{
  const controller=new AbortController();const pending=worker.invoke({op:'wait'},{signal:controller.signal});
  await assert.rejects(worker.invoke({op:'echo'}),{code:'BUSY'});controller.abort();await assert.rejects(pending,{code:'CANCELLED'});
  assert.equal(worker.state,'idle');assert.deepEqual(await worker.invoke({value:'ready'}),{value:'ready'});
  assert.ok(worker.diagnostics.discardedBytes>0);
 }finally{await worker.close();}assert.equal(worker.state,'stopped');
});
test('worker failures and already-aborted requests return typed errors',async()=>{
 const worker=new EngineProcess(entry);try{
  await assert.rejects(worker.invoke({op:'echo'},{signal:AbortSignal.abort()}),{code:'CANCELLED'});
  await assert.rejects(worker.invoke({op:'exit'}),{code:'WORKER_EXITED'});
 }finally{await worker.close();}
});


test('idle deadlines allow active work past the absolute timeout and still stop stalled work',async()=>{
 const worker=new EngineProcess(entry);try {
  await worker.invoke({op:'echo'});const events=[],start=performance.now();
  assert.equal(await worker.invoke({op:'progress'},{timeoutMs:100,timeoutMode:'idle',onProgress:e=>events.push(e.completed)}),'done');assert.ok(performance.now()-start>100);assert.equal(events.length,8);
  await assert.rejects(worker.invoke({op:'progress'},{timeoutMs:80}),{code:'WORKER_TIMEOUT'});assert.equal(worker.state,'idle');
  await assert.rejects(worker.invoke({op:'wait'},{timeoutMs:80,timeoutMode:'idle'}),{code:'WORKER_TIMEOUT'});assert.equal(worker.state,'idle');
  const controller=new AbortController();await assert.rejects(worker.invoke({op:'progress'},{timeoutMs:100,timeoutMode:'idle',signal:controller.signal,onProgress:()=>controller.abort()}),{code:'CANCELLED'});assert.equal(worker.state,'idle');
  assert.deepEqual(await worker.invoke({value:'reusable'}),{value:'reusable'});
 } finally {await worker.close();}
});

test('deadline of an unresponsive worker waits for exit and is distinct from user cancellation',async()=>{
 const worker=new EngineProcess(entry,{cancelGraceMs:60});try {
  await worker.invoke({op:'echo'});await assert.rejects(worker.invoke({op:'stall'},{timeoutMs:80,timeoutMode:'idle'}),{code:'WORKER_TIMEOUT'});assert.equal(worker.state,'stopped');assert.throws(()=>process.kill(worker.pid,0),{code:'ESRCH'});
 }finally{await worker.close();}
});
