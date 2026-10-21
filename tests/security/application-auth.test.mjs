import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,chmod,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalAuth} from '../../apps/daemon/dist/auth.js';
import {createApplication} from '../../apps/daemon/dist/index.js';
const artifact={repository:'test/model',filename:'model.gguf',repository_revision:'a'.repeat(40),sha256:'b'.repeat(64),quantization:'Q8_0'};
const profile={schema_version:2,profile_id:'test-profile',engine:{repository:'https://github.com/tobi/qmd',source_version:'2.8.3',upstream_commit:'c'.repeat(40),patch_digest:'d'.repeat(64),artifact_sha256:'e'.repeat(64)},models:{embed:{...artifact,dimension:1024},rerank:artifact,expansion:null},input_policy:{compiler_version:'test',projection_utf16_cap:2400,embedding_input_token_cap:800,query_token_cap:512,rerank_context_tokens:4096,strict_no_truncation:true,cache_mode:'memory'},runtime:{node_exact:'24.21.0',node_llama_cpp:'3.20.0',platform:'darwin-arm64',heavy_concurrency:1,embed_parallelism:1,idle_worker_shutdown_seconds:300}};
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'dsearch-auth-'));await chmod(root,0o700);t.after(()=>rm(root,{recursive:true,force:true}));return realpath(root);}
test('device auth is private and GUI credentials are single-use, expiring and scoped to same-origin CSRF',async t=>{
 const root=await fixture(t);let now=100;const auth=await LocalAuth.open(root,'abcdef00-0000-4000-8000-000000000000',()=>now),origin='http://127.0.0.1:1234';t.after(()=>auth.close());
 const code=()=>new URL(auth.issue(origin)).hash.slice(6);let first=code();now+=60000;assert.throws(()=>auth.exchange(first),{code:'UNAUTHORIZED'});
 first=code();const result=auth.exchange(first);assert.throws(()=>auth.exchange(first),{code:'UNAUTHORIZED'});const cookie=result.cookie.split(';')[0];
 const req=(method,headers={})=>({method,headers:{cookie,origin,...headers}});
 assert.equal(auth.authenticate(req('GET'),origin),'cookie');assert.throws(()=>auth.authenticate(req('POST'),origin),{code:'SCOPE_DENIED'});
 assert.equal(auth.authenticate(req('POST',{'x-dsearch-csrf':result.csrf_token}),origin),'cookie');assert.throws(()=>auth.authenticate(req('POST',{origin:'https://evil.test','x-dsearch-csrf':result.csrf_token}),origin),{code:'SCOPE_DENIED'});
 assert.throws(()=>auth.authenticate(req('GET',{authorization:'Bearer invalid'}),origin),{code:'UNAUTHORIZED'});
 const token=(await readFile(join(root,'credentials/device-token'),'utf8')).trim();assert.equal(auth.authenticate({method:'GET',headers:{authorization:'Bearer '+token}},origin),'bearer');
 now+=12*60*60*1000+1;assert.throws(()=>auth.authenticate(req('GET'),origin),{code:'UNAUTHORIZED'});
 await chmod(join(root,'credentials/device-token'),0o644);await assert.rejects(LocalAuth.open(root,'other'),{code:'SCOPE_DENIED'});
});
test('startup refuses linked/oversized UI assets and releases ownership after failure',async t=>{
 const root=await fixture(t),web=join(root,'web');await mkdir(web);for(const name of ['index.html','app.js','app.css'])await writeFile(join(web,name),'ok');
 await rm(join(web,'app.css'));await symlink(join(web,'app.js'),join(web,'app.css'));const data=join(root,'data');await assert.rejects(createApplication({dataRoot:data,webRoot:web,profile}),{code:'COMPATIBILITY_FAILED'});await assert.rejects(readFile(join(data,'daemon.lock')),{code:'ENOENT'});
 await rm(join(web,'app.css'));await writeFile(join(web,'app.css'),'ok');const app=await createApplication({dataRoot:data,webRoot:web,profile});try{assert.equal((await fetch(app.url+'/healthz')).status,200);assert.equal((await fetch(app.url+'/app.js')).headers.get('cache-control'),'no-store');await assert.rejects(createApplication({dataRoot:data,webRoot:web,profile}),{code:'BUSY'});}finally{await app.close();}
 await assert.rejects(createApplication({dataRoot:data,webRoot:web,profile,port:-1}),{code:'INVALID_REQUEST'});await assert.rejects(readFile(join(data,'daemon.lock')),{code:'ENOENT'});
});
