import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSource,compileProbeDocument,sourceIntersection,sourcePoint} from '../../packages/compiler/dist/index.js';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('source map preserves Korean, decomposed text, emoji and CRLF positions without mutating bytes',()=>{
 const raw=Buffer.from('\uFEFF# 수학\r\n\r\n한글 e\u0301 😀 정의\r\n\r\n$$\r\nQ=dG\r\n$$\r\n\r\n조건과 위수 설명\r\n');const original=Buffer.from(raw);
 const normalized=normalizeSource(raw);const chunks=compileProbeDocument(normalized.text,'시험');
 assert.deepEqual(raw,original);assert.notEqual(normalized.rawSha256,normalized.textSha256);assert.equal(chunks.length,1);
 const chunk=chunks[0];const span=sourceIntersection(chunk,0,chunk.text.length);
 assert.equal(chunk.text.slice(chunk.projectionStart),normalized.text.slice(span.start,span.end));
 assert.equal(sourceIntersection(chunk,0,chunk.projectionStart),null);
 const emoji=normalized.text.indexOf('😀');assert.equal(sourcePoint(normalized.text,emoji+2).column_utf16-sourcePoint(normalized.text,emoji).column_utf16,2);
 assert.throws(()=>normalizeSource(Uint8Array.of(0xff)));
});
test('code fences do not introduce headings and atomic overflow is kept intact for lexical-only handling',()=>{
 const source='# 실제 제목\n\n설명\n\n```txt\n# 코드 안의 제목\n$$\n'+('x'.repeat(2500))+'\n```\n\n코드 조건\n';
 const chunks=compileProbeDocument(source,'문서');assert.ok(chunks.every(c=>c.heading.join('/')==='실제 제목'));
 const overflow=chunks.find(c=>c.lexicalOnly);assert.ok(overflow);assert.ok(overflow.text.includes('```txt\n# 코드 안의 제목'));
 assert.ok(overflow.text.includes('코드 조건'));assert.ok(overflow.text.includes('설명'));
});
test('filesystem NFC/NFD names and duplicate titles retain separate source mappings for table, math and code',async()=>{
 const fixture=JSON.parse(await readFile(new URL('../../fixtures/synthetic/r0/source-boundaries.json',import.meta.url),'utf8'));
 const folder=await mkdtemp(join(tmpdir(),'dsearch-source-'));
 try{
  const documents=[];
  for(const entry of fixture.cases){
   const dir=join(folder,entry.directory);await mkdir(dir);
   const path=join(dir,entry.filename),raw=Buffer.from(entry.body);await writeFile(path,raw);
   const listed=await readdir(dir);assert.equal(listed.length,1);assert.equal(listed[0].normalize('NFC'),entry.filename.normalize('NFC'));
   const bytes=await readFile(join(dir,listed[0]));assert.deepEqual(bytes,raw);
   const normalized=normalizeSource(bytes),chunks=compileProbeDocument(normalized.text,entry.title);
   assert.equal(chunks.length,1);
   for(const chunk of chunks){
    const span=sourceIntersection(chunk,0,chunk.text.length);assert.ok(span);
    assert.equal(chunk.text.slice(chunk.projectionStart),normalized.text.slice(span.start,span.end));
    assert.equal(sourceIntersection(chunk,0,chunk.projectionStart),null);
   }
   documents.push({path,title:entry.title,chunk:chunks[0]});
  }
  assert.equal(documents[0].title,documents[1].title);assert.notEqual(documents[0].path,documents[1].path);
  assert.ok(documents[0].chunk.text.includes('| $p$ |'));assert.ok(documents[0].chunk.text.includes('$$\nQ=dG\n$$'));
  assert.ok(documents[1].chunk.text.includes('# This is code, not a heading'));assert.deepEqual(documents[1].chunk.heading,['공통 제목']);
 }finally{await rm(folder,{recursive:true,force:true});}
});
