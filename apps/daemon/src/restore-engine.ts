import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DsearchError,type ProfileManifest} from '@dsearch/contracts';
import {loadEngineArtifact} from '@dsearch/runtime';

type Pin={engineArtifactSha256:string;patchSha256:string};
type Variant='base'|'recovery'|'audited';
type Registry=Pin&{
  repository:string;sourceVersion:string;commit:string;recovery?:Pin;audited?:Pin;
  restoreCompatibility?:{artifactSha256:string;patchSha256:string;use:Variant}[];
};
/** Retired artifacts may be audited during restore, but never become active search profiles. */
export async function resolveRestoreEngine(workspace:string,engine:ProfileManifest['engine']):Promise<{root:string;requiresRebuild:boolean}>{
  try{
    const registry=JSON.parse(await readFile(join(workspace,'vendor/qmd-upstream.json'),'utf8')) as Registry;
    if(engine.repository!==registry.repository||engine.source_version!==registry.sourceVersion||engine.upstream_commit!==registry.commit)throw new DsearchError('COMPATIBILITY_FAILED');
    const variants:{variant:Variant;folder:string;pin:Pin|undefined}[]=[
      {variant:'audited',folder:'qmd-audited',pin:registry.audited},
      {variant:'recovery',folder:'qmd-recovery',pin:registry.recovery},
      {variant:'base',folder:'qmd-upstream',pin:registry},
    ];
    const exact=variants.find(v=>v.pin?.engineArtifactSha256===engine.artifact_sha256&&v.pin.patchSha256===engine.patch_digest);
    const previous=registry.restoreCompatibility?.find(v=>v.artifactSha256===engine.artifact_sha256&&v.patchSha256===engine.patch_digest);
    const target=exact??(previous?variants.find(v=>v.variant===previous.use&&v.pin?.patchSha256===previous.patchSha256):undefined);
    if(!target?.pin)throw new DsearchError('COMPATIBILITY_FAILED');
    const root=join(workspace,'.local',target.folder),manifestFile=join(root,'dsearch-artifact.json');
    const manifest=JSON.parse(await readFile(manifestFile,'utf8'));
    if(manifest.upstream_commit!==registry.commit||manifest.artifact_sha256!==target.pin.engineArtifactSha256||manifest.patch_digest!==target.pin.patchSha256)throw new DsearchError('COMPATIBILITY_FAILED');
    await loadEngineArtifact(root,manifestFile);
    return {root,requiresRebuild:!exact};
  }catch(error){
    if(error instanceof DsearchError)throw error;
    throw new DsearchError('COMPATIBILITY_FAILED');
  }
}
