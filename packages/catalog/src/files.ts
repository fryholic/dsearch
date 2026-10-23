import { constants } from "node:fs";
import { lstat, realpath, open } from "node:fs/promises";
import { join, sep, isAbsolute } from "node:path";
import type { BigIntStats } from "node:fs";
import { DsearchError } from "@dsearch/contracts";
import { normalizeSource } from "@dsearch/compiler";
import { within, parseMetadata, type ScopePolicy } from "./policy.js";

// birthtime can move backwards on macOS when mtime is restored; it is not a stable file ID.
export const fileKey = (info: BigIntStats): string => `${info.dev}:${info.ino}`;
const same = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
export async function checkRoot(root: string, policy: ScopePolicy): Promise<void> {
  try {
    const info = await lstat(root, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root || fileKey(info) !== policy.root_file_key) throw new Error("Root changed");
  } catch { throw new DsearchError("SCOPE_DENIED"); }
}
/** No symlink component, no final-link following, and full-content revision validation. */
export async function readStableSource(root: string, path: string, policy: ScopePolicy, maxBytes = 32 * 1024 * 1024, onRead?: (bytes: number) => void) {
  if (isAbsolute(path) || path.includes("\\") || path.split("/").some(x => !x || x === "." || x === "..")) throw new DsearchError("SCOPE_DENIED");
  await checkRoot(root, policy);
  const full = join(root, ...path.split("/"));
  if (!within(root, full)) throw new DsearchError("SCOPE_DENIED");
  const checkParents = async () => {
    let current = root;
    for (const part of path.split("/").slice(0, -1)) {
      current += sep + part;
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new DsearchError("SCOPE_DENIED");
    }
    if (await realpath(full) !== full) throw new DsearchError("SCOPE_DENIED");
  };
  try {
    await checkParents();
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw new DsearchError("SCOPE_DENIED");
      if (before.size > BigInt(maxBytes)) throw new DsearchError("SOURCE_TOO_LARGE");
      const bytes = Buffer.alloc(Number(before.size));let offset = 0;
      while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) break; offset += bytesRead;onRead?.(bytesRead); }
      const after = await handle.stat({ bigint: true });
      const atPath = await lstat(full, { bigint: true });
      await checkParents(); await checkRoot(root, policy);
      if (offset !== bytes.length || !same(before, after) || !same(after, atPath)) throw new DsearchError("SOURCE_PENDING");
      let normalized;
      try { normalized = normalizeSource(bytes); } catch { throw new DsearchError("UNSUPPORTED_ENCODING"); }
      const parsed = parseMetadata(normalized.text, policy.version === 2 ? policy.metadata_mode ?? "general" : "legacy-v1");
      return { ...normalized, ...parsed, bytes: bytes.length, fileKey: fileKey(after) };
    } finally { await handle.close(); }
  } catch (e) {
    if (e instanceof DsearchError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    throw new DsearchError(code === "ENOENT" ? "STALE_REVISION" : code === "ELOOP" ? "SCOPE_DENIED" : "SCOPE_INCOMPLETE");
  }
}
