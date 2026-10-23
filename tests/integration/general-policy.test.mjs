import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,stat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Catalog,StateStore,canonicalJSON,digest,parseMetadata} from '../../packages/catalog/dist/index.js';
import {CollectionRequest} from '../../packages/contracts/dist/index.js';
import {compileDocument} from '../../packages/compiler/dist/index.js';

async function fixture(t){
 const folder=await mkdtemp(join(tmpdir(),'dsearch-general-')),root=join(folder,'documents'),data=join(folder,'data');await mkdir(root);
 let state=await StateStore.open(data);
 t.after(async()=>{if(state.isOpen)state.close();await rm(folder,{recursive:true,force:true});});
 return {root,data,get state(){return state;},get catalog(){return new Catalog(state);},async reopen(){state.close();state=await StateStore.open(data);return new Catalog(state);},async put(path,text){await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),text);}};
}
async function legacyFixture(t){
 const f=await fixture(t);
 for(const [path,front] of [['30_Resources/Crypto/lesson.md','role: lesson'],['30_Resources/Crypto/array.md','role: [concept]'],['30_Resources/Crypto/old.md','type: concept\nstatus: superseded'],['notes/ordinary.md','role: lesson'],['30_Resources/Networking/lesson.md','role: lesson'],['30_Resources/Crypto/Sources/raw.md','role: lesson']])await f.put(path,'---\n'+front+'\n---\n# Example\n\nUnchanged source body.\n');
 const col=await f.catalog.addCollection({name:'Existing collection',root:f.root}),policy=JSON.parse(col.scope_json);
 const old={preset:'learning',include:policy.include,exclude:[],root_file_key:policy.root_file_key},scope=canonicalJSON(old);
 f.state.db.prepare('UPDATE collections SET scope_json=?,scope_fp=? WHERE collection_id=?').run(scope,digest(scope),col.collection_id);
 await f.catalog.reconcile(col.collection_id);
 const before=f.catalog.documents(col.collection_id).map(d=>({id:d.doc_id,path:d.relative_path,revision:d.latest_revision_id,eligible:d.eligibility==='eligible'}));
 f.state.db.exec('DROP TABLE scope_migrations; PRAGMA user_version=4;');
 return {f,id:col.collection_id,before,scope};
}

test('new collections accept ordinary folders and independent, typed frontmatter without source mutation',async t=>{
 const f=await fixture(t);
 const inputs={
  'Projects/meeting.md':'---\nrole: author\ntype: meeting\ntopics: backup\n---\n# Meeting\n\nA backup policy.\n',
  'Notes/Sources/list.md':'---\ntype: [meeting, note]\nstatus: superseded\n---\n# Notes\n\nKeep this document.\n',
  'Archive/custom.md':'---\nrole: {custom: value}\n---\n# Body\n\nThe source remains readable.\n',
  'broken.md':'---\nrole: one\nrole: two\n---\n# Invalid YAML\n'
 };
 for(const [path,text] of Object.entries(inputs))await f.put(path,text);
 const c=await f.catalog.addCollection({name:'General',root:f.root}),scan=await f.catalog.reconcile(c.collection_id);
 assert.equal(scan.counts.eligible,3);assert.equal(scan.counts.invalid_metadata,1);
 assert.equal(JSON.parse(c.scope_json).version,2);assert.equal(JSON.parse(c.scope_json).metadata_mode,'general');
 for(const [path,text] of Object.entries(inputs))assert.equal(await readFile(join(f.root,path),'utf8'),text);
 assert.deepEqual(parseMetadata(inputs['Projects/meeting.md']).metadata,{role:'author',type:'meeting',topics:'backup'});
 assert.equal(CollectionRequest.safeParse({name:'Old shortcut',root:f.root,preset:'learning'}).success,false);
});

test('explicit path and metadata conditions work together with typed list and missing-key semantics',async t=>{
 const f=await fixture(t);
 await f.put('Projects/match.md','---\ntype: [meeting, note]\nauthor: Ada\nproject: {team: infrastructure}\n---\n# Included\n');
 await f.put('Projects/no.md','---\nauthor: Other\n---\n# Excluded\n');await f.put('Elsewhere/match.md','---\nauthor: Ada\n---\n# Outside\n');
 const filter={and:[{field:'metadata.type',operator:'all',value:['meeting','note']},{field:'metadata.author',operator:'eq',value:'Ada'},{field:'metadata.project.team',operator:'eq',value:'infrastructure'},{not:{field:'metadata.status',operator:'eq',value:'superseded'}}]};
 const c=await f.catalog.addCollection({name:'Explicit rules',root:f.root,path_prefixes:['Projects/'],metadata_filter:filter});
 const scan=await f.catalog.reconcile(c.collection_id);assert.equal(scan.counts.eligible,1);assert.equal(scan.counts.excluded_metadata,1);assert.equal(scan.counts.excluded_pattern,1);
 assert.equal(f.catalog.documents(c.collection_id).find(d=>d.eligibility==='eligible').relative_path,'Projects/match.md');
 for(const prefix of ['/absolute/','../escape/','glob*/','no-trailing-slash'])assert.equal(CollectionRequest.safeParse({name:'invalid',root:f.root,path_prefixes:[prefix]}).success,false);
 assert.equal(CollectionRequest.safeParse({name:'invalid',root:f.root,metadata_filter:{field:'document_key',operator:'eq',value:'x'}}).success,false);
});

test('headings only suppress body content when explicitly configured',async()=>{
 const text='# Guide\n\n## 학습 탐색\n\nThis paragraph is actual content.\n';
 const compile=headings=>compileDocument({doc_id:'doc',revision_id:'rev',text,fallback_title:'Guide',navigation_headings:headings},async()=>({embeddingTokens:20,embeddingChunks:1,searchChunks:1,safe:true}));
 assert.ok((await compile([])).passages.some(p=>p.text.includes('actual content')));
 const excluded=await compile(['학습 탐색']);assert.equal(excluded.passages.length,0);assert.ok(excluded.coverage.some(b=>b.state==='excluded_navigation'));
});

test('v4 upgrade privately backs up WAL data and preserves IDs, revisions, and legacy membership',async t=>{
 const {f,id,before,scope}=await legacyFixture(t),catalog=await f.reopen();
 assert.equal(f.state.db.prepare('PRAGMA user_version').get().user_version,5);
 const policy=JSON.parse(catalog.collection(id).scope_json);assert.equal(policy.version,2);assert.equal(policy.preset,'general');assert.equal(policy.metadata_mode,'legacy-v1');assert.equal(policy.path_prefixes.length,3);
 assert.equal(catalog.migrationInfo(id).status,'unverified');assert.equal(catalog.policyUpgradePending,true);
 const backups=await readdir(join(f.data,'backups'));assert.equal(backups.length,1);assert.equal((await stat(join(f.data,'backups',backups[0]))).mode&0o777,0o600);
 const snapshot=new DatabaseSync(join(f.data,'backups',backups[0]),{readOnly:true});
 try{assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version,4);assert.equal(snapshot.prepare('SELECT scope_json FROM collections WHERE collection_id=?').get(id).scope_json,scope);assert.equal(snapshot.prepare('SELECT count(*) AS n FROM source_documents').get().n,before.length);}finally{snapshot.close();}
 assert.throws(()=>catalog.markPoliciesIndexed([id]),{code:'COMPATIBILITY_FAILED'});
 await catalog.reconcile(id);
 const after=catalog.documents(id).map(d=>({id:d.doc_id,path:d.relative_path,revision:d.latest_revision_id,eligible:d.eligibility==='eligible'}));assert.deepEqual(after,before);
 assert.equal(catalog.migrationInfo(id).status,'matched');assert.ok(catalog.migrationInfo(id).checked_entries>0);
 const currentScope=catalog.collection(id).scope_json;await f.reopen();assert.equal(f.catalog.collection(id).scope_json,currentScope);assert.equal((await readdir(join(f.data,'backups'))).filter(p=>p.endsWith('.sqlite')).length,1);
});

test('legacy metadata relaxation is previewed and requires an explicit scope edit',async t=>{
 const {f,id}=await legacyFixture(t),catalog=await f.reopen();await catalog.reconcile(id);
 const seq=f.state.sourceSeq,prior=catalog.collection(id).scope_json;
 const preview=await catalog.previewPatch(id,{legacy_compatibility:false});assert.deepEqual(preview.changes,{added:1,removed:0,unchanged:1});assert.equal(catalog.collection(id).scope_json,prior);assert.equal(f.state.sourceSeq,seq);
 catalog.patch(id,{legacy_compatibility:false});assert.equal(catalog.migrationInfo(id).reviewed,true);
 const scan=await catalog.reconcile(id);assert.equal(scan.counts.eligible,2);assert.equal(JSON.parse(catalog.collection(id).scope_json).metadata_mode,'general');
});

test('scope conversion disagreement blocks publication before new source rows are admitted',async t=>{
 const {f,id,before}=await legacyFixture(t),catalog=await f.reopen();
 const policy=JSON.parse(catalog.collection(id).scope_json);policy.path_prefixes=[];const changed=canonicalJSON(policy);
 f.state.db.prepare('UPDATE collections SET scope_json=?,scope_fp=? WHERE collection_id=?').run(changed,digest(changed),id);
 await assert.rejects(catalog.reconcile(id),{code:'COMPATIBILITY_FAILED'});assert.equal(catalog.migrationInfo(id).status,'changed');
 assert.deepEqual(catalog.documents(id).map(d=>d.doc_id),before.map(d=>d.id));assert.throws(()=>catalog.markPoliciesIndexed([id]),{code:'COMPATIBILITY_FAILED'});
});


test('migration rejects altered scope fingerprints without changing the old database',async t=>{
 const {f,id,scope}=await legacyFixture(t),seq=f.state.sourceSeq;
 f.state.db.prepare('UPDATE collections SET scope_fp=? WHERE collection_id=?').run('0'.repeat(64),id);
 await assert.rejects(f.reopen(),{code:'COMPATIBILITY_FAILED'});
 const db=new DatabaseSync(join(f.data,'state.sqlite'));
 try { assert.equal(db.prepare('PRAGMA user_version').get().user_version,4);assert.equal(db.prepare('SELECT scope_json FROM collections WHERE collection_id=?').get(id).scope_json,scope);assert.equal(db.prepare('SELECT source_seq FROM catalog_meta WHERE slot=1').get().source_seq,seq);assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='scope_migrations'").get().n,0); } finally { db.close(); }
});

test('linked backup and preview directories are rejected before writing private state',async t=>{
 const {f}=await legacyFixture(t),outside=join(f.data,'outside');await mkdir(outside);
 await symlink(outside,join(f.data,'backups'));
 await assert.rejects(f.reopen(),{code:'SCOPE_DENIED'});assert.deepEqual(await readdir(outside),[]);
 // A fresh database isolates preview rejection from the deliberately blocked migration.
 const state=await StateStore.open(join(f.data,'preview-data'));
 try { await symlink(outside,join(state.root,'previews'));await assert.rejects(new Catalog(state).preview({name:'Example',root:f.root}),{code:'SCOPE_DENIED'});assert.deepEqual(await readdir(outside),[]); } finally { state.close(); }
});


test('explicit registration after removing a migrated collection replaces its rules and preserves identity',async t=>{
 const {f,id}=await legacyFixture(t),catalog=await f.reopen();catalog.unregister(id);
 const restored=await catalog.addCollection({name:'New explicit registration',root:f.root});assert.equal(restored.collection_id,id);
 assert.equal(catalog.migrationInfo(id).reviewed,true);assert.equal(catalog.migrationInfo(id).status,'matched');
 assert.equal(JSON.parse(restored.scope_json).metadata_mode,'general');
 const scan=await catalog.reconcile(id);assert.equal(scan.counts.eligible,6);
});
