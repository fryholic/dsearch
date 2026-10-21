import {test} from 'node:test';
import assert from 'node:assert/strict';
import {guardedSearchMutation,normalizedScope} from '../../apps/web/dist/search-state.js';
import {terminalText} from '../../apps/cli/dist/terminal.js';
test('human CLI output escapes C0/C1, ANSI and OSC without changing source/JSON or Korean text',()=>{
 const source='한글 😀\n\tOK\x1b[2J\x1b]8;;https://invalid\x07link\x1b]8;;\x07\r\x9b31m\x00';
 const shown=terminalText(source);assert.doesNotMatch(shown,/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);assert.ok(shown.startsWith('한글 😀\n\tOK'));assert.ok(shown.includes('\\u001b[2J'));assert.equal(JSON.parse(JSON.stringify(source)),source);
});
test('delayed cancel success and failure cannot replace a newer search, including reused IDs',async()=>{
 for(const reject of [false,true])for(const next of [{id:'B',generation:2},{id:'A',generation:2}]){
  let current={id:'A',generation:1},resolve,fail,applied=false,error=false;
  const pending=guardedSearchMutation({...current},()=>current,()=>new Promise((r,j)=>{resolve=r;fail=j;}),()=>applied=true,()=>error=true);
  current=next;if(reject)fail(new Error('late'));else resolve('old');await pending;assert.equal(applied,false);assert.equal(error,false);
 }
 let applied;await guardedSearchMutation({id:'A',generation:1},()=>({id:'A',generation:1}),async()=>42,v=>applied=v,()=>assert.fail());assert.equal(applied,42);
});
test('disabled or missing selected scopes reset to all enabled collections',()=>{
 const collections=[{collection_id:'A',enabled:false},{collection_id:'B',enabled:true}];assert.equal(normalizedScope('A',collections),'all');assert.equal(normalizedScope('missing',collections),'all');assert.equal(normalizedScope('B',collections),'B');assert.equal(normalizedScope('all',collections),'all');
});
