import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {compileDocument,normalizeSource,validateSourceMap,primaryIntersections} from '../../packages/compiler/dist/index.js';
import {QmdWorker} from '../../packages/engine-qmd/dist/index.js';
const root=resolve(import.meta.dirname,'../..');
test('production compiler preserves complete source coverage with actual Qwen tokens and both engine chunkers',async()=>{
 await mkdir(join(root,'.local/alpha'),{recursive:true});const dir=await mkdtemp(join(root,'.local/alpha/compiler-'));await mkdir(join(dir,'docs'));
 const worker=new QmdWorker();
 try{
  await worker.open({engineRoot:join(root,'.local/qmd-upstream'),dbPath:join(dir,'qmd.sqlite'),collectionPath:join(dir,'docs'),modelRoot:join(root,'.local/models'),embedRole:'embed',strict:true});
  const paragraph=('한글 😀 e\u0301 공개키와 개인키를 사용하여 서명의 입력을 설명한다. ').repeat(100);
  const text=normalizeSource(Buffer.from('\ufeff---\r\nrole: concept\r\n---\r\n# ECC\r\n\r\n개인키를 정의한다.\r\n\r\n$$\r\nQ=dG\r\n$$\r\n\r\n위수는 n이다.\r\n\r\n## 설명\r\n\r\n'+paragraph+'\r\n\r\n## 코드\r\n\r\n설명\r\n\r\n```text\r\n'+('x'.repeat(2700))+'\r\n```\r\n\r\n조건')).text;
  const inspector=async(text,title,file)=>(await worker.invoke('inspect',{text,title,file})).result;
  const result=await compileDocument({doc_id:'native-source',revision_id:'revision-native',fallback_title:'source',metadata:{role:'concept'},text},inspector);
  assert.ok(result.passages.length>3);assert.ok(result.passages.some(p=>p.kind==='lexical_only'));assert.ok(result.passages.some(p=>p.kind==='semantic'));
  const checks=[];
  for(const passage of result.passages){
   validateSourceMap(passage,text);
   if(passage.kind==='semantic'){const check=await inspector(passage.text,result.title,'projection.md');assert.equal(check.safe,true);assert.equal(check.embeddingChunks,1);assert.equal(check.searchChunks,1);assert.ok(check.embeddingTokens<=800);checks.push({passage_id:passage.passage_id,...check});}
  }
  const reconstructed=result.passages.flatMap(p=>primaryIntersections(p,0,p.text.length)).map(s=>text.slice(s.start,s.end)).join('');assert.ok(reconstructed.includes('Q=dG'));assert.ok(reconstructed.includes(paragraph));assert.ok(reconstructed.includes('x'.repeat(2700)));
  assert.ok(result.coverage.every(b=>b.state!=='failed'));
  await mkdir(join(root,'artifacts/alpha'),{recursive:true});await writeFile(join(root,'artifacts/alpha/compiler-native.json'),JSON.stringify({schema_version:1,scope:'P2 production compiler native preflight on synthetic sources',semantic:checks,lexical_only:result.passages.filter(p=>p.kind==='lexical_only').map(p=>({passage_id:p.passage_id,reason:p.reason})),coverage:result.coverage},null,2)+'\n');
 }finally{await worker.close();await rm(dir,{recursive:true,force:true});}
});
