import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,stat} from 'node:fs/promises';
import {join,resolve,dirname,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {ProfileManifest} from '../packages/contracts/dist/index.js';
import {fileDigest,verifyModel,loadEngineArtifact} from '../packages/runtime/dist/index.js';
import {r0Fingerprint} from './lib/r0-fingerprint.mjs';
const root=resolve(import.meta.dirname,'..'),engine=join(root,'.local/qmd-upstream');
const json=async path=>JSON.parse(await readFile(join(root,path),'utf8'));
const upstream=await json('vendor/qmd-upstream.json'),registry=await json('vendor/models/registry.json');
await loadEngineArtifact(engine,join(engine,'dsearch-artifact.json'));
const artifact=await json('.local/qmd-upstream/dsearch-artifact.json');
assert.equal(artifact.upstream_commit,upstream.commit);
assert.equal(artifact.patch_digest,await fileDigest(join(root,'vendor/qmd-patches/compat-v1.patch')));
assert.equal(artifact.lock_sha256,await fileDigest(join(root,'vendor/qmd-lock.yaml')));
const require=createRequire(join(engine,'package.json')),llamaEntry=require.resolve('node-llama-cpp');
const llama=await import(pathToFileURL(llamaEntry).href);
assert.equal(await llama.getModuleVersion(),'3.20.0');
const formatting=await import(pathToFileURL(join(engine,'dist/llm.js')).href);
const metadata=[];
for(const model of registry.models){
 const file=join(root,'.local/models',model.filename);await verifyModel(file,model);
 const info=await llama.readGgufFileInfo(file),m=info.metadata,architecture=m.general.architecture;
 assert.equal(info.version,3);assert.equal(m.general.file_type,7);
 const fields=m[architecture],tokenizer=m.tokenizer.ggml;
 const templates=Object.fromEntries(Object.entries(m.tokenizer).filter(([key])=>key.startsWith('chat_template')).map(([key,value])=>[key,{sha256:createHash('sha256').update(JSON.stringify(value)).digest('hex'),utf16:JSON.stringify(value).length}]));
 metadata.push({...model,gguf_version:info.version,quantization:'Q8_0',architecture,license:m.general.license,
  context_length:fields.context_length,embedding_length:fields.embedding_length,pooling_type:fields.pooling_type,
  classifier_labels:fields.classifier?.output_labels??null,
  tokenizer:{model:tokenizer.model,pre:tokenizer.pre,vocabulary_size:tokenizer.tokens.length,
   bos:tokenizer.bos_token_id??null,eos:tokenizer.eos_token_id??null,add_bos:tokenizer.add_bos_token??null,add_eos:tokenizer.add_eos_token??null,templates},
  embedding_input:model.role==='rerank'?null:{query:formatting.formatQueryForEmbedding('same bytes before signing',model.filename),document:formatting.formatDocForEmbedding('동일 바이트열을 사용한다.','합성 표본',model.filename)},
  output:model.role==='rerank'?'one relevance score per query/document pair':{dimension:fields.embedding_length,norm:'finite nonzero; unit norm is not assumed'}});
}
assert.equal(metadata.find(m=>m.role==='embed').embedding_length,1024);
assert.equal(metadata.find(m=>m.role==='reference').embedding_length,768);
assert.deepEqual(metadata.find(m=>m.role==='rerank').classifier_labels,['yes','no']);
const pick=role=>{const m=registry.models.find(m=>m.role===role);return {repository:m.repository,filename:m.filename,repository_revision:m.revision,sha256:m.sha256,quantization:'Q8_0'};};
const profiles=['embed','reference'].map(role=>ProfileManifest.parse({schema_version:2,profile_id:role==='embed'?'qwen-r0-candidate-v1':'qmd-reference-r0-v1',
 engine:{repository:upstream.repository,source_version:upstream.sourceVersion,upstream_commit:upstream.commit,patch_digest:artifact.patch_digest,artifact_sha256:artifact.artifact_sha256},
 models:{embed:{...pick(role),dimension:metadata.find(m=>m.role===role).embedding_length},rerank:pick('rerank'),expansion:null},
 input_policy:{compiler_version:'r0-projection-v1',projection_utf16_cap:2400,embedding_input_token_cap:800,query_token_cap:512,rerank_context_tokens:4096,strict_no_truncation:true,cache_mode:'memory'},
 runtime:{node_exact:process.versions.node,node_llama_cpp:'3.20.0',platform:'darwin-arm64',heavy_concurrency:1,embed_parallelism:1,idle_worker_shutdown_seconds:300}}));
const llamaRequire=createRequire(llamaEntry),nativeRoot=dirname(dirname(llamaRequire.resolve('@node-llama-cpp/mac-arm64-metal')));
const nativeFiles=[];
async function visit(folder){for(const entry of await readdir(folder,{withFileTypes:true})){const file=join(folder,entry.name);if(entry.isDirectory())await visit(file);else if(/\.(node|dylib|metallib)$/.test(file))nativeFiles.push({file:relative(nativeRoot,file),bytes:(await stat(file)).size,sha256:await fileDigest(file)});}}
await visit(nativeRoot);assert.ok(nativeFiles.some(f=>f.file.endsWith('.node')));
const observe=(cmd,args)=>execFileSync(cmd,args,{encoding:'utf8',maxBuffer:1024*1024}).trim();
const report={schema_version:1,input_fingerprint:await r0Fingerprint(),runtime:{node_exact:process.versions.node,node_llama_cpp:await llama.getModuleVersion(),platform:process.platform,arch:process.arch},models:metadata,profiles,
 native_files:nativeFiles,ranking_template_bridge:{runtime:'3.20.0',method:'LlamaRankingContext._getEvaluationInput',private_pinned_bridge:true,source_sha256:await fileDigest(join(dirname(llamaEntry),'evaluator/LlamaRankingContext.js'))},
 environment:{machine:observe('sysctl',['-n','hw.model']),cpu:observe('sysctl',['-n','machdep.cpu.brand_string']),physical_memory_bytes:Number(observe('sysctl',['-n','hw.memsize'])),os:observe('sw_vers',['-productVersion']),os_build:observe('sw_vers',['-buildVersion']),memory_pressure:observe('memory_pressure',['-Q']),swap:observe('sysctl',['-n','vm.swapusage']),vm_stat:observe('vm_stat',[])}};
await mkdir(join(root,'artifacts/r0'),{recursive:true});await writeFile(join(root,'artifacts/r0/model-metadata.json'),JSON.stringify(report,null,2)+'\n');
for(const profile of profiles)await writeFile(join(root,'artifacts/r0',profile.profile_id+'.json'),JSON.stringify(profile,null,2)+'\n');
console.log('Verified three GGUF headers and checksums; wrote two resolved R0 candidate profile manifests.');
