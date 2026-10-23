import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {QmdWorker} from '../../packages/engine-qmd/dist/index.js';
import {compileDocument,primaryIntersections,validateSourceMap} from '../../packages/compiler/dist/index.js';
const root=resolve(import.meta.dirname,'../..');

test('production fragments satisfy both pinned native chunkers and preserve primary source independently of repeated context',async t=>{
 await mkdir(join(root,'.local/alpha'),{recursive:true});const folder=await mkdtemp(join(root,'.local/alpha/fragments-')),worker=new QmdWorker();
 try {
  await worker.open({engineRoot:join(root,'.local/qmd-upstream'),modelRoot:join(root,'.local/models'),dbPath:join(folder,'qmd.sqlite'),collectionPath:folder,embedRole:'embed',strict:true});
  const inspect=async(text,title,file)=>(await worker.invoke('inspect',{text,title,file})).result;
  const compile=text=>compileDocument({doc_id:'native-fragments',revision_id:'original-source',text,fallback_title:'Search examples'},inspect);
  const primary=(p,text)=>primaryIntersections(p,0,p.text.length).map(r=>text.slice(r.start,r.end)).join('');
  await t.test('table rows, language fences and unspaced graphemes all use real tokenizer budgets',async()=>{
   const table='| Item | 설명 |\n| --- | --- |\n'+Array.from({length:100},(_,i)=>'| item-'+i+' | 한글 e\u0301 😀 original row |').join('\n'),code='````python\n'+Array.from({length:140},(_,i)=>'print("row '+i+' 한글 😀")').join('\n')+'\n````',paragraph='👩‍💻e\u0301가🇰🇷'.repeat(300),text='# Table\n\n'+table+'\n\n# Code\n\n'+code+'\n\n# Graphemes\n\n'+paragraph,result=await compile(text);
   assert.ok(result.passages.length>6);assert.ok(result.passages.every(p=>p.kind==='semantic'&&p.embedding_tokens<=800&&p.text.length<=2400));
   for(const [heading,body] of [['Table',table],['Code',code],['Graphemes',paragraph]])assert.equal(result.passages.filter(p=>p.heading.includes(heading)).map(p=>primary(p,text)).join(''),body);
   for(const p of result.passages){const check=await inspect(p.text,result.title,'projection.md');assert.equal(check.safe,true);assert.equal(check.embeddingChunks,1);assert.equal(check.searchChunks,1);validateSourceMap(p,text);}
   const bodies=result.passages.filter(p=>p.heading.includes('Graphemes')).map(p=>primary(p,text)),boundaries=new Set([0,...[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(paragraph)].map(s=>s.index+s.segment.length)]);let end=0;for(const part of bodies){end+=part.length;assert.ok(boundaries.has(end));}
  });
  await t.test('an indivisible oversized row stays explicit while following rows remain semantic',async()=>{
   const table='| Item | Value |\n| --- | --- |\n| wide | '+('x'.repeat(5000))+' |\n| safe | Original source row |',text='# Rows\n\n'+table,result=await compile(text);
   assert.ok(result.passages.some(p=>p.kind==='lexical_only'&&p.reason==='projection_utf16_overflow'));assert.ok(result.passages.some(p=>p.kind==='semantic'&&primary(p,text).includes('Original source row')));assert.equal(result.passages.map(p=>primary(p,text)).join(''),table);
  });
 }finally{await worker.close();await rm(folder,{recursive:true,force:true});}
});
