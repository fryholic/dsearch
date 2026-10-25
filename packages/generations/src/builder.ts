import { HeavyLane } from "@dsearch/runtime";
import { randomUUID } from "node:crypto";
import { mkdir, chmod, readFile, rm } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { Catalog, canonicalJSON, digest, legacyNavigationHeadings } from "@dsearch/catalog";
import { compileDocument, type Passage, type CoverageBlock, type CompiledDocument } from "@dsearch/compiler";
import { DsearchError, type ProfileManifest } from "@dsearch/contracts";
import { JobInfo } from "@dsearch/contracts/control";
import { QmdWorker, type EngineResponse, type OpenEngine } from "@dsearch/engine-qmd";
import { atomicFile, sealFiles, verifySeal } from "./seal.js";
import { snapshotForReuse, type SourceInput } from './reuse.js';
import { pinGeneration, maintenanceActive } from './pins.js';
import { BuildCheckpoints, loadCheckpoint, type BuildPlan, type CheckpointCursor } from './checkpoint.js';
export type GenerationDocument = { doc_id: string; revision_id: string | null; collection_id: string; state: "included" | "partial" | "lexical_only" | "excluded" | "pending" | "failed"; reason: string | null; coverage: CoverageBlock[] };
export type IndexedPassage = Omit<Passage, "text"> & { engine_collection: string; engine_relative_path: string };
export type BuildResult = { generation_id: string; epoch: number; manifest_sha256: string; coverage: GenerationDocument[]; published: boolean };
export type BuildHandle = { job_id: string; generation_id: string; completion: Promise<BuildResult> };
type ActiveBuild = { controller: AbortController; handle: BuildHandle };
const timestamp = () => new Date().toISOString();

/** Manual generation builder; reuse is confined to verified, compatible snapshots. */
export class GenerationBuilder {
  private active: ActiveBuild | undefined;
  private closing = false;
  constructor(readonly catalog: Catalog, readonly options: { engineRoot: string; modelRoot: string; profile: ProfileManifest; embedRole: "embed" | "reference"; lane?: HeavyLane; beforeWork?: (signal: AbortSignal) => Promise<void>; fault?: (phase: string) => void | Promise<void> }) {}
  get busy(): boolean { return this.active !== undefined; }
  getJob(id: string) {
    const row = this.catalog.state.db.prepare("SELECT job_id,kind,generation_id,state,phase,cursor_json,progress_json,cancel_requested,error_code,updated_at FROM jobs WHERE job_id=?").get(id);
    if (!row) throw new DsearchError("NOT_FOUND");
    return JobInfo.parse({ job_id: row.job_id, kind: row.kind, generation_id: row.generation_id, state: row.cancel_requested && ["queued", "running"].includes(String(row.state)) ? "cancel_requested" : row.state, phase: row.phase, progress: JSON.parse(String(row.progress_json)), error_code: row.error_code, retryable: ["failed","obsolete","cancelled"].includes(String(row.state)) && !!JSON.parse(String(row.cursor_json)).checkpoint, updated_at: row.updated_at });
  }
  cancel(id: string): void {
    this.getJob(id);
    if (this.active?.handle.job_id !== id) return;
    this.catalog.state.db.prepare("UPDATE jobs SET cancel_requested=1,updated_at=? WHERE job_id=?").run(timestamp(), id);this.active.controller.abort();
  }
  start(options: { publish?: boolean; full?: boolean; resume?: string } = {}): BuildHandle {
    if (this.closing) throw new DsearchError("SERVICE_UNAVAILABLE");
    if (this.active || maintenanceActive(this.catalog.state)) throw new DsearchError("BUSY");
    const state = this.catalog.state, profile = this.options.profile, fp = digest(canonicalJSON(profile)), jobId = randomUUID(), genId = randomUUID();
    let targetGenId: string = genId, resumeCursor: CheckpointCursor | undefined;
    const prior = options.resume ? state.db.prepare("SELECT j.*,g.profile_fp,g.directory_path,g.state AS generation_state FROM jobs j JOIN generations g USING(generation_id) WHERE j.job_id=?").get(options.resume) : undefined;
    if (options.resume) {
      if (!prior) throw new DsearchError("NOT_FOUND");
      if (!['failed','cancelled','obsolete'].includes(String(prior.state)) || prior.generation_state !== 'invalid' || prior.profile_fp !== fp) throw new DsearchError("COMPATIBILITY_FAILED");
      const latest = state.db.prepare('SELECT job_id FROM jobs WHERE generation_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1').get(String(prior.generation_id));
      if (latest?.job_id !== options.resume) throw new DsearchError("STALE_EPOCH");
      targetGenId = String(prior.generation_id);resumeCursor = JSON.parse(String(prior.cursor_json));
      if (!resumeCursor?.checkpoint) throw new DsearchError("INVALID_REQUEST");
      if (prior.directory_path !== join(state.root,'generations',targetGenId)) throw new DsearchError('SCOPE_DENIED');
    }
    const directory = join(state.root, "generations", targetGenId), created = timestamp();
    const existing = state.db.prepare("SELECT profile_fp,manifest_json FROM profiles WHERE profile_id=?").get(profile.profile_id);
    if (existing && (existing.profile_fp !== fp || existing.manifest_json !== canonicalJSON(profile))) throw new DsearchError("COMPATIBILITY_FAILED");
    state.transaction(() => {
      if (!existing) state.db.prepare("INSERT INTO profiles VALUES (?,?,?,'draft',?)").run(profile.profile_id, fp, canonicalJSON(profile), created);
      if (prior) {
        state.db.prepare('DELETE FROM passages WHERE generation_id=?').run(targetGenId);state.db.prepare('DELETE FROM generation_documents WHERE generation_id=?').run(targetGenId);
        state.db.prepare("UPDATE generations SET state='building',manifest_sha256=NULL,sealed_at=NULL WHERE generation_id=?").run(targetGenId);
      } else state.db.prepare("INSERT INTO generations VALUES (?,?,?,'building',?,?,NULL,?,?,NULL)").run(genId, profile.profile_id, fp, directory, state.sourceSeq, "{}", created);
      state.db.prepare("INSERT INTO jobs VALUES (?,?,?,?,'queued','queued','{}','{}',0,0,NULL,NULL,NULL,?)").run(jobId, digest(canonicalJSON(["full-build", targetGenId, fp, jobId])), prior ? String(prior.kind) : options.publish === false ? 'profile-build' : "full-build", targetGenId, created);
      if (resumeCursor) state.db.prepare("UPDATE jobs SET cursor_json=?,attempt=? WHERE job_id=?").run(canonicalJSON(resumeCursor),Number(prior!.attempt)+1,jobId);
    });
    const unpin=pinGeneration(state,targetGenId,"builder");
    const controller = new AbortController();
    // Defer execution until the caller has received the persisted queued job ID.
    const completion = Promise.resolve().then(() => this.perform(jobId, targetGenId, directory, fp, controller.signal, prior ? prior.kind === "full-build" : options.publish !== false, options.full === true, resumeCursor)).finally(() => { unpin();if (this.active?.handle.job_id === jobId) this.active = undefined; });
    const handle = { job_id: jobId, generation_id: targetGenId, completion };this.active = { controller, handle };void completion.catch(() => {});return handle;
  }
  async close(): Promise<void> { this.closing = true;const active = this.active;if (active) { active.controller.abort();await active.handle.completion.catch(() => {}); } }
  private phase(jobId: string, phase: string, progress: object = {}): void {
    this.catalog.state.db.prepare("UPDATE jobs SET state='running',phase=?,progress_json=?,updated_at=? WHERE job_id=?").run(phase, canonicalJSON(progress), timestamp(), jobId);
  }
  private async perform(jobId: string, genId: string, directory: string, fp: string, signal: AbortSignal, publish: boolean, full: boolean, resumeCursor?: CheckpointCursor): Promise<BuildResult> {
    const state = this.catalog.state, profile = this.options.profile, builder = new QmdWorker();let reader: QmdWorker | undefined, releaseBase:(()=>void)|undefined;
    const check = () => { if (signal.aborted) throw new DsearchError("CANCELLED"); };
    const owner=process.pid+':'+jobId;
    const heartbeat=()=>state.db.prepare('UPDATE jobs SET lease_owner=?,lease_expires_at=? WHERE job_id=?').run(owner,new Date(Date.now()+60000).toISOString(),jobId);
    heartbeat();const timer=setInterval(heartbeat,10000);timer.unref();
    let releaseLane!: () => void;
    try {
      if (this.options.lane) {
        this.phase(jobId, "waiting-model");
        releaseLane = await this.options.lane.acquire(signal);check();
      }
      await this.options.beforeWork?.(signal);
      check();this.phase(jobId, "reconciling");
      const collections = this.catalog.listCollections().filter(c => c.enabled);
      if (!collections.length || collections.length > 32) throw new DsearchError("INVALID_REQUEST");
      const reports = [];for (const collection of collections) reports.push(await this.catalog.reconcile(collection.collection_id, { signal }));
      if (reports.some(r => r.scope_incomplete)) {
        this.phase(jobId, "scope-incomplete", { incomplete_collections: reports.filter(r => r.scope_incomplete).length, incomplete_boundaries: reports.reduce((n, r) => n + r.boundaries.filter(b => b.incomplete).length, 0) });
        throw new DsearchError("SCOPE_INCOMPLETE");
      }
      const sourceSeq = state.sourceSeq, scopes = Object.fromEntries(collections.map(c => [c.collection_id, c.scope_fp]));
      const expectedEpoch = Number(state.db.prepare("SELECT epoch FROM active_slot WHERE slot=1").get()?.epoch ?? 0);
      const docs = reports.flatMap(r => r.documents.filter(d => d.present));
      state.db.prepare("UPDATE generations SET source_seq=? WHERE generation_id=?").run(sourceSeq, genId);
      await mkdir(join(directory, "projection"), { recursive: true, mode: 0o700 });
      const internal: Record<string, { path: string; pattern: string }> = {}, semantic: string[] = [], names = new Map<string, { semantic: string; lexical: string }>();
      for (const collection of collections) {
        const suffix = collection.collection_id.replaceAll("-", ""), sem = "s_" + suffix, lex = "l_" + suffix;
        for (const key of [sem, lex]) { const path = join(directory, "projection", key);await mkdir(path, { recursive:true, mode: 0o700 });internal[key] = { path, pattern: "**/*.md" }; }
        names.set(collection.collection_id, { semantic: sem, lexical: lex });semantic.push(sem);
      }
      const engine: OpenEngine = { engineRoot: this.options.engineRoot, dbPath: join(directory, "qmd.sqlite"), collectionPath: join(directory, "projection"), modelRoot: this.options.modelRoot, embedRole: this.options.embedRole, strict: true, role: "builder", generationId: genId, collections: internal, semanticCollections: semantic };
      const restored = resumeCursor ? await loadCheckpoint(directory,resumeCursor) : undefined;
      if (restored) {
        const plan=restored.plan;
        if(plan.profile_fp!==fp||plan.generation_id!==genId||plan.source_seq!==sourceSeq||plan.expected_epoch!==expectedEpoch||canonicalJSON(plan.engine)!==canonicalJSON(engine)||canonicalJSON(plan.inputs.map(i=>[i.doc_id,i.revision_id,i.relative_path,i.scope_fp]).sort())!==canonicalJSON(docs.filter(d=>d.eligibility==='eligible'&&d.latest_revision_id).map(d=>[d.doc_id,d.latest_revision_id,d.relative_path,scopes[d.collection_id]]).sort()))throw new DsearchError('STALE_EPOCH');
        for(const input of plan.inputs)await this.catalog.readDocument(input.doc_id,input.revision_id);
        await rm(engine.dbPath+'-wal',{force:true});await rm(engine.dbPath+'-shm',{force:true});await atomicFile(engine.dbPath,await readFile(join(directory,restored.checkpoint.database)));
      }
      const reuse = full || restored ? undefined : await snapshotForReuse(this.catalog, fp, engine, signal);
      releaseBase=reuse?.release;
      const opened=await builder.open(engine) as {capabilities?:{boundedEmbedCalls?:boolean}};check();
      if (!reuse && !restored) {
        const probe = await builder.invoke<EngineResponse<{ dimension: number; norm: number }>>("embedding", { text: "dsearch dimension validation probe", title: "", isQuery: true }, { signal });
        if (probe.result.dimension !== profile.models.embed.dimension || !Number.isFinite(probe.result.norm) || probe.result.norm <= 0) throw new DsearchError("COMPATIBILITY_FAILED");
      }
      const previousInputs = new Map(reuse?.inputs.map(input=>[input.doc_id,canonicalJSON(input)]));
      const previousCoverageById = new Map(reuse?.coverage.map(doc=>[doc.doc_id,doc]));
      const previousPassagesById = new Map<string, IndexedPassage[]>();
      for (const passage of reuse?.mappings ?? []) { const list = previousPassagesById.get(passage.doc_id) ?? [];list.push(passage);previousPassagesById.set(passage.doc_id,list); }
      const inputs: SourceInput[] = [];let reusedDocuments = 0;
      const coverage: GenerationDocument[] = [], mappings: IndexedPassage[] = [], files: string[] = [];
      let completed = 0;
      if(restored){coverage.push(...restored.plan.coverage);mappings.push(...restored.plan.mappings);files.push(...restored.plan.files);inputs.push(...restored.plan.inputs);reusedDocuments=restored.plan.reused_documents;}
      for (const doc of restored ? [] : docs) {
        check();this.phase(jobId, "compiling", { completed, total: docs.length });
        if (doc.eligibility !== "eligible" || !doc.latest_revision_id) {
          coverage.push({ doc_id: doc.doc_id, revision_id: doc.latest_revision_id, collection_id: doc.collection_id, state: doc.eligibility === "pending" ? "pending" : ["unreadable", "invalid_metadata", "unsupported_encoding"].includes(doc.eligibility) ? "failed" : "excluded", reason: doc.eligibility_reason, coverage: [] });completed++;continue;
        }
        const source = await this.catalog.readDocument(doc.doc_id, doc.latest_revision_id), collection = collections.find(c => c.collection_id === doc.collection_id)!;
        const sourceInput = { doc_id: doc.doc_id, revision_id: doc.latest_revision_id, relative_path: doc.relative_path, scope_fp: collection.scope_fp };inputs.push(sourceInput);
        const cached = previousInputs.get(doc.doc_id) === canonicalJSON(sourceInput);
        const previousCoverage = cached && previousCoverageById.get(doc.doc_id);
        if (previousCoverage && ['included','partial','lexical_only','excluded'].includes(previousCoverage.state)) {
          coverage.push(previousCoverage);
          for (const passage of previousPassagesById.get(doc.doc_id) ?? []) {
            const path = "projection/" + passage.engine_collection + "/" + passage.engine_relative_path;
            await atomicFile(join(directory,path), await readFile(join(reuse!.directory,path)));files.push(path);mappings.push(passage);
          }
          reusedDocuments++;completed++;continue;
        }
        let compiled: CompiledDocument;
        try {
          compiled = await compileDocument({ doc_id: doc.doc_id, revision_id: doc.latest_revision_id, text: source.text, metadata: source.metadata, fallback_title: basename(doc.relative_path, extname(doc.relative_path)), navigation_headings: (JSON.parse(collection.scope_json).navigation_headings ?? legacyNavigationHeadings(JSON.parse(collection.scope_json).preset)), signal }, async (text, title, file) => (await builder.invoke<EngineResponse<{ embeddingTokens: number; embeddingChunks: number; searchChunks: number; safe: boolean }>>("inspect", { text, title, file }, { signal })).result);
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
      const semanticPassages = mappings.filter(p => p.kind === "semantic").length;
      this.phase(jobId, "embedding", { completed: 0, total: semanticPassages });
      let embedded: EngineResponse<{results:{errors:number}[]}>;
      if(opened.capabilities?.boundedEmbedCalls){
        const plan:BuildPlan={schema_version:1,generation_id:genId,profile_fp:fp,source_seq:sourceSeq,expected_epoch:expectedEpoch,publish,engine,inputs,coverage,mappings,files,reused_documents:reusedDocuments};
        const checkpoints=new BuildCheckpoints(state,jobId,directory,plan);await checkpoints.initialize();await checkpoints.save(builder,0,signal);await this.options.fault?.('checkpoint-initial');check();
        const results:{errors:number}[]=[];let embeddingCalls=0,finished=0;
        for(const collection of semantic){let remaining:number;do{
          const step=await builder.invoke<EngineResponse<{errors:number;docsProcessed:number;remainingDocs:number}>>('embed_step',{collection},{signal,timeoutMode:'idle'});
          results.push(step.result);embeddingCalls+=Number(step.stats.embeddingCalls);finished+=step.result.docsProcessed;remaining=step.result.remainingDocs;
          if(!Number.isSafeInteger(remaining)||remaining<0||step.result.errors)throw new DsearchError('MODEL_UNAVAILABLE');
          await this.options.fault?.('batch-before-checkpoint');check();await checkpoints.save(builder,Math.min(finished,semanticPassages),signal);
          this.phase(jobId,'embedding',{completed:Math.min(finished,semanticPassages),total:semanticPassages});await this.options.fault?.('checkpoint-batch');check();
        }while(remaining);}
        embedded={result:{results},stats:{embeddingCalls},duration_ms:0,rss_bytes:0};
      }else{
        embedded=await builder.invoke<EngineResponse<{results:{errors:number}[]}>>('embed',{}, {signal,timeoutMode:'idle',onProgress:event=>{if(event.phase==='embedding-batch')this.phase(jobId,'embedding',{completed:Math.min(event.completed,semanticPassages),total:semanticPassages});}});
      }
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
      for (const [name, value] of Object.entries({ "source-inputs.json": { schema_version: 1, inputs }, "profile.json": profile, "engine-config.json": engine, "mappings.json": mappings, "coverage.json": coverage, "catalog.json": { scopes, source_seq: sourceSeq, boundaries: reports.map(r => ({ collection_id: r.collection_id, scope_incomplete: r.scope_incomplete, boundaries: r.boundaries })) } })) { await atomicFile(join(directory, name), canonicalJSON(value) + "\n");files.push(name); }
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
      if (!publish) {
        state.transaction(() => {
          if (state.sourceSeq !== sourceSeq || Number(state.db.prepare('SELECT epoch FROM active_slot WHERE slot=1').get()?.epoch ?? 0) !== expectedEpoch) throw new DsearchError('STALE_EPOCH');
          state.db.prepare("UPDATE profiles SET status='validated' WHERE profile_id=?").run(profile.profile_id);
          state.db.prepare("UPDATE generations SET state='ready' WHERE generation_id=?").run(genId);
          state.db.prepare("UPDATE jobs SET state='succeeded',phase='ready',progress_json=?,updated_at=? WHERE job_id=?").run(canonicalJSON({ documents: docs.length, passages: mappings.length, reused_documents: reusedDocuments, embedding_calls: embedded.stats.embeddingCalls }), timestamp(), jobId);
        });
        return { generation_id: genId, epoch: 0, manifest_sha256: sealed.sha256, coverage, published: false };
      }
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
        this.catalog.markPoliciesIndexed(collections.map(c => c.collection_id));
        state.db.prepare("UPDATE jobs SET state='succeeded',phase='complete',progress_json=?,updated_at=? WHERE job_id=?").run(canonicalJSON({ documents: docs.length, passages: mappings.length, reused_documents: reusedDocuments, embedding_calls: embedded.stats.embeddingCalls }), timestamp(), jobId);
      });
      return { generation_id: genId, epoch, manifest_sha256: sealed.sha256, coverage, published: true };
    } catch (e) {
      // Confirm native worker exit before publishing a terminal cancellation.
      await builder.close();if (reader) await reader.close();
      const cancelled = signal.aborted || (e instanceof DsearchError && e.code === "CANCELLED"), code = e instanceof DsearchError ? e.code : "INTERNAL_ERROR";
      state.transaction(() => { state.db.prepare("UPDATE generations SET state='invalid' WHERE generation_id=?").run(genId);state.db.prepare("UPDATE jobs SET state=?,phase='stopped',error_code=?,updated_at=? WHERE job_id=?").run(cancelled ? "cancelled" : "failed", cancelled ? "CANCELLED" : code, timestamp(), jobId); });
      throw new DsearchError(cancelled ? "CANCELLED" : code);
    } finally { releaseBase?.();clearInterval(timer);state.db.prepare("UPDATE jobs SET lease_owner=NULL,lease_expires_at=NULL WHERE job_id=?").run(jobId);try { await builder.close();if (reader) await reader.close(); } finally { releaseLane?.(); } }
  }
}
