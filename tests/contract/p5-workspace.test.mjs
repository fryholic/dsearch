import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DsearchError} from '../../packages/contracts/dist/index.js';
import {loadModelInventory} from '../../apps/web/dist/features/workspace-state.js';
import {unavailableModel} from '../../apps/web/dist/features/availability.js';
test('model inventory repair does not block core workspace loading or retain a verified snapshot',async()=>{
 for(const failure of [new DsearchError('SCOPE_DENIED'),new DsearchError('SERVICE_UNAVAILABLE')]){
  assert.deepEqual(await loadModelInventory(async()=>{throw failure;}),{models:[],unavailable:true});
 }
 assert.deepEqual(await loadModelInventory(async()=>[{state:'verified'}]),{models:[],unavailable:true});
 assert.deepEqual(await loadModelInventory(async()=>[]),{models:[],unavailable:false});
 await assert.rejects(loadModelInventory(async()=>{throw new DsearchError('UNAUTHORIZED');}),{code:'UNAUTHORIZED'});
});
test('known missing models block semantic execution while lexical and explicit fallback remain available',()=>{
 const catalog={selected_profile_id:'qwen',profiles:[{profile_id:'qwen',manifest:{models:{embed:{dimension:1024}}}}]};
 assert.ok(unavailableModel('hybrid',false,false,[],catalog));
 assert.equal(unavailableModel('lexical',true,false,[],catalog),null);
 assert.equal(unavailableModel('literal',false,false,[],catalog),null);
 assert.equal(unavailableModel('hybrid',true,true,[],catalog),null);
 const models=[{role:'embed',state:'unverified'},{role:'rerank',state:'missing'}];
 assert.equal(unavailableModel('hybrid',false,false,models,catalog),null);
 assert.ok(unavailableModel('hybrid',true,false,models,catalog));
});
