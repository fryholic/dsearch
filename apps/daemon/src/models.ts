import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, lstat, realpath, open, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DsearchError } from '@dsearch/contracts';
import { ModelInfo } from '@dsearch/contracts/control';
import { verifyModel } from '@dsearch/runtime';
type Model = { role: 'embed' | 'rerank' | 'reference'; repository: string; revision: string; filename: string; sha256: string; bytes: number };
type Progress = (phase: string, counts?: Record<string, number>) => void;
export class ModelManager {
  private readonly checked = new Map<string, { at: string; state: 'verified' | 'invalid'; signature: string; code: 'MODEL_UNAVAILABLE' | null }>();
  constructor(readonly root: string, readonly registry: Model[], private readonly download: typeof fetch = fetch) {}
  static async open(root: string, download?: typeof fetch) {
    const { models } = JSON.parse(await readFile(new URL('../../../vendor/models/registry.json', import.meta.url), 'utf8')) as { models: Model[] };
    for (const m of models) if (!/^[\w.-]+\/[\w.-]+$/.test(m.repository) || !/^[\w.-]+\.gguf$/.test(m.filename) || !/^[a-f0-9]{40}$/.test(m.revision) || !/^[a-f0-9]{64}$/.test(m.sha256) || !Number.isSafeInteger(m.bytes) || m.bytes <= 0) throw new DsearchError('COMPATIBILITY_FAILED');
    return new ModelManager(resolve(root), models, download);
  }
  private async safeRoot(create = false) { if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });const info = await lstat(this.root);if (!info.isDirectory() || info.isSymbolicLink() || await realpath(this.root) !== this.root) throw new DsearchError('SCOPE_DENIED'); }
  private signature(info: Awaited<ReturnType<typeof lstat>>) { return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':'); }
  async list(): Promise<ModelInfo[]> {
    let missing = false;try { await this.safeRoot(); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') missing = true;else throw e; }
    return Promise.all(this.registry.map(async model => {
      const info = missing ? undefined : await lstat(join(this.root, model.filename)).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e;return undefined; });
      const checked = this.checked.get(model.role), unchanged = info && checked?.signature === this.signature(info);
      const state = !info ? 'missing' : !info.isFile() || info.isSymbolicLink() || info.size !== model.bytes ? 'invalid' : unchanged ? checked.state : 'unverified';
      return ModelInfo.parse({ ...model, state, verified_at: unchanged ? checked.at : null, error_code: state === 'missing' ? 'MODEL_NOT_INSTALLED' : state === 'invalid' ? 'MODEL_UNAVAILABLE' : null });
    }));
  }
  async check(roles: string[], signal: AbortSignal, progress: Progress) {
    try { await this.safeRoot(); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new DsearchError('MODEL_NOT_INSTALLED');throw e; }let completed = 0;
    for (const model of this.registry.filter(m => roles.includes(m.role))) { if (signal.aborted) throw new DsearchError('CANCELLED');progress('verifying-model', { completed, total: roles.length });
      const path = join(this.root, model.filename);
      try { await verifyModel(path, model);const info = await lstat(path);this.checked.set(model.role, { state: 'verified', signature: this.signature(info), at: new Date().toISOString(), code: null }); }
      catch (error) { const info = await lstat(path).catch(() => undefined);if (info) this.checked.set(model.role, { state: 'invalid', signature: this.signature(info), at: new Date().toISOString(), code: 'MODEL_UNAVAILABLE' });throw error; }
      completed++;
    }
    progress('models-ready', { completed, total: roles.length });
  }
  async prepare(roles: string[], signal: AbortSignal, progress: Progress) {
    await this.safeRoot(true);let completed = 0;
    for (const model of this.registry.filter(m => roles.includes(m.role))) {
      if (signal.aborted) throw new DsearchError('CANCELLED');const path = join(this.root, model.filename);
      progress('verifying-model', { completed, total: roles.length });
      const existing = await lstat(path).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e;return undefined; });
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new DsearchError('SCOPE_DENIED');
      if (!await verifyModel(path, model).then(() => true, () => false)) {
        const partial = path + '.' + randomUUID() + '.part';let file;
        try {
          progress('downloading-model', { completed, total: roles.length, bytes: 0, total_bytes: model.bytes });
          const response = await this.download('https://huggingface.co/' + model.repository + '/resolve/' + model.revision + '/' + model.filename, { signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) });
          if (!response.ok || !response.body) throw new DsearchError('MODEL_UNAVAILABLE');
          file = await open(partial, 'wx', 0o600);let bytes = 0, lastProgress = 0;const hash = createHash('sha256');
          for await (const chunk of response.body) { if (signal.aborted) throw new DsearchError('CANCELLED');bytes += chunk.length;if (bytes > model.bytes) throw new DsearchError('MODEL_UNAVAILABLE');hash.update(chunk);await file.writeFile(chunk);if (performance.now() - lastProgress >= 100 || bytes === model.bytes) { progress('downloading-model', { completed, total: roles.length, bytes, total_bytes: model.bytes });lastProgress = performance.now(); } }
          if (bytes !== model.bytes || hash.digest('hex') !== model.sha256) throw new DsearchError('MODEL_UNAVAILABLE');
          await file.sync();await file.close();file = undefined;if (signal.aborted) throw new DsearchError('CANCELLED');await rename(partial, path);
        } catch (error) { throw error instanceof DsearchError ? error : new DsearchError(signal.aborted ? 'CANCELLED' : 'MODEL_UNAVAILABLE'); }
        finally { await file?.close();await rm(partial, { force: true }); }
      }
      await this.check([model.role], signal, () => {});completed++;
    }
    progress('models-ready', { completed, total: roles.length });
  }
}
