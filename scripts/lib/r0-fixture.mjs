import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {compileProbeDocument,normalizeSource,sourceIntersection,sourcePoint} from '../../packages/compiler/dist/index.js';
import {validateEvaluationSplit} from '../../packages/evaluation/dist/index.js';
export async function createFixture(folder){
 const root=resolve(import.meta.dirname,'../..');
 const corpusBytes=await readFile(join(root,'fixtures/synthetic/r0/corpus.json'));
 const manifest=JSON.parse(await readFile(join(root,'fixtures/synthetic/r0/evaluation-manifest.json'),'utf8'));
 const digest=createHash('sha256').update(corpusBytes).digest('hex');if(digest!==manifest.corpus_sha256)throw new Error('Evaluation fixture changed after freezing');
 const corpus=JSON.parse(corpusBytes.toString('utf8'));
 const splits=validateEvaluationSplit(corpus.queries.map(q=>({id:q.id,split:q.split,groups:Object.keys(q.relevance).map(id=>corpus.documents.find(d=>d.id===id).group)})),false);
 if(splits.tuning!==20||splits.holdout!==0)throw new Error('Frozen synthetic development split changed');
 await mkdir(join(folder,'raw'),{recursive:true});await mkdir(join(folder,'projection'),{recursive:true});
 const rawMap={},projectionMap={};let mapped=0;
 for(const doc of corpus.documents){
  const bytes=Buffer.from(doc.body),normalized=normalizeSource(bytes),rawName=doc.id+'.md';
  await writeFile(join(folder,'raw',rawName),bytes);rawMap[rawName]={docId:doc.id,source:normalized.text};
  const projections=compileProbeDocument(normalized.text,doc.title);
  for(const [i,projection] of projections.entries()){
   if(projection.lexicalOnly)throw new Error('Unexpected oversized development fixture');
   const span=sourceIntersection(projection,0,projection.text.length);
   if(!span||projection.text.slice(projection.projectionStart)!==normalized.text.slice(span.start,span.end))throw new Error('Source map mismatch');
   if(sourceIntersection(projection,0,projection.projectionStart)!==null)throw new Error('Generated evidence accepted');
   const name=doc.id+'-'+i+'.md';await writeFile(join(folder,'projection',name),projection.text);
   projectionMap[name]={docId:doc.id,source:normalized.text,...projection,locator:{kind:'markdown',start:sourcePoint(normalized.text,span.start),end:sourcePoint(normalized.text,span.end)}};mapped++;
  }
 }
 const mapping={raw:rawMap,projection:projectionMap};
 await writeFile(join(folder,'source-maps.json'),JSON.stringify(mapping,null,2)+'\n');
 return {corpus,manifest,mapping,sourceMapChecks:mapped};
}
export function hitName(file){return decodeURIComponent(file.replace(/^qmd:\/\/[^/]+\//,''));}
