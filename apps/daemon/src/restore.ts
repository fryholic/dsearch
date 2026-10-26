import {DatabaseSync} from 'node:sqlite';
import {readFile,lstat,realpath,mkdir,readdir,rm,rename,open} from 'node:fs/promises';
import {join,dirname,basename,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {StateStore,Catalog,canonicalJSON,digest,within} from '@dsearch/catalog';
import {DsearchError,ProfileManifest} from '@dsearch/contracts';
import {readBackup,atomicFile,verifySeal,sealFiles,BackupStore,createAlphaProfile,privateDirectory,durableFile,copyBackupFiles} from '@dsearch/generations';
import {fileDigest,verifyModel} from '@dsearch/runtime';
import {QmdWorker,type OpenEngine,type EngineResponse} from '@dsearch/engine-qmd';
import {privateRoot,takeOwnership,takeRestoreOwnership,restoreJournalPath,restoreLockPath} from './owner.js';
import {PreferenceStore} from './management.js';

type RestoreOptions={backupPath:string;targetRoot:string;apply?:boolean;planId?:string;fault?:(phase:string)=>void|Promise<void>};
export type RestoreReport={plan_id:string;backup_id:string;backup_sha256:string;backup_path:string;target_root:string;target_exists:boolean;current_history:{decisions:number;write_operations:number}|null;source_changes:number;scope_incomplete:boolean;rebuild_required:boolean;models_ready:boolean;applied:boolean;previous_archive:string|null;previous_backup:string|null};
type Journal={schema_version:1;operation_id:string;target:string;stage:string;previous:string;phase:"preparing"|"prepared";owner_instance:string;state_sha256:string|null;report:RestoreReport|null};
const exists=async(path:string)=>lstat(path).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;return undefined;});
const paths=(target:string,id:string)=>({stage:join(dirname(target),'.dsearch-restore-'+id),previous:join(dirname(target),'.dsearch-before-restore-'+id)});
async function syncParent(path:string){await durableFile(dirname(path));}
async function clearOwnDaemonLock(folder:string,instance?:string){const file=join(folder,'daemon.lock'),info=await exists(file);if(!info)return;if(!info.isFile()||info.isSymbolicLink()||info.size>4096)throw new DsearchError('SCOPE_DENIED');const owner=JSON.parse(await readFile(file,'utf8'));if(instance===undefined||owner.instance_id===instance){await rm(file);await durableFile(folder);}}
/** Called with the sibling restore lock held. Recover from observed paths, never just a phase string. */
async function reconcileJournal(target:string):Promise<void>{
 const file=restoreJournalPath(target),info=await exists(file);if(!info)return;if(!info.isFile()||info.isSymbolicLink()||info.size>32768)throw new DsearchError('COMPATIBILITY_FAILED');
 const journal=JSON.parse(await readFile(file,'utf8')) as Journal,id=journal.operation_id,expected=paths(target,id);if(journal.schema_version!==1||!/^([a-f0-9-]{36})$/.test(id)||journal.target!==target||journal.stage!==expected.stage||journal.previous!==expected.previous)throw new DsearchError('COMPATIBILITY_FAILED');
 if(journal.phase==='preparing'){if(await exists(journal.previous))throw new DsearchError('COMPATIBILITY_FAILED');if(await exists(journal.stage))await rm(journal.stage,{recursive:true});if(await exists(target))await clearOwnDaemonLock(target,journal.owner_instance);await rm(file);await syncParent(target);return;}
 if(journal.phase!=='prepared'||!journal.report||typeof journal.state_sha256!=='string')throw new DsearchError('COMPATIBILITY_FAILED');
 const installed=await exists(target),previous=await exists(journal.previous),stage=await exists(journal.stage);
 for(const entry of [installed,previous,stage])if(entry&&(!entry.isDirectory()||entry.isSymbolicLink()))throw new DsearchError('SCOPE_DENIED');
 if(installed&&await fileDigest(join(target,'state.sqlite')).then(hash=>hash===journal.state_sha256,()=>false)){
  if(stage)await rm(journal.stage,{recursive:true});if(previous)await clearOwnDaemonLock(journal.previous);await atomicFile(join(target,'.last-restore.json'),canonicalJSON({...journal.report,applied:true,previous_archive:previous?journal.previous:null})+'\n');
 }else if(previous){
  if(installed)await rename(target,join(dirname(target),'.dsearch-failed-restore-'+id));await rename(journal.previous,target);await clearOwnDaemonLock(target);if(stage)await rm(journal.stage,{recursive:true});
 }else if(installed&&stage&&!previous){await rm(journal.stage,{recursive:true});await clearOwnDaemonLock(target,journal.owner_instance);}
 else if(!installed){if(stage)await rm(journal.stage,{recursive:true});}
 else throw new DsearchError('COMPATIBILITY_FAILED');
 await rm(file);await syncParent(target);
}
/** Run before privateRoot can create a directory where an interrupted swap was in progress. */
export async function reconcileRestore(dataRoot:string):Promise<void>{
 const requested=resolve(dataRoot),parent=await realpath(dirname(requested)).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;return dirname(requested);}),target=join(parent,basename(requested));if(!await exists(restoreLockPath(target))&&!await exists(restoreJournalPath(target)))return;
 const done=await takeRestoreOwnership(target,randomUUID());try{await reconcileJournal(target);}finally{await done();}
}
async function targetState(target:string):Promise<{exists:boolean;fingerprint:string;history:RestoreReport['current_history']}>{
 const info=await exists(target);if(!info)return {exists:false,fingerprint:'absent',history:null};if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)||await realpath(target)!==target)throw new DsearchError('SCOPE_DENIED');
 const files=(await readdir(target)).filter(name=>!['daemon.lock','daemon.lock.sqlite','daemon.lock.sqlite-journal'].includes(name));if(!files.length)return {exists:true,fingerprint:'empty',history:null};const statePath=join(target,'state.sqlite');if(!await exists(statePath))throw new DsearchError('SCOPE_DENIED');const stateInfo=await lstat(statePath);if(!stateInfo.isFile()||stateInfo.isSymbolicLink())throw new DsearchError('SCOPE_DENIED');
 let history:RestoreReport['current_history']=null;
 try{const db=new DatabaseSync(statePath,{readOnly:true});try{
  db.exec('BEGIN');history={decisions:Number(db.prepare('SELECT count(*) AS n FROM decisions').get()!.n),write_operations:Number(db.prepare('SELECT count(*) AS n FROM write_operations').get()!.n)};
  const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(),snapshot=tables.map(table=>({name:table.name,sql:table.sql,rows:db.prepare('SELECT * FROM "'+String(table.name).replaceAll('"','""')+'" ORDER BY rowid').all()}));
  return {exists:true,fingerprint:digest(canonicalJSON({schema:Number(db.prepare('PRAGMA user_version').get()!.user_version),snapshot})),history};
 }finally{try{db.exec('ROLLBACK');}finally{db.close();}}}catch{/* Preserve an unreadable current state as a raw archive. */}
 const hashes=[await fileDigest(statePath)],wal=await exists(statePath+'-wal');if(wal?.size)hashes.push(await fileDigest(statePath+'-wal'));
 return {exists:true,fingerprint:digest(canonicalJSON(hashes)),history};
}
function rebaseEngine(engine:OpenEngine,original:string,destination:string,id:string):OpenEngine{
 const old=join(original,'generations',id),root=join(destination,'generations',id);if(engine.dbPath!==join(old,'qmd.sqlite')||engine.collectionPath!==join(old,'projection')||engine.generationId!==id||!engine.collections||!engine.strict)throw new DsearchError('COMPATIBILITY_FAILED');
 const collections:NonNullable<OpenEngine['collections']>={};for(const [name,collection] of Object.entries(engine.collections)){if(!/^[sl]_[a-f0-9]{32}$/.test(name)||collection.path!==join(old,'projection',name)||collection.pattern!=='**/*.md')throw new DsearchError('COMPATIBILITY_FAILED');collections[name]={path:join(root,'projection',name),pattern:'**/*.md'};}
 return {...engine,dbPath:join(root,'qmd.sqlite'),collectionPath:join(root,'projection'),collections};
}
const workspace=fileURLToPath(new URL('../../../',import.meta.url));
async function trustedEngine(artifactSha:string,patchSha:string):Promise<string>{
 for(const path of [join(workspace,'.local/qmd-audited'),join(workspace,'.local/qmd-recovery'),join(workspace,'.local/qmd-upstream')]){try{const artifact=JSON.parse(await readFile(join(path,'dsearch-artifact.json'),'utf8'));if(artifact.artifact_sha256===artifactSha&&artifact.patch_digest===patchSha)return path;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 throw new DsearchError('COMPATIBILITY_FAILED');
}
async function prepareStage(backupPath:string,stage:string,target:string,fault?:RestoreOptions['fault']):Promise<{backup_id:string;backup_sha256:string;source_changes:number;scope_incomplete:boolean;rebuild_required:boolean;models_ready:boolean;source_fingerprint:string}>{
 const {manifest,sha256}=await readBackup(backupPath),backupRoot=await realpath(backupPath);await privateDirectory(stage);
 await copyBackupFiles(backupRoot,manifest.files,stage,undefined,()=>fault?.('restore-copy-batch'));
 const sourceDb=new DatabaseSync(join(stage,'state.sqlite'),{readOnly:true});try{if(Number(sourceDb.prepare('PRAGMA user_version').get()!.user_version)!==manifest.state_schema||sourceDb.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok'||sourceDb.prepare('PRAGMA foreign_key_check').all().length)throw new DsearchError('COMPATIBILITY_FAILED');const rows=sourceDb.prepare('SELECT generation_id,state,manifest_sha256 FROM generations ORDER BY generation_id').all();if(canonicalJSON(rows)!==canonicalJSON([...manifest.generations].sort((a,b)=>a.generation_id.localeCompare(b.generation_id))))throw new DsearchError('COMPATIBILITY_FAILED');}finally{sourceDb.close();}
 const state=await StateStore.open(stage),catalog=new Catalog(state,target);let source_changes=0,scope_incomplete=false,rebuild_required=false,models_ready=true,runtimeMismatch=false,source_fingerprint="";
 try{
  await new PreferenceStore(stage).load();
  for(const row of state.db.prepare('SELECT * FROM generations').all()){
   const id=String(row.generation_id),root=join(stage,'generations',id);if(row.directory_path!==join(manifest.source_data_root,'generations',id))throw new DsearchError('COMPATIBILITY_FAILED');
   state.db.prepare('UPDATE generations SET directory_path=? WHERE generation_id=?').run(join(target,'generations',id),id);
   if(['active','ready','retired'].includes(String(row.state))){
    const sealed=await verifySeal(root,String(row.manifest_sha256)),profile=ProfileManifest.parse(JSON.parse(await readFile(join(root,'profile.json'),'utf8')));if(digest(canonicalJSON(profile))!==row.profile_fp||sealed.profile_fp!==row.profile_fp)throw new DsearchError('COMPATIBILITY_FAILED');
    const engine=JSON.parse(await readFile(join(root,'engine-config.json'),'utf8')) as OpenEngine,rebased=rebaseEngine(engine,manifest.source_data_root,target,id),worker=new QmdWorker();
    rebased.engineRoot=await trustedEngine(profile.engine.artifact_sha256,profile.engine.patch_digest);if(row.state==='active'&&(rebased.engineRoot!==join(workspace,'.local/qmd-audited')||rebased.modelRoot!==join(workspace,'.local/models')))runtimeMismatch=true;
    const registry=JSON.parse(await readFile(new URL('../../../vendor/models/registry.json',import.meta.url),'utf8')) as {models:{role:string;sha256:string;filename:string;bytes:number}[]};if(!registry.models.some(m=>m.sha256===profile.models.embed.sha256)||!registry.models.some(m=>m.role==='rerank'&&m.sha256===profile.models.rerank.sha256))throw new DsearchError('COMPATIBILITY_FAILED');
    for(const hash of [profile.models.embed.sha256,profile.models.rerank.sha256]){const model=registry.models.find(m=>m.sha256===hash)!;try{await verifyModel(join(engine.modelRoot,model.filename),model);}catch(error){if(error instanceof DsearchError&&['MODEL_NOT_INSTALLED','MODEL_UNAVAILABLE'].includes(error.code))models_ready=false;else throw error;}}
    try{await worker.open({...rebased,dbPath:join(root,'qmd.sqlite'),collectionPath:join(root,'projection'),role:'maintenance'});const audit=(await worker.invoke<EngineResponse<{documents:{collection:string;path:string;vector_chunks:number}[];cache:{rows:number};integrity:{quick_check:string}}>>('index_audit')).result,mappings=JSON.parse(await readFile(join(root,'mappings.json'),'utf8')) as {engine_collection:string;engine_relative_path:string;kind:string}[];if(audit.integrity.quick_check!=='ok'||audit.cache.rows||audit.documents.length!==mappings.length||audit.documents.some(d=>{const p=mappings.find(p=>p.engine_collection===d.collection&&p.engine_relative_path===d.path);return !p||d.vector_chunks!==(p.kind==='semantic'?1:0);} ))throw new DsearchError('COMPATIBILITY_FAILED');}finally{await worker.close();}
    await atomicFile(join(root,'engine-config.json'),canonicalJSON(rebased)+'\n');const {files,...header}=sealed,revalidated=await sealFiles(root,header,files.map(f=>f.path));state.db.prepare('UPDATE generations SET manifest_sha256=? WHERE generation_id=?').run(revalidated.sha256,id);
   }
   const latest=state.db.prepare('SELECT job_id,state,cursor_json FROM jobs WHERE generation_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1').get(id);
   if(latest&&['failed','obsolete','cancelled'].includes(String(latest.state))){const cursor=JSON.parse(String(latest.cursor_json));if(cursor.checkpoint){
    if(!/^\.checkpoints\/[a-f0-9-]+\.json$/.test(cursor.checkpoint))throw new DsearchError('COMPATIBILITY_FAILED');const cpFile=join(root,cursor.checkpoint);if(await fileDigest(cpFile)!==cursor.sha256)throw new DsearchError('COMPATIBILITY_FAILED');const cp=JSON.parse(await readFile(cpFile,'utf8')),plan=JSON.parse(await readFile(join(root,'build-plan.json'),'utf8'));plan.engine=rebaseEngine(plan.engine,manifest.source_data_root,target,id);const archivedProfile=ProfileManifest.parse(JSON.parse(String(state.db.prepare('SELECT manifest_json FROM profiles WHERE profile_id=?').get(String(row.profile_id))!.manifest_json)));plan.engine.engineRoot=await trustedEngine(archivedProfile.engine.artifact_sha256,archivedProfile.engine.patch_digest);await atomicFile(join(root,'build-plan.json'),canonicalJSON(plan)+'\n');const planFile=cp.files.find((f:{path:string})=>f.path==='build-plan.json');if(!planFile)throw new DsearchError('COMPATIBILITY_FAILED');planFile.sha256=await fileDigest(join(root,'build-plan.json'));planFile.bytes=(await lstat(join(root,'build-plan.json'))).size;await atomicFile(cpFile,canonicalJSON(cp)+'\n');cursor.sha256=await fileDigest(cpFile);state.db.prepare('UPDATE jobs SET cursor_json=? WHERE job_id=?').run(canonicalJSON(cursor),latest.job_id as string);
   }}
  }
  const before=state.db.prepare('SELECT doc_id,present,latest_revision_id FROM source_documents ORDER BY doc_id').all(),sequence=state.sourceSeq;
  for(const collection of catalog.listCollections().filter(c=>c.enabled)){try{const report=await catalog.reconcile(collection.collection_id);scope_incomplete ||=report.scope_incomplete;}catch(error){if(error instanceof DsearchError&&['SCOPE_DENIED','SCOPE_INCOMPLETE','COMPATIBILITY_FAILED'].includes(error.code))scope_incomplete=true;else throw error;}}
  const prior=new Map(before.map(row=>[String(row.doc_id),canonicalJSON([row.present,row.latest_revision_id])])),after=state.db.prepare('SELECT doc_id,present,latest_revision_id FROM source_documents').all();source_changes=after.filter(row=>prior.get(String(row.doc_id))!==canonicalJSON([row.present,row.latest_revision_id])).length;const sourceChanged=scope_incomplete||sequence!==state.sourceSeq,active=state.db.prepare('SELECT g.source_seq FROM active_slot a JOIN generations g USING(generation_id) WHERE a.slot=1').get();const knownProfiles=await Promise.all([createAlphaProfile(join(workspace,'.local/qmd-audited')),createAlphaProfile(join(workspace,'.local/qmd-audited'),'reference')]),activeProfile=state.db.prepare('SELECT g.profile_fp FROM active_slot a JOIN generations g USING(generation_id) WHERE a.slot=1').get();runtimeMismatch ||=!!activeProfile&&!knownProfiles.some(p=>p.fingerprint===activeProfile.profile_fp);rebuild_required=sourceChanged||runtimeMismatch||!active||Number(active.source_seq)!==state.sourceSeq;
  if(sourceChanged||runtimeMismatch)state.transaction(()=>{state.db.prepare("UPDATE generations SET state='retired' WHERE state='active'").run();/* Keep the unavailable pointer's epoch so a later publish cannot reuse old CAS values. */});
  source_fingerprint=digest(canonicalJSON(state.db.prepare('SELECT d.collection_id,d.relative_path,d.present,r.raw_sha256,c.scope_fp,c.enabled FROM source_documents d LEFT JOIN source_revisions r ON r.revision_id=d.latest_revision_id JOIN collections c USING(collection_id) ORDER BY d.collection_id,d.relative_path,d.present').all()));
  state.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
 }finally{state.close();}
 await rm(join(stage,'state.sqlite-wal'),{force:true});await rm(join(stage,'state.sqlite-shm'),{force:true});await durableFile(join(stage,'state.sqlite'));return {backup_id:manifest.backup_id,backup_sha256:sha256,source_changes,scope_incomplete,rebuild_required,models_ready,source_fingerprint};
}
export async function restoreBackup(options:RestoreOptions):Promise<RestoreReport>{
 const requested=resolve(options.targetRoot);await mkdir(dirname(requested),{recursive:true,mode:0o700});const parent=await realpath(dirname(requested)),target=join(parent,basename(requested));if(target===parent)throw new DsearchError('SCOPE_DENIED');
 await reconcileRestore(target);const instance=randomUUID(),release=await takeRestoreOwnership(target,instance),id=randomUUID(),{stage,previous}=paths(target,id);let releaseTarget:(()=>Promise<void>)|undefined,installed=false;
 try{
  const current=await targetState(target);if(current.exists)releaseTarget=await takeOwnership(target,instance);
  const receipt=join(target,'.last-restore.json');if(options.apply&&options.planId&&await exists(receipt)){
   const info=await lstat(receipt);if(!info.isFile()||info.isSymbolicLink()||info.size>32768)throw new DsearchError('SCOPE_DENIED');const prior=JSON.parse(await readFile(receipt,'utf8')) as RestoreReport;
   if(prior.plan_id===options.planId&&prior.target_root===target&&prior.applied&&(!await exists(options.backupPath)||prior.backup_sha256===(await readBackup(options.backupPath)).sha256))return prior;
  }
  await atomicFile(restoreJournalPath(target),canonicalJSON({schema_version:1,operation_id:id,target,stage,previous,phase:'preparing',owner_instance:instance,state_sha256:null,report:null})+'\n');await options.fault?.('restore-preparing');
  const backupPath=await realpath(options.backupPath);if(within(backupPath,target))throw new DsearchError('SCOPE_DENIED');
  const prepared=await prepareStage(backupPath,stage,target,options.fault),value={...prepared,target_root:target,target_exists:current.exists,current_history:current.history,current_fingerprint:current.fingerprint},report:RestoreReport={plan_id:digest(canonicalJSON(value)),backup_id:prepared.backup_id,backup_sha256:prepared.backup_sha256,backup_path:backupPath,target_root:target,target_exists:current.exists,current_history:current.history,source_changes:prepared.source_changes,scope_incomplete:prepared.scope_incomplete,rebuild_required:prepared.rebuild_required,models_ready:prepared.models_ready,applied:false,previous_archive:null,previous_backup:null};
  if(!options.apply)return report;if(options.planId!==report.plan_id)throw new DsearchError('STALE_EPOCH');
  if(current.exists&&current.fingerprint!=='empty'&&current.history){let state:StateStore|undefined;try{state=await StateStore.open(target);const info=await new BackupStore(new Catalog(state),{protectedIds:[prepared.backup_id]}).create();report.previous_backup=join(previous,'backups',info.backup_id);}catch(error){if(!(error instanceof DsearchError&&error.code==='COMPATIBILITY_FAILED'))throw error;}finally{state?.close();}}
  if(current.exists&&within(target,backupPath))report.backup_path=join(previous,relative(target,backupPath));
  const journal:Journal={schema_version:1,operation_id:id,target,stage,previous,phase:'prepared',owner_instance:instance,state_sha256:await fileDigest(join(stage,'state.sqlite')),report};await atomicFile(restoreJournalPath(target),canonicalJSON(journal)+'\n');await options.fault?.('restore-before-swap');
  if(current.exists){await rename(target,previous);await syncParent(target);}await options.fault?.('restore-after-old-move');await rename(stage,target);await syncParent(target);installed=true;await options.fault?.('restore-after-install');await reconcileJournal(target);report.applied=true;report.previous_archive=current.exists?previous:null;return report;
 }catch(error){await reconcileJournal(target);throw error;}finally{
  if(await exists(restoreJournalPath(target)))await reconcileJournal(target);
  if(!installed&&await exists(stage))await rm(stage,{recursive:true,force:true});await releaseTarget?.();await release();
 }
}
