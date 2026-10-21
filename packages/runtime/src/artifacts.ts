import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { DsearchError } from "@dsearch/contracts";

export async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function verifyModel(path: string, expected: { sha256: string; bytes: number }): Promise<void> {
  const info = await lstat(path).catch(() => { throw new DsearchError("MODEL_NOT_INSTALLED"); });
  if (!info.isFile() || info.size !== expected.bytes || await fileDigest(path) !== expected.sha256)
    throw new DsearchError("MODEL_UNAVAILABLE", "Model integrity check failed");
}

/** Hash executable SDK files and the exact dependency lock. Paths and order are deterministic. */
export async function engineArtifact(root: string): Promise<{ sha256: string; files: { path: string; sha256: string }[] }> {
  const names: string[] = ["package.json", "pnpm-lock.yaml"];
  const visit = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".js")) names.push(relative(root, path));
    }
  };
  await visit(join(root, "dist"));
  const files = await Promise.all(names.sort().map(async path => ({ path, sha256: await fileDigest(join(root, path)) })));
  const sha256 = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return { sha256, files };
}
export async function loadEngineArtifact(root: string, manifestFile: string): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { artifact_sha256?: string };
  if ((await engineArtifact(root)).sha256 !== manifest.artifact_sha256) throw new DsearchError("COMPATIBILITY_FAILED", "Engine artifact changed");
}
