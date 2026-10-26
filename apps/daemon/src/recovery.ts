import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Catalog,canonicalJSON} from '@dsearch/catalog';
import {atomicFile,verifySeal} from '@dsearch/generations';
import {ReaderPool} from '@dsearch/search';
import {DsearchError} from '@dsearch/contracts';
export type RecoveryInfo={state:'healthy'|'recovered'|'rebuild_required';damaged_generation_id:string|null;recovered_generation_id:string|null};
const healthy:RecoveryInfo={state:'healthy',damaged_generation_id:null,recovered_generation_id:null};
/** Startup only: validate before serving; an unavailable pointer retains its epoch for future CAS. */
export async function recoverActiveGeneration(catalog:Catalog,options:{engineRoot:string;modelRoot:string;profileFingerprints:Set<string>}):Promise<RecoveryInfo>{
 const state=catalog.state,slot=state.db.prepare('SELECT a.generation_id,a.epoch,g.state,g.profile_fp,g.directory_path,g.manifest_sha256 FROM active_slot a JOIN generations g USING(generation_id) WHERE a.slot=1').get();if(!slot)return healthy;
 const damaged=String(slot.generation_id);if(slot.state!=='active')return {state:'rebuild_required',damaged_generation_id:damaged,recovered_generation_id:null};
 const readerCheck=async()=>{
  const pool=new ReaderPool(catalog,{engineRoot:options.engineRoot,modelRoot:options.modelRoot});let lease;
  try{lease=pool.reserve();const reader=await lease.ready;const value=(await lease.run<{documents:{collection:string;path:string;vector_chunks:number}[];cache:{rows:number};integrity:{quick_check:string}}>('index_audit',{})).result;if(value.integrity.quick_check!=='ok'||value.cache.rows||value.documents.length!==reader.mappings.size)throw new DsearchError('COMPATIBILITY_FAILED');for(const d of value.documents){const p=reader.mappings.get(d.collection+'/'+d.path);if(!p||d.vector_chunks!==(p.kind==='semantic'?1:0))throw new DsearchError('COMPATIBILITY_FAILED');}}
  finally{lease?.release();await pool.close();}
 };
 try{if(slot.directory_path!==join(state.root,'generations',damaged))throw new DsearchError('SCOPE_DENIED');await verifySeal(String(slot.directory_path),String(slot.manifest_sha256));if(options.profileFingerprints.has(String(slot.profile_fp)))await readerCheck();return healthy;}catch{/* The sealed active artifact or its product mapping is damaged. */}
 let complete=true;
 for(const collection of catalog.listCollections().filter(c=>c.enabled)){try{const report=await catalog.reconcile(collection.collection_id);complete&&=!report.scope_incomplete;}catch{complete=false;}}
 const scopes=Object.fromEntries(catalog.listCollections().filter(c=>c.enabled).map(c=>[c.collection_id,c.scope_fp])),candidates=complete?state.db.prepare("SELECT g.* FROM generations g JOIN profiles p USING(profile_id) WHERE g.state IN ('retired','ready') AND g.profile_fp=? AND g.source_seq=? AND p.status='validated' ORDER BY g.created_at DESC,g.rowid DESC").all(String(slot.profile_fp),state.sourceSeq):[];
 for(const candidate of candidates){if(!options.profileFingerprints.has(String(candidate.profile_fp)))continue;const root=join(state.root,'generations',String(candidate.generation_id));if(candidate.directory_path!==root)continue;
  let transaction=false;
  try{
   const manifest=await verifySeal(root,String(candidate.manifest_sha256));if(manifest.generation_id!==candidate.generation_id||manifest.source_seq!==state.sourceSeq||canonicalJSON(manifest.scopes)!==canonicalJSON(scopes))throw new DsearchError('STALE_EPOCH');
   const coverage=JSON.parse(await readFile(join(root,'coverage.json'),'utf8')) as {doc_id:string;revision_id:string|null;state:string}[];for(const document of coverage.filter(d=>['included','partial','lexical_only'].includes(d.state)))await catalog.readDocument(document.doc_id,document.revision_id!);
   state.db.exec('BEGIN IMMEDIATE');transaction=true;
   const current=state.db.prepare('SELECT generation_id,epoch FROM active_slot WHERE slot=1').get();if(current?.generation_id!==damaged||current.epoch!==slot.epoch||state.sourceSeq!==manifest.source_seq)throw new DsearchError('STALE_EPOCH');
   state.db.prepare("UPDATE generations SET state='invalid' WHERE generation_id=?").run(damaged);state.db.prepare("UPDATE generations SET state='active' WHERE generation_id=?").run(String(candidate.generation_id));state.db.prepare('UPDATE active_slot SET generation_id=?,epoch=?,changed_at=? WHERE slot=1').run(String(candidate.generation_id),Number(slot.epoch)+1,new Date().toISOString());
   await readerCheck();state.db.exec('COMMIT');transaction=false;
   const report:RecoveryInfo={state:'recovered',damaged_generation_id:damaged,recovered_generation_id:String(candidate.generation_id)};await atomicFile(join(state.root,'.recovery-report.json'),canonicalJSON({...report,created_at:new Date().toISOString()})+'\n');return report;
  }catch{if(transaction)state.db.exec('ROLLBACK');}
 }
 state.transaction(()=>{state.db.prepare("UPDATE generations SET state='invalid' WHERE generation_id=?").run(damaged);});
 const report:RecoveryInfo={state:'rebuild_required',damaged_generation_id:damaged,recovered_generation_id:null};await atomicFile(join(state.root,'.recovery-report.json'),canonicalJSON({...report,created_at:new Date().toISOString()})+'\n');return report;
}
