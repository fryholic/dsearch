import { randomUUID } from "node:crypto";
import { readdir, lstat, realpath, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, matchesGlob } from "node:path";
import { CollectionRequest, ReadRequest, DsearchError } from "@dsearch/contracts";
import { CollectionPatch } from '@dsearch/contracts/control';
import { StateStore } from "./database.js";
import { isLegacySourceDirectory } from "./legacy-scope.js";
export { legacyNavigationHeadings } from "./legacy-scope.js";
import { canonicalJSON, digest, within, pathEligibility, metadataEligibility, newScopePolicy, type ScopePolicy, type Eligibility } from "./policy.js";
import { fileKey, checkRoot, readStableSource } from "./files.js";
export { StateStore } from "./database.js";
export { canonicalJSON, digest, within, parseMetadata, type Metadata, type Eligibility, type ScopePolicy } from "./policy.js";

export type Collection = { collection_id: string; name: string; root_path: string; scope_json: string; scope_fp: string; enabled: number; created_at: string };
export type SourceDocument = { doc_id: string; collection_id: string; relative_path: string; file_key: string | null; present: number; eligibility: Eligibility; eligibility_reason: string | null; latest_revision_id: string | null; observed_seq: number; observed_at: string };
type Source = Awaited<ReturnType<typeof readStableSource>>;
type Observation = { relative_path: string; file_key: string | null; eligibility: Eligibility; reason: string; source?: Source };
type Boundary = { path: string; eligibility: Eligibility; reason: string; incomplete: boolean; retain?: boolean };
export type ScanBudget = { maxBytesPerFile: number; maxTotalBytes: number; deadline: number };
export type ScanReport = { collection_id: string; source_seq: number; scope_incomplete: boolean; counts: Record<string, number>; boundaries: Boundary[]; documents: SourceDocument[]; read_bytes: number; skipped_files: number; stop_reason: "time_limit" | "byte_limit" | "entry_limit" | null; captured_sources?: { document: SourceDocument; source: Source }[] };
const now = () => new Date().toISOString();

/** Filesystem discovery precedes a short synchronous product-state transaction. */
export class Catalog {
  private readonly scanning = new Set<string>();
  constructor(readonly state: StateStore, private readonly excludedDataRoot = state.root) {}
  listCollections(): Collection[] { return this.state.db.prepare("SELECT c.* FROM collections c LEFT JOIN collection_registrations r USING(collection_id) WHERE COALESCE(r.removed,0)=0 ORDER BY name,collection_id").all() as Collection[]; }
  collection(id: string): Collection {
    const row = this.state.db.prepare("SELECT * FROM collections WHERE collection_id=?").get(id) as Collection | undefined;
    if (!row) throw new DsearchError("NOT_FOUND"); return row;
  }
  scanStatus(id: string) {
    const c = this.collection(id), row = this.state.db.prepare("SELECT * FROM collection_scans WHERE collection_id=? AND scope_fp=?").get(id, c.scope_fp);
    return { status: !row ? 'unscanned' as const : row.incomplete ? 'incomplete' as const : 'complete' as const, incomplete_boundaries: row ? (JSON.parse(String(row.boundaries_json)) as Boundary[]).filter(b => b.incomplete).length : 0, checked_at: row ? String(row.checked_at) : null };
  }
  private recordScan(id: string, scopeFp: string, boundaries: Boundary[]): void {
    this.state.db.prepare("INSERT INTO collection_scans VALUES (?,?,?,?,?) ON CONFLICT(collection_id) DO UPDATE SET scope_fp=excluded.scope_fp,incomplete=excluded.incomplete,boundaries_json=excluded.boundaries_json,checked_at=excluded.checked_at").run(id, scopeFp, Number(boundaries.some(b => b.incomplete)), canonicalJSON(boundaries), now());
  }
  async addCollection(input: unknown): Promise<Collection> {
    const parsed = CollectionRequest.safeParse(input); if (!parsed.success) throw new DsearchError("INVALID_REQUEST");
    const request = parsed.data;let root: string, key: string;
    try {
      root = await realpath(resolve(request.root));const info = await lstat(root, { bigint: true });
      if (!info.isDirectory() || within(this.excludedDataRoot, root)) throw new Error("Invalid source root");key = fileKey(info);
    } catch { throw new DsearchError("SCOPE_DENIED"); }
    const policy = newScopePolicy(request, key);
    const scope = canonicalJSON(policy);
    const detached = this.state.db.prepare('SELECT c.* FROM collections c JOIN collection_registrations r USING(collection_id) WHERE c.root_path=? AND r.removed=1 ORDER BY r.detached_at DESC').all(root) as Collection[];
    const prior = detached.find(c => (JSON.parse(c.scope_json) as ScopePolicy).root_file_key === key), id = prior?.collection_id ?? randomUUID();
    if (this.listCollections().some(c => c.name === request.name || c.root_path === root)) throw new DsearchError("INVALID_REQUEST");
    this.state.transaction(() => { if (prior) { this.state.db.prepare('UPDATE collections SET name=?,scope_json=?,scope_fp=?,enabled=1 WHERE collection_id=?').run(request.name, scope, digest(scope), id);this.state.db.prepare('DELETE FROM collection_registrations WHERE collection_id=?').run(id);this.state.db.prepare("UPDATE scope_migrations SET reviewed=1,status='matched',reindexed=0 WHERE collection_id=?").run(id); }
      else this.state.db.prepare("INSERT INTO collections VALUES (?,?,?,?,?,1,?)").run(id, request.name, root, scope, digest(scope), now());this.state.advance(); });
    return this.collection(id);
  }
  private requireRegistered(id: string): Collection {
    const collection = this.collection(id);
    if (this.state.db.prepare('SELECT removed FROM collection_registrations WHERE collection_id=?').get(id)?.removed) throw new DsearchError('SCOPE_DENIED');
    return collection;
  }
  patch(id: string, input: unknown): Collection {
    const row = this.requireRegistered(id), patch = CollectionPatch.safeParse(input);if (!patch.success) throw new DsearchError('INVALID_REQUEST');
    const prior = JSON.parse(row.scope_json) as ScopePolicy, { name = row.name, enabled = !!row.enabled, ...scopePatch } = patch.data;
    const parsed = CollectionRequest.safeParse({ name, root: row.root_path, preset: "general", include: prior.include, exclude: prior.exclude, path_prefixes: prior.path_prefixes, metadata_filter: prior.metadata_filter, navigation_headings: prior.navigation_headings, ...Object.fromEntries(Object.entries(scopePatch).filter(([key]) => key !== "legacy_compatibility")) });
    if (!parsed.success || this.listCollections().some(c => c.collection_id !== id && c.name === name)) throw new DsearchError('INVALID_REQUEST');
    const policy = newScopePolicy(parsed.data, prior.root_file_key, prior.metadata_mode === "legacy-v1" && patch.data.legacy_compatibility !== false), scope = canonicalJSON(policy);
    this.state.transaction(() => { this.state.db.prepare('UPDATE collections SET name=?,enabled=?,scope_json=?,scope_fp=? WHERE collection_id=?').run(parsed.data.name, Number(enabled), scope, digest(scope), id);if (scope !== row.scope_json) this.state.db.prepare("UPDATE scope_migrations SET reviewed=1,status='matched',reindexed=0 WHERE collection_id=?").run(id);if (scope !== row.scope_json || Number(enabled) !== row.enabled) this.state.advance(); });
    return this.collection(id);
  }
  setEnabled(id: string, enabled: boolean): void { this.patch(id, { enabled }); }
  rename(id: string, name: string): void { this.patch(id, { name }); }
  setScope(id: string, input: unknown): void { this.patch(id, input); }
  unregister(id: string): void {
    const row = this.collection(id);if (this.state.db.prepare('SELECT removed FROM collection_registrations WHERE collection_id=?').get(id)?.removed) return;
    this.state.transaction(() => { this.state.db.prepare('INSERT INTO collection_registrations VALUES (?,1,?,?) ON CONFLICT(collection_id) DO UPDATE SET removed=1,previous_name=excluded.previous_name,detached_at=excluded.detached_at').run(id, row.name, now());this.state.db.prepare('UPDATE collections SET enabled=0,name=? WHERE collection_id=?').run(id + '-removed', id);this.state.advance(); });
  }
  migrationInfo(id: string) {
    const row = this.state.db.prepare('SELECT status,checked_entries,reindexed,reviewed FROM scope_migrations WHERE collection_id=?').get(id);
    return row ? { status: row.status as 'unverified' | 'matched' | 'changed', checked_entries: Number(row.checked_entries), reindex_required: !row.reindexed, reviewed: !!row.reviewed } : null;
  }
  get policyUpgradePending(): boolean {
    return !!this.state.db.prepare('SELECT 1 FROM scope_migrations m JOIN collections c USING(collection_id) LEFT JOIN collection_registrations r USING(collection_id) WHERE m.reindexed=0 AND c.enabled=1 AND COALESCE(r.removed,0)=0 LIMIT 1').get();
  }
  markPoliciesIndexed(ids: string[]): void {
    for (const id of ids) {
      const migration = this.migrationInfo(id);
      if (migration?.status === 'changed' || migration?.status === 'unverified') throw new DsearchError('COMPATIBILITY_FAILED');
      this.state.db.prepare('UPDATE scope_migrations SET reindexed=1 WHERE collection_id=?').run(id);
    }
  }
  async previewPatch(id: string, input: unknown) {
    const patch = CollectionPatch.safeParse(input);if (!patch.success) throw new DsearchError('INVALID_REQUEST');
    const c = this.requireRegistered(id), policy = JSON.parse(c.scope_json) as ScopePolicy;
    const request = { name: c.name, root: c.root_path, preset: 'general', include: policy.include, exclude: policy.exclude, path_prefixes: policy.path_prefixes, metadata_filter: policy.metadata_filter, navigation_headings: policy.navigation_headings, ...Object.fromEntries(Object.entries(patch.data).filter(([key]) => !['legacy_compatibility','enabled'].includes(key))) };
    const recorded = this.state.db.prepare("SELECT previous_scope_json FROM scope_migrations WHERE collection_id=? AND status='changed' AND reviewed=0").get(id);
    const before = await this.previewScan(request, recorded ? JSON.parse(String(recorded.previous_scope_json)) as ScopePolicy : policy);
    const next = newScopePolicy(CollectionRequest.parse(request), policy.root_file_key, policy.metadata_mode === 'legacy-v1' && patch.data.legacy_compatibility !== false);
    const after = await this.previewScan(request, next);
    // Preview only returns bounded changes when both scans cover the full scope.
    const { eligible_paths: _paths, ...result } = after;
    return { ...result, changes: before.partial || after.partial || before.scope_incomplete || after.scope_incomplete ? null : { added: after.eligible_paths.filter(p => !before.eligible_paths.includes(p)).length, removed: before.eligible_paths.filter(p => !after.eligible_paths.includes(p)).length, unchanged: after.eligible_paths.filter(p => before.eligible_paths.includes(p)).length } };
  }
  async preview(input: unknown) {
    const { eligible_paths: _paths, ...result } = await this.previewScan(input);return result;
  }
  private async previewScan(input: unknown, effectivePolicy?: ScopePolicy) {
    const parsed = CollectionRequest.safeParse(input);if (!parsed.success) throw new DsearchError('INVALID_REQUEST');
    const base = join(this.state.root, 'previews');await mkdir(base, { recursive: true, mode: 0o700 });
    const info = await lstat(base);if (!info.isDirectory() || info.isSymbolicLink() || await realpath(base) !== base || (info.mode & 0o077)) throw new DsearchError('SCOPE_DENIED');
    const folder = await mkdtemp(join(base, 'scope-'));let store: StateStore | undefined;
    try { store = await StateStore.open(folder);const catalog = new Catalog(store, this.excludedDataRoot), col = await catalog.addCollection(parsed.data);
      if (effectivePolicy) { const policy = { ...effectivePolicy, root_file_key: JSON.parse(col.scope_json).root_file_key };store.db.prepare("UPDATE collections SET scope_json=?,scope_fp=? WHERE collection_id=?").run(canonicalJSON(policy), digest(canonicalJSON(policy)), col.collection_id); }
      const report = await catalog.reconcile(col.collection_id, { maxEntries: 10000, budget: { maxBytesPerFile: 2 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024, deadline: Date.now() + 5000 } });
      return { eligible_paths: report.documents.filter(d => d.eligibility === "eligible").map(d => d.relative_path), changes: null, counts: report.counts, partial: !!report.stop_reason, stop_reason: report.stop_reason, scope_incomplete: report.scope_incomplete, read_bytes: report.read_bytes, sample: report.documents.slice(0, 30).map(d => ({ relative_path: d.relative_path, eligibility: d.eligibility, reason: d.eligibility_reason })) };
    } finally { store?.close();await rm(folder, { recursive: true, force: true }); }
  }
  documents(collectionId?: string): SourceDocument[] {
    return (collectionId ? this.state.db.prepare("SELECT * FROM source_documents WHERE collection_id=? ORDER BY relative_path,doc_id").all(collectionId)
      : this.state.db.prepare("SELECT * FROM source_documents ORDER BY collection_id,relative_path,doc_id").all()) as SourceDocument[];
  }
  document(id: string): SourceDocument {
    const row = this.state.db.prepare("SELECT * FROM source_documents WHERE doc_id=?").get(id) as SourceDocument | undefined;
    if (!row) throw new DsearchError("NOT_FOUND");return row;
  }
  async reconcile(id: string, options: { signal?: AbortSignal; maxEntries?: number; budget?: ScanBudget; captureSources?: boolean } = {}): Promise<ScanReport> {
    if (this.scanning.has(id)) throw new DsearchError("BUSY");this.scanning.add(id);
    try {
      const collection = this.collection(id);if (this.migrationInfo(id)?.status === "changed") throw new DsearchError("COMPATIBILITY_FAILED");if (!collection.enabled) throw new DsearchError("SCOPE_DENIED");
      const policy = JSON.parse(collection.scope_json) as ScopePolicy;await checkRoot(collection.root_path, policy);
      const migration = this.state.db.prepare("SELECT previous_scope_json FROM scope_migrations WHERE collection_id=? AND status='unverified' AND reviewed=0").get(id);
      const oldPolicy = migration ? JSON.parse(String(migration.previous_scope_json)) as ScopePolicy : undefined;
      let comparedEntries = 0, scopeMismatch = false;
      const previous = this.documents(id).filter(d => d.present), observations: Observation[] = [], boundaries: Boundary[] = [];
      const previousByPath = new Map(previous.map(d => [d.relative_path, d]));
      const seen = new Set<string>();let count = 0, readBytes = 0, skipped = 0, stopped = false;
      let stopReason: ScanReport["stop_reason"] = null;
      const abort = () => { if (options.signal?.aborted) throw new DsearchError("CANCELLED"); };
      const budgetStop = () => { if (options.budget && Date.now() >= options.budget.deadline) { stopped = true;stopReason = "time_limit"; }return stopped; };
      const walk = async (path: string, depth: number): Promise<void> => {
        abort();if (budgetStop()) return;if (depth > 128) { boundaries.push({ path, eligibility: "unreadable", reason: "depth_limit", incomplete: true });return; }
        let entries;
        try { entries = await readdir(join(collection.root_path, path), { withFileTypes: true }); }
        catch { boundaries.push({ path, eligibility: "unreadable", reason: "directory_unreadable", incomplete: true });return; }
        for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
          abort();if (budgetStop()) return;
          if (++count > (options.maxEntries ?? 250_000)) { if (options.budget) { stopped = true;stopReason = "entry_limit";return; }throw new DsearchError("SCOPE_INCOMPLETE"); }
          const child = path ? path + "/" + entry.name : entry.name, full = join(collection.root_path, child);let info;
          try { info = await lstat(full, { bigint: true }); }
          catch { boundaries.push({ path: child, eligibility: "unreadable", reason: "stat_failed", incomplete: true });if (!entry.isDirectory()) observations.push({ relative_path: child, file_key: null, eligibility: "unreadable", reason: "stat_failed" });continue; }
          const key = fileKey(info);
          if (info.isSymbolicLink()) {
            boundaries.push({ path: child, eligibility: "excluded_source", reason: "symlink", incomplete: false });
            observations.push({ relative_path: child, file_key: key, eligibility: "excluded_source", reason: "symlink" });continue;
          }
          if (info.isDirectory()) {
            const hidden = child.split("/").some(x => x.startsWith(".") || x === "node_modules");
            const excluded = policy.exclude.some(glob => glob.endsWith("/**") && matchesGlob(child, glob.slice(0, -3)));
            const product = within(this.excludedDataRoot, full), source = policy.version !== 2 && isLegacySourceDirectory(child, policy.preset);
            const oldExcluded = oldPolicy && (oldPolicy.exclude.some(glob => glob.endsWith("/**") && matchesGlob(child, glob.slice(0, -3))) || (oldPolicy.version !== 2 && isLegacySourceDirectory(child, oldPolicy.preset)));
            // During conversion, inspect either policy's candidate directories before comparing file decisions.
            if (hidden || product || ((excluded || source) && (!oldPolicy || oldExcluded))) boundaries.push({ path: child, eligibility: source ? "excluded_source" : "excluded_pattern", reason: product ? "product_data" : hidden ? "hidden_or_dependency_path" : source ? "source_directory" : "exclude_pattern", incomplete: false });
            else await walk(child, depth + 1);
            continue;
          }
          let eligibility = pathEligibility(child, policy);
          if (oldPolicy && info.isFile()) { comparedEntries++;scopeMismatch ||= (pathEligibility(child, oldPolicy).eligibility === 'eligible') !== (eligibility.eligibility === 'eligible'); }
          if (!info.isFile()) eligibility = { eligibility: "excluded_source", reason: "not_regular_file" };
          if (eligibility.eligibility !== "eligible") { observations.push({ relative_path: child, file_key: key, ...eligibility });continue; }
          if (options.budget && info.size > BigInt(Math.max(0, Math.min(options.budget.maxBytesPerFile, options.budget.maxTotalBytes - readBytes)))) {
            skipped++;stopReason ??= "byte_limit";const candidate = previousByPath.get(child), old = candidate?.file_key === key ? candidate : undefined;
            observations.push({ relative_path: child, file_key: key, eligibility: old?.eligibility ?? "pending", reason: old?.eligibility_reason ?? "literal_file_limit" });
            if (readBytes >= options.budget.maxTotalBytes || info.size <= BigInt(options.budget.maxBytesPerFile)) stopped = true;
            continue;
          }
          try {
            const cap = options.budget ? Math.min(options.budget.maxBytesPerFile, options.budget.maxTotalBytes - readBytes) : 32 * 1024 * 1024;
            const source = await readStableSource(collection.root_path, child, policy, cap, bytes => { readBytes += bytes; });
            const decision = metadataEligibility(source.metadata, policy);
            if (oldPolicy) scopeMismatch ||= (metadataEligibility(source.metadata, oldPolicy).eligibility === 'eligible') !== (decision.eligibility === 'eligible');
            observations.push({ relative_path: child, file_key: source.fileKey, ...decision, source });
          } catch (e) {
            const code = e instanceof DsearchError ? e.code : "INTERNAL_ERROR";
            const eligibility: Eligibility = code === "INVALID_METADATA" ? "invalid_metadata" : code === "UNSUPPORTED_ENCODING" ? "unsupported_encoding" : code === "SOURCE_PENDING" || code === "STALE_REVISION" ? "pending" : "unreadable";
            observations.push({ relative_path: child, file_key: key, eligibility, reason: code.toLowerCase() });
          }
        }
      };
      await walk("", 0);abort();if (stopped) boundaries.push({ path: "", eligibility: "pending", reason: "scan_budget", incomplete: true, retain: true });await checkRoot(collection.root_path, policy);
      if (!this.collection(id).enabled || this.collection(id).scope_fp !== collection.scope_fp) throw new DsearchError("STALE_EPOCH");
      if (scopeMismatch && oldPolicy) {
        this.state.transaction(() => {
          this.state.db.prepare("UPDATE scope_migrations SET status='changed',checked_entries=? WHERE collection_id=?").run(comparedEntries, id);this.state.advance();
        });
        throw new DsearchError('COMPATIBILITY_FAILED');
      }
      const matched = new Set<string>(), byPath = new Map(previous.map(d => [d.relative_path, d])), assigned = new Map<Observation, SourceDocument>();
      for (const observation of observations) {
        const old = byPath.get(observation.relative_path);
        if (old && (observation.file_key === null || old.file_key === observation.file_key)) { assigned.set(observation, old);matched.add(old.doc_id); }
        seen.add(observation.relative_path);
      }
      // Only a unique file identity among disappeared/new paths confirms an offline move.
      const oldKeys = new Map<string, SourceDocument[]>(), newKeys = new Map<string, Observation[]>();
      for (const doc of previous) if (!matched.has(doc.doc_id) && doc.file_key) oldKeys.set(doc.file_key, [...(oldKeys.get(doc.file_key) ?? []), doc]);
      for (const observation of observations) if (!assigned.has(observation) && observation.file_key) newKeys.set(observation.file_key, [...(newKeys.get(observation.file_key) ?? []), observation]);
      for (const [key, newPaths] of newKeys) {
        const candidates = oldKeys.get(key);
        if (candidates?.length === 1 && newPaths.length === 1) { assigned.set(newPaths[0]!, candidates[0]!);matched.add(candidates[0]!.doc_id); }
      }
      const rows: SourceDocument[] = [], revisions: { docId: string; revisionId: string; source: Source }[] = [];
      for (const observation of observations) {
        const old = assigned.get(observation), docId = old?.doc_id ?? randomUUID();
        const revisionId = observation.source ? digest(docId + "\0" + observation.source.rawSha256) : old?.latest_revision_id ?? null;
        rows.push({ doc_id: docId, collection_id: id, relative_path: observation.relative_path, file_key: observation.file_key ?? old?.file_key ?? null, present: 1, eligibility: observation.eligibility, eligibility_reason: observation.reason, latest_revision_id: revisionId, observed_seq: old?.observed_seq ?? 0, observed_at: now() });
        if (observation.source && revisionId) revisions.push({ docId, revisionId, source: observation.source });
      }
      for (const old of previous.filter(d => !matched.has(d.doc_id))) {
        const boundary = !seen.has(old.relative_path) ? boundaries.find(b => b.path === "" || old.relative_path === b.path || old.relative_path.startsWith(b.path + "/")) : undefined;
        rows.push({ ...old, present: boundary ? 1 : 0, eligibility: boundary?.retain ? old.eligibility : boundary?.eligibility ?? "deleted", eligibility_reason: boundary?.retain ? old.eligibility_reason : boundary?.reason ?? "not_present", observed_at: now() });
      }
      const comparable = (d: SourceDocument) => canonicalJSON([d.relative_path, d.file_key, d.present, d.eligibility, d.eligibility_reason, d.latest_revision_id]);
      const oldById = new Map(previous.map(d => [d.doc_id, d]));
      const changed = rows.some(row => !oldById.has(row.doc_id) || comparable(oldById.get(row.doc_id)!) !== comparable(row));
      this.state.transaction(() => {
        if (oldPolicy && !options.budget && !boundaries.some(b => b.incomplete)) this.state.db.prepare("UPDATE scope_migrations SET status='matched',checked_entries=? WHERE collection_id=?").run(comparedEntries, id);
        const seq = changed ? this.state.advance() : this.state.sourceSeq;
        this.state.db.prepare("UPDATE source_documents SET present=0 WHERE collection_id=? AND present=1").run(id);
        const insert = this.state.db.prepare("INSERT INTO source_documents (doc_id,collection_id,relative_path,file_key,present,eligibility,latest_revision_id,observed_seq,observed_at,eligibility_reason) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(doc_id) DO UPDATE SET relative_path=excluded.relative_path,file_key=excluded.file_key,present=excluded.present,eligibility=excluded.eligibility,latest_revision_id=excluded.latest_revision_id,observed_seq=excluded.observed_seq,observed_at=excluded.observed_at,eligibility_reason=excluded.eligibility_reason");
        for (const row of rows) {
          const old = oldById.get(row.doc_id);if (!old || comparable(old) !== comparable(row)) row.observed_seq = seq;
          insert.run(row.doc_id, id, row.relative_path, row.file_key, row.present, row.eligibility, row.latest_revision_id, row.observed_seq, row.observed_at, row.eligibility_reason);
        }
        const revision = this.state.db.prepare("INSERT OR IGNORE INTO source_revisions VALUES (?,?,?,?,?,?,?)");
        for (const value of revisions) revision.run(value.revisionId, value.docId, value.source.rawSha256, value.source.textSha256, value.source.bytes, canonicalJSON(value.source.metadata), now());
      });
      if (!options.budget) this.recordScan(id, collection.scope_fp, boundaries);
      const documents = this.documents(id), counts: Record<string, number> = {};
      for (const doc of documents) counts[doc.eligibility] = (counts[doc.eligibility] ?? 0) + 1;
      const captured = options.captureSources ? observations.flatMap((o, i) => o.source && o.eligibility === "eligible" ? [{ document: rows[i]!, source: o.source }] : []) : undefined;
      return { collection_id: id, source_seq: this.state.sourceSeq, scope_incomplete: boundaries.some(b => b.incomplete), counts, boundaries, documents, read_bytes: readBytes, skipped_files: skipped, stop_reason: stopReason, ...(captured ? { captured_sources: captured } : {}) };
    } catch (e) {
      if (!options.budget && e instanceof DsearchError && ['SCOPE_INCOMPLETE', 'SCOPE_DENIED'].includes(e.code)) this.recordScan(id, this.collection(id).scope_fp, [{ path: '', eligibility: 'unreadable', reason: e.code.toLowerCase(), incomplete: true }]);
      throw e;
    } finally { this.scanning.delete(id); }
  }
  async readDocument(docId: string, expectedRevision: string): Promise<Source & { document: SourceDocument; collection: Collection }> {
    const doc = this.document(docId), collection = this.collection(doc.collection_id), policy = JSON.parse(collection.scope_json) as ScopePolicy;
    if (within(this.excludedDataRoot, join(collection.root_path, doc.relative_path))) throw new DsearchError("SCOPE_DENIED");
    if (this.migrationInfo(collection.collection_id)?.status === "changed") throw new DsearchError("COMPATIBILITY_FAILED");
    if (!collection.enabled || !doc.present || doc.eligibility !== "eligible" || pathEligibility(doc.relative_path, policy).eligibility !== "eligible") throw new DsearchError("SCOPE_DENIED");
    if (!doc.latest_revision_id || doc.latest_revision_id !== expectedRevision) throw new DsearchError("STALE_REVISION");
    const source = await readStableSource(collection.root_path, doc.relative_path, policy);
    if (metadataEligibility(source.metadata, policy).eligibility !== "eligible") throw new DsearchError("SCOPE_DENIED");
    if (source.fileKey !== doc.file_key || digest(doc.doc_id + "\0" + source.rawSha256) !== expectedRevision) throw new DsearchError("STALE_REVISION");
    const current = this.collection(collection.collection_id);
    if (!current.enabled || current.scope_fp !== collection.scope_fp) throw new DsearchError("SCOPE_DENIED");
    return { ...source, document: doc, collection };
  }
  async read(input: unknown) {
    const parsed = ReadRequest.safeParse(input);if (!parsed.success) throw new DsearchError("INVALID_REQUEST");
    const request = parsed.data, source = await this.readDocument(request.doc_id, request.revision_id), lines = source.text.split("\n");
    const { start, end } = request.locator;
    const eofEnd = end.line === lines.length + 1 && end.column_utf16 === 0;
    if (start.line > lines.length || (!eofEnd && end.line > lines.length) || start.column_utf16 > lines[start.line - 1]!.length || (!eofEnd && end.column_utf16 > lines[end.line - 1]!.length)) throw new DsearchError("INVALID_LOCATOR");
    const finalLine = end.column_utf16 === 0 && end.line > start.line ? end.line - 1 : end.line;
    const first = Math.max(1, start.line - request.context_before_lines), last = Math.min(lines.length, finalLine + request.context_after_lines);
    const selected = lines.slice(first - 1, Math.min(last, first - 1 + request.max_lines));
    let text = selected.join("\n"), truncated = last - first + 1 > selected.length;
    while (new TextEncoder().encode(text).length > 65_536 && selected.length) { selected.pop();text = selected.join("\n");truncated = true; }
    if (!selected.length && last >= first) throw new DsearchError("SOURCE_TOO_LARGE");
    return { doc_id: request.doc_id, revision_id: request.revision_id, relative_path: source.document.relative_path, collection_id: source.collection.collection_id, locator: request.locator, start_line: first, end_line: first + selected.length - 1, text, truncated };
  }
}
