import { randomUUID } from "node:crypto";
import { mkdir, chmod } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { Catalog, canonicalJSON, digest } from "@dsearch/catalog";
import { compileDocument, type Passage, type CoverageBlock, type CompiledDocument } from "@dsearch/compiler";
import { DsearchError, type ProfileManifest } from "@dsearch/contracts";
import { QmdWorker, type EngineResponse, type OpenEngine } from "@dsearch/engine-qmd";
import { atomicFile, sealFiles, verifySeal } from "./seal.js";
export type GenerationDocument = { doc_id: string; revision_id: string | null; collection_id: string; state: "included" | "partial" | "lexical_only" | "excluded" | "pending" | "failed"; reason: string | null; coverage: CoverageBlock[] };
export type IndexedPassage = Omit<Passage, "text"> & { engine_collection: string; engine_relative_path: string };
export type BuildResult = { generation_id: string; epoch: number; manifest_sha256: string; coverage: GenerationDocument[] };
export type BuildHandle = { job_id: string; generation_id: string; completion: Promise<BuildResult> };
type ActiveBuild = { controller: AbortController; handle: BuildHandle };
const timestamp = () => new Date().toISOString();

/** Manual full-generation builder. Incremental reuse and restart recovery follow in P6. */
export class GenerationBuilder {
  private active: ActiveBuild | undefined;
  constructor(readonly catalog: Catalog, readonly options: { engineRoot: string; modelRoot: string; profile: ProfileManifest; embedRole: "embed" | "reference"; fault?: (phase: string) => void | Promise<void> }) {}
  get busy(): boolean { return this.active !== undefined; }
  getJob(id: string) {
    const row = this.catalog.state.db.prepare("SELECT job_id,generation_id,state,phase,progress_json,cancel_requested,error_code,updated_at FROM jobs WHERE job_id=?").get(id);
    if (!row) throw new DsearchError("NOT_FOUND");
    return { ...row, state: row.cancel_requested && ["queued", "running"].includes(String(row.state)) ? "cancel_requested" : row.state, progress: JSON.parse(String(row.progress_json)), progress_json: undefined };
  }
  cancel(id: string): void {
    this.getJob(id);
    if (this.active?.handle.job_id !== id) return;
    this.catalog.state.db.prepare("UPDATE jobs SET cancel_requested=1,updated_at=? WHERE job_id=?").run(timestamp(), id);this.active.controller.abort();
  }
  start(): BuildHandle {
    if (this.active) throw new DsearchError("BUSY");
    const state = this.catalog.state, profile = this.options.profile, fp = digest(canonicalJSON(profile)), jobId = randomUUID(), genId = randomUUID();
    const directory = join(state.root, "generations", genId), created = timestamp();
    const existing = state.db.prepare("SELECT profile_fp,manifest_json FROM profiles WHERE profile_id=?").get(profile.profile_id);
    if (existing && (existing.profile_fp !== fp || existing.manifest_json !== canonicalJSON(profile))) throw new DsearchError("COMPATIBILITY_FAILED");
    state.transaction(() => {
      if (!existing) state.db.prepare("INSERT INTO profiles VALUES (?,?,?,'draft',?)").run(profile.profile_id, fp, canonicalJSON(profile), created);
      state.db.prepare("INSERT INTO generations VALUES (?,?,?,'building',?,?,NULL,?,?,NULL)").run(genId, profile.profile_id, fp, directory, state.sourceSeq, "{}", created);
      state.db.prepare("INSERT INTO jobs VALUES (?,?,?,?,'queued','queued','{}','{}',0,0,NULL,NULL,NULL,?)").run(jobId, digest(canonicalJSON(["full-build", genId, fp, state.sourceSeq])), "full-build", genId, created);
    });
    const controller = new AbortController();
    // Defer execution until the caller has received the persisted queued job ID.
    const completion = Promise.resolve().then(() => this.perform(jobId, genId, directory, fp, controller.signal)).finally(() => { if (this.active?.handle.job_id === jobId) this.active = undefined; });
    const handle = { job_id: jobId, generation_id: genId, completion };this.active = { controller, handle };void completion.catch(() => {});return handle;
  }
  private phase(jobId: string, phase: string, progress: object = {}): void {
    this.catalog.state.db.prepare("UPDATE jobs SET state='running',phase=?,progress_json=?,updated_at=? WHERE job_id=?").run(phase, canonicalJSON(progress), timestamp(), jobId);
  }
  private async perform(jobId: string, genId: string, directory: string, fp: string, signal: AbortSignal): Promise<BuildResult> {
    const state = this.catalog.state, profile = this.options.profile, builder = new QmdWorker();let reader: QmdWorker | undefined;
    const check = () => { if (signal.aborted) throw new DsearchError("CANCELLED"); };
    try {
      check();this.phase(jobId, "reconciling");
      const collections = this.catalog.listCollections().filter(c => c.enabled);
      if (!collections.length || collections.length > 32) throw new DsearchError("INVALID_REQUEST");
      const reports = [];for (const collection of collections) reports.push(await this.catalog.reconcile(collection.collection_id, { signal }));
      const sourceSeq = state.sourceSeq, scopes = Object.fromEntries(collections.map(c => [c.collection_id, c.scope_fp]));
      const expectedEpoch = Number(state.db.prepare("SELECT epoch FROM active_slot WHERE slot=1").get()?.epoch ?? 0);
      const docs = reports.flatMap(r => r.documents.filter(d => d.present));
      state.db.prepare("UPDATE generations SET source_seq=? WHERE generation_id=?").run(sourceSeq, genId);
      await mkdir(join(directory, "projection"), { recursive: true, mode: 0o700 });
      const internal: Record<string, { path: string; pattern: string }> = {}, semantic: string[] = [], names = new Map<string, { semantic: string; lexical: string }>();
      for (const collection of collections) {
        const suffix = collection.collection_id.replaceAll("-", ""), sem = "s_" + suffix, lex = "l_" + suffix;
        for (const key of [sem, lex]) { const path = join(directory, "projection", key);await mkdir(path, { mode: 0o700 });internal[key] = { path, pattern: "**/*.md" }; }
        names.set(collection.collection_id, { semantic: sem, lexical: lex });semantic.push(sem);
      }
      const engine: OpenEngine = { engineRoot: this.options.engineRoot, dbPath: join(directory, "qmd.sqlite"), collectionPath: join(directory, "projection"), modelRoot: this.options.modelRoot, embedRole: this.options.embedRole, strict: true, role: "builder", generationId: genId, collections: internal, semanticCollections: semantic };
      await builder.open(engine);check();
      const probe = await builder.invoke<EngineResponse<{ dimension: number; norm: number }>>("embedding", { text: "dsearch dimension validation probe", title: "", isQuery: true }, { signal });
      if (probe.result.dimension !== profile.models.embed.dimension || !Number.isFinite(probe.result.norm) || probe.result.norm <= 0) throw new DsearchError("COMPATIBILITY_FAILED");
      const coverage: GenerationDocument[] = [], mappings: IndexedPassage[] = [], files: string[] = [];
      let completed = 0;
      for (const doc of docs) {
        check();this.phase(jobId, "compiling", { completed, total: docs.length });
        if (doc.eligibility !== "eligible" || !doc.latest_revision_id) {
          coverage.push({ doc_id: doc.doc_id, revision_id: doc.latest_revision_id, collection_id: doc.collection_id, state: doc.eligibility === "pending" ? "pending" : ["unreadable", "invalid_metadata", "unsupported_encoding"].includes(doc.eligibility) ? "failed" : "excluded", reason: doc.eligibility_reason, coverage: [] });completed++;continue;
        }
        const source = await this.catalog.readDocument(doc.doc_id, doc.latest_revision_id), collection = collections.find(c => c.collection_id === doc.collection_id)!;
        let compiled: CompiledDocument;
        try {
          compiled = await compileDocument({ doc_id: doc.doc_id, revision_id: doc.latest_revision_id, text: source.text, metadata: source.metadata, fallback_title: basename(doc.relative_path, extname(doc.relative_path)), navigation_headings: JSON.parse(collection.scope_json).preset === "learning" ? ["목차", "학습 탐색", "이전·다음"] : [], signal }, async (text, title, file) => (await builder.invoke<EngineResponse<{ embeddingTokens: number; embeddingChunks: number; searchChunks: number; safe: boolean }>>("inspect", { text, title, file }, { signal })).result);
        } catch (e) {
          if (!e || typeof e !== "object" || !("code" in e) || e.code !== "PARSE_ERROR") throw e;
          coverage.push({ doc_id: doc.doc_id, revision_id: doc.latest_revision_id, collection_id: doc.collection_id, state: "failed", reason: "parse_error", coverage: [{ start: source.bodyStart, end: source.text.length, type: "document", state: "failed", reason: "parse_error", passages: [] }] });completed++;continue;
        }
        const semanticCount = compiled.passages.filter(p => p.kind === "semantic").length, lexicalCount = compiled.passages.length - semanticCount;
        coverage.push({ doc_id: doc.doc_id, revision_id: doc.latest_revision_id, collection_id: doc.collection_id, state: semanticCount && lexicalCount ? "partial" : semanticCount ? "included" : lexicalCount ? "lexical_only" : "excluded", reason: compiled.passages.length ? null : "empty_or_navigation_only", coverage: compiled.coverage });
        for (const passage of compiled.passages) {
          const collectionName = passage.kind === "semantic" ? names.get(doc.collection_id)!.semantic : names.get(doc.collection_id)!.lexical;
          const relative = passage.passage_id + ".md", path = "projection/" + collectionName + "/" + relative;
          await atomicFile(join(directory, path), passage.text);files.push(path);
          const { text: _text, ...metadata } = passage;mappings.push({ ...metadata, engine_collection: collectionName, engine_relative_path: relative });
        }
        completed++;
      }
      this.phase(jobId, "indexing", { passages: mappings.length });await builder.invoke("update", {}, { signal });
      this.phase(jobId, "embedding", { semantic_passages: mappings.filter(p => p.kind === "semantic").length });
      const embedded = await builder.invoke<EngineResponse<{ results: { errors: number }[] }>>("embed", {}, { signal });
      if (embedded.result.results.some(r => r.errors !== 0)) {
        for (const doc of coverage) if (["included", "partial"].includes(doc.state)) { doc.state = "failed";doc.reason = "failed_embedding"; }
        state.db.prepare("UPDATE generations SET coverage_json=? WHERE generation_id=?").run(canonicalJSON(coverage), genId);
        throw new DsearchError("MODEL_UNAVAILABLE");
      }
      const audit = (await builder.invoke<EngineResponse<{ documents: { collection: string; path: string; vector_chunks: number }[]; cache: { rows: number }; integrity: { quick_check: string } }>>("index_audit")).result;
      if (audit.cache.rows !== 0 || audit.integrity.quick_check !== "ok" || audit.documents.length !== mappings.length) throw new DsearchError("COMPATIBILITY_FAILED");
      const mapped = new Map(mappings.map(p => [p.engine_collection + "/" + p.engine_relative_path, p]));
      for (const doc of audit.documents) { const passage = mapped.get(doc.collection + "/" + doc.path);if (!passage || doc.vector_chunks !== (passage.kind === "semantic" ? 1 : 0)) throw new DsearchError("COMPATIBILITY_FAILED"); }
      await builder.close();await chmod(engine.dbPath, 0o600);check();await this.options.fault?.("after-index");check();
      // Every compiled source must still be the exact registered revision before sealing.
      for (const doc of coverage.filter(d => ["included", "partial", "lexical_only"].includes(d.state))) await this.catalog.readDocument(doc.doc_id, doc.revision_id!);
      if (state.sourceSeq !== sourceSeq) throw new DsearchError("STALE_EPOCH");
      this.phase(jobId, "sealing");
      for (const [name, value] of Object.entries({ "profile.json": profile, "engine-config.json": engine, "mappings.json": mappings, "coverage.json": coverage, "catalog.json": { scopes, source_seq: sourceSeq, boundaries: reports.map(r => ({ collection_id: r.collection_id, scope_incomplete: r.scope_incomplete, boundaries: r.boundaries })) } })) { await atomicFile(join(directory, name), canonicalJSON(value) + "\n");files.push(name); }
      files.push("qmd.sqlite");
      const sealed = await sealFiles(directory, { schema_version: 1, generation_id: genId, profile_fp: fp, source_seq: sourceSeq, scopes, documents: docs.length, passages: mappings.length, created_at: timestamp() }, files);
      state.transaction(() => {
        state.db.prepare("UPDATE generations SET state='validating',manifest_sha256=?,coverage_json=?,sealed_at=? WHERE generation_id=?").run(sealed.sha256, canonicalJSON(coverage), timestamp(), genId);
        const addDoc = state.db.prepare("INSERT INTO generation_documents VALUES (?,?,?,?,?)");
        for (const doc of coverage) if (doc.revision_id) addDoc.run(genId, doc.doc_id, doc.revision_id, doc.state, doc.reason);
        const addPassage = state.db.prepare("INSERT INTO passages VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
        for (const passage of mappings) addPassage.run(genId, passage.passage_id, passage.doc_id, passage.revision_id, passage.engine_collection, passage.engine_relative_path, passage.kind, passage.projection_sha256, canonicalJSON({ offset_unit: "utf16_lf", segments: passage.segments }), canonicalJSON(passage.heading), passage.embedding_tokens, "ready");
      });
      reader = new QmdWorker();await reader.open({ ...engine, role: "reader" });await reader.close();await this.options.fault?.("before-publish");check();
      for (const doc of coverage.filter(d => ["included", "partial", "lexical_only"].includes(d.state))) await this.catalog.readDocument(doc.doc_id, doc.revision_id!);
      await verifySeal(directory, sealed.sha256);check();
      let epoch = 0;
      state.transaction(() => {
        if (state.sourceSeq !== sourceSeq || collections.some(c => !this.catalog.collection(c.collection_id).enabled || this.catalog.collection(c.collection_id).scope_fp !== c.scope_fp)) throw new DsearchError("STALE_EPOCH");
        const slot = state.db.prepare("SELECT epoch FROM active_slot WHERE slot=1").get();
        if (Number(slot?.epoch ?? 0) !== expectedEpoch) throw new DsearchError("STALE_EPOCH");epoch = expectedEpoch + 1;
        state.db.prepare("UPDATE generations SET state='retired' WHERE state='active'").run();
        state.db.prepare("UPDATE profiles SET status='validated' WHERE profile_id=?").run(profile.profile_id);
        state.db.prepare("UPDATE generations SET state='ready' WHERE generation_id=?").run(genId);
        state.db.prepare("INSERT INTO active_slot VALUES (1,?,?,?) ON CONFLICT(slot) DO UPDATE SET generation_id=excluded.generation_id,epoch=excluded.epoch,changed_at=excluded.changed_at").run(genId, epoch, timestamp());
        state.db.prepare("UPDATE generations SET state='active' WHERE generation_id=?").run(genId);
        state.db.prepare("UPDATE jobs SET state='succeeded',phase='complete',progress_json=?,updated_at=? WHERE job_id=?").run(canonicalJSON({ documents: docs.length, passages: mappings.length }), timestamp(), jobId);
      });
      return { generation_id: genId, epoch, manifest_sha256: sealed.sha256, coverage };
    } catch (e) {
      // Confirm native worker exit before publishing a terminal cancellation.
      await builder.close();if (reader) await reader.close();
      const cancelled = signal.aborted || (e instanceof DsearchError && e.code === "CANCELLED"), code = e instanceof DsearchError ? e.code : "INTERNAL_ERROR";
      state.transaction(() => { state.db.prepare("UPDATE generations SET state='invalid' WHERE generation_id=?").run(genId);state.db.prepare("UPDATE jobs SET state=?,phase='stopped',error_code=?,updated_at=? WHERE job_id=?").run(cancelled ? "cancelled" : "failed", cancelled ? "CANCELLED" : code, timestamp(), jobId); });
      throw new DsearchError(cancelled ? "CANCELLED" : code);
    } finally { await builder.close();if (reader) await reader.close(); }
  }
}
