import {watch,type FSWatcher} from 'node:fs';
import {isAbsolute,relative} from 'node:path';
import {Catalog,canonicalJSON,digest} from '@dsearch/catalog';
import {DsearchError,ErrorCode} from '@dsearch/contracts';
import {beginMaintenance,automaticCursorMetadata,type AutomaticCursor,type BuildHandle} from '@dsearch/generations';
export type SyncPhase='disabled'|'idle'|'debouncing'|'reconciling'|'queued'|'indexing'|'blocked';
export type SyncInfo={enabled:boolean;state:SyncPhase;pending:boolean;job_id:string|null;last_reconciled_at:string|null;last_indexed_at:string|null;error_code:ErrorCode|null};
type Hint='startup'|'filesystem'|'periodic'|'wake'|'configuration'|'models';
type Host={catalog:Catalog;enabled:()=>boolean;busy:()=>boolean;profile:()=>string;models:()=>Promise<{ready:boolean;fingerprint:string;error?:ErrorCode|null}>;build:(automatic:AutomaticCursor)=>BuildHandle;cancel:(jobId:string)=>void;published:()=>void;onWake?:()=>void|Promise<void>};
type WatchHandle=Pick<FSWatcher,'close'|'on'>;
/** Events are hints. Only a complete catalog reconciliation can decide what to publish. */
export class Synchronization {
 private readonly watchers=new Map<string,WatchHandle>();
 private timer:ReturnType<typeof setTimeout>|undefined;
 private readonly poll:ReturnType<typeof setInterval>;
 private dirty:{first:number;last:number;immediate:boolean}|undefined;
 private running:Promise<void>|undefined;
 private controller:AbortController|undefined;
 private active:BuildHandle|undefined;
 private cancelledBeforeStop=false;
 private phase:SyncPhase='idle';
 private lastReconciled:string|null=null;
 private lastIndexed:string|null=null;
 private error:ErrorCode|null=null;
 private failedKey:string|undefined;
 private failedCode:ErrorCode|null=null;
 private closed=false;
 private lastPoll:number;
 private waking=false;
 private scanning=false;
 private readonly stableMs:number;
 private readonly maxDelayMs:number;
 private readonly pollMs:number;
 constructor(readonly host:Host,readonly options:{stableMs?:number;maxDelayMs?:number;pollMs?:number;retryMs?:number;now?:()=>number;watch?:(root:string,changed:()=>void,failed:()=>void)=>WatchHandle}={}){
  this.lastPoll=this.now();this.stableMs=options.stableMs??5000;this.maxDelayMs=options.maxDelayMs??30000;this.pollMs=options.pollMs??60000;
  if(![this.stableMs,this.maxDelayMs,this.pollMs,options.retryMs??500].every(v=>Number.isSafeInteger(v)&&v>0)||this.maxDelayMs<this.stableMs)throw new DsearchError('INVALID_REQUEST');
  this.poll=setInterval(()=>{const now=this.now(),wake=now-this.lastPoll>this.pollMs*2||now<this.lastPoll;this.lastPoll=now;if(wake)this.waking=true;this.notify(wake?'wake':'periodic',true);},this.pollMs);this.poll.unref();
 }
 private now(){return this.options.now?.()??Date.now();}
 start(){if(!this.host.enabled())this.refresh();else this.notify('startup',true);}
 get busy(){return this.scanning;}
 info():SyncInfo{return {enabled:!this.closed&&this.host.enabled(),state:this.phase,pending:this.host.enabled()&&(!!this.dirty||!!this.running||this.phase==='blocked'),job_id:this.active?.job_id??null,last_reconciled_at:this.lastReconciled,last_indexed_at:this.lastIndexed,error_code:this.error};}
 refresh(){
  if(!this.host.enabled()){this.error=null;this.phase='disabled';this.dirty=undefined;clearTimeout(this.timer);this.stopAutomatic();this.closeWatches();return;}
  this.notify('configuration',true);
 }
 notify(reason:Hint,immediate=false){
  if(this.closed||!this.host.enabled())return;
  if(reason==='models'||reason==='configuration')this.clearFailure();
  if(reason==='configuration'||reason==='startup')this.attach();
  if(reason==='wake')this.waking=true;
  const now=this.now();if(!this.dirty)this.dirty={first:now,last:now,immediate};else{if(reason==='filesystem'||reason==='configuration')this.dirty.last=now;this.dirty.immediate ||=immediate&&reason!=='periodic';}
  this.schedule();
 }
 private clearFailure(){
  this.failedKey=undefined;this.failedCode=null;
  const state=this.host.catalog.state;
  const rows=state.db.prepare("SELECT job_id,cursor_json FROM jobs WHERE state IN ('failed','cancelled','obsolete') AND CASE WHEN json_valid(cursor_json) THEN json_extract(cursor_json,'$.automatic_source_seq') END=? AND CASE WHEN json_valid(cursor_json) THEN json_extract(cursor_json,'$.automatic_profile_fp') END=?").all(state.sourceSeq,this.host.profile());
  state.transaction(()=>{for(const row of rows){const cursor=JSON.parse(String(row.cursor_json)),metadata=automaticCursorMetadata(cursor);if(metadata.automatic_key&&!metadata.automatic_retry_allowed)state.db.prepare('UPDATE jobs SET cursor_json=? WHERE job_id=?').run(canonicalJSON({...cursor,automatic_retry_allowed:true}),String(row.job_id));}});
 }
 private recordedFailure(key:string):ErrorCode|null{
  const row=this.host.catalog.state.db.prepare("SELECT state,error_code,cursor_json FROM jobs WHERE kind='full-build' AND state IN ('failed','cancelled','obsolete','succeeded') AND CASE WHEN json_valid(cursor_json) THEN json_extract(cursor_json,'$.automatic_key') END=? ORDER BY rowid DESC LIMIT 1").get(key);
  if(!row||row.state==='succeeded')return null;
  const metadata=automaticCursorMetadata(JSON.parse(String(row.cursor_json)));
  if(metadata.automatic_key!==key||metadata.automatic_retry_allowed)return null;
  const code=ErrorCode.safeParse(row.error_code);return code.success?code.data:'INTERNAL_ERROR';
 }
 private stopAutomatic(){
  if(!this.controller?.signal.aborted)this.cancelledBeforeStop=!!(this.active&&this.host.catalog.state.db.prepare('SELECT cancel_requested FROM jobs WHERE job_id=?').get(this.active.job_id)?.cancel_requested);
  this.controller?.abort();if(this.active)this.host.cancel(this.active.job_id);
 }
 private schedule(delay?:number){
  if(this.running||this.closed||!this.host.enabled()||!this.dirty)return;
  clearTimeout(this.timer);if(this.phase!=='blocked')this.phase=this.host.busy()?'queued':'debouncing';
  const due=this.dirty.immediate?this.now():Math.min(this.dirty.last+this.stableMs,this.dirty.first+this.maxDelayMs);
  this.timer=setTimeout(()=>{this.timer=undefined;this.run();},delay??Math.max(0,due-this.now()));this.timer.unref();
 }
 private closeWatches(){for(const watcher of this.watchers.values())watcher.close();this.watchers.clear();}
 private attach(){
  const roots=new Set(this.host.catalog.listCollections().filter(c=>c.enabled).map(c=>c.root_path));
  for(const [root,watcher] of this.watchers)if(!roots.has(root)){watcher.close();this.watchers.delete(root);}
  for(const root of roots)if(!this.watchers.has(root)){
   const changed=()=>this.notify('filesystem'),failed=()=>{const watcher=this.watchers.get(root);watcher?.close();this.watchers.delete(root);this.notify('filesystem');};
   try{
    const handle=this.options.watch?this.options.watch(root,changed,failed):watch(root,{recursive:true},(_event,name)=>{
     // Catalog enforces the actual scope and root identity. Do not turn private product writes into hints.
     if(name){const path=String(name),parts=path.split(/[\\/]/),inside=relative(root,this.host.catalog.state.root);if(isAbsolute(path)||parts.some(part=>part.startsWith('.')||part==='node_modules')||inside&&!inside.startsWith('..')&&(path===inside||path.startsWith(inside+'/')))return;}
     changed();
    });
    handle.on('error',failed);this.watchers.set(root,handle);
   }catch{ /* A periodic reconciliation retries disconnected roots and recreates watchers. */ }
  }
 }
 private run(){
  if(this.closed||!this.host.enabled()||!this.dirty)return;
  if(this.host.busy()){this.phase='queued';this.schedule(this.options.retryMs??500);return;}
  const controller=new AbortController();this.controller=controller;this.dirty=undefined;
  this.running=this.perform(controller.signal).catch(error=>{
   if(!controller.signal.aborted){this.phase='blocked';this.error=error instanceof DsearchError?error.code:'INTERNAL_ERROR';}
  }).finally(()=>{this.running=undefined;this.controller=undefined;this.active=undefined;if(this.closed||!this.host.enabled())this.phase='disabled';else this.schedule();});
 }
 private async perform(signal:AbortSignal){
  this.attach();this.phase='reconciling';this.error=null;
  let release:(()=>void)|undefined;
  try{
   release=beginMaintenance(this.host.catalog.state);this.scanning=true;
   const collections=this.host.catalog.listCollections().filter(c=>c.enabled);
   if(!collections.length){this.phase='idle';return;}
   for(const collection of collections){try{const scan=await this.host.catalog.reconcile(collection.collection_id,{signal});if(scan.scope_incomplete)throw new DsearchError('SCOPE_INCOMPLETE');}catch(error){this.watchers.get(collection.root_path)?.close();this.watchers.delete(collection.root_path);throw error;}}
   this.lastReconciled=new Date().toISOString();
  }finally{release?.();this.scanning=false;}
  if(signal.aborted)throw new DsearchError('CANCELLED');
  if(this.waking){this.waking=false;await this.host.onWake?.();}
  const state=this.host.catalog.state,active=state.db.prepare("SELECT g.source_seq,g.profile_fp FROM active_slot a JOIN generations g USING(generation_id) WHERE g.state='active'").get();
  if(active?.source_seq===state.sourceSeq&&active.profile_fp===this.host.profile()){this.phase='idle';this.clearFailure();return;}
  const models=await this.host.models();if(signal.aborted)throw new DsearchError('CANCELLED');
  if(!models.ready){this.phase='blocked';this.error=models.error??'MODEL_NOT_INSTALLED';return;}
  const key=digest(canonicalJSON([state.sourceSeq,this.host.profile(),models.fingerprint])),recorded=this.recordedFailure(key);
  if(key===this.failedKey||recorded){this.failedKey=key;this.failedCode=recorded??this.failedCode;this.phase='blocked';this.error=this.failedCode;return;}
  if(this.host.busy()){this.notify('periodic',true);this.phase='queued';return;}
  this.phase='indexing';const job=this.host.build({origin:'automatic',automatic_key:key,automatic_source_seq:state.sourceSeq,automatic_profile_fp:this.host.profile()});this.active=job;
  try{await job.completion;if(signal.aborted)throw new DsearchError('CANCELLED');this.host.published();this.lastIndexed=new Date().toISOString();this.phase='idle';this.failedKey=undefined;}
  catch(error){
   this.host.cancel(job.job_id);await job.completion.catch(()=>{});
   if(signal.aborted){if(!this.cancelledBeforeStop){const cursor=JSON.parse(String(state.db.prepare('SELECT cursor_json FROM jobs WHERE job_id=?').get(job.job_id)!.cursor_json));state.db.prepare('UPDATE jobs SET cursor_json=? WHERE job_id=?').run(canonicalJSON({...cursor,automatic_retry_allowed:true}),job.job_id);}throw error;}
   this.failedKey=key;this.failedCode=error instanceof DsearchError?error.code:'INTERNAL_ERROR';
   if(error instanceof DsearchError&&['STALE_EPOCH','STALE_REVISION','SOURCE_PENDING'].includes(error.code)){this.notify('filesystem');this.phase='debouncing';}else throw error;
  }
 }
 async close(){this.closed=true;clearInterval(this.poll);clearTimeout(this.timer);this.dirty=undefined;this.closeWatches();this.stopAutomatic();await this.running;this.phase='disabled';}
}
