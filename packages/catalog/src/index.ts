import { randomUUID } from "node:crypto";
import { readdir, lstat, realpath } from "node:fs/promises";
import { join, resolve, matchesGlob } from "node:path";
import { CollectionRequest, ReadRequest, DsearchError } from "@dsearch/contracts";
import { StateStore } from "./database.js";
import { canonicalJSON, digest, within, pathEligibility, metadataEligibility, type ScopePolicy, type Eligibility } from "./policy.js";
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
  constructor(readonly state: StateStore) {}
  listCollections(): Collection[] { return this.state.db.prepare("SELECT * FROM collections ORDER BY name,collection_id").all() as Collection[]; }
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
      if (!info.isDirectory() || within(this.state.root, root)) throw new Error("Invalid source root");key = fileKey(info);
    } catch { throw new DsearchError("SCOPE_DENIED"); }
    const policy: ScopePolicy = { preset: request.preset, include: request.include, exclude: request.exclude, root_file_key: key };
    const scope = canonicalJSON(policy), id = randomUUID();
    if (this.listCollections().some(c => c.name === request.name || c.root_path === root)) throw new DsearchError("INVALID_REQUEST");
    this.state.transaction(() => { this.state.db.prepare("INSERT INTO collections VALUES (?,?,?,?,?,1,?)").run(id, request.name, root, scope, digest(scope), now());this.state.advance(); });
    return this.collection(id);
  }
  setEnabled(id: string, enabled: boolean): void {
    this.collection(id);this.state.transaction(() => { this.state.db.prepare("UPDATE collections SET enabled=? WHERE collection_id=?").run(Number(enabled), id);this.state.advance(); });
  }
  rename(id: string, name: string): void {
    this.collection(id);const parsed = CollectionRequest.shape.name.safeParse(name);
    if (!parsed.success || this.listCollections().some(c => c.collection_id !== id && c.name === parsed.data)) throw new DsearchError('INVALID_REQUEST');
    this.state.db.prepare('UPDATE collections SET name=? WHERE collection_id=?').run(parsed.data, id);
  }
  setScope(id: string, input: unknown): void {
    const row = this.collection(id), previous = JSON.parse(row.scope_json) as ScopePolicy;
    const parsed = CollectionRequest.safeParse({ name: row.name, root: row.root_path, preset: previous.preset, include: previous.include, exclude: previous.exclude, ...(input as object) });
    if (!parsed.success || parsed.data.root !== row.root_path || parsed.data.name !== row.name) throw new DsearchError("INVALID_REQUEST");
    const policy: ScopePolicy = { preset: parsed.data.preset, include: parsed.data.include, exclude: parsed.data.exclude, root_file_key: previous.root_file_key };
    const scope = canonicalJSON(policy);
    this.state.transaction(() => { this.state.db.prepare("UPDATE collections SET scope_json=?,scope_fp=? WHERE collection_id=?").run(scope, digest(scope), id);this.state.advance(); });
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
      const collection = this.collection(id);if (!collection.enabled) throw new DsearchError("SCOPE_DENIED");
      const policy = JSON.parse(collection.scope_json) as ScopePolicy;await checkRoot(collection.root_path, policy);
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
            const product = within(this.state.root, full), source = policy.preset === "learning" && child.split("/").includes("Sources");
            if (hidden || excluded || product || source) boundaries.push({ path: child, eligibility: source ? "excluded_source" : "excluded_pattern", reason: product ? "product_data" : hidden ? "hidden_or_dependency_path" : source ? "source_directory" : "exclude_pattern", incomplete: false });
            else await walk(child, depth + 1);
            continue;
          }
          let eligibility = pathEligibility(child, policy);if (!info.isFile()) eligibility = { eligibility: "excluded_source", reason: "not_regular_file" };
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
            observations.push({ relative_path: child, file_key: source.fileKey, ...metadataEligibility(source.metadata, policy), source });
          } catch (e) {
            const code = e instanceof DsearchError ? e.code : "INTERNAL_ERROR";
            const eligibility: Eligibility = code === "INVALID_METADATA" ? "invalid_metadata" : code === "UNSUPPORTED_ENCODING" ? "unsupported_encoding" : code === "SOURCE_PENDING" || code === "STALE_REVISION" ? "pending" : "unreadable";
            observations.push({ relative_path: child, file_key: key, eligibility, reason: code.toLowerCase() });
          }
        }
      };
      await walk("", 0);abort();if (stopped) boundaries.push({ path: "", eligibility: "pending", reason: "scan_budget", incomplete: true, retain: true });await checkRoot(collection.root_path, policy);
      if (!this.collection(id).enabled || this.collection(id).scope_fp !== collection.scope_fp) throw new DsearchError("STALE_EPOCH");
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
    if (within(this.state.root, join(collection.root_path, doc.relative_path))) throw new DsearchError("SCOPE_DENIED");
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
