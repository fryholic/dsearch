import { randomUUID } from "node:crypto";
import { open, rename, lstat, realpath, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { DsearchError, GenerationManifest } from "@dsearch/contracts";
import { canonicalJSON, within } from "@dsearch/catalog";
import { fileDigest } from "@dsearch/runtime";

export async function atomicFile(path: string, bytes: string | Uint8Array): Promise<void> {
  const temp = path + "." + randomUUID() + ".tmp";
  const file = await open(temp, "wx", 0o600);
  try { await file.writeFile(bytes);await file.sync(); }
  catch (e) { await file.close();await rm(temp, { force: true });throw e; }
  await file.close();
  try {
    await rename(temp, path);const dir = await open(dirname(path), "r");try { await dir.sync(); } finally { await dir.close(); }
  } catch (e) { await rm(temp, { force: true });throw e; }
}
async function checkedFile(folder: string, relative: string): Promise<{ path: string; bytes: number; sha256: string }> {
  const path = join(folder, relative);
  if (!within(folder, path) || await realpath(path) !== path) throw new DsearchError("SCOPE_DENIED");
  const info = await lstat(path);if (!info.isFile() || info.isSymbolicLink()) throw new DsearchError("SCOPE_DENIED");
  return { path: relative, bytes: info.size, sha256: await fileDigest(path) };
}
export async function sealFiles(folder: string, header: Omit<GenerationManifest, "files">, names: string[]): Promise<{ manifest: GenerationManifest; sha256: string }> {
  const root = await realpath(folder), files = [];
  for (const name of [...names].sort()) files.push(await checkedFile(root, name));
  const manifest = GenerationManifest.parse({ ...header, files });
  if (files.some(f => f.path === "manifest.json")) throw new DsearchError("INVALID_REQUEST");
  await atomicFile(join(root, "manifest.json"), canonicalJSON(manifest) + "\n");
  const sha256 = await fileDigest(join(root, "manifest.json"));await verifySeal(root, sha256);return { manifest, sha256 };
}
export async function verifySeal(folder: string, expectedSha256: string): Promise<GenerationManifest> {
  try {
    const root = await realpath(folder), file = join(root, "manifest.json"), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || await fileDigest(file) !== expectedSha256 || info.size > 32 * 1024 * 1024) throw new Error("Manifest integrity");
    const manifest = GenerationManifest.parse(JSON.parse(await readFile(file, "utf8")));
    for (const entry of manifest.files) { const actual = await checkedFile(root, entry.path);if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw new Error("File integrity"); }
    return manifest;
  } catch (e) { if (e instanceof DsearchError && e.code === "SCOPE_DENIED") throw e;throw new DsearchError("COMPATIBILITY_FAILED"); }
}
