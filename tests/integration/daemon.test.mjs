import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDiagnosticServer} from '../../apps/daemon/dist/index.js';
import {EngineProcess} from '../../packages/runtime/dist/index.js';
test('authenticated status stays responsive while isolated worker cannot service events',async()=>{
 const worker=new EngineProcess(new URL('../fixtures/worker.mjs',import.meta.url),{cancelGraceMs:80});
 const service=await createDiagnosticServer(()=>({worker:worker.state}));
 const controller=new AbortController();const busy=worker.invoke({op:'stall'},{signal:controller.signal});
 try{
  const start=performance.now();const response=await fetch(service.url+'/v1/status',{headers:{authorization:'Bearer '+service.token}});
  assert.equal(response.status,200);assert.equal((await response.json()).data.worker,'running');assert.ok(performance.now()-start<300);
  assert.equal((await fetch(service.url+'/v1/status')).status,401);
  assert.equal((await fetch(service.url+'/v1/status',{headers:{authorization:'Bearer '+service.token,origin:'https://other.example'}})).status,403);
  controller.abort();await assert.rejects(busy,{code:'CANCELLED'});
 }finally{controller.abort();await worker.close();await service.close();}
});
