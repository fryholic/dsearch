import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {r0Fingerprint} from './lib/r0-fingerprint.mjs';
const root=resolve(import.meta.dirname,'..'),folder=join(root,'artifacts/p5');await mkdir(folder,{recursive:true});
const report={schema_version:1,checkpoint:'Application interface verification',status:'running',started_at:new Date().toISOString(),input_fingerprint:await r0Fingerprint(),runtime:{node:process.versions.node,platform:process.platform,arch:process.arch},steps:[]};
const save=()=>writeFile(join(folder,'verification.json'),JSON.stringify(report,null,2)+'\n'),sha=async file=>createHash('sha256').update(await readFile(file)).digest('hex');await save();
try{
 for(const command of ['check','test:r0']){const chunks=[];const code=await new Promise((resolve,reject)=>{const child=spawn('pnpm',[command],{cwd:root,stdio:['ignore','pipe','pipe']});for(const s of [child.stdout,child.stderr])s.on('data',chunk=>{chunks.push(chunk);process.stdout.write(chunk);});child.once('error',reject);child.once('exit',resolve);});const log=command.replace(':','-')+'.log';await writeFile(join(folder,log),Buffer.concat(chunks));report.steps.push({command,exit_code:code,log});await save();assert.equal(code,0,command+' failed');}
 assert.equal(await r0Fingerprint(),report.input_fingerprint,'Sources changed during verification');report.web={};for(const name of ['app.js','app.css','index.html'])report.web[name]=await sha(join(root,'apps/web/dist-web',name));
 const browser=JSON.parse(await readFile(join(folder,'browser/checks.json'),'utf8'));assert.equal(browser.source_fingerprint,report.input_fingerprint);assert.deepEqual(browser.web,report.web);
 const required=['setup_folder_preview_registration','setup_model_verify_build','search_read','literal_search','metadata_filter','related_source_query','comparison_independent_read','comparison_stale_side','profile_prepare_activate','jobs_cancel_retry','settings_themes','diagnostics_export','result_export_default','result_export_query_opt_in','keyboard_focus','late_search_cancel','responsive_layout','model_inventory_recovery','client_parity','collection_management'];
 for(const name of required){const check=browser.cases[name];assert.equal(check?.passed,true,'Missing browser proof: '+name);assert.ok(check.evidence?.length,'Missing evidence: '+name);for(const file of check.evidence){assert.ok(!file.startsWith('/')&&!file.split('/').includes('..'));await readFile(join(folder,'browser',file));}}
 assert.ok([320,390,768,1024,1440].every(width=>browser.layouts.some(row=>row.width===width)));assert.ok(browser.layouts.every(row=>row.overflow===0&&row.short_primary_controls===0));
 report.browser={cases:required.length,layouts:browser.layouts.length,log:'browser/checks.json'};report.engine=JSON.parse(await readFile(join(root,'vendor/qmd-upstream.json'),'utf8'));report.models=JSON.parse(await readFile(join(root,'vendor/models/registry.json'),'utf8')).models.map(({role,repository,revision,filename,sha256})=>({role,repository,revision,filename,sha256}));report.status='passed';report.completed_at=new Date().toISOString();report.scope='Catalog, models/profiles, GUI/CLI/MCP parity and lifecycle. Incremental recovery and representative quality, installation and endurance acceptance remain separate.';await save();
}catch(error){report.status='failed';report.completed_at=new Date().toISOString();report.failure=error.message;await save();throw error;}
