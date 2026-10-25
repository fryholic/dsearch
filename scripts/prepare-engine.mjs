import {spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir,copyFile,access,symlink,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {engineArtifact,fileDigest} from '../packages/runtime/dist/index.js';
const root=resolve(import.meta.dirname,'..'),recovery=process.argv.includes('--recovery');const engine=join(root,recovery?'.local/qmd-recovery':'.local/qmd-upstream');
const registry=JSON.parse(await readFile(join(root,'vendor/qmd-upstream.json'),'utf8'));
const source=recovery?{...registry,...registry.recovery}:registry;
const patchPath=join(root,'vendor/qmd-patches',source.patchFile??'compat-v1.patch'),patch=await readFile(patchPath);
const hash=x=>createHash('sha256').update(x).digest('hex');
function run(cmd,args,cwd=root,options={}) {
 const r=spawnSync(cmd,args,{cwd,encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:32*1024*1024,...options});
 if(r.error||r.status!==0)throw new Error(cmd+' failed: '+(r.stderr||r.error?.message||r.status));
 return r.stdout;
}
if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('Supported platform is macOS Apple Silicon (darwin-arm64)');
await mkdir(join(root,'.local'),{recursive:true});
if(!await access(join(engine,'.git')).then(()=>true,()=>false)) {
 run('git',['clone','--filter=blob:none','--no-checkout',source.repository+'.git',engine]);
 run('git',['checkout','--detach',source.commit],engine);
}
if(run('git',['rev-parse','HEAD'],engine).trim()!==source.commit)throw new Error('Managed engine checkout is at another commit');
let diff=Buffer.from(run('git',['diff','HEAD','--','src'],engine));
if(diff.length===0)run('git',['apply',patchPath],engine);
else if(hash(diff)!==hash(patch))throw new Error('Managed source has changes other than the pinned patch');
// Include the added compatibility source in the patch identity without making an upstream commit.
run('git',['add','-N','src/dsearch-compat.ts'],engine);
diff=Buffer.from(run('git',['diff','HEAD','--','src'],engine));
if(hash(diff)!==hash(patch))throw new Error('Applied patch differs from the pinned patch');
const packageInfo=JSON.parse(await readFile(join(engine,'package.json'),'utf8'));
if(packageInfo.version!==source.sourceVersion)throw new Error('Upstream source version mismatch');
const changed=run('git',['diff','HEAD','--name-only'],engine).trim().split('\n').filter(Boolean);
if(changed.some(path=>!path.startsWith('src/')&&path!=='pnpm-lock.yaml'))throw new Error('Managed checkout has changes outside the pinned patch and lock');
await copyFile(join(root,'vendor/qmd-lock.yaml'),join(engine,'pnpm-lock.yaml'));
await writeFile(join(engine,'pnpm-workspace.yaml'),`packages: []\nallowBuilds:\n  better-sqlite3: true\n  node-llama-cpp: true\n  esbuild: true\n  tree-sitter-go: true\n  tree-sitter-python: true\n  tree-sitter-rust: true\n  tree-sitter-typescript: true\n`);
run('pnpm',['install','--frozen-lockfile','--ignore-scripts'],engine);
run('pnpm',['rebuild','better-sqlite3','node-llama-cpp','tree-sitter-go','tree-sitter-python','tree-sitter-rust','tree-sitter-typescript'],engine);
run(process.execPath,['scripts/build.mjs'],engine);
const artifact=await engineArtifact(engine);
const manifest={schema_version:1,upstream_commit:source.commit,patch_digest:hash(patch),artifact_sha256:artifact.sha256,
 lock_sha256:await fileDigest(join(root,'vendor/qmd-lock.yaml')),node_exact:process.versions.node,node_llama_cpp:'3.20.0',files:artifact.files};
await writeFile(join(engine,'dsearch-artifact.json'),JSON.stringify(manifest,null,2)+'\n');
const reference=join(root,'.local/qmd-reference');
if(!await access(join(reference,'package.json')).then(()=>true,()=>false)) {
 await mkdir(reference,{recursive:true});
 const archive=spawnSync('git',['archive',source.commit],{cwd:engine,maxBuffer:32*1024*1024});
 if(archive.status!==0)throw new Error('Cannot archive pinned reference');
 run('tar',['-xf','-','-C',reference],root,{input:archive.stdout});
 await writeFile(join(reference,'dsearch-reference.json'),JSON.stringify({upstream_commit:source.commit})+'\n');
}
// Verify the reference's compiler inputs against the pinned tree, not a self-declared marker.
const sourceFiles=run('git',['ls-tree','-r','--name-only',source.commit,'--','src','package.json','tsconfig.json','tsconfig.build.json','scripts/build.mjs'],engine).trim().split('\n');
for(const path of sourceFiles){
 const expected=run('git',['show',source.commit+':'+path],engine,{encoding:null});
 if(hash(expected)!==hash(await readFile(join(reference,path))))throw new Error('Reference source differs from pinned upstream: '+path);
}
const referenceIdentity=JSON.parse(await readFile(join(reference,'dsearch-reference.json'),'utf8'));
if(referenceIdentity.upstream_commit!==source.commit)throw new Error('Reference source identity mismatch');
if(!await access(join(reference,'node_modules')).then(()=>true,()=>false))await symlink(join(engine,'node_modules'),join(reference,'node_modules'),'dir');
if(await realpath(join(reference,'node_modules'))!==await realpath(join(engine,'node_modules')))throw new Error('Reference dependencies differ');
await copyFile(join(root,'vendor/qmd-lock.yaml'),join(reference,'pnpm-lock.yaml'));
run(process.execPath,['scripts/build.mjs'],reference);
const referenceArtifact=await engineArtifact(reference);
await writeFile(join(reference,'dsearch-artifact.json'),JSON.stringify({upstream_commit:source.commit,artifact_sha256:referenceArtifact.sha256,files:referenceArtifact.files},null,2)+'\n');
console.log(JSON.stringify({engine:source.commit,patch_digest:manifest.patch_digest,artifact_sha256:manifest.artifact_sha256,reference:'unpatched',status:'prepared'},null,2));

if(!recovery)process.stdout.write(run(process.execPath,[import.meta.filename,"--recovery"]));
