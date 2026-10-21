import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {r0Fingerprint} from './lib/r0-fingerprint.mjs';
const root=resolve(import.meta.dirname,'..'),folder=join(root,'artifacts/p3');
await mkdir(folder,{recursive:true});
const report={schema_version:1,checkpoint:'P2-P3 automated alpha gates',status:'running',started_at:new Date().toISOString(),input_fingerprint:await r0Fingerprint(),runtime:{node:process.versions.node,platform:process.platform,arch:process.arch},steps:[]};
const save=()=>writeFile(join(folder,'verification.json'),JSON.stringify(report,null,2)+'\n');
const sha=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
await save();
try{
 for(const command of ['check','test:r0']){
  console.log('P3 verification: '+command);
  const chunks=[];const code=await new Promise((resolve,reject)=>{const child=spawn('pnpm',[command],{cwd:root,stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{chunks.push(chunk);process.stdout.write(chunk);});child.on('error',reject);child.on('exit',resolve);});
  const log=command.replace(':','-')+'.log';await writeFile(join(folder,log),Buffer.concat(chunks));report.steps.push({command,exit_code:code,log});await save();assert.equal(code,0,command+' failed');
 }
 assert.equal(await r0Fingerprint(),report.input_fingerprint,'Sources changed during verification');
 report.engine=JSON.parse(await readFile(join(root,'vendor/qmd-upstream.json'),'utf8'));
 report.models=JSON.parse(await readFile(join(root,'vendor/models/registry.json'),'utf8')).models.map(({role,repository,revision,sha256,filename})=>({role,repository,revision,sha256,filename}));
 report.web={};for(const name of ['app.js','app.css','index.html'])report.web[name]=await sha(join(root,'apps/web/dist-web',name));
 report.status='passed';report.completed_at=new Date().toISOString();report.scope='Real temporary folders; native engine, source revisions, sealed generations, API/auth/SSE, initial CLI lifecycle. Browser walkthrough and responsive evidence are documented separately. This is not full R1 quality, installation or endurance acceptance.';
 await save();console.log('P3 automated alpha gates passed.');
}catch(error){report.status='failed';report.completed_at=new Date().toISOString();report.failure=error.message;await save();throw error;}
