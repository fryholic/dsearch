import {mkdir,lstat,readdir,readFile,rename,rm,realpath,open} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Catalog,canonicalJSON,digest} from '@dsearch/catalog';
import {DsearchError} from '@dsearch/contracts';
import {atomicFile} from './seal.js';
import {canResumeBuild,automaticCursorMetadata} from './checkpoint.js';
import {generationPins,claimGenerationDeletion,beginMaintenance} from './pins.js';
type Policy={keep_retired:number;min_age_seconds:number};
export type GCPreview={plan_id:string;policy:Policy;candidates:{generation_id:string;bytes:number;state:string;created_at:string;documents:number;passages:number}[];protected:{generation_id:string;reasons:string[]}[]};
async function privateFolder(path:string){await mkdir(path,{recursive:true,mode:0o700});const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)||await realpath(path)!==path)throw new DsearchError('SCOPE_DENIED');}
async function syncDirectory(path:string){const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}}
async function moveDirectory(from:string,to:string){await rename(from,to);await syncDirectory(join(from,'..'));await syncDirectory(join(to,'..'));}
async function treeBytes(path:string):Promise<number>{let n=0;for(const item of await readdir(path,{withFileTypes:true})){const child=join(path,item.name),info=await lstat(child);n+=item.isDirectory()&&!item.isSymbolicLink()?await treeBytes(child):info.size;}return n;}
const validId=(id:unknown):id is string=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(id);
/** Complete or roll back a journal before the service can reserve readers or start builders. */
export async function reconcileGC(catalog:Catalog):Promise<void>{
 const root=catalog.state.root,folder=join(root,'.maintenance');await privateFolder(folder);await privateFolder(join(root,'generations'));await privateFolder(join(root,'generations','.trash'));
 for(const item of await readdir(folder)){if(!/^gc-[a-f0-9-]+\.json$/.test(item))continue;const file=join(folder,item),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>4096)throw new DsearchError('COMPATIBILITY_FAILED');
  const record=JSON.parse(await readFile(file,'utf8')) as {generation_id:string;operation_id:string};if(!validId(record.generation_id)||!validId(record.operation_id))throw new DsearchError('COMPATIBILITY_FAILED');
  const original=join(root,'generations',record.generation_id),trash=join(root,'generations','.trash',record.operation_id),row=catalog.state.db.prepare('SELECT generation_id FROM generations WHERE generation_id=?').get(record.generation_id),exists=await lstat(trash).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;return undefined;});
  if(exists){if(!exists.isDirectory()||exists.isSymbolicLink())throw new DsearchError('SCOPE_DENIED');if(row){if(await lstat(original).then(()=>true,(e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;return false;}))throw new DsearchError('COMPATIBILITY_FAILED');await moveDirectory(trash,original);}else await rm(trash,{recursive:true});}
  await rm(file);await syncDirectory(folder);
 }
}
export class GenerationGC{
 constructor(readonly catalog:Catalog,readonly options:{backupReferences?:()=>Promise<string[]>;fault?:(phase:string)=>void|Promise<void>}={}){}
 async preview(policy:Policy={keep_retired:2,min_age_seconds:86400}):Promise<GCPreview>{
  if(!Number.isSafeInteger(policy.keep_retired)||policy.keep_retired<0||policy.keep_retired>100||!Number.isSafeInteger(policy.min_age_seconds)||policy.min_age_seconds<0)throw new DsearchError('INVALID_REQUEST');
  const state=this.catalog.state,rows=state.db.prepare('SELECT * FROM generations ORDER BY created_at DESC,rowid DESC').all(),active=state.db.prepare('SELECT generation_id,epoch FROM active_slot WHERE slot=1').get(),backups=new Set(await this.options.backupReferences?.()??[]),retained=new Set(rows.filter(r=>r.state==='retired'&&r.manifest_sha256).slice(0,policy.keep_retired).map(r=>String(r.generation_id))),candidates:GCPreview['candidates']=[],protectedRows:GCPreview['protected']=[];
  for(const row of rows){const id=String(row.generation_id),reasons=generationPins(state,id).map(reason=>'lease:'+reason);
   if(row.directory_path!==join(state.root,'generations',id)||!validId(id))throw new DsearchError('SCOPE_DENIED');
   if(active?.generation_id===id||row.state==='active')reasons.push('active');if(['building','validating'].includes(String(row.state)))reasons.push('build');if(row.state==='ready')reasons.push('prepared_candidate');if(retained.has(id))reasons.push('retention');if(backups.has(id))reasons.push('backup');
   const job=state.db.prepare('SELECT job_id,state,cursor_json FROM jobs WHERE generation_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1').get(id);
   if(job&&(canResumeBuild(state,String(job.job_id))||['queued','running'].includes(String(job.state))&&JSON.parse(String(job.cursor_json)).checkpoint))reasons.push('resume_checkpoint');
   if(state.db.prepare('SELECT 1 FROM evaluation_runs WHERE generation_id=? LIMIT 1').get(id))reasons.push('evaluation');
   if(Date.now()-Date.parse(String(row.created_at))<policy.min_age_seconds*1000)reasons.push('minimum_age');
   if(reasons.length){protectedRows.push({generation_id:id,reasons});continue;}
   const info=await lstat(String(row.directory_path)).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;return undefined;});if(info&&(!info.isDirectory()||info.isSymbolicLink()))throw new DsearchError('SCOPE_DENIED');
   const coverage=JSON.parse(String(row.coverage_json));candidates.push({generation_id:id,bytes:info?await treeBytes(String(row.directory_path)):0,state:String(row.state),created_at:String(row.created_at),documents:Array.isArray(coverage)?coverage.length:0,passages:Number(state.db.prepare('SELECT count(*) AS n FROM passages WHERE generation_id=?').get(id)!.n)});
  }
  const value={policy,candidates,protected:protectedRows};return {plan_id:digest(canonicalJSON({root:state.root,source_seq:state.sourceSeq,active:active??null,...value})),...value};
 }
 async apply(planId:string,policy:Policy,signal?:AbortSignal):Promise<{removed:string[];bytes:number}>{
  if(signal?.aborted)throw new DsearchError('CANCELLED');
  const done=beginMaintenance(this.catalog.state);try {
  const preview=await this.preview(policy);if(preview.plan_id!==planId)throw new DsearchError('STALE_EPOCH');const state=this.catalog.state,removed:string[]=[];let bytes=0;
  await privateFolder(join(state.root,'.maintenance'));await privateFolder(join(state.root,'generations','.trash'));
  for(const candidate of preview.candidates){if(signal?.aborted)throw new DsearchError('CANCELLED');const id=candidate.generation_id,release=claimGenerationDeletion(state,id),operation_id=randomUUID(),file=join(state.root,'.maintenance','gc-'+operation_id+'.json'),original=join(state.root,'generations',id),trash=join(state.root,'generations','.trash',operation_id);
   try{
    await atomicFile(file,canonicalJSON({generation_id:id,operation_id})+'\n');const exists=await lstat(original).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;return undefined;});if(exists)await moveDirectory(original,trash);
    await this.options.fault?.('gc-after-rename');if(signal?.aborted)throw new DsearchError('CANCELLED');
    state.transaction(()=>{
     if(state.db.prepare('SELECT 1 FROM active_slot WHERE generation_id=?').get(id)||generationPins(state,id).length)throw new DsearchError('BUSY');
     state.db.prepare('DELETE FROM passages WHERE generation_id=?').run(id);state.db.prepare('DELETE FROM generation_documents WHERE generation_id=?').run(id);for(const job of state.db.prepare('SELECT job_id,cursor_json FROM jobs WHERE generation_id=?').all(id)){const cursor=JSON.parse(String(job.cursor_json));state.db.prepare('UPDATE jobs SET generation_id=NULL,cursor_json=? WHERE job_id=?').run(canonicalJSON(automaticCursorMetadata(cursor)),String(job.job_id));}state.db.prepare('DELETE FROM generations WHERE generation_id=?').run(id);
    });
    await this.options.fault?.('gc-after-state-commit');if(exists)await rm(trash,{recursive:true});await rm(file);await syncDirectory(join(state.root,".maintenance"));await syncDirectory(join(state.root,"generations",".trash"));removed.push(id);bytes+=candidate.bytes;
   }catch(error){await reconcileGC(this.catalog);throw error;}finally{release();}
  }
  return {removed,bytes};
  }finally{done();}
 }
}
