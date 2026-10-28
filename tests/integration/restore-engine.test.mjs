import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {engineArtifact} from '../../packages/runtime/dist/index.js';
import {resolveRestoreEngine} from '../../apps/daemon/dist/restore-engine.js';

async function fixture(t){
  const workspace=await mkdtemp(join(tmpdir(),'dsearch-restore-engine-'));
  t.after(()=>rm(workspace,{recursive:true,force:true}));
  const root=join(workspace,'.local/qmd-audited'),commit='a'.repeat(40),patch='b'.repeat(64),previous='c'.repeat(64);
  await mkdir(join(root,'dist'),{recursive:true});await mkdir(join(workspace,'vendor'));
  await writeFile(join(root,'package.json'),'{}');await writeFile(join(root,'pnpm-lock.yaml'),'fixture: pinned');
  await writeFile(join(root,'dist/index.js'),'export const fixture=1;');
  const artifact=await engineArtifact(root);
  const manifest={upstream_commit:commit,patch_digest:patch,artifact_sha256:artifact.sha256};
  await writeFile(join(root,'dsearch-artifact.json'),JSON.stringify(manifest));
  const registry={repository:'https://example.invalid/pinned-engine',sourceVersion:'2.8.3',commit,engineArtifactSha256:'d'.repeat(64),patchSha256:patch,
    audited:{engineArtifactSha256:artifact.sha256,patchSha256:patch},restoreCompatibility:[{artifactSha256:previous,patchSha256:patch,use:'audited'}]};
  await writeFile(join(workspace,'vendor/qmd-upstream.json'),JSON.stringify(registry));
  const engine={repository:registry.repository,source_version:registry.sourceVersion,upstream_commit:commit,artifact_sha256:artifact.sha256,patch_digest:patch};
  return {workspace,root,registry,manifest,engine,previous};
}

test('a pinned retired build resolves only for restore and explicitly requires a fresh active generation',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await resolveRestoreEngine(f.workspace,f.engine),{root:f.root,requiresRebuild:false});
  const previous={...f.engine,artifact_sha256:f.previous},before=structuredClone(previous);
  assert.deepEqual(await resolveRestoreEngine(f.workspace,previous),{root:f.root,requiresRebuild:true});
  assert.deepEqual(previous,before);
});

test('restore compatibility refuses unknown identities, different code patches and caller-controlled variant paths',async t=>{
  const f=await fixture(t);
  for(const changed of [
    {artifact_sha256:'e'.repeat(64)},
    {artifact_sha256:f.previous,patch_digest:'f'.repeat(64)},
    {repository:'https://example.invalid/other'},
    {upstream_commit:'0'.repeat(40)},
    {source_version:'other'},
  ])await assert.rejects(resolveRestoreEngine(f.workspace,{...f.engine,...changed}),{code:'COMPATIBILITY_FAILED'});
  for(const alias of [
    {artifactSha256:f.previous,patchSha256:f.engine.patch_digest,use:'../../outside'},
    {artifactSha256:f.previous,patchSha256:'f'.repeat(64),use:'audited'},
  ]){
    await writeFile(join(f.workspace,'vendor/qmd-upstream.json'),JSON.stringify({...f.registry,restoreCompatibility:[alias]}));
    await assert.rejects(resolveRestoreEngine(f.workspace,{...f.engine,artifact_sha256:f.previous,patch_digest:alias.patchSha256}),{code:'COMPATIBILITY_FAILED'});
  }
});

test('a matching manifest marker cannot hide modified executable files or another upstream identity',async t=>{
  const f=await fixture(t),file=join(f.root,'dist/index.js'),original=await readFile(file);
  await writeFile(file,'export const fixture="modified";');
  await assert.rejects(resolveRestoreEngine(f.workspace,{...f.engine,artifact_sha256:f.previous}),{code:'COMPATIBILITY_FAILED'});
  await writeFile(file,original);
  await writeFile(join(f.root,'dsearch-artifact.json'),JSON.stringify({...f.manifest,upstream_commit:'0'.repeat(40)}));
  await assert.rejects(resolveRestoreEngine(f.workspace,f.engine),{code:'COMPATIBILITY_FAILED'});
});
