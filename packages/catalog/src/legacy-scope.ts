import { DsearchError, type Filter } from "@dsearch/contracts";
import type { Eligibility, Metadata, ScopePolicy } from "./policy.js";

type Decision = { eligibility: Eligibility; reason: string };

/** Compatibility rules for existing learning collections. New policies must use explicit rules. */
export function legacyLearningPath(path: string): Decision {
  if (isLegacySourceDirectory(path, "learning")) return { eligibility: "excluded_source", reason: "source_directory" };
  if (!["30_Resources/ASN.1/", "30_Resources/Crypto/", "30_Resources/V2X-Crypto/"].some(prefix => path.startsWith(prefix))) return { eligibility: "excluded_pattern", reason: "outside_learning_scope" };
  return { eligibility: "eligible", reason: "eligible" };
}
export function legacyLearningMetadata(metadata: Metadata): Decision {
  const role = metadata.role ?? metadata.type;
  if (role === "source") return { eligibility: "excluded_source", reason: "source_role" };
  if (!["lesson", "concept", "example"].includes(String(role))) return { eligibility: "excluded_role", reason: "learning_role" };
  if (metadata.status === "superseded") return { eligibility: "excluded_status", reason: "superseded" };
  return { eligibility: "eligible", reason: "eligible" };
}
export function isLegacySourceDirectory(path: string, preset: string): boolean {
  return preset === "learning" && path.split("/").includes("Sources");
}
export function legacyNavigationHeadings(preset: string): string[] {
  return preset === "learning" ? ["목차", "학습 탐색", "이전·다음"] : [];
}

/** Old parsers reserved these fields. Keep this only for unchanged existing scopes. */
export function validateLegacyMetadata(metadata: Metadata): void {
  for (const key of ["role", "type", "status", "title"]) if (metadata[key] !== undefined && typeof metadata[key] !== "string") throw new DsearchError("INVALID_METADATA");
  if (metadata.role && metadata.type && metadata.role !== metadata.type) throw new DsearchError("INVALID_METADATA");
  if (metadata.topics !== undefined && (!Array.isArray(metadata.topics) || metadata.topics.some(x => typeof x !== "string"))) throw new DsearchError("INVALID_METADATA");
}
export function upgradeLegacyScope(policy: ScopePolicy): ScopePolicy {
  if (policy.version === 2) return policy;
  const allowed = ["lesson", "concept", "example"];
  const roleFilter: Filter = { or: [
    { field: "metadata.role", operator: "in", value: allowed },
    { and: [{ not: { field: "metadata.role", operator: "exists", value: true } }, { field: "metadata.type", operator: "in", value: allowed }] },
  ] };
  return { version: 2, preset: "general", root_file_key: policy.root_file_key, include: policy.include, exclude: [...policy.exclude, ...(policy.preset === "learning" ? ["**/Sources/**"] : [])],
    path_prefixes: policy.preset === "learning" ? ["30_Resources/ASN.1/", "30_Resources/Crypto/", "30_Resources/V2X-Crypto/"] : [],
    metadata_filter: policy.preset === "learning" ? { and: [roleFilter, { not: { field: "metadata.status", operator: "eq", value: "superseded" } }] } : null,
    navigation_headings: legacyNavigationHeadings(policy.preset), metadata_mode: "legacy-v1" };
}
