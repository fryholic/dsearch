import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sealFiles,verifySeal,atomicFile} from '../../packages/generations/dist/index.js';
import {GenerationManifest} from '../../packages/contracts/dist/index.js';
const header={schema_version:1,generation_id:'generation-one',profile_fp:'a'.repeat(64),source_seq:5,scopes:{},documents:1,passages:1,created_at:'2026-10-21T00:00:00.000Z'};
test('generation seals verify actual bytes and reject corruption, missing files and symlink substitution',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'dsearch-seal-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 await mkdir(join(folder,'projection'));await atomicFile(join(folder,'projection/passage.md'),'# Source\n\n한글 😀');
 const sealed=await sealFiles(folder,header,['projection/passage.md']);assert.equal((await verifySeal(folder,sealed.sha256)).passages,1);
 await writeFile(join(folder,'projection/passage.md'),'# Modified');await assert.rejects(verifySeal(folder,sealed.sha256),{code:'COMPATIBILITY_FAILED'});
 await atomicFile(join(folder,'projection/passage.md'),'# Source\n\n한글 😀');await verifySeal(folder,sealed.sha256);
 await rm(join(folder,'projection/passage.md'));await writeFile(join(folder,'other.md'),'# Source\n\n한글 😀');await symlink(join(folder,'other.md'),join(folder,'projection/passage.md'));await assert.rejects(verifySeal(folder,sealed.sha256),{code:'SCOPE_DENIED'});
 await rm(join(folder,'projection/passage.md'));await assert.rejects(verifySeal(folder,sealed.sha256),{code:'COMPATIBILITY_FAILED'});
 assert.equal((await readFile(join(folder,'manifest.json'),'utf8')).includes('Source'),false);
});
test('manifest boundary rejects duplicate file entries and traversal before activation',()=>{
 const file={path:'qmd.sqlite',bytes:12,sha256:'b'.repeat(64)};assert.ok(GenerationManifest.safeParse({...header,files:[file]}).success);
 for(const path of ['../outside','/absolute','projection/../source','a\\b','a//b'])assert.equal(GenerationManifest.safeParse({...header,files:[{...file,path}]}).success,false);
 assert.equal(GenerationManifest.safeParse({...header,files:[file,file]}).success,false);
});
