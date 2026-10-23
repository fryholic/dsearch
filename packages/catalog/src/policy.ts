import { createHash } from "node:crypto";
import { matchesGlob, relative, isAbsolute, sep } from "node:path";
import { parseDocument } from "yaml";
import { legacyLearningPath, legacyLearningMetadata } from "./legacy-scope.js";
import { DsearchError, type CollectionRequest } from "@dsearch/contracts";

export function canonicalJSON(value: unknown): string {
  const visit = (v: unknown): unknown => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map(k => [k, visit((v as Record<string, unknown>)[k])]));
    throw new DsearchError("INVALID_METADATA");
  };
  return JSON.stringify(visit(value));
}
export const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const within = (root: string, path: string): boolean => { const r = relative(root, path); return r === "" || (!r.startsWith(".." + sep) && r !== ".." && !isAbsolute(r)); };
export type Eligibility = "eligible" | "excluded_pattern" | "excluded_role" | "excluded_status" | "excluded_source" | "invalid_metadata" | "unreadable" | "unsupported_encoding" | "pending" | "deleted";
export type ScopePolicy = Pick<CollectionRequest, "include" | "exclude" | "preset"> & { root_file_key: string };
export type Metadata = Record<string, unknown>;
export function parseMetadata(text: string): { metadata: Metadata; bodyStart: number } {
  if (!text.startsWith("---\n")) return { metadata: {}, bodyStart: 0 };
  const close = /^(?:---|\.\.\.)[ \t]*(?:\n|$)/m.exec(text.slice(4));
  if (!close || close.index > 65_536) throw new DsearchError("INVALID_METADATA");
  const source = text.slice(4, 4 + close.index);
  if (new TextEncoder().encode(source).byteLength > 65_536) throw new DsearchError("INVALID_METADATA");
  try {
    const doc = parseDocument(source, { uniqueKeys: true, stringKeys: true, strict: true });
    if (doc.errors.length || doc.warnings.length) throw new Error("Invalid YAML");
    const map: unknown = doc.toJS({ mapAsMap: true, maxAliasCount: 20 });
    let nodes = 0;
    const convert = (v: unknown, depth = 0): unknown => {
      if (++nodes > 2048 || depth > 6) throw new Error("Metadata budget");
      if (v instanceof Map) return Object.fromEntries([...v].map(([k, val]) => {
        if (typeof k !== "string" || k.length > 128) throw new Error("Invalid metadata key");
        return [k, convert(val, depth + 1)];
      }));
      if (Array.isArray(v)) return v.map(x => convert(x, depth + 1));
      if (v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return v;
      throw new Error("Invalid metadata value");
    };
    const result = map == null ? {} : convert(map);
    if (!result || Array.isArray(result) || typeof result !== "object") throw new Error("Metadata must be a mapping");
    const metadata = result as Metadata;
    for (const key of ["role", "type", "status", "title"]) if (metadata[key] !== undefined && typeof metadata[key] !== "string") throw new Error("Metadata type");
    if (metadata.role && metadata.type && metadata.role !== metadata.type) throw new Error("Conflicting role");
    if (metadata.topics !== undefined && (!Array.isArray(metadata.topics) || metadata.topics.some(x => typeof x !== "string"))) throw new Error("Metadata topics");
    canonicalJSON(metadata);
    return { metadata, bodyStart: 4 + close.index + close[0].length };
  } catch { throw new DsearchError("INVALID_METADATA"); }
}
export function pathEligibility(path: string, policy: ScopePolicy): { eligibility: Eligibility; reason: string } {
  const parts = path.split("/");
  if (parts.some(x => x.startsWith("."))) return { eligibility: "excluded_pattern", reason: "hidden_path" };
  if (parts.includes("node_modules")) return { eligibility: "excluded_pattern", reason: "dependency_directory" };
  if (policy.exclude.some(glob => matchesGlob(path, glob))) return { eligibility: "excluded_pattern", reason: "exclude_pattern" };
  if (!policy.include.some(glob => matchesGlob(path, glob))) return { eligibility: "excluded_pattern", reason: "include_pattern" };
  if (policy.preset === "learning") return legacyLearningPath(path);
  return { eligibility: "eligible", reason: "eligible" };
}
export function metadataEligibility(metadata: Metadata, policy: ScopePolicy): { eligibility: Eligibility; reason: string } {
  if (policy.preset !== "learning") return { eligibility: "eligible", reason: "eligible" };
  return legacyLearningMetadata(metadata);
}
