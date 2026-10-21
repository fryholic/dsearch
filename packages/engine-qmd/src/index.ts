import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EngineProcess, loadEngineArtifact, verifyModel } from "@dsearch/runtime";
import { DsearchError, type SearchRequest } from "@dsearch/contracts";

export type ModelFile = { role: "embed" | "rerank" | "reference"; filename: string; bytes: number; sha256: string };
export type EngineResponse<T> = { result: T; stats: Record<string, number | boolean>; duration_ms: number; rss_bytes: number };
export type OpenEngine = {
  engineRoot: string; dbPath: string; collectionPath: string; modelRoot: string;
  embedRole: "embed" | "reference"; strict: boolean;
  role?: "probe" | "builder" | "reader"; generationId?: string;
  collections?: Record<string, { path: string; pattern: string }>;
  semanticCollections?: string[];
};
export class QmdWorker {
  readonly process = new EngineProcess(new URL("./worker.js", import.meta.url), { env: { QMD_EMBED_PARALLELISM: "1" } });
  private opened = false;
  async open(options: OpenEngine): Promise<unknown> {
    await loadEngineArtifact(options.engineRoot, join(options.engineRoot, "dsearch-artifact.json"));
    if (options.strict) {
      const expected = JSON.parse(await readFile(new URL("../../../vendor/qmd-upstream.json", import.meta.url), "utf8")) as { commit: string; engineArtifactSha256: string; patchSha256: string };
      const actual = JSON.parse(await readFile(join(options.engineRoot, "dsearch-artifact.json"), "utf8")) as { upstream_commit: string; artifact_sha256: string; patch_digest: string };
      if (actual.upstream_commit !== expected.commit || actual.artifact_sha256 !== expected.engineArtifactSha256 || actual.patch_digest !== expected.patchSha256) throw new DsearchError("COMPATIBILITY_FAILED");
    }
    const registry = JSON.parse(await readFile(new URL("../../../vendor/models/registry.json", import.meta.url), "utf8")) as { models: ModelFile[] };
    const embed = registry.models.find(m => m.role === options.embedRole);
    const rerank = registry.models.find(m => m.role === "rerank");
    if (!embed || !rerank) throw new DsearchError("COMPATIBILITY_FAILED");
    const modelErrors: Record<string, string | null> = {};
    for (const [key, model] of [['embed', embed], ['rerank', rerank]] as const) {
      try { await verifyModel(join(options.modelRoot, model.filename), model);modelErrors[key] = null; }
      catch (error) {
        if (options.role !== 'reader' && !(options.role === 'builder' && key === 'rerank')) throw error;
        modelErrors[key] = error instanceof DsearchError ? error.code : 'MODEL_UNAVAILABLE';
      }
    }
    const result = await this.process.invoke({ method: "open", ...options,
      modelErrors, embedModel: join(options.modelRoot, embed.filename), rerankModel: join(options.modelRoot, rerank.filename) });
    this.opened = true; return result;
  }
  invoke<T>(method: string, args: unknown = {}, options: Parameters<EngineProcess["invoke"]>[1] = {}): Promise<T> {
    return this.process.invoke<T>({ method, args }, options);
  }
  search(request: SearchRequest, options: Parameters<EngineProcess["invoke"]>[1] = {}): Promise<unknown> {
    return this.invoke("search", request, options);
  }
  async close(): Promise<void> {
    try { if (this.opened && this.process.state === "idle") await this.invoke("close", {}, { timeoutMs: 5000 }); }
    finally { this.opened = false; await this.process.close(); }
  }
}
