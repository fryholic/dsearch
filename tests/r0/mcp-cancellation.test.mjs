import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {LATEST_PROTOCOL_VERSION} from '@modelcontextprotocol/sdk/types.js';
import {createApplication} from '../../apps/daemon/dist/index.js';
const root=resolve(import.meta.dirname,'../..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const bounded=async(promise,label)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error(label+' timed out')),15000))]);}finally{clearTimeout(timer);}};
test('MCP wire cancellation and stdin EOF both wait for real native cancellation',async t=>{
 await mkdir(join(root,'.local/alpha'),{recursive:true});const folder=await mkdtemp(join(root,'.local/alpha/mcp-cancel-')),sources=join(folder,'source');await mkdir(sources);
 for(let i=0;i<12;i++)await writeFile(join(sources,i+'.md'),'# Key agreement '+i+'\n\nECDH derives a shared secret using a private scalar and a public point. ECDSA authenticates messages and the signing key.');
 const app=await createApplication({dataRoot:join(folder,'data')}),original=app.sessions.createKeyword.bind(app.sessions);let accepted,unsubscribe,phaseResolve;
 app.sessions.createKeyword=input=>{accepted=original(input);unsubscribe?.();unsubscribe=app.sessions.subscribe(accepted.search_id,status=>{if(status.state==='running'&&status.phase==='reranking')phaseResolve?.();});return accepted;};
 const terminal=async()=>{for(let i=0;i<1200;i++){const state=app.sessions.get(accepted.search_id);if(['cancelled','completed','failed'].includes(state.state))return state;await sleep(10);}throw new Error('native cancellation timed out');};
 try{const col=await app.catalog.addCollection({name:'MCP native cancellation',root:sources});await app.builder.start().completion;
  const query=suffix=>({query:'private-query-'+suffix,collection_ids:[col.collection_id],mode:'hybrid',rerank:true});
  await t.test('client AbortSignal emits MCP notification and becomes terminal in the daemon',async()=>{
   const client=new Client({name:'cancel-test',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[join(root,'apps/cli/dist/main.js'),'mcp','--data-root',app.root,'--no-start'],stderr:'pipe'}),controller=new AbortController();
   try{await client.connect(transport);const phase=new Promise(resolve=>phaseResolve=resolve);const operation=client.callTool({name:'search_documents',arguments:query('notification')},undefined,{signal:controller.signal});operation.catch(()=>{});
    await bounded(phase,'rerank notification');controller.abort();await assert.rejects(operation);assert.equal((await terminal()).state,'cancelled');assert.equal(app.status().execution.heavy_busy,false);
   }finally{controller.abort();await client.close();}
  });
  await t.test('ending stdin drains a native request before the CLI exits',async()=>{
   const child=spawn(process.execPath,[join(root,'apps/cli/dist/main.js'),'mcp','--data-root',app.root,'--no-start'],{stdio:['pipe','pipe','pipe']});let output='',readyResolve;const ready=new Promise(resolve=>readyResolve=resolve),exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});
   child.stdout.on('data',chunk=>{output+=chunk;for(;;){const end=output.indexOf('\n');if(end<0)break;const line=output.slice(0,end);output=output.slice(end+1);if(line.trim()){const packet=JSON.parse(line);if(packet.id===1&&packet.result)readyResolve();}}});child.stderr.resume();
   const send=packet=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...packet})+'\n');
   try{send({id:1,method:'initialize',params:{protocolVersion:LATEST_PROTOCOL_VERSION,capabilities:{},clientInfo:{name:'eof-test',version:'1'}}});await bounded(ready,'MCP initialize');send({method:'notifications/initialized'});
    const phase=new Promise(resolve=>phaseResolve=resolve);send({id:2,method:'tools/call',params:{name:'search_documents',arguments:query('stdin-eof')}});await bounded(phase,'EOF rerank');child.stdin.end();assert.equal(await bounded(exit,'MCP EOF exit'),0);assert.equal((await terminal()).state,'cancelled');assert.equal(app.status().execution.heavy_busy,false);
   }finally{if(child.exitCode===null){child.stdin.end();child.kill('SIGTERM');await bounded(exit,'child cleanup').catch(()=>child.kill('SIGKILL'));}}
  });
  for(const file of ['state.sqlite','state.sqlite-wal']){try{assert.equal((await readFile(join(app.root,file))).includes(Buffer.from('private-query-')),false);}catch(e){if(e.code!=='ENOENT')throw e;}}
 }finally{unsubscribe?.();app.sessions.createKeyword=original;await app.close();await rm(folder,{recursive:true,force:true});}
});
