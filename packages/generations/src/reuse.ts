import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Catalog } from '@dsearch/catalog';
import { DsearchError } from '@dsearch/contracts';
import { QmdWorker, type OpenEngine } from '@dsearch/engine-qmd';
import { verifySeal } from './seal.js';
import type { GenerationDocument, IndexedPassage } from './builder.js';

export type SourceInput = { doc_id: string; revision_id: string; relative_path: string; scope_fp: string };
export type ReuseSnapshot = { directory: string; coverage: GenerationDocument[]; mappings: IndexedPassage[]; inputs: SourceInput[] };

/** Clone through the pinned SDK only; the old database remains a sealed reader. */
export async function snapshotForReuse(catalog: Catalog, fp: string, engine: OpenEngine, signal: AbortSignal): Promise<ReuseSnapshot | undefined> {
  const row = catalog.state.db.prepare("SELECT g.directory_path,g.manifest_sha256,g.profile_fp,p.status FROM active_slot a JOIN generations g ON g.generation_id=a.generation_id JOIN profiles p ON p.profile_id=g.profile_id WHERE a.slot=1 AND g.state='active'").get();
  if (!row || row.profile_fp !== fp || row.status !== 'validated') return;
  const directory = String(row.directory_path), sha = String(row.manifest_sha256);
  const manifest = await verifySeal(directory, sha);
  if (manifest.profile_fp !== fp) throw new DsearchError('COMPATIBILITY_FAILED');
  const previous = JSON.parse(await readFile(join(directory,'engine-config.json'),'utf8')) as OpenEngine;
  const keys = (value: OpenEngine) => Object.keys(value.collections ?? {}).sort().join('\0');
  if (previous.engineRoot !== engine.engineRoot || previous.modelRoot !== engine.modelRoot || previous.embedRole !== engine.embedRole || keys(previous) !== keys(engine)) return;
  const inputsFile = manifest.files.some(file=>file.path==='source-inputs.json');
  const saved = inputsFile ? JSON.parse(await readFile(join(directory,'source-inputs.json'),'utf8')) : { schema_version:1, inputs:[] };
  if (saved.schema_version !== 1 || !Array.isArray(saved.inputs) || saved.inputs.some((input: SourceInput)=>!input || ['doc_id','revision_id','relative_path','scope_fp'].some(key=>typeof input[key as keyof SourceInput]!=='string'))) throw new DsearchError('COMPATIBILITY_FAILED');
  const coverage: GenerationDocument[] = JSON.parse(await readFile(join(directory,'coverage.json'),'utf8'));
  const mappings: IndexedPassage[] = JSON.parse(await readFile(join(directory,'mappings.json'),'utf8'));
  if (mappings.some(p=>!previous.collections?.[p.engine_collection] || !/^[a-f0-9]{64}$/.test(p.passage_id) || p.engine_relative_path!==p.passage_id+'.md')) throw new DsearchError('COMPATIBILITY_FAILED');
  const reader = new QmdWorker();
  try {
    if (signal.aborted) throw new DsearchError('CANCELLED');
    await reader.open({...previous,role:'reader'});
    await reader.invoke('snapshot',{target:engine.dbPath},{signal});
  } finally { await reader.close(); }
  await verifySeal(directory,sha);
  return {directory,coverage,mappings,inputs:saved.inputs};
}
