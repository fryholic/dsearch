import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compileDocument,normalizeSource,primaryIntersections,validateSourceMap} from '../../packages/compiler/dist/index.js';
// A deterministic fixture inspector tests compiler control flow; native tokenizer gates are separate.
const fixtureInspector=async text=>({embeddingTokens:text.split(/\s+/).length,embeddingChunks:1,searchChunks:1,safe:true});
const base={doc_id:'doc-one',revision_id:'revision-one',fallback_title:'시험'};
const primary=(passage,text)=>primaryIntersections(passage,0,passage.text.length).map(r=>text.slice(r.start,r.end)).join('');

test('production compiler preserves frontmatter positions, math definitions/conditions and fenced code boundaries',async()=>{
 const text=normalizeSource(Buffer.from('\ufeff---\r\nrole: concept\r\n---\r\n# ECC 😀\r\n\r\n개인키 정의 e\u0301\r\n\r\n$$\r\nQ=dG\r\n$$\r\n\r\n$$\r\nR=kG\r\n$$\r\n\r\n위수 조건이다.\r\n\r\n~~~txt\r\n# 코드 제목\r\n$$\r\n~~~\r\n\r\n코드의 설명.\r\n')).text;
 const result=await compileDocument({...base,text,metadata:{role:'concept'}},fixtureInspector);
 assert.equal(result.metadata_range.start,0);assert.ok(result.metadata_range.end>0);assert.equal(result.passages.length,1);
 const passage=result.passages[0],body=primary(passage,text);assert.ok(body.includes('개인키 정의'));assert.ok(body.includes('R=kG'));assert.ok(body.includes('위수 조건'));assert.ok(body.includes('# 코드 제목'));assert.deepEqual(passage.heading,['ECC 😀']);
 assert.ok(result.coverage.every(b=>b.state==='semantic'));assert.ok(!body.includes('role: concept'));validateSourceMap(passage,text);
});

test('long ordinary paragraphs split at source boundaries while every byte-equivalent UTF16 unit remains covered',async()=>{
 const paragraph=('Korean 한글 😀 and e\u0301 source words. ').repeat(250),text='# Long\n\n'+paragraph;
 const result=await compileDocument({...base,text},fixtureInspector);assert.ok(result.passages.length>2);assert.ok(result.passages.every(p=>p.kind==='semantic'&&p.text.length<=2400&&p.embedding_tokens<=800));
 const bodies=result.passages.map(p=>primary(p,text));assert.ok(bodies.join('')===paragraph,'Paragraph source bytes must remain contiguous and complete, including trailing whitespace');
 assert.ok(result.coverage.filter(b=>b.type==='paragraph').every(b=>b.passages.length>1));
 for(const passage of result.passages)validateSourceMap(passage,text);
});

test('oversized presentation groups split tables with repeated context while retaining an indivisible code line',async()=>{
 const code='코드 정의\n\n```text\n'+('x'.repeat(2700))+'\n```\n\n코드 조건';
 const table='표 정의\n\n| 값 | 조건 |\n| --- | --- |\n'+Array(180).fill('| 한글 | 조건 😀 |').join('\n')+'\n\n표 조건';
 const text='# Code\n\n'+code+'\n\n# Table\n\n'+table;
 const result=await compileDocument({...base,text},fixtureInspector),lexical=result.passages.filter(p=>p.kind==='lexical_only');assert.equal(lexical.length,1);assert.ok(primary(lexical[0],text).includes('x'.repeat(2700)));
 const tables=result.passages.filter(p=>p.heading.includes('Table')&&p.text.includes('| --- | --- |'));assert.ok(tables.length>1);assert.ok(tables.every(p=>p.kind==='semantic'));assert.ok(tables.slice(1).every(p=>p.segments.some(s=>s.kind==='source'&&s.context&&text.slice(s.source_start,s.source_end).includes('| 값 | 조건 |'))));
 assert.equal(tables.map(p=>primary(p,text)).join('').match(/\| 값 \| 조건 \|/g).length,1);
 for(const p of result.passages)validateSourceMap(p,text);
});

test('fenced code chunks repeat the original language/fences as context and partition primary source',async()=>{
 const code='````python\n'+Array.from({length:180},(_,i)=>'print("value '+i+' 한글 😀")').join('\n')+'\n````',text='# Script\n\n'+code;
 const result=await compileDocument({...base,text},fixtureInspector);assert.ok(result.passages.length>1);assert.ok(result.passages.every(p=>p.kind==='semantic'&&p.text.includes('````python')&&p.text.includes('\n````')));assert.equal(result.passages.map(p=>primary(p,text)).join(''),code);assert.ok(result.passages.slice(1).every(p=>p.segments.some(s=>s.kind==='source'&&s.context&&text.slice(s.source_start,s.source_end)==='````python\n')));
});

test('unspaced text splits only at grapheme boundaries without altering emoji, combining marks or source bytes',async()=>{
 const paragraph='👩‍💻e\u0301가🇰🇷'.repeat(500),text='# Graphemes\n\n'+paragraph,result=await compileDocument({...base,text},fixtureInspector),offset=text.indexOf(paragraph),boundaries=new Set([0,...[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(paragraph)].map(s=>s.index+s.segment.length)]);
 assert.ok(result.passages.length>2);assert.ok(result.passages.every(p=>p.kind==='semantic'));assert.equal(result.passages.map(p=>primary(p,text)).join(''),paragraph);
 for(const p of result.passages)for(const r of primaryIntersections(p,0,p.text.length)){assert.ok(boundaries.has(r.start-offset));assert.ok(boundaries.has(r.end-offset));}
});

test('oversized equation groups retain definitions and conditions as an explicitly lexical atomic unit',async()=>{
 const body='정의 '+('word '.repeat(500))+'\n\n$$\nQ=dG\n$$\n\n조건 '+('word '.repeat(500)),text='# Math\n\n'+body,result=await compileDocument({...base,text},fixtureInspector);assert.equal(result.passages.length,1);assert.equal(result.passages[0].kind,'lexical_only');assert.equal(primary(result.passages[0],text),body);
});

test('passage IDs distinguish duplicate sections/documents and remain stable across revision-only changes',async()=>{
 const text='# Repeated\n\nThe same source.\n\n# Repeated\n\nThe same source.';
 const first=await compileDocument({...base,text},fixtureInspector),revision=await compileDocument({...base,text,revision_id:'revision-two'},fixtureInspector),copy=await compileDocument({...base,text,doc_id:'doc-copy'},fixtureInspector);
 assert.equal(first.passages.length,2);assert.notEqual(first.passages[0].passage_id,first.passages[1].passage_id);assert.deepEqual(first.passages.map(p=>p.passage_id),revision.passages.map(p=>p.passage_id));assert.notEqual(first.passages[0].passage_id,copy.passages[0].passage_id);
});

test('generated metadata and repeated heading context never independently provide primary source evidence',async()=>{
 const text='# Original heading\n\nActual body source.';const result=await compileDocument({...base,text},fixtureInspector),passage=result.passages[0];
 for(const segment of passage.segments.filter(s=>s.kind==='generated'||s.context))assert.deepEqual(primaryIntersections(passage,segment.projection_start,segment.projection_end),[]);
 assert.equal(primary(passage,text),'Actual body source.');const corrupt=structuredClone(passage);corrupt.text+='x';assert.throws(()=>validateSourceMap(corrupt,text),/SOURCE_MAP_MISMATCH/);
});

test('configured navigation is explained in coverage and input cancellation interrupts compilation',async()=>{
 const text='# Lesson\n\nDefinition.\n\n## 목차\n\n[다음](next.md)\n\n## 본문\n\nActual explanation.';
 const result=await compileDocument({...base,text,navigation_headings:['목차']},fixtureInspector);assert.ok(result.coverage.some(b=>b.state==='excluded_navigation'));assert.ok(result.passages.every(p=>!primary(p,text).includes('[다음]')));
 await assert.rejects(compileDocument({...base,text,signal:AbortSignal.abort()},fixtureInspector),{code:'CANCELLED'});
});


test('splitting an oversized presentation group preserves blank lines between its original AST blocks',async()=>{
 const code='```python\n'+Array.from({length:180},(_,i)=>'print("source '+i+'")').join('\n')+'\n```',body='Definition and context.\n\n'+code+'\n\nCondition and explanation.',text='# Group\n\n'+body,result=await compileDocument({...base,text},fixtureInspector);
 assert.ok(result.passages.length>3);assert.ok(result.passages.every(p=>p.kind==='semantic'));assert.equal(result.passages.map(p=>primary(p,text)).join(''),body);
});
