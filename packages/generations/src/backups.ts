import {backup,DatabaseSync} from 'node:sqlite';
import {readFile,mkdir,open,lstat,realpath,readdir,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Catalog,canonicalJSON,within} from '@dsearch/catalog';
import {DsearchError} from '@dsearch/contracts';
import {fileDigest} from '@dsearch/runtime';
import {atomicFile,verifySeal} from './seal.js';
import {beginMaintenance} from './pins.js';
export type BackupEntry={path:string;bytes:number;sha256:string};
export type BackupManifest={schema_version:1;backup_id:string;created_at:string;source_data_root:string;state_schema:number;source_seq:number;generations:{generation_id:string;state:string;manifest_sha256:string|null}[];files:BackupEntry[]};
export type BackupInfo={backup_id:string;created_at:string;path:string;sha256:string;generations:number;bytes:number};
export async function privateDirectory(path:string){await mkdir(path,{recursive:true,mode:0o700});const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)||await realpath(path)!==path)throw new DsearchError('SCOPE_DENIED');}
export async function durableFile(path:string){const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}}
async function fileEntry(root:string,path:string):Promise<BackupEntry>{const file=join(root,path);if(!within(root,file)||await realpath(file)!==file)throw new DsearchError('SCOPE_DENIED');const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw new DsearchError('SCOPE_DENIED');return {path,bytes:info.size,sha256:await fileDigest(file)};}
export async function copyBackupTree(from:string,to:string,relative='',files:BackupEntry[]=[]):Promise<BackupEntry[]>{
 await privateDirectory(to);
 for(const item of await readdir(from,{withFileTypes:true})){const source=join(from,item.name),target=join(to,item.name),path=relative?relative+'/'+item.name:item.name;
  if(item.isSymbolicLink())throw new DsearchError('SCOPE_DENIED');
  if(item.isDirectory())await copyBackupTree(source,target,path,files);
  else if(item.isFile()){const before=await fileEntry(from,item.name);await atomicFile(target,await readFile(source));const after=await fileEntry(from,item.name);if(before.sha256!==after.sha256)throw new DsearchError('STALE_REVISION');files.push({path,bytes:before.bytes,sha256:before.sha256});}
  else throw new DsearchError('SCOPE_DENIED');
 }
 return files;
}
export async function readBackup(folder:string,full=true):Promise<{manifest:BackupManifest;sha256:string}>{
 const root=await realpath(folder),info=await lstat(folder);if(!info.isDirectory()||info.isSymbolicLink())throw new DsearchError('SCOPE_DENIED');
 try{
  const file=join(root,'manifest.json'),manifestInfo=await lstat(file);if(!manifestInfo.isFile()||manifestInfo.isSymbolicLink()||manifestInfo.size>32*1024*1024)throw new Error('Manifest budget');const entry=await fileEntry(root,'manifest.json');
  const checksumInfo=await lstat(join(root,'manifest.sha256'));if(!checksumInfo.isFile()||checksumInfo.isSymbolicLink()||checksumInfo.size>128)throw new Error('Checksum file');
  const sha256=(await readFile(join(root,'manifest.sha256'),'utf8')).trim();if(entry.sha256!==sha256)throw new Error('Manifest digest');
  const manifest=JSON.parse(await readFile(file,'utf8')) as BackupManifest;
  if(manifest.schema_version!==1||!/^backup-[a-f0-9-]{36}$/.test(manifest.backup_id)||!Array.isArray(manifest.files)||!Array.isArray(manifest.generations)||!manifest.files.some(f=>f.path==='state.sqlite'))throw new Error('Manifest schema');
  if(!Number.isSafeInteger(manifest.state_schema)||manifest.state_schema<1||!Number.isSafeInteger(manifest.source_seq)||manifest.source_seq<0||manifest.generations.some(g=>!/^([a-f0-9-]{36})$/.test(g.generation_id))||manifest.files.some(f=>!Number.isSafeInteger(f.bytes)||f.bytes<0||typeof f.sha256!=='string'||!/^([a-f0-9]{64})$/.test(f.sha256)))throw new Error('Manifest values');
  if(new Set(manifest.files.map(f=>f.path)).size!==manifest.files.length)throw new Error('Duplicate paths');
  for(const item of manifest.files){if(typeof item.path!=='string'||!within(root,join(root,item.path))||item.path.startsWith('/')||item.path.includes('..'))throw new Error('Manifest path');if(full){const actual=await fileEntry(root,item.path);if(actual.sha256!==item.sha256||actual.bytes!==item.bytes)throw new Error('Backup file');}}
  return {manifest,sha256};
 }catch(error){if(error instanceof DsearchError&&error.code==='SCOPE_DENIED')throw error;throw new DsearchError('COMPATIBILITY_FAILED');}
}
export class BackupStore{
 constructor(readonly catalog:Catalog,readonly options:{keep?:number;fault?:(phase:string)=>void|Promise<void>}={}){}
 get root(){return join(this.catalog.state.root,'backups');}
 async list():Promise<BackupInfo[]>{
  await privateDirectory(this.root);const result:BackupInfo[]=[];
  for(const name of await readdir(this.root)){if(!/^backup-[a-f0-9-]{36}$/.test(name))continue;const path=join(this.root,name),{manifest,sha256}=await readBackup(path,false);if(manifest.backup_id!==name)throw new DsearchError('COMPATIBILITY_FAILED');result.push({backup_id:name,created_at:manifest.created_at,path,sha256,generations:manifest.generations.length,bytes:manifest.files.reduce((n,f)=>n+f.bytes,0)});}
  return result.sort((a,b)=>b.created_at.localeCompare(a.created_at));
 }
 async generationReferences():Promise<string[]>{
  const ids=new Set<string>();for(const backup of await this.list()){const {manifest}=await readBackup(backup.path,false);for(const generation of manifest.generations)ids.add(generation.generation_id);}
  // Migration snapshots are intentionally retained and may refer to older generation directories.
  for(const name of await readdir(this.root)){if(!/^state-before-[a-zA-Z0-9-]+\.sqlite$/.test(name))continue;const path=join(this.root,name);await fileEntry(this.root,name);const db=new DatabaseSync(path,{readOnly:true});try{for(const row of db.prepare('SELECT generation_id FROM generations').all())ids.add(String(row.generation_id));}finally{db.close();}}
  return [...ids];
 }
 async create():Promise<BackupInfo>{
  const keep=this.options.keep??7;if(!Number.isSafeInteger(keep)||keep<1||keep>100)throw new DsearchError('INVALID_REQUEST');
  const done=beginMaintenance(this.catalog.state),id='backup-'+randomUUID(),folder=join(this.root,id+'.tmp'),destination=join(this.root,id);let committed=false;
  try{
   await privateDirectory(this.root);await privateDirectory(folder);const path=join(folder,'state.sqlite'),handle=await open(path,'wx',0o600);await handle.close();await backup(this.catalog.state.db,path);await durableFile(path);
   const db=new DatabaseSync(path,{readOnly:true});let generations:BackupManifest['generations'],source_seq:number,state_schema:number;
   try{
    if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw new DsearchError('COMPATIBILITY_FAILED');
    generations=db.prepare('SELECT generation_id,state,manifest_sha256 FROM generations').all().map(row=>({generation_id:String(row.generation_id),state:String(row.state),manifest_sha256:row.manifest_sha256===null?null:String(row.manifest_sha256)}));source_seq=Number(db.prepare('SELECT source_seq FROM catalog_meta WHERE slot=1').get()!.source_seq);state_schema=Number(db.prepare('PRAGMA user_version').get()!.user_version);
   }finally{db.close();}
   await rm(path+'-wal',{force:true});await rm(path+'-shm',{force:true});
   const files:BackupEntry[]=[await fileEntry(folder,'state.sqlite')];
   for(const generation of generations){
    if(!/^[a-f0-9-]{36}$/.test(generation.generation_id))throw new DsearchError('COMPATIBILITY_FAILED');const from=join(this.catalog.state.root,'generations',generation.generation_id),to=join(folder,'generations',generation.generation_id),info=await lstat(from).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;return undefined;});
    if(!info){if(['active','ready','retired'].includes(generation.state))throw new DsearchError('COMPATIBILITY_FAILED');continue;}
    if(!info.isDirectory()||info.isSymbolicLink())throw new DsearchError('SCOPE_DENIED');
    if(['active','ready','retired'].includes(generation.state)){if(!generation.manifest_sha256)throw new DsearchError('COMPATIBILITY_FAILED');await verifySeal(from,generation.manifest_sha256);}
    await copyBackupTree(from,to,'generations/'+generation.generation_id,files);
   }
   const preferences=join(this.catalog.state.root,'preferences.json');if(await lstat(preferences).then(()=>true,(e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;return false;})){await fileEntry(this.catalog.state.root,'preferences.json');await atomicFile(join(folder,'preferences.json'),await readFile(preferences));files.push(await fileEntry(folder,'preferences.json'));}
   const manifest:BackupManifest={schema_version:1,backup_id:id,created_at:new Date().toISOString(),source_data_root:this.catalog.state.root,state_schema,source_seq,generations,files:files.sort((a,b)=>a.path.localeCompare(b.path))};
   await atomicFile(join(folder,'manifest.json'),canonicalJSON(manifest)+'\n');await atomicFile(join(folder,'manifest.sha256'),await fileDigest(join(folder,'manifest.json'))+'\n');await readBackup(folder);await this.options.fault?.('backup-before-publish');
   await rename(folder,destination);await durableFile(this.root);committed=true;await this.options.fault?.('backup-after-publish');
   const list=(await this.list()).sort((a,b)=>a.backup_id===id?-1:b.backup_id===id?1:b.created_at.localeCompare(a.created_at));
   for(const old of list.slice(keep))await rm(old.path,{recursive:true});await durableFile(this.root);return list.find(b=>b.backup_id===id)!;
  }catch(error){if(!committed)await rm(folder,{recursive:true,force:true});throw error;}finally{done();}
 }
}
