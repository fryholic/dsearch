import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { open, lstat, readFile, rm, mkdir, realpath, link } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { DsearchError } from '@dsearch/contracts';
export async function privateRoot(path: string): Promise<string> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
        throw new DsearchError('SCOPE_DENIED');
    return realpath(path);
}
async function ownerRecord(path:string):Promise<{pid:number;instance_id:string}|undefined>{
 const info=await lstat(path).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;return undefined;});if(!info)return;
 if(!info.isFile()||info.isSymbolicLink()||info.size>4096)throw new DsearchError('BUSY');const value=JSON.parse(await readFile(path,'utf8'));if(!Number.isSafeInteger(value.pid)||value.pid<=0||typeof value.instance_id!=='string')throw new DsearchError('BUSY');return value;
}
function alive(pid:number){try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}}
/** SQLite's OS lock is released on process death; prewritten hardlinks keep legacy lock records atomic. */
async function claimFile(path:string,instance:string):Promise<()=>Promise<void>>{
 const prior=await ownerRecord(path);if(prior&&alive(prior.pid))throw new DsearchError('BUSY');
 const database=path+'.sqlite',handle=await open(database,'wx',0o600).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='EEXIST')throw e;return undefined;});await handle?.close();
 const info=await lstat(database);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077))throw new DsearchError('SCOPE_DENIED');
 const db=new DatabaseSync(database,{timeout:0});try{db.exec('PRAGMA journal_mode=DELETE;CREATE TABLE IF NOT EXISTS owner_lock(slot INTEGER);BEGIN EXCLUSIVE');}catch{db.close();throw new DsearchError('BUSY');}
 const guard=path+'.recovery',unique=path+'.owner-'+randomUUID();let guarded=false,claimed=false;
 try{
  const oldGuard=await ownerRecord(guard);if(oldGuard){if(alive(oldGuard.pid))throw new DsearchError('BUSY');await rm(guard);}
  const fd=await open(unique,'wx',0o600);try{await fd.writeFile(JSON.stringify({pid:process.pid,instance_id:instance}));await fd.sync();}finally{await fd.close();}
  await link(unique,guard);guarded=true;const old=await ownerRecord(path);if(old&&alive(old.pid))throw new DsearchError('BUSY');if(old)await rm(path);await link(unique,path);claimed=true;
  const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}
 }catch(error){if(claimed&&(await ownerRecord(path))?.instance_id===instance)await rm(path);db.exec('ROLLBACK');db.close();throw error;}
 finally{if(guarded)await rm(guard,{force:true});await rm(unique,{force:true});}
 let released=false;return async()=>{if(released)return;released=true;try{if((await ownerRecord(path))?.instance_id===instance)await rm(path);}finally{db.exec('ROLLBACK');db.close();}};
}

export const restoreLockPath=(root:string)=>join(dirname(root),'.'+basename(root)+'.restore.lock');
export const restoreJournalPath=(root:string)=>join(dirname(root),'.'+basename(root)+'.restore.json');
export const takeRestoreOwnership=(root:string,instance:string)=>claimFile(restoreLockPath(root),instance);
export async function takeOwnership(root:string,instance:string):Promise<()=>Promise<void>>{
 const path=restoreLockPath(root),info=await lstat(path).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;return undefined;});
 if(info){if(!info.isFile()||info.isSymbolicLink()||info.size>4096)throw new DsearchError('BUSY');const owner=JSON.parse(await readFile(path,'utf8'));if(owner.pid!==process.pid||owner.instance_id!==instance)throw new DsearchError('BUSY');}
 return claimFile(join(root,'daemon.lock'),instance);
}
