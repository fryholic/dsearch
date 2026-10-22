import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DsearchError } from '@dsearch/contracts';
import { Preferences } from '@dsearch/contracts/control';
import { atomicFile } from '@dsearch/generations';
import type { Catalog } from '@dsearch/catalog';

export class PreferenceStore {
  private value = Preferences.parse({});
  constructor(private readonly root: string) {}
  async load() {
    const file = join(this.root, 'preferences.json');
    try { const info = await lstat(file);if (!info.isFile() || info.isSymbolicLink() || info.size > 16384 || (info.mode & 0o077)) throw new DsearchError('SCOPE_DENIED');
      this.value = Preferences.parse(JSON.parse(await readFile(file, 'utf8')));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new DsearchError('COMPATIBILITY_FAILED'); }
    return this.get();
  }
  get() { return structuredClone(this.value); }
  async set(input: unknown) { const parsed = Preferences.safeParse(input);if (!parsed.success) throw new DsearchError('INVALID_REQUEST');
    await atomicFile(join(this.root, 'preferences.json'), JSON.stringify(parsed.data) + '\n');this.value = parsed.data;return this.get();
  }
}
/** Query material is excluded recursively, including both nested comparison sides. */
export function exportSearch(input: unknown, includeQuery: boolean): Record<string, unknown> {
  const data = structuredClone(input) as Record<string, any>;
  if (data.state !== 'completed') throw new DsearchError('BUSY');
  const redact = (value: Record<string, any>) => { if (!includeQuery) delete value.query_plan; };
  if (data.purpose === 'compare') { redact(data.left.result);redact(data.right.result); } else redact(data);
  return { export_version: 1, includes_query: includeQuery, exported_at: new Date().toISOString(), data };
}
export async function openRegisteredDocument(catalog: Catalog, docId: string, revision: string, launch = launchFile) {
  const source = await catalog.readDocument(docId, revision);
  await launch(join(source.collection.root_path, source.document.relative_path));
  return { opened: true, doc_id: docId, revision_id: revision };
}
async function launchFile(path: string): Promise<void> {
  if (process.platform !== 'darwin') throw new DsearchError('SERVICE_UNAVAILABLE');
  await new Promise<void>((resolve, reject) => { const child = spawn('/usr/bin/open', ['--', path], { stdio: 'ignore' });
    child.once('error', () => reject(new DsearchError('SERVICE_UNAVAILABLE')));child.once('exit', code => code === 0 ? resolve() : reject(new DsearchError('SERVICE_UNAVAILABLE')));
  });
}
