import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { EngineSearchRequest, DsearchError, ErrorCode, ErrorReason, type Filter } from "@dsearch/contracts";

type Stats = Record<string, number | boolean>;
type Hit = { file: string; title: string; body?: string; bestChunk?: string; bestChunkPos?: number; score: number; [key: string]: unknown };
type Store = {
  internal: { db: { prepare(sql: string): { get(): unknown; all(): unknown[] } } };
  update(): Promise<unknown>; embed(options: unknown): Promise<unknown>;
  search(options: unknown): Promise<Hit[]>; searchLex(query: string, options: unknown): Promise<Hit[]>;
  close(): Promise<void>;
  dsearchInspectProjection(text: string, title: string, file: string): Promise<unknown>;
  dsearchInspectRerank(query: string, text: string): Promise<unknown>;
  dsearchQueryTokens(query: string): Promise<number>;
  dsearchRerank(query: string, docs: { file: string; text: string }[]): Promise<unknown>;
  dsearchEmbedding(text: string, title: string, isQuery: boolean): Promise<unknown>;
  dsearchDevice(): Promise<unknown>; dsearchSnapshot(target: string): Promise<void>;
  dsearchLexicalMatches(query: string, files: unknown[]): Promise<unknown>;
};
type Module = {
  createStore(options: unknown): Promise<Store>;
  dsearchCapabilities?: Record<string, unknown>;
  MemoryQueryCache: new () => unknown;
  compatibilityStats(): Stats;
  runDsearchRequest<T>(request: unknown, operation: () => Promise<T>): Promise<T>;
};
let sdk: Module, store: Store | undefined, cache: unknown, strict = true, engineRoot = "";
let role: "probe" | "builder" | "reader" = "probe", allowedCollections = ["probe"], semanticCollections = ["probe"];
let active: { id: string; controller: AbortController } | undefined;
let requestStats: Stats | undefined;
let modelErrors: Record<string, unknown> = {};
const send = (message: unknown) => { if (process.connected) process.send?.(message); };
const string = (v: unknown): string => { if (typeof v !== "string") throw new DsearchError("INVALID_REQUEST"); return v; };
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new DsearchError("INVALID_REQUEST");
  return v as Record<string, unknown>;
};
function compileFilter(node: Filter): unknown {
  const group = (operator: string, operands: unknown[]): unknown => operands.length <= 32 ? { operator, operands }
    : { operator, operands: [group(operator, operands.slice(0, 32)), group(operator, operands.slice(32))] };
  if ("and" in node) return group("and", node.and.map(compileFilter));
  if ("or" in node) return group("or", node.or.map(compileFilter));
  if ("not" in node) return { operator: "not", operand: compileFilter(node.not) };
  const field = node.field === "document_key" ? "document_key" : node.field.slice("metadata.".length);
  if (!["document_key", "role", "type", "status", "topics"].includes(field)) throw new DsearchError("INVALID_REQUEST");
  if (Array.isArray(node.value) && node.value.length > 64) return group(node.operator === "in" ? "or" : "and", [
    { field, operator: node.operator, value: node.value.slice(0, 64) }, { field, operator: node.operator, value: node.value.slice(64) }]);
  return { field, operator: node.operator, value: node.value };
}

async function execute(payload: Record<string, unknown>, signal: AbortSignal, id: string): Promise<unknown> {
  const method = string(payload.method);
  if (method === "open") {
    if (store) throw new DsearchError("BUSY", "One store per process");
    modelErrors = payload.modelErrors ? object(payload.modelErrors) : {};
    const root = string(payload.engineRoot);
    engineRoot = root;
    sdk = await import(pathToFileURL(join(root, "dist/index.js")).href) as Module;
    strict = payload.strict === true;
    if (strict && !["EP-01", "EP-02", "EP-03", "EP-04"].every(key => sdk.dsearchCapabilities?.[key] === true))
      throw new DsearchError("COMPATIBILITY_FAILED");
    if (payload.role !== undefined && !["probe", "builder", "reader"].includes(String(payload.role))) throw new DsearchError("INVALID_REQUEST");
    role = (payload.role ?? "probe") as typeof role;
    if (role !== "probe" && (typeof payload.generationId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.generationId))) throw new DsearchError("INVALID_REQUEST");
    if (role === "reader" && sdk.dsearchCapabilities?.sealedReadOnly !== true) throw new DsearchError("COMPATIBILITY_FAILED");
    const requestedCollections = payload.collections ? object(payload.collections) : { probe: { path: string(payload.collectionPath), pattern: "**/*.md" } };
    const collections = Object.fromEntries(Object.entries(requestedCollections).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, value]) => {
      const entry = object(value);if (entry.pattern !== "**/*.md") throw new DsearchError("INVALID_REQUEST");
      return [name, { path: string(entry.path), pattern: "**/*.md" }];
    }));
    allowedCollections = Object.keys(collections);
    if (!allowedCollections.length || allowedCollections.length > 64 || allowedCollections.some(key => !/^[a-zA-Z0-9_-]{1,128}$/.test(key))) throw new DsearchError("INVALID_REQUEST");
    for (const value of Object.values(collections)) { const entry = object(value);string(entry.path);if (entry.pattern !== "**/*.md") throw new DsearchError("INVALID_REQUEST"); }
    semanticCollections = Array.isArray(payload.semanticCollections) ? payload.semanticCollections.map(string) : [...allowedCollections];
    if (semanticCollections.some(key => !allowedCollections.includes(key))) throw new DsearchError("INVALID_REQUEST");
    try { store = await sdk.createStore({ dbPath: string(payload.dbPath), dsearchReadOnly: role === "reader", config: {
      collections,
      models: { embed: string(payload.embedModel), rerank: string(payload.rerankModel), generate: join(root, "not-installed.gguf") },
    } }); } catch { throw new DsearchError("COMPATIBILITY_FAILED"); }
    if (strict) cache = new sdk.MemoryQueryCache();
    return { capabilities: sdk.dsearchCapabilities ?? null, strict };
  }
  if (!store) throw new DsearchError("COMPATIBILITY_FAILED");
  const args = object(payload.args ?? {}), current = store;
  if (role === "reader" && ["update", "embed"].includes(method)) throw new DsearchError("SCOPE_DENIED");
  const stats = strict ? sdk.compatibilityStats() : {};
  requestStats = stats;
  const operation = async (): Promise<unknown> => {
    switch (method) {
      case "update": return current.update();
      case "embed": {
        if (role === "probe") return current.embed({ maxDocsPerBatch: 4, maxBatchBytes: 2_097_152, chunkStrategy: "regex" });
        const results = [];
        for (const collection of semanticCollections) results.push(await current.embed({ collection, maxDocsPerBatch: 4, maxBatchBytes: 2_097_152, chunkStrategy: "regex" }));
        return { results };
      }
      case "inspect": return current.dsearchInspectProjection(string(args.text), string(args.title), string(args.file));
      case "inspect_rerank": return current.dsearchInspectRerank(string(args.query), string(args.text));
      case "query_tokens": return current.dsearchQueryTokens(string(args.query));
      case "lexical_matches": {
        if (sdk.dsearchCapabilities?.lexicalEvidence !== true) throw new DsearchError("COMPATIBILITY_FAILED");
        if (!Array.isArray(args.files) || args.files.length > 80 || string(args.query).length > 32768) throw new DsearchError("INVALID_REQUEST");
        return current.dsearchLexicalMatches(string(args.query), args.files);
      }
      case "embedding": {
        const text = string(args.text), title = string(args.title ?? ""), isQuery = args.isQuery === true;
        if (strict) return current.dsearchEmbedding(text, title, isQuery);
        const llm = (current.internal as unknown as { llm: { embedModelName: string; embed(text: string, options: unknown): Promise<{ embedding: number[] } | null> } }).llm;
        const format = await import(pathToFileURL(join(engineRoot, "dist/llm.js")).href) as {
          formatDocForEmbedding(text: string, title: string, model: string): string;
          formatQueryForEmbedding(text: string, model: string): string;
        };
        const vector = await llm.embed(isQuery ? format.formatQueryForEmbedding(text, llm.embedModelName) : format.formatDocForEmbedding(text, title, llm.embedModelName), { isQuery });
        if (!vector) throw new DsearchError("MODEL_UNAVAILABLE");
        return { dimension: vector.embedding.length, norm: Math.sqrt(vector.embedding.reduce((sum, n) => sum + n * n, 0)) };
      }
      case "rerank": {
        if (!Array.isArray(args.documents) || args.documents.length > 1000) throw new DsearchError("INVALID_REQUEST");
        const docs = args.documents.map(value => { const doc = object(value); return { file: string(doc.file), text: string(doc.text) }; });
        return current.dsearchRerank(string(args.query), docs);
      }
      case "device": return typeof current.dsearchDevice === "function" ? current.dsearchDevice()
        : (current.internal as unknown as { llm: { getDeviceInfo(options: unknown): Promise<unknown> } }).llm.getDeviceInfo({ allowBuild: false });
      case "index_audit": {
        const db = current.internal.db;
        return { documents: db.prepare("SELECT d.collection,d.path,count(v.hash) AS vector_chunks FROM documents d LEFT JOIN content_vectors v ON v.hash=d.hash WHERE d.active=1 GROUP BY d.id ORDER BY d.collection,d.path").all(),
          integrity: db.prepare("PRAGMA quick_check").get(), cache: db.prepare("SELECT count(*) AS rows FROM llm_cache").get() };
      }
      case "clear_cache": if (strict) (cache as { clear(): void }).clear(); return { cleared: true };
      case "cache_audit": {
        if (!strict) throw new DsearchError("INVALID_REQUEST");
        const db = current.internal.db;
        const original = db.prepare;
        const rows = () => (original.call(db, "SELECT count(*) AS n FROM llm_cache").get() as { n: number }).n;
        const before = rows(); let touches = 0, expansionStubCalls = 0;
        db.prepare = function (sql: string) {
          if (/llm_cache/i.test(sql)) { touches++; throw new Error("CACHE_SQL_BLOCKED"); }
          return original.call(db, sql);
        };
        let guardConfirmed = false;
        try {
          try { db.prepare("SELECT result FROM llm_cache").get(); } catch { guardConfirmed = true; }
          touches = 0;
          await current.dsearchRerank("r0 cache audit signing bytes", [{ file: "one", text: "Canonical encoding fixes signing input bytes." }]);
          const functions = await import(pathToFileURL(join(engineRoot, "dist/store.js")).href) as {
            expandQuery(query: string, model: string | undefined, db: unknown, llm: unknown): Promise<unknown>;
          };
          const stub = { expandQuery: async () => { expansionStubCalls++; return [{ type: "vec", text: "synthetic expanded variant" }]; } };
          for (let i = 0; i < 2; i++) await functions.expandQuery("r0-expansion-cache-sentinel", undefined, db, stub);
          return { cacheRowsBefore: before, cacheRowsAfter: rows(), databaseCacheTouches: touches,
            sqlGuardConfirmed: guardConfirmed, expansionStubCalls, expansionNativeModelTested: false };
        } finally { db.prepare = original; }
      }
      case "snapshot": await current.dsearchSnapshot(string(args.target)); return { complete: true };
      case "close": await current.close(); store = undefined; return { closed: true };
      case "search": {
        const request = EngineSearchRequest.parse(args);
        if (request.collections.some(id => !allowedCollections.includes(id))) throw new DsearchError("SCOPE_DENIED");
        const filter = request.filter ? compileFilter(request.filter) : undefined;
        const line = request.query.replace(/\s+/g, " "), lexical = request.lexical_query ?? line;
        const search = async (mode: string, rerank: boolean) => {
          // Expansion is absent from this validated profile. Never invoke an implicit downloader.
          if (mode === 'deep') throw new DsearchError('MODEL_NOT_INSTALLED', undefined, false, 'EXPANSION_MODEL_NOT_INSTALLED');
          if (mode !== 'lexical' && modelErrors.embed) throw new DsearchError(modelErrors.embed === 'MODEL_NOT_INSTALLED' ? 'MODEL_NOT_INSTALLED' : 'MODEL_UNAVAILABLE', undefined, false, modelErrors.embed === 'MODEL_NOT_INSTALLED' ? 'EMBED_MODEL_NOT_INSTALLED' : 'EMBED_MODEL_UNAVAILABLE');
          if (rerank && modelErrors.rerank) throw new DsearchError('RERANK_UNAVAILABLE', undefined, false, modelErrors.rerank === 'MODEL_NOT_INSTALLED' ? 'RERANK_MODEL_NOT_INSTALLED' : 'RERANK_MODEL_UNAVAILABLE');
          const values = mode === "lexical"
          ? await current.searchLex(lexical, { collection: request.collections, limit: request.limit, filter })
          : await current.search({ ...(mode === "deep" ? { query: line } : { queries: [{ type: "lex", query: lexical }, { type: "vec", query: line }] }),
            collections: request.collections, filter, rerank, candidateLimit: request.candidate_limit, limit: request.limit, minScore: 0,
            explain: true, chunkStrategy: "regex" });
          if (strict && mode === "lexical") stats.actualCandidates = values.length;
          const explains = values.map(v => v.explain as { rrf?: { contributions?: { source: string }[] } } | undefined);
          stats.lexicalContributors = mode === 'lexical' ? values.length : explains.filter(e => e?.rrf?.contributions?.some(c => c.source === 'fts')).length;
          stats.vectorContributors = mode === 'lexical' ? 0 : explains.filter(e => e?.rrf?.contributions?.some(c => c.source === 'vec')).length;
          stats.rerankedCandidates = stats.rerankSucceeded ? Number(stats.actualCandidates ?? 0) : 0;
          return values.map(value => {
            const file = typeof value.file === "string" ? value.file : typeof value.filepath === "string" ? value.filepath : undefined;
            if (!file) throw new DsearchError("COMPATIBILITY_FAILED");
            return role === "reader" ? { file, score: value.score } : { ...value, file };
          });
        };
        let mode = request.mode, rerank = request.rerank;
        const warnings: string[] = [];
        for (;;) {
          // Reset stage evidence before a real retry; failed attempts cannot certify the new ranking.
          stats.rerankSucceeded = false;
          try {
            const hits = await search(mode, rerank);
            return { hits, requested_mode: request.mode, effective_mode: mode, rank_stage: mode === 'lexical' ? 'bm25' : stats.rerankSucceeded ? 'qmd_reranked_blend' : 'qmd_rrf', degraded: warnings.length > 0, warnings };
          } catch (error) {
            if (!request.allow_degraded || mode === 'lexical' || signal.aborted) throw error;
            const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
            if (!['RERANK_UNAVAILABLE', 'MODEL_NOT_INSTALLED', 'MODEL_UNAVAILABLE'].includes(code)) throw error;
            warnings.push(code);if (error && typeof error === 'object' && 'reason' in error && ErrorReason.safeParse(error.reason).success) warnings.push(String(error.reason));
            stats.fallbackUsed = true;
            if (mode === 'deep') mode = 'hybrid';
            else if (code === 'RERANK_UNAVAILABLE') rerank = false;
            else { mode = 'lexical';rerank = false; }
          }
        }
      }
      default: throw new DsearchError("INVALID_REQUEST");
    }
  };
  const start = performance.now();
  const result = strict ? await sdk.runDsearchRequest({ signal, cache, stats,
    onProgress: (value: unknown) => send({ version: 1, id, type: "progress", value }) }, operation) : await operation();
  return { result, stats, duration_ms: performance.now() - start, rss_bytes: process.memoryUsage().rss,
    resource_usage: process.resourceUsage() };
}

process.on("message", message => {
  let record: Record<string, unknown>;
  try { record = object(message); } catch { return; }
  if (record.version !== 1 || typeof record.id !== "string") return;
  if (record.type === "cancel") { if (active?.id === record.id) active.controller.abort(); return; }
  if (record.type !== "request") return;
  const id = record.id;
  if (active) { send({ version: 1, id, type: "response", ok: false, code: "BUSY" }); return; }
  const controller = new AbortController(); active = { id, controller };
  void Promise.resolve().then(() => execute(object(record.payload), controller.signal, id)).then(value => {
    send({ version: 1, id, type: "response", ok: !controller.signal.aborted, code: "CANCELLED", value });
  }).catch(error => {
    const parsed = ErrorCode.safeParse(error?.code);
    const code = controller.signal.aborted ? "CANCELLED" : parsed.success ? parsed.data : error?.name === "ZodError" ? "INVALID_REQUEST" : "MODEL_UNAVAILABLE";
    send({ version: 1, id, type: "response", ok: false, code, reason: ErrorReason.safeParse(error?.reason).success ? error.reason : code === "RERANK_UNAVAILABLE" ? "RERANK_EXECUTION_FAILED" : undefined, telemetry: requestStats });
  }).finally(() => { active = undefined; });
});
