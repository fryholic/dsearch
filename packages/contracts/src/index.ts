import { z } from "zod";

export const API_VERSION = 1 as const;
export const Identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const Mode = z.enum(["lexical", "hybrid", "deep"]);
export const RankStage = z.enum(["bm25", "qmd_rrf", "qmd_reranked_blend", "literal"]);
const sourcePoint = z.strictObject({ line: z.number().int().positive(), column_utf16: z.number().int().nonnegative() });
export const Locator = z.strictObject({
  kind: z.literal("markdown"), start: sourcePoint, end: sourcePoint,
}).refine(v => v.end.line > v.start.line || (v.end.line === v.start.line && v.end.column_utf16 >= v.start.column_utf16), "Invalid source range");

type Scalar = string | number | boolean;
export type Filter =
  | { and: Filter[] } | { or: Filter[] } | { not: Filter }
  | { field: string; operator: "eq" | "ne" | "in" | "all" | "exists"; value: Scalar | Scalar[] };
const scalar = z.union([z.string().max(1024), z.number().finite(), z.boolean()]);
const filterNode: z.ZodType<Filter> = z.lazy(() => z.union([
  z.strictObject({ and: z.array(filterNode).min(1).max(64) }),
  z.strictObject({ or: z.array(filterNode).min(1).max(64) }),
  z.strictObject({ not: filterNode }),
  z.strictObject({
    field: z.string().regex(/^(document_key|metadata\.[a-z][a-z0-9_.-]{0,63})$/),
    operator: z.enum(["eq", "ne", "in", "all", "exists"]),
    value: z.union([scalar, z.array(scalar).max(128)]),
  }).refine(v => {
    const value = v.value;
    return v.operator === "exists" ? typeof value === "boolean" : ["in", "all"].includes(v.operator)
      ? Array.isArray(value) && value.length > 0 && value.every(x => typeof x === typeof value[0]) : !Array.isArray(value);
  }, "Operator/value mismatch"),
]));
// Inspect bounded JSON before recursive parsing, so hostile nesting cannot overflow the parser stack.
export const MetadataFilter = z.unknown().transform((input, ctx): Filter => {
  let nodes = 0, leaves = 0;
  const pending: { value: unknown; depth: number }[] = [{ value: input, depth: 1 }];
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 64 || depth > 6) {
      ctx.addIssue({ code: "custom", message: "Filter exceeds depth or node budget" }); return z.NEVER;
    }
    if (value && typeof value === "object") {
      const node = value as Record<string, unknown>;
      for (const key of ["and", "or"]) if (Array.isArray(node[key]))
        for (const child of node[key]) pending.push({ value: child, depth: depth + 1 });
      if ("not" in node) pending.push({ value: node.not, depth: depth + 1 });
      if ("field" in node) leaves += Array.isArray(node.value) ? node.value.length : 1;
    }
  }
  let bytes: number;
  try { bytes = new TextEncoder().encode(JSON.stringify(input) ?? "").byteLength; }
  catch { ctx.addIssue({ code: "custom", message: "Filter must be JSON" }); return z.NEVER; }
  if (leaves > 128 || bytes > 16384) {
    ctx.addIssue({ code: "custom", message: "Filter exceeds value or byte budget" }); return z.NEVER;
  }
  const parsed = filterNode.safeParse(input);
  if (!parsed.success) { ctx.addIssue({ code: "custom", message: "Invalid filter AST" }); return z.NEVER; }
  return parsed.data;
});

const collections = z.array(Identifier).min(1).max(32)
  .refine(ids => new Set(ids).size === ids.length, "Duplicate collection");
export const SearchRequest = z.strictObject({
  query: z.string().trim().min(1).max(8192).refine(v => new TextEncoder().encode(v).byteLength <= 8192), purpose: z.literal("find"), mode: Mode,
  rerank: z.boolean(), collections, limit: z.number().int().min(1).max(50).default(10),
  candidate_limit: z.number().int().min(1).max(80).default(40),
  allow_degraded: z.boolean().default(false), expected_epoch: z.number().int().positive().nullable().optional(),
  filter: MetadataFilter.optional(),
}).refine(v => v.mode !== "lexical" || !v.rerank, "Lexical search cannot rerank");
export type SearchRequest = z.infer<typeof SearchRequest>;
// Product requests stay at 50 documents; the internal engine may return 80 passages for grouping.
export const EngineSearchRequest = SearchRequest.safeExtend({ lexical_query: z.string().min(1).max(32768).optional(), limit: z.number().int().min(1).max(80), collections: z.array(Identifier).min(1).max(64).refine(v => new Set(v).size === v.length), query: z.string().min(1).max(32768).refine(v => new TextEncoder().encode(v).byteLength <= 32768) });
export const LiteralRequest = z.strictObject({ query: z.string().min(1).max(1024), collections,
  ignore_case: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(200) });
export type LiteralRequest = z.infer<typeof LiteralRequest>;
export const DocumentRef = z.strictObject({ doc_id: z.uuid(), revision_id: Identifier });
export const ReadRequest = DocumentRef.extend({ locator: Locator,
  context_before_lines: z.number().int().min(0).max(100).default(0),
  context_after_lines: z.number().int().min(0).max(100).default(0),
  max_lines: z.number().int().min(1).max(200).default(200) });
export const RelatedRequest = z.strictObject({ source: DocumentRef.extend({ locator: Locator }), collections, mode: Mode, rerank: z.boolean(), allow_degraded: z.boolean().default(false), limit: z.number().int().min(1).max(50).default(10), candidate_limit: z.number().int().min(1).max(80).default(40), expected_epoch: z.number().int().positive().nullable().optional() }).refine(v => v.mode !== 'lexical' || !v.rerank);
export type RelatedRequest = z.infer<typeof RelatedRequest>;
export const CompareRequest = z.strictObject({ left: DocumentRef, right: DocumentRef, query: z.string().trim().min(1).max(8192).refine(v => new TextEncoder().encode(v).length <= 8192), mode: Mode, rerank: z.boolean(), allow_degraded: z.boolean().default(false), candidate_limit: z.number().int().min(1).max(80).default(40), expected_epoch: z.number().int().positive().nullable().optional() }).refine(v => v.left.doc_id !== v.right.doc_id && (v.mode !== 'lexical' || !v.rerank));
export type CompareRequest = z.infer<typeof CompareRequest>;
export const CollectionRequest = z.strictObject({
  name: z.string().trim().min(1).max(80), root: z.string().min(1).max(4096),
  preset: z.enum(["general", "learning"]).default("general"),
  include: z.array(z.string().max(512)).max(32).default(["**/*.md", "**/*.markdown"]),
  exclude: z.array(z.string().max(512)).max(64).default([]),
});
export type CollectionRequest = z.infer<typeof CollectionRequest>;
export const JobState = z.enum(["queued", "running", "succeeded", "obsolete", "retry_wait", "failed", "cancel_requested", "cancelled"]);
export const ErrorCode = z.enum(["INVALID_REQUEST", "UNSUPPORTED_VERSION", "COMPATIBILITY_FAILED", "MODEL_NOT_INSTALLED", "MODEL_UNAVAILABLE", "INPUT_TOO_LONG", "RERANK_UNAVAILABLE", "CANCELLED", "WORKER_EXITED", "BUSY", "STALE_REVISION", "INVALID_LOCATOR", "UNSUPPORTED_LOCATOR", "SCOPE_DENIED", "INTERNAL_ERROR", "NOT_FOUND", "SCOPE_INCOMPLETE", "UNSUPPORTED_ENCODING", "INVALID_METADATA", "SOURCE_PENDING", "STALE_EPOCH", "SOURCE_MAP_MISMATCH", "SOURCE_TOO_LARGE", "UNAUTHORIZED", "NO_ACTIVE_GENERATION", "RESULT_EXPIRED", "INVALID_QUERY", "SERVICE_UNAVAILABLE", "INPUT_TOO_LARGE"]);
export type ErrorCode = z.infer<typeof ErrorCode>;
export class DsearchError extends Error {
  constructor(public readonly code: ErrorCode, message: string = code, public readonly retryable = false) {
    super(message); this.name = "DsearchError";
  }
}
export const ErrorEnvelope = z.strictObject({
  schema_version: z.literal(API_VERSION), request_id: Identifier, ok: z.literal(false),
  error: z.strictObject({ code: ErrorCode, message: z.string().max(512), retryable: z.boolean() }),
});
export const successEnvelope = <T extends z.ZodType>(data: T) => z.strictObject({
  schema_version: z.literal(API_VERSION), request_id: Identifier, ok: z.literal(true), data,
});
const modelArtifact = z.strictObject({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), filename: z.string().regex(/^[\w.-]+\.gguf$/),
  repository_revision: z.string().regex(/^[a-f0-9]{40}$/), sha256: Digest,
  quantization: z.literal("Q8_0"), dimension: z.number().int().positive().optional(),
});
export const ProfileManifest = z.strictObject({
  schema_version: z.literal(2), profile_id: Identifier,
  engine: z.strictObject({ repository: z.literal("https://github.com/tobi/qmd"), source_version: z.literal("2.8.3"),
    upstream_commit: z.string().regex(/^[a-f0-9]{40}$/), patch_digest: Digest, artifact_sha256: Digest }),
  models: z.strictObject({ embed: modelArtifact.extend({ dimension: z.number().int().positive() }), rerank: modelArtifact, expansion: z.null() }),
  input_policy: z.strictObject({ compiler_version: Identifier, projection_utf16_cap: z.literal(2400), embedding_input_token_cap: z.literal(800),
    query_token_cap: z.literal(512), rerank_context_tokens: z.literal(4096), strict_no_truncation: z.literal(true), cache_mode: z.literal("memory") }),
  runtime: z.strictObject({ node_exact: z.string().regex(/^24\.\d+\.\d+$/), node_llama_cpp: z.literal("3.20.0"), platform: z.literal("darwin-arm64"),
    heavy_concurrency: z.literal(1), embed_parallelism: z.literal(1), idle_worker_shutdown_seconds: z.literal(300) }),
});
export type ProfileManifest = z.infer<typeof ProfileManifest>;
const GenerationFile = z.strictObject({ path: z.string().min(1).max(512).regex(/^[A-Za-z0-9_.\/-]+$/).refine(p => !p.startsWith("/") && p.split("/").every(x => x !== "" && x !== "." && x !== "..")), bytes: z.number().int().nonnegative(), sha256: Digest });
export const GenerationManifest = z.strictObject({
  schema_version: z.literal(1), generation_id: Identifier, profile_fp: Digest, source_seq: z.number().int().nonnegative(),
  scopes: z.record(z.uuid(), Digest), files: z.array(GenerationFile).min(1).max(250_000).refine(values => new Set(values.map(v => v.path)).size === values.length),
  documents: z.number().int().nonnegative(), passages: z.number().int().nonnegative(), created_at: z.iso.datetime(),
});
export type GenerationManifest = z.infer<typeof GenerationManifest>;
