import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve,relative} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
export async function r0Fingerprint(){
 const files=[];
 async function visit(path){
  for(const entry of await readdir(path,{withFileTypes:true})){
   if(['node_modules','dist','dist-web'].includes(entry.name))continue;
   const file=join(path,entry.name);
   if(entry.isDirectory())await visit(file);
   else if(entry.isFile()&&/\.(?:ts|tsx|mjs|json|yaml|patch|css|html)$/.test(file))files.push(file);
  }
 }
 for(const name of ['apps','packages','scripts','tests','fixtures','vendor'])await visit(join(root,name));
 for(const name of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','tsconfig.base.json'])files.push(join(root,name));
 const hash=createHash('sha256');
 for(const file of files.sort())hash.update(relative(root,file)+'\0').update(await readFile(file)).update('\0');
 return hash.digest('hex');
}
