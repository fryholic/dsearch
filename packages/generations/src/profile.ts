import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProfileManifest, DsearchError } from "@dsearch/contracts";
import { fileDigest, loadEngineArtifact } from "@dsearch/runtime";
import { canonicalJSON, digest } from "@dsearch/catalog";

export async function createAlphaProfile(engineRoot: string, embedRole: "embed" | "reference" = "embed"): Promise<{ manifest: ProfileManifest; fingerprint: string }> {
  await loadEngineArtifact(engineRoot, join(engineRoot, "dsearch-artifact.json"));
  const artifact = JSON.parse(await readFile(join(engineRoot, "dsearch-artifact.json"), "utf8"));
  const upstream = JSON.parse(await readFile(new URL("../../../vendor/qmd-upstream.json", import.meta.url), "utf8"));
  if (artifact.artifact_sha256 !== upstream.engineArtifactSha256 || artifact.patch_digest !== upstream.patchSha256 || artifact.upstream_commit !== upstream.commit) throw new DsearchError("COMPATIBILITY_FAILED");
  const registry = JSON.parse(await readFile(new URL("../../../vendor/models/registry.json", import.meta.url), "utf8")) as { models: { role: string; repository: string; filename: string; revision: string; sha256: string }[] };
  const pick = (role: string) => { const model = registry.models.find(m => m.role === role);if (!model) throw new DsearchError("COMPATIBILITY_FAILED");return { repository: model.repository, filename: model.filename, repository_revision: model.revision, sha256: model.sha256, quantization: "Q8_0" as const }; };
  const compilerDigest = digest(canonicalJSON({
    production: await fileDigest(fileURLToPath(new URL("../../compiler/dist/production.js", import.meta.url))),
    normalization: await fileDigest(fileURLToPath(new URL("../../compiler/dist/index.js", import.meta.url))),
    dependency_lock: await fileDigest(fileURLToPath(new URL("../../../pnpm-lock.yaml", import.meta.url))),
    policy: "projection-v1",
  }));
  const payload = {
    schema_version: 2, profile_id: "pending-profile", engine: { repository: upstream.repository, source_version: upstream.sourceVersion, upstream_commit: upstream.commit, patch_digest: artifact.patch_digest, artifact_sha256: artifact.artifact_sha256 },
    models: { embed: { ...pick(embedRole), dimension: embedRole === "embed" ? 1024 : 768 }, rerank: pick("rerank"), expansion: null },
    input_policy: { compiler_version: "projection-v1-" + compilerDigest.slice(0, 16), projection_utf16_cap: 2400, embedding_input_token_cap: 800, query_token_cap: 512, rerank_context_tokens: 4096, strict_no_truncation: true, cache_mode: "memory" },
    runtime: { node_exact: process.versions.node, node_llama_cpp: "3.20.0", platform: "darwin-arm64", heavy_concurrency: 1, embed_parallelism: 1, idle_worker_shutdown_seconds: 300 },
  };
  const identity = digest(canonicalJSON(payload));
  const manifest = ProfileManifest.parse({ ...payload, profile_id: (embedRole === "embed" ? "qwen" : "reference") + "-alpha-" + identity.slice(0, 16) });
  return { manifest, fingerprint: digest(canonicalJSON(manifest)) };
}
