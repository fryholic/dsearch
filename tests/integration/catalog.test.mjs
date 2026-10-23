import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rename,copyFile,rm,symlink,chmod,stat,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Catalog,StateStore,parseMetadata,canonicalJSON} from '../../packages/catalog/dist/index.js';
async function fixture(t){
 const folder=await mkdtemp(join(tmpdir(),'dsearch-catalog-')),root=join(folder,'source');await mkdir(root);
 const state=await StateStore.open(join(folder,'data')),catalog=new Catalog(state);
 t.after(async()=>{state.close();await rm(folder,{recursive:true,force:true});});
 return {folder,root,state,catalog,put:async(name,text)=>{await mkdir(join(root,name,'..'),{recursive:true});await writeFile(join(root,name),text);}};
}
const current=(catalog,id)=>catalog.documents(id).filter(d=>d.present);
const request=doc=>({doc_id:doc.doc_id,revision_id:doc.latest_revision_id,locator:{kind:'markdown',start:{line:1,column_utf16:0},end:{line:1,column_utf16:0}}});

test('general collection explains scope, preserves source bytes and retains stable state on unchanged reconciliation',async t=>{
 const {root,state,catalog,put,folder}=await fixture(t),raw=Buffer.from('\ufeff---\r\ntitle: 한글\r\n---\r\n# 시험 😀\r\n\r\n원문 e\u0301\r\n');
 await put('수학.md',raw);await put('.hidden/private.md','# Hidden');await put('node_modules/dep/readme.md','# Dependency');await put('notes.txt','not markdown');await put('Sources/raw.md','# Ordinary general document');
 const collection=await catalog.addCollection({name:'일반',root});
 const scan=await catalog.reconcile(collection.collection_id);assert.equal(scan.counts.eligible,2);assert.equal(scan.counts.excluded_pattern,1);assert.equal(scan.boundaries.length,2);assert.equal(scan.scope_incomplete,false);
 assert.deepEqual(await readFile(join(root,'수학.md')),raw);const seq=state.sourceSeq;
 const again=await catalog.reconcile(collection.collection_id);assert.equal(state.sourceSeq,seq);assert.deepEqual(again.documents.map(d=>d.doc_id),scan.documents.map(d=>d.doc_id));
 assert.equal((await stat(join(folder,'data/state.sqlite'))).mode&0o777,0o600);
 const reopened=await StateStore.open(join(folder,'data'));try{assert.equal(new Catalog(reopened).listCollections().length,1);assert.equal(reopened.sourceSeq,seq);}finally{reopened.close();}
 await assert.rejects(catalog.addCollection({name:'missing',root:join(root,'absent')}),{code:'SCOPE_DENIED'});await assert.rejects(stat(join(root,'absent')),{code:'ENOENT'});
 await assert.rejects(catalog.addCollection({name:'data',root:state.root}),{code:'SCOPE_DENIED'});
});

test('learning preset independently classifies role, status, source and malformed frontmatter',async t=>{
 const {root,catalog,put}=await fixture(t),prefix='30_Resources/Crypto/';
 for(const [name,front] of [['lesson','role: lesson'],['concept','type: concept'],['old','role: concept\nstatus: superseded'],['role','role: dashboard'],['source','role: source'],['bad','role: concept\nrole: lesson'],['typed','role: [concept]']])await put(prefix+name+'.md','---\n'+front+'\n---\n# '+name+'\n');
 await put(prefix+'Sources/raw.md','# Raw');await put('elsewhere.md','# Outside');
 const collection=await catalog.addCollection({name:'학습',root,preset:'learning',exclude:['**/skip/**']});const report=await catalog.reconcile(collection.collection_id);
 assert.equal(report.counts.eligible,2);assert.equal(report.counts.excluded_status,1);assert.equal(report.counts.excluded_role,1);assert.equal(report.counts.excluded_source,1);assert.equal(report.counts.invalid_metadata,2);assert.equal(report.counts.excluded_pattern,1);assert.ok(report.boundaries.some(b=>b.reason==='source_directory'));
});

test('offline rename preserves identity, copies and deleted-path replacements receive distinct IDs',async t=>{
 const {root,catalog,put}=await fixture(t);await put('first.md','# 공통 제목\n\n같은 내용');const col=await catalog.addCollection({name:'identity',root});await catalog.reconcile(col.collection_id);
 const original=current(catalog,col.collection_id)[0];await rename(join(root,'first.md'),join(root,'moved.md'));await catalog.reconcile(col.collection_id);
 let moved=current(catalog,col.collection_id)[0];assert.equal(moved.doc_id,original.doc_id);assert.equal(moved.latest_revision_id,original.latest_revision_id);
 await copyFile(join(root,'moved.md'),join(root,'copy.md'));await catalog.reconcile(col.collection_id);const copy=current(catalog,col.collection_id).find(d=>d.relative_path==='copy.md');assert.notEqual(copy.doc_id,original.doc_id);
 // A move and a replacement of the old path in the same scan must not collide.
 await rename(join(root,'moved.md'),join(root,'again.md'));await put('moved.md','# New path occupant');await catalog.reconcile(col.collection_id);
 const rows=current(catalog,col.collection_id);assert.equal(rows.find(d=>d.relative_path==='again.md').doc_id,original.doc_id);assert.notEqual(rows.find(d=>d.relative_path==='moved.md').doc_id,original.doc_id);
 await rm(join(root,'copy.md'));await catalog.reconcile(col.collection_id);assert.equal(catalog.document(copy.doc_id).present,0);
 await copyFile(join(root,'again.md'),join(root,'copy.md'));await catalog.reconcile(col.collection_id);assert.notEqual(current(catalog,col.collection_id).find(d=>d.relative_path==='copy.md').doc_id,copy.doc_id);
});

test('read verifies full bytes despite equal size and restored mtime, and requires the expected revision',async t=>{
 const {root,catalog,put}=await fixture(t);await put('file.md','# Same\n\nAAAA');const col=await catalog.addCollection({name:'freshness',root});await catalog.reconcile(col.collection_id);let doc=current(catalog,col.collection_id)[0];
 const prior=await stat(join(root,'file.md'));await put('file.md','# Same\n\nBBBB');await utimes(join(root,'file.md'),prior.atime,prior.mtime);
 await assert.rejects(catalog.read(request(doc)),{code:'STALE_REVISION'});await catalog.reconcile(col.collection_id);const changed=current(catalog,col.collection_id)[0];assert.equal(changed.doc_id,doc.doc_id);assert.notEqual(changed.latest_revision_id,doc.latest_revision_id);
 await assert.rejects(catalog.read(request(doc)),{code:'STALE_REVISION'});assert.ok((await catalog.read(request(changed))).text.includes('# Same'));
 await put('file.md',Buffer.from([0xff]));await catalog.reconcile(col.collection_id);assert.equal(catalog.document(doc.doc_id).eligibility,'unsupported_encoding');await assert.rejects(catalog.read(request(changed)),{code:'SCOPE_DENIED'});
});

test('reads validate normalized UTF16 locators and explicit line/byte output bounds',async t=>{
 const {root,catalog,put}=await fixture(t);await put('file.md','\ufeff# 제목\r\n\r\n한글 😀 e\u0301\r\n'+Array(220).fill('line').join('\r\n'));const col=await catalog.addCollection({name:'locators',root});await catalog.reconcile(col.collection_id);const doc=current(catalog,col.collection_id)[0],base=request(doc);
 const value=await catalog.read({...base,locator:{kind:'markdown',start:{line:3,column_utf16:3},end:{line:3,column_utf16:5}}});assert.equal(value.text,'한글 😀 e\u0301');assert.equal(value.start_line,3);
 const limited=await catalog.read({...base,locator:{kind:'markdown',start:{line:1,column_utf16:0},end:{line:220,column_utf16:0}},max_lines:200});assert.equal(limited.end_line,200);assert.equal(limited.truncated,true);
 await assert.rejects(catalog.read({...base,locator:{kind:'markdown',start:{line:999,column_utf16:0},end:{line:999,column_utf16:0}}}),{code:'INVALID_LOCATOR'});
 await assert.rejects(catalog.read({...base,locator:{kind:'markdown',start:{line:3,column_utf16:99},end:{line:3,column_utf16:99}}}),{code:'INVALID_LOCATOR'});
});

test('scope changes, disabling and symlink swaps block reads immediately without waiting for a scan',async t=>{
 const {root,catalog,put,folder}=await fixture(t);await put('file.md','# Inside');await put('nested/a.md','# Nested');await writeFile(join(folder,'outside.md'),'# Outside sentinel');
 const col=await catalog.addCollection({name:'boundary',root});await catalog.reconcile(col.collection_id);const doc=current(catalog,col.collection_id).find(d=>d.relative_path==='file.md');
 catalog.setScope(col.collection_id,{exclude:['file.md']});await assert.rejects(catalog.read(request(doc)),{code:'SCOPE_DENIED'});
 catalog.setScope(col.collection_id,{exclude:[]});catalog.setEnabled(col.collection_id,false);await assert.rejects(catalog.read(request(doc)),{code:'SCOPE_DENIED'});catalog.setEnabled(col.collection_id,true);
 await rm(join(root,'file.md'));await symlink(join(folder,'outside.md'),join(root,'file.md'));await assert.rejects(catalog.read(request(doc)),{code:'SCOPE_DENIED'});
 const report=await catalog.reconcile(col.collection_id);assert.equal(report.documents.find(d=>d.doc_id===doc.doc_id).present,0);assert.equal(current(catalog,col.collection_id).find(d=>d.relative_path==='file.md').eligibility,'excluded_source');
 await rename(join(root,'nested'),join(folder,'original-nested'));await symlink(join(folder,'original-nested'),join(root,'nested'));const nested=report.documents.find(d=>d.relative_path==='nested/a.md');await assert.rejects(catalog.read(request(nested)),{code:'SCOPE_DENIED'});
});

test('an inaccessible subtree is scope-incomplete and never silently becomes a deletion',async t=>{
 const {root,catalog,put}=await fixture(t);await put('locked/file.md','# Keep identity');const col=await catalog.addCollection({name:'access',root});await catalog.reconcile(col.collection_id);const doc=current(catalog,col.collection_id)[0];
 await chmod(join(root,'locked'),0);
 try{const report=await catalog.reconcile(col.collection_id);assert.equal(report.scope_incomplete,true);assert.equal(catalog.document(doc.doc_id).present,1);assert.equal(catalog.document(doc.doc_id).eligibility,'unreadable');}
 finally{await chmod(join(root,'locked'),0o700);}
 await catalog.reconcile(col.collection_id);assert.equal(current(catalog,col.collection_id)[0].doc_id,doc.doc_id);assert.equal(current(catalog,col.collection_id)[0].eligibility,'eligible');
});

test('cancellation and discovery limits never commit a partial or empty replacement catalog',async t=>{
 const {root,catalog,put,state}=await fixture(t);await put('a.md','# A');await put('b.md','# B');const col=await catalog.addCollection({name:'cancellation',root});await catalog.reconcile(col.collection_id);const before=state.sourceSeq,ids=current(catalog,col.collection_id).map(d=>d.doc_id);
 await assert.rejects(catalog.reconcile(col.collection_id,{signal:AbortSignal.abort()}),{code:'CANCELLED'});await assert.rejects(catalog.reconcile(col.collection_id,{maxEntries:1}),{code:'SCOPE_INCOMPLETE'});assert.equal(state.sourceSeq,before);assert.deepEqual(current(catalog,col.collection_id).map(d=>d.doc_id),ids);
 const first=catalog.reconcile(col.collection_id);await assert.rejects(catalog.reconcile(col.collection_id),{code:'BUSY'});await first;
});

test('YAML validation rejects duplicate keys, aliases, recursive budgets and incorrect types',()=>{
 assert.deepEqual(parseMetadata('---\ntopics: [ECC, ECDSA]\n---\ntext').metadata,{topics:['ECC','ECDSA']});assert.equal(canonicalJSON({z:1,a:{b:2,a:1}}),'\x7b"a":\x7b"a":1,"b":2\x7d,"z":1\x7d');
 for(const yaml of ['role: lesson\nrole: concept','role: [concept]','topics: text','x: !unknown tag','x: &recursive [*recursive]','- list item'])assert.throws(()=>parseMetadata('---\n'+yaml+'\n---\ntext'),{code:'INVALID_METADATA'});
 assert.throws(()=>parseMetadata('---\nunclosed'),{code:'INVALID_METADATA'});
});

test('literal byte, deadline and entry budgets preserve unvisited identities and report actual bytes',async t=>{
 const {root,catalog,put}=await fixture(t);await put('a.md','# A');await put('b.md','# B');await put('c.md',Buffer.from([255]));const col=await catalog.addCollection({name:'budget',root});await catalog.reconcile(col.collection_id);const ids=current(catalog,col.collection_id).map(d=>d.doc_id);
 const options={captureSources:true,budget:{maxBytesPerFile:10,maxTotalBytes:3,deadline:Date.now()+5000}};
 const capped=await catalog.reconcile(col.collection_id,options);assert.equal(capped.stop_reason,'byte_limit');assert.equal(capped.read_bytes,3);assert.equal(capped.captured_sources.length,1);assert.deepEqual(current(catalog,col.collection_id).map(d=>d.doc_id),ids);
 const expired=await catalog.reconcile(col.collection_id,{...options,budget:{...options.budget,deadline:0}});assert.equal(expired.stop_reason,'time_limit');assert.equal(expired.read_bytes,0);assert.deepEqual(current(catalog,col.collection_id).map(d=>d.doc_id),ids);
 const entry=await catalog.reconcile(col.collection_id,{...options,maxEntries:1,budget:{...options.budget,maxTotalBytes:100}});assert.equal(entry.stop_reason,'entry_limit');assert.deepEqual(current(catalog,col.collection_id).map(d=>d.doc_id),ids);
 const complete=await catalog.reconcile(col.collection_id,{...options,budget:{...options.budget,maxTotalBytes:100}});assert.equal(complete.read_bytes,7);assert.equal(complete.counts.unsupported_encoding,1);
 const doc=current(catalog,col.collection_id).find(d=>d.relative_path==='a.md');const eof=await catalog.read({...request(doc),locator:{kind:'markdown',start:{line:1,column_utf16:0},end:{line:2,column_utf16:0}}});assert.equal(eof.text,'# A');
});

test('v2 product state migrates scan completeness without altering existing source identity',async t=>{
 const {state,folder,root,catalog,put}=await fixture(t);await put('one.md','# one');const col=await catalog.addCollection({name:'migration',root});await catalog.reconcile(col.collection_id);const id=current(catalog,col.collection_id)[0].doc_id;state.db.exec('DROP TABLE collection_scans; PRAGMA user_version=2;');
 const reopened=await StateStore.open(join(folder,'data'));try{const migrated=new Catalog(reopened);assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version,4);assert.equal(migrated.scanStatus(col.collection_id).status,'unscanned');assert.equal(current(migrated,col.collection_id)[0].doc_id,id);await migrated.reconcile(col.collection_id);assert.equal(migrated.scanStatus(col.collection_id).status,'complete');}finally{reopened.close();}
});


test('legacy scope extraction preserves general and existing learning boundaries', async () => {
 const {pathEligibility}=await import('../../packages/catalog/dist/policy.js');
 const {legacyNavigationHeadings}=await import('../../packages/catalog/dist/index.js');
 for(const preset of ['general','learning']) {
  const policy={preset,include:['**/*.md'],exclude:[],root_file_key:'fixture'};
  for(const path of ['documents/backup.md','30_Resources/Networking/lesson.md','30_resources/Crypto/lesson.md'])
   assert.equal(pathEligibility(path,policy).eligibility,preset==='general'?'eligible':'excluded_pattern');
  assert.equal(pathEligibility('30_Resources/Crypto/lesson.md',policy).eligibility,'eligible');
  assert.equal(pathEligibility('30_Resources/Crypto/Sources/raw.md',policy).eligibility,preset==='general'?'eligible':'excluded_source');
 }
 assert.deepEqual(legacyNavigationHeadings('general'),[]);
 assert.deepEqual(legacyNavigationHeadings('learning'),['목차','학습 탐색','이전·다음']);
});
