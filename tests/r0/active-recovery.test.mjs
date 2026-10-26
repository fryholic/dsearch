import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {StateStore,Catalog} from '../../packages/catalog/dist/index.js';
import {GenerationBuilder,createAlphaProfile} from '../../packages/generations/dist/index.js';
import {createApplication} from '../fixtures/application.mjs';
const root=resolve(import.meta.dirname,'../..'),engineRoot=join(root,'.local/qmd-recovery'),modelRoot=join(root,'.local/models');
async function fixture(t){await mkdir(join(root,'.local/alpha'),{recursive:true});const folder=await mkdtemp(join(root,'.local/alpha/active-recovery-')),source=join(folder,'source'),data=join(folder,'data');await mkdir(source);await writeFile(join(source,'guide.md'),'# Project guide\n\nRecord the owner before the milestone review.');t.after(()=>rm(folder,{recursive:true,force:true}));const state=await StateStore.open(data),catalog=new Catalog(state);await catalog.addCollection({name:'Projects',root:source});const profile=(await createAlphaProfile(engineRoot)).manifest,builder=new GenerationBuilder(catalog,{engineRoot,modelRoot,profile,embedRole:'embed'});try{const first=await builder.start().completion,second=await builder.start().completion;return {data,source,first,second};}finally{state.close();}}
async function projection(data,id){const directory=join(data,'generations',id),mappings=JSON.parse(await readFile(join(directory,'mappings.json'),'utf8')),p=mappings[0];return join(directory,'projection',p.engine_collection,p.engine_relative_path);}
test('a damaged active seal falls back only to a fully validated matching source snapshot',async t=>{
 const {data,first,second}=await fixture(t);await writeFile(await projection(data,second.generation_id),'damaged');const app=await createApplication({dataRoot:data,engineRoot,modelRoot});try{const status=app.status();assert.equal(status.recovery.state,'recovered');assert.equal(status.generation.generation_id,first.generation_id);assert.equal(status.generation.epoch,second.epoch+1);assert.equal(status.needs_rebuild,false);assert.equal(app.catalog.state.db.prepare('SELECT state FROM generations WHERE generation_id=?').get(second.generation_id).state,'invalid');}finally{await app.close();}
});
test('failed product mappings cannot be hidden by a valid engine file seal',async t=>{
 const {data,first,second}=await fixture(t),db=new DatabaseSync(join(data,'state.sqlite'));db.prepare("UPDATE passages SET source_map_json='{}' WHERE generation_id=?").run(second.generation_id);db.close();const app=await createApplication({dataRoot:data,engineRoot,modelRoot});try{assert.equal(app.status().recovery.state,'recovered');assert.equal(app.status().generation.generation_id,first.generation_id);}finally{await app.close();}
});
test('source changes prevent stale fallback and an unavailable pointer preserves monotonically increasing epochs',async t=>{
 const {data,source,second}=await fixture(t);await writeFile(join(source,'guide.md'),'# Project guide\n\nA newer milestone owner and schedule.');await writeFile(await projection(data,second.generation_id),'damaged');const app=await createApplication({dataRoot:data,engineRoot,modelRoot});try{assert.equal(app.status().recovery.state,'rebuild_required');assert.equal(app.status().generation,null);assert.equal(app.status().modes.lexical,false);assert.equal(app.catalog.state.db.prepare('SELECT epoch FROM active_slot').get().epoch,second.epoch);const built=await app.builder.start().completion;assert.equal(built.epoch,second.epoch+1);assert.equal(app.status().needs_rebuild,false);assert.ok((await readFile(join(source,'guide.md'),'utf8')).includes('A newer'));}finally{await app.close();}
});
