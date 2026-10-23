import type { Eligibility, Metadata } from "./policy.js";

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
