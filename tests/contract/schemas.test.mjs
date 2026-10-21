import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SearchRequest,ReadRequest,MetadataFilter,ProfileManifest,ErrorEnvelope,successEnvelope} from '../../packages/contracts/dist/index.js';
const base={query:'서명 입력의 바이트열',purpose:'find',mode:'hybrid',rerank:true,collections:['tech']};
test('search boundary rejects unsupported fields, inconsistent modes and duplicate scopes',()=>{
 assert.equal(SearchRequest.parse(base).candidate_limit,40);
 for(const v of [{...base,path:'/etc/passwd'},{...base,mode:'lexical'},{...base,collections:['tech','tech']},{...base,query:'  '},{...base,candidate_limit:100}])assert.equal(SearchRequest.safeParse(v).success,false);
 assert.ok(SearchRequest.safeParse({...base,mode:'lexical',rerank:false}).success);
});
test('source reads require identity, revision and a bounded ordered locator',()=>{
 const ref={doc_id:'019a0aaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',revision_id:'a'.repeat(64),locator:{kind:'markdown',start:{line:1,column_utf16:0},end:{line:2,column_utf16:20}}};
 assert.ok(ReadRequest.safeParse(ref).success);
 for(const v of [{...ref,revision_id:'invalid revision'},{...ref,path:'/tmp/other'},{...ref,max_lines:201},{...ref,locator:{...ref.locator,end:{line:0,column_utf16:-1}}}])assert.equal(ReadRequest.safeParse(v).success,false);
});
test('metadata AST rejects depth and node attacks before recursive parsing',()=>{
 const leaf={field:'metadata.type',operator:'eq',value:'concept'};
 assert.deepEqual(MetadataFilter.parse({and:[leaf]}),{and:[leaf]});
 let deep=leaf;for(let i=0;i<10000;i++)deep={not:deep};
 assert.equal(MetadataFilter.safeParse(deep).success,false);
 for(const v of [{and:Array(65).fill(leaf)},{field:'raw_sql',operator:'eq',value:'x'},{...leaf,operator:'exists',value:'true'},{...leaf,value:'x'.repeat(1025)},{...leaf,operator:'in',value:Array(129).fill('x')}])assert.equal(MetadataFilter.safeParse(v).success,false);
});
test('client envelope rejects incompatible versions and unresolved model manifests',()=>{
 const schema=successEnvelope(SearchRequest);
 const packet={schema_version:1,request_id:'request-one',ok:true,data:base};
 assert.equal(schema.parse(JSON.parse(JSON.stringify(packet))).data.query,base.query);
 assert.equal(schema.safeParse({...packet,schema_version:2}).success,false);
 assert.ok(ErrorEnvelope.safeParse({schema_version:1,request_id:'request-one',ok:false,error:{code:'STALE_REVISION',message:'STALE_REVISION',retryable:false}}).success);
});
test('a complete profile requires resolved engine and model identities plus an embedding output dimension',()=>{
 const artifact={repository:'Qwen/Qwen3-Embedding-0.6B-GGUF',filename:'embedding.gguf',repository_revision:'a'.repeat(40),sha256:'b'.repeat(64),quantization:'Q8_0'};
 const profile={schema_version:2,profile_id:'candidate',engine:{repository:'https://github.com/tobi/qmd',source_version:'2.8.3',upstream_commit:'c'.repeat(40),patch_digest:'d'.repeat(64),artifact_sha256:'e'.repeat(64)},models:{embed:{...artifact,dimension:1024},rerank:{...artifact,filename:'rerank.gguf'},expansion:null},input_policy:{compiler_version:'r0-projection-v1',projection_utf16_cap:2400,embedding_input_token_cap:800,query_token_cap:512,rerank_context_tokens:4096,strict_no_truncation:true,cache_mode:'memory'},runtime:{node_exact:'24.21.0',node_llama_cpp:'3.20.0',platform:'darwin-arm64',heavy_concurrency:1,embed_parallelism:1,idle_worker_shutdown_seconds:300}};
 assert.deepEqual(ProfileManifest.parse(profile),profile);
 for(const v of [{...profile,engine:{...profile.engine,patch_digest:'UNRESOLVED'}},{...profile,models:{...profile.models,embed:artifact}},{...profile,models:{...profile.models,embed:{...profile.models.embed,sha256:'UNRESOLVED'}}}])assert.equal(ProfileManifest.safeParse(v).success,false);
});
