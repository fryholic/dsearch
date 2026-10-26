import {readFile,mkdir,chmod,open,rm,lstat,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {StateStore,canonicalJSON,within} from '@dsearch/catalog';
import {DsearchError} from '@dsearch/contracts';
import {fileDigest} from '@dsearch/runtime';
import {QmdWorker,type OpenEngine} from '@dsearch/engine-qmd';
import {atomicFile} from './seal.js';
import type {GenerationDocument,IndexedPassage} from './builder.js';
import type {SourceInput} from './reuse.js';
export type BuildPlan={schema_version:1;generation_id:string;profile_fp:string;source_seq:number;expected_epoch:number;publish:boolean;engine:OpenEngine;inputs:SourceInput[];coverage:GenerationDocument[];mappings:IndexedPassage[];files:string[];reused_documents:number};
type Entry={path:string;bytes:number;sha256:string};
type Checkpoint={schema_version:1;generation_id:string;profile_fp:string;source_seq:number;expected_epoch:number;database:string;files:Entry[];completed:number};
export type AutomaticCursor={origin?:'automatic';automatic_key?:string;automatic_source_seq?:number;automatic_profile_fp?:string;automatic_retry_allowed?:boolean};
export function automaticCursorMetadata(value:unknown):AutomaticCursor{
 if(!value||typeof value!=='object'||Array.isArray(value))return {};
 const v=value as Record<string,unknown>;if(v.origin!=='automatic')return {};
 const result:AutomaticCursor={origin:'automatic'};
 if(typeof v.automatic_key==='string'&&/^[a-f0-9]{64}$/.test(v.automatic_key)&&typeof v.automatic_profile_fp==='string'&&/^[a-f0-9]{64}$/.test(v.automatic_profile_fp)&&Number.isSafeInteger(v.automatic_source_seq)&&Number(v.automatic_source_seq)>=0){
  Object.assign(result,{automatic_key:v.automatic_key,automatic_source_seq:v.automatic_source_seq,automatic_profile_fp:v.automatic_profile_fp});
  if(v.automatic_retry_allowed===true)result.automatic_retry_allowed=true;
 }
 return result;
}
export type CheckpointCursor=AutomaticCursor&{checkpoint:string;sha256:string;source_seq?:number;resource_retries?:number;max_documents?:number;failed_native_requests?:number;embedding_call_count_incomplete?:number};
const cursorValid=(c:CheckpointCursor)=>!!c&&/^\.checkpoints\/[a-f0-9-]+\.json$/.test(c.checkpoint)&&/^[a-f0-9]{64}$/.test(c.sha256);
async function entry(root:string,path:string):Promise<Entry>{
 const file=join(root,path);if(!within(root,file)||await realpath(file)!==file)throw new DsearchError('SCOPE_DENIED');
 const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw new DsearchError('SCOPE_DENIED');
 return {path,bytes:stat.size,sha256:await fileDigest(file)};
}
export async function loadCheckpoint(root:string,cursor:CheckpointCursor):Promise<{plan:BuildPlan;checkpoint:Checkpoint}>{
 try{
  if(!cursorValid(cursor)||await fileDigest(join(root,cursor.checkpoint))!==cursor.sha256)throw new Error('Checkpoint digest');
  const checkpoint=JSON.parse(await readFile(join(root,cursor.checkpoint),'utf8')) as Checkpoint;
  if(checkpoint.schema_version!==1||!Array.isArray(checkpoint.files)||!/^\.checkpoints\/[a-f0-9-]+\.sqlite$/.test(checkpoint.database))throw new Error('Checkpoint schema');
  for(const expected of checkpoint.files){const actual=await entry(root,expected.path);if(actual.bytes!==expected.bytes||actual.sha256!==expected.sha256)throw new Error('Checkpoint file');}
  if(!checkpoint.files.some(f=>f.path===checkpoint.database)||!checkpoint.files.some(f=>f.path==='build-plan.json'))throw new Error('Checkpoint contents');
  const plan=JSON.parse(await readFile(join(root,'build-plan.json'),'utf8')) as BuildPlan;
  if(plan.schema_version!==1||plan.generation_id!==checkpoint.generation_id||plan.profile_fp!==checkpoint.profile_fp||plan.source_seq!==checkpoint.source_seq||plan.expected_epoch!==checkpoint.expected_epoch||!Array.isArray(plan.mappings)||!Array.isArray(plan.coverage)||!Array.isArray(plan.inputs)||plan.engine.dbPath!==join(root,'qmd.sqlite')||plan.engine.generationId!==plan.generation_id)throw new Error('Checkpoint plan');
  if(plan.files.some(path=>!checkpoint.files.some(f=>f.path===path)))throw new Error('Missing projection');
  return {plan,checkpoint};
 }catch(error){if(error instanceof DsearchError&&error.code==='SCOPE_DENIED')throw error;throw new DsearchError('COMPATIBILITY_FAILED');}
}
export function canResumeBuild(state:StateStore,jobId:string,profiles?:ReadonlySet<string>):boolean{
 const row=state.db.prepare('SELECT j.state,j.cursor_json,g.state AS generation_state,g.source_seq,g.profile_fp,(SELECT job_id FROM jobs WHERE generation_id=j.generation_id ORDER BY updated_at DESC,rowid DESC LIMIT 1) AS latest FROM jobs j JOIN generations g USING(generation_id) WHERE j.job_id=?').get(jobId);
 if(!row||!['failed','cancelled','obsolete'].includes(String(row.state))||row.generation_state!=='invalid'||row.source_seq!==state.sourceSeq||row.latest!==jobId||(profiles&&!profiles.has(String(row.profile_fp))))return false;
 try{const cursor=JSON.parse(String(row.cursor_json));return cursorValid(cursor)&&(cursor.source_seq===undefined||cursor.source_seq===state.sourceSeq);}catch{return false;}
}
export class BuildCheckpoints{
 private files:Entry[]=[];
 private previous:CheckpointCursor|undefined;
 constructor(private readonly state:StateStore,readonly jobId:string,readonly root:string,readonly plan:BuildPlan){}
 async initialize(){
  const folder=join(this.root,'.checkpoints');await mkdir(folder,{recursive:true,mode:0o700});const info=await lstat(folder);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)||await realpath(folder)!==folder)throw new DsearchError('SCOPE_DENIED');
  await atomicFile(join(this.root,'build-plan.json'),canonicalJSON(this.plan)+'\n');
  this.files=await Promise.all(['build-plan.json',...this.plan.files].map(path=>entry(this.root,path)));
  const previous=JSON.parse(String(this.state.db.prepare('SELECT cursor_json FROM jobs WHERE job_id=?').get(this.jobId)!.cursor_json));
  if(cursorValid(previous))this.previous=previous;
 }
 async save(worker:QmdWorker,completed:number,signal:AbortSignal){
  const id=randomUUID(),database='.checkpoints/'+id+'.sqlite',checkpoint='.checkpoints/'+id+'.json',path=join(this.root,database);
  const handle=await open(path,'wx',0o600);await handle.close();
  await worker.invoke('snapshot',{target:path},{signal});await chmod(path,0o600);const durable=await open(path,'r');try{await durable.sync();}finally{await durable.close();}
  const value:Checkpoint={schema_version:1,generation_id:this.plan.generation_id,profile_fp:this.plan.profile_fp,source_seq:this.plan.source_seq,expected_epoch:this.plan.expected_epoch,database,files:[...this.files,await entry(this.root,database)],completed};
  await atomicFile(join(this.root,checkpoint),canonicalJSON(value)+'\n');
  const persisted=JSON.parse(String(this.state.db.prepare('SELECT cursor_json FROM jobs WHERE job_id=?').get(this.jobId)!.cursor_json));
  const counters=Object.fromEntries(['resource_retries','max_documents','failed_native_requests','embedding_call_count_incomplete'].filter(key=>Number.isSafeInteger(persisted[key])&&persisted[key]>=0).map(key=>[key,persisted[key]]));
  const cursor={...automaticCursorMetadata(persisted),...counters,source_seq:this.plan.source_seq,checkpoint,sha256:await fileDigest(join(this.root,checkpoint))};
  this.state.db.prepare('UPDATE jobs SET cursor_json=?,updated_at=? WHERE job_id=?').run(canonicalJSON(cursor),new Date().toISOString(),this.jobId);
  // The state pointer is durable before obsolete snapshots are removed. An interrupted removal is harmless.
  const prior=this.previous;this.previous=cursor;
  if(prior&&prior.checkpoint!==checkpoint){await rm(join(this.root,prior.checkpoint),{force:true});await rm(join(this.root,prior.checkpoint.replace(/\.json$/,'.sqlite')),{force:true});}
 }
}
/** Only call after exclusive daemon ownership has established that its former owner is gone. */
export function reconcileInterruptedBuilds(state:StateStore):void{
 state.transaction(()=>{
  const now=new Date().toISOString();state.db.prepare("UPDATE jobs SET lease_owner=NULL,lease_expires_at=NULL WHERE state NOT IN ('queued','running','retry_wait')").run();
  state.db.prepare("UPDATE generations SET state='invalid' WHERE state IN ('building','validating') AND generation_id NOT IN (SELECT generation_id FROM active_slot)").run();
  state.db.prepare("UPDATE jobs SET state='obsolete',phase='interrupted',error_code='WORKER_EXITED',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE kind IN ('full-build','profile-build') AND state IN ('queued','running','retry_wait')").run(now);
 });
}
