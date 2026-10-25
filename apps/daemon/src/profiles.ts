import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Catalog, canonicalJSON, digest } from '@dsearch/catalog';
import { DsearchError, ProfileManifest } from '@dsearch/contracts';
import { GenerationBuilder, verifySeal } from '@dsearch/generations';
import { QmdWorker, type OpenEngine } from '@dsearch/engine-qmd';
import { HeavyLane } from '@dsearch/runtime';
import type { ReaderPool } from '@dsearch/search';
import type { ModelManager } from './models.js';

/** Prepared generations remain invisible until an explicit checked activation. */
export class ProfileController {
  private selected: ProfileManifest;
  private currentBuilder: GenerationBuilder;
  private staging: GenerationBuilder | undefined;
  private closing = false;
  constructor(readonly catalog: Catalog, readonly options: { profiles: ProfileManifest[]; engineRoot: string; modelRoot: string; models: ModelManager; lane: HeavyLane; readers: ReaderPool }) {
    for (const profile of options.profiles) {
      const fp = digest(canonicalJSON(profile)), prior = catalog.state.db.prepare('SELECT profile_fp FROM profiles WHERE profile_id=?').get(profile.profile_id);
      if (prior && prior.profile_fp !== fp) throw new DsearchError('COMPATIBILITY_FAILED');
      if (!prior) catalog.state.db.prepare("INSERT INTO profiles VALUES (?,?,?,'draft',?)").run(profile.profile_id, fp, canonicalJSON(profile), new Date().toISOString());
    }
    const active = catalog.state.db.prepare('SELECT g.profile_fp FROM active_slot a JOIN generations g USING(generation_id) WHERE a.slot=1').get()?.profile_fp;
    this.selected = options.profiles.find(p => digest(canonicalJSON(p)) === active) ?? options.profiles[0]!;
    this.currentBuilder = this.makeBuilder(this.selected);
  }
  get profile() { return this.selected; }
  get fingerprint() { return digest(canonicalJSON(this.selected)); }
  get builder() { return this.staging ?? this.currentBuilder; }
  get busy() { return this.currentBuilder.busy || !!this.staging?.busy; }
  resolve(id: string) {
    const profile = this.options.profiles.find(p => p.profile_id === id || (id === 'qwen-local' && p.models.embed.dimension === 1024) || (id === 'qmd-reference' && p.models.embed.dimension === 768));
    if (!profile) throw new DsearchError('NOT_FOUND');return profile;
  }
  roles(profile: ProfileManifest): string[] { return [profile.models.embed.dimension === 1024 ? 'embed' : 'reference', 'rerank']; }
  private makeBuilder(profile: ProfileManifest, requireAll = false) {
    return new GenerationBuilder(this.catalog, { engineRoot: this.options.engineRoot, modelRoot: this.options.modelRoot, profile, embedRole: profile.models.embed.dimension === 1024 ? 'embed' : 'reference', lane: this.options.lane,
      beforeWork: async signal => { await this.options.readers.unloadExcept();if (requireAll) await this.options.models.check(this.roles(profile), signal, () => {}); } });
  }
  list() {
    const state = this.catalog.state, epoch = Number(state.db.prepare('SELECT epoch FROM active_slot WHERE slot=1').get()?.epoch ?? 0);
    const generations = state.db.prepare('SELECT generation_id,profile_id,profile_fp,state,source_seq,created_at FROM generations ORDER BY created_at DESC LIMIT 100').all().map(row => ({ generation_id: String(row.generation_id), profile_id: String(row.profile_id), state: String(row.state), source_seq: Number(row.source_seq), created_at: String(row.created_at), compatible: this.options.profiles.some(p => digest(canonicalJSON(p)) === row.profile_fp), stale: row.source_seq !== state.sourceSeq }));
    return { active_epoch: epoch, selected_profile_id: this.selected.profile_id, profiles: this.options.profiles.map(p => ({ profile_id: p.profile_id, alias: p.models.embed.dimension === 1024 ? 'qwen-local' : 'qmd-reference', title: p.models.embed.dimension === 1024 ? 'Qwen3 · 0.6B' : 'EmbeddingGemma · 300M', profile_fp: digest(canonicalJSON(p)), status: String(state.db.prepare('SELECT status FROM profiles WHERE profile_id=?').get(p.profile_id)!.status), model_roles: this.roles(p), manifest: p })), generations };
  }
  prepare(id: string, publish = false) {
    if (this.closing) throw new DsearchError('SERVICE_UNAVAILABLE');if (this.busy) throw new DsearchError('BUSY');
    const builder = this.makeBuilder(this.resolve(id), true);this.staging = builder;
    const target = this.resolve(id), handle = builder.start({ publish });
    void handle.completion.then(result => { if (result.published) { this.selected = target;this.currentBuilder = this.makeBuilder(target); } }, () => {});
    void handle.completion.finally(() => { if (this.staging === builder) this.staging = undefined; }).catch(() => {});
    return handle;
  }
  resume(jobId:string) {
    if(this.closing)throw new DsearchError('SERVICE_UNAVAILABLE');if(this.busy)throw new DsearchError('BUSY');
    const row=this.catalog.state.db.prepare('SELECT g.profile_id FROM jobs j JOIN generations g USING(generation_id) WHERE j.job_id=?').get(jobId);if(!row)throw new DsearchError('NOT_FOUND');
    const target=this.resolve(String(row.profile_id)),builder=this.makeBuilder(target),handle=builder.start({resume:jobId});this.staging=builder;
    void handle.completion.then(result=>{if(result.published){this.selected=target;this.currentBuilder=this.makeBuilder(target);}},()=>{});
    void handle.completion.finally(()=>{if(this.staging===builder)this.staging=undefined;}).catch(()=>{});return handle;
  }
  async activate(profileId: string, generationId: string, expectedEpoch: number, signal: AbortSignal, progress: (phase: string) => void) {
    const target = this.resolve(profileId), fp = digest(canonicalJSON(target));
    progress('waiting-model');
    await this.options.lane.run(signal, async () => {
      if (this.busy) throw new DsearchError('BUSY');progress('validating');
      const state = this.catalog.state, row = state.db.prepare('SELECT * FROM generations WHERE generation_id=?').get(generationId);
      if (!row || row.profile_id !== target.profile_id || row.profile_fp !== fp || !['ready', 'retired', 'active'].includes(String(row.state)) || !row.manifest_sha256) throw new DsearchError('COMPATIBILITY_FAILED');
      const root = join(state.root, 'generations', generationId);if (row.directory_path !== root) throw new DsearchError('SCOPE_DENIED');
      const check = () => {
        if (signal.aborted) throw new DsearchError('CANCELLED');
        if (Number(state.db.prepare('SELECT epoch FROM active_slot WHERE slot=1').get()?.epoch ?? 0) !== expectedEpoch || state.sourceSeq !== row.source_seq) throw new DsearchError('STALE_EPOCH');
      };
      check();const manifest = await verifySeal(root, String(row.manifest_sha256));
      if (manifest.profile_fp !== fp || manifest.generation_id !== generationId) throw new DsearchError('COMPATIBILITY_FAILED');
      const scopes = this.catalog.listCollections().filter(c => c.enabled);
      if (Object.keys(manifest.scopes).length !== scopes.length || scopes.some(c => manifest.scopes[c.collection_id] !== c.scope_fp)) throw new DsearchError('SCOPE_DENIED');
      await this.options.models.check(this.roles(target), signal, () => {});check();
      const engine = JSON.parse(await readFile(join(root, 'engine-config.json'), 'utf8')) as OpenEngine;
      if (engine.engineRoot !== this.options.engineRoot || engine.modelRoot !== this.options.modelRoot || engine.dbPath !== join(root, 'qmd.sqlite') || engine.generationId !== generationId || engine.collectionPath !== join(root, 'projection') || !engine.strict) throw new DsearchError('COMPATIBILITY_FAILED');
      await this.options.readers.unloadExcept();
      const worker = new QmdWorker();try { await worker.open({ ...engine, role: 'reader' }); } finally { await worker.close(); }
      for (const doc of state.db.prepare("SELECT doc_id,revision_id FROM generation_documents WHERE generation_id=? AND processing_state IN ('included','partial','lexical_only')").all(generationId)) { check();await this.catalog.readDocument(String(doc.doc_id), String(doc.revision_id)); }
      await verifySeal(root, String(row.manifest_sha256));check();progress('publishing');
      state.transaction(() => { check();this.catalog.markPoliciesIndexed(scopes.map(c => c.collection_id));state.db.prepare("UPDATE generations SET state='retired' WHERE state='active'").run();state.db.prepare("UPDATE generations SET state='active' WHERE generation_id=?").run(generationId);state.db.prepare("INSERT INTO active_slot VALUES (1,?,?,?) ON CONFLICT(slot) DO UPDATE SET generation_id=excluded.generation_id,epoch=excluded.epoch,changed_at=excluded.changed_at").run(generationId, expectedEpoch + 1, new Date().toISOString()); });
      this.selected = target;this.currentBuilder = this.makeBuilder(target);this.options.readers.sweep();
    });
  }
  async close() { this.closing = true;await Promise.allSettled([this.currentBuilder.close(), this.staging?.close()]); }
}
