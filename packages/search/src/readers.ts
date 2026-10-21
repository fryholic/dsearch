import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Catalog, canonicalJSON, digest } from '@dsearch/catalog';
import { DsearchError, ProfileManifest } from '@dsearch/contracts';
import { verifySeal, type IndexedPassage } from '@dsearch/generations';
import { QmdWorker, type OpenEngine, type EngineResponse } from '@dsearch/engine-qmd';
import type { Progress } from '@dsearch/runtime';
export type Snapshot = {
    generation_id: string;
    epoch: number;
    profile_fp: string;
    directory_path: string;
    manifest_sha256: string;
};
export type Reader = {
    worker: QmdWorker;
    root: string;
    mappings: Map<string, IndexedPassage>;
    scopes: Record<string, string>;
};
type Entry = {
    snapshot: Snapshot;
    ready: Promise<Reader>;
    refs: number;
    tail: Promise<void>;
    worker?: QmdWorker;
    retired: boolean;
    disposing?: boolean;
};
export type ReadLease = {
    snapshot: Snapshot;
    ready: Promise<Reader>;
    run<T>(method: string, args: unknown, options?: {
        signal?: AbortSignal;
        onProgress?: (p: Progress) => void;
    }): Promise<EngineResponse<T>>;
    release(): void;
};
/** Reserve a generation synchronously; retain its immutable files until every lease is released. */
export class ReaderPool {
    private readonly entries = new Map<string, Entry>();
    private closing = false;
    private readonly closings = new Set<Promise<void>>();
    constructor(readonly catalog: Catalog, readonly options: {
        engineRoot: string;
        modelRoot: string;
        profile_fp?: string;
    }) { }
    active(): Snapshot {
        const value = this.catalog.state.db.prepare("SELECT a.generation_id,a.epoch,g.profile_fp,g.directory_path,g.manifest_sha256 FROM active_slot a JOIN generations g ON g.generation_id=a.generation_id WHERE a.slot=1 AND g.state='active'").get() as Snapshot | undefined;
        if (!value)
            throw new DsearchError('NO_ACTIVE_GENERATION');
        return value;
    }
    reserve(expectedEpoch?: number | null): ReadLease {
        if (this.closing)
            throw new DsearchError('SERVICE_UNAVAILABLE');
        const snapshot = this.active();
        if (expectedEpoch != null && expectedEpoch !== snapshot.epoch)
            throw new DsearchError('STALE_EPOCH');
        this.sweep();
        let entry = this.entries.get(snapshot.generation_id);
        if (!entry || entry.worker?.process.state === 'stopped') {
            entry = { snapshot, refs: 0, tail: Promise.resolve(), retired: false, ready: undefined! };
            const created = entry;
            entry.ready = this.load(snapshot, created);
            void entry.ready.catch(() => { created.retired = true; this.dispose(created); });
            this.entries.set(snapshot.generation_id, entry);
        }
        entry.refs++;
        const held = entry;
        let released = false;
        return { snapshot, ready: held.ready, run: async <T>(method: string, args: unknown, options: {
                signal?: AbortSignal;
                onProgress?: (p: Progress) => void;
            } = {}) => {
                let unlock!: () => void;
                const prior = held.tail;
                held.tail = new Promise<void>(resolve => unlock = resolve);
                try {
                    await prior;
                    if (options.signal?.aborted)
                        throw new DsearchError('CANCELLED');
                    const reader = await held.ready;
                    if (options.signal?.aborted)
                        throw new DsearchError('CANCELLED');
                    return await reader.worker.invoke<EngineResponse<T>>(method, args, options);
                }
                finally {
                    unlock();
                }
            }, release: () => { if (released)
                return; released = true; held.refs--; this.sweep(); this.dispose(held); } };
    }
    private async load(snapshot: Snapshot, entry: Entry): Promise<Reader> {
        const root = join(this.catalog.state.root, 'generations', snapshot.generation_id);
        if (root !== snapshot.directory_path)
            throw new DsearchError('SCOPE_DENIED');
        if (this.options.profile_fp && snapshot.profile_fp !== this.options.profile_fp)
            throw new DsearchError('COMPATIBILITY_FAILED');
        const manifest = await verifySeal(root, snapshot.manifest_sha256);
        if (manifest.generation_id !== snapshot.generation_id || manifest.profile_fp !== snapshot.profile_fp)
            throw new DsearchError('COMPATIBILITY_FAILED');
        const json = async (name: string) => JSON.parse(await readFile(join(root, name), 'utf8'));
        const profile = ProfileManifest.parse(await json('profile.json'));
        if (digest(canonicalJSON(profile)) !== snapshot.profile_fp)
            throw new DsearchError('COMPATIBILITY_FAILED');
        const config = await json('engine-config.json') as OpenEngine;
        if (config.engineRoot !== this.options.engineRoot || config.modelRoot !== this.options.modelRoot || config.dbPath !== join(root, 'qmd.sqlite') || config.generationId !== snapshot.generation_id || config.collectionPath !== join(root, 'projection') || !config.strict || !config.collections)
            throw new DsearchError('COMPATIBILITY_FAILED');
        for (const [name, collection] of Object.entries(config.collections))
            if (!/^[sl]_[a-f0-9]{32}$/.test(name) || collection.path !== join(root, 'projection', name) || collection.pattern !== '**/*.md')
                throw new DsearchError('COMPATIBILITY_FAILED');
        const values = await json('mappings.json') as IndexedPassage[], mappings = new Map<string, IndexedPassage>();
        const stored = this.catalog.state.db.prepare('SELECT * FROM passages WHERE generation_id=?').all(snapshot.generation_id);
        const storedById = new Map(stored.map(p => [String(p.passage_id), p]));
        for (const passage of values) {
            const row = storedById.get(passage.passage_id), key = passage.engine_collection + '/' + passage.engine_relative_path;
            if (!row || passage.engine_relative_path !== passage.passage_id + '.md' || !/^[a-f0-9]{64}$/.test(passage.passage_id) || !config.collections[passage.engine_collection] || row.doc_id !== passage.doc_id || row.revision_id !== passage.revision_id || row.projection_sha256 !== passage.projection_sha256 || row.engine_collection !== passage.engine_collection || row.engine_relative_path !== passage.engine_relative_path || row.source_map_json !== canonicalJSON({ offset_unit: 'utf16_lf', segments: passage.segments }) || mappings.has(key))
                throw new DsearchError('SOURCE_MAP_MISMATCH');
            mappings.set(key, passage);
        }
        if (stored.length !== values.length || manifest.passages !== values.length)
            throw new DsearchError('SOURCE_MAP_MISMATCH');
        const worker = new QmdWorker();
        entry.worker = worker;
        try {
            await worker.open({ ...config, role: 'reader' });
            return { worker, root, mappings, scopes: manifest.scopes };
        }
        catch (e) {
            await worker.close();
            throw e;
        }
    }
    sweep(): void {
        const active = this.catalog.state.db.prepare('SELECT generation_id FROM active_slot WHERE slot=1').get()?.generation_id;
        for (const entry of this.entries.values()) {
            entry.retired ||= entry.snapshot.generation_id !== active || entry.worker?.process.state === 'stopped';
            this.dispose(entry);
        }
    }
    private dispose(entry: Entry): void {
        if (entry.disposing || entry.refs || (!entry.retired && !this.closing))
            return;
        entry.disposing = true;
        if (this.entries.get(entry.snapshot.generation_id) === entry)
            this.entries.delete(entry.snapshot.generation_id);
        const closing = entry.ready.then(reader => reader.worker.close(), () => { }).catch(() => { });
        this.closings.add(closing);
        void closing.finally(() => this.closings.delete(closing));
    }
    async close(): Promise<void> { this.closing = true; const entries = [...this.entries.values()]; this.entries.clear(); await Promise.allSettled(entries.map(e => e.ready.then(r => r.worker.close(), () => { }))); while (this.closings.size)
        await Promise.allSettled([...this.closings]); }
}
