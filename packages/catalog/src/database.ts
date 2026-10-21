import { DatabaseSync } from "node:sqlite";
import { mkdir, realpath, chmod, lstat } from "node:fs/promises";
import { join } from "node:path";
import { STATE_SCHEMA } from "./schema.js";
import { DsearchError } from "@dsearch/contracts";

/** Product state only. QMD owns its separate engine database. */
export class StateStore {
  private constructor(readonly root: string, readonly db: DatabaseSync) {}
  static async open(dataRoot: string): Promise<StateStore> {
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const info = await lstat(dataRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new DsearchError("SCOPE_DENIED");
    const root = await realpath(dataRoot), file = join(root, "state.sqlite");
    const existing = await lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return undefined; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new DsearchError("SCOPE_DENIED");
    const db = new DatabaseSync(file, { timeout: 5000 });
    try {
      db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
      if (version === 0) {
        const count = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()!.n;
        if (count !== 0) throw new DsearchError("COMPATIBILITY_FAILED");
        db.exec("BEGIN IMMEDIATE");
        try { db.exec(STATE_SCHEMA); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
      } else if (version === 2) {
        db.exec("BEGIN IMMEDIATE");
        try { db.exec("CREATE TABLE collection_scans (collection_id TEXT PRIMARY KEY REFERENCES collections(collection_id),scope_fp TEXT NOT NULL,incomplete INTEGER NOT NULL CHECK(incomplete IN (0,1)),boundaries_json TEXT NOT NULL,checked_at TEXT NOT NULL); PRAGMA user_version=3;"); db.exec("COMMIT"); }
        catch (e) { db.exec("ROLLBACK"); throw e; }
      } else if (version !== 3) throw new DsearchError("COMPATIBILITY_FAILED");
      db.prepare("SELECT eligibility_reason FROM source_documents LIMIT 0").all();
      const meta = db.prepare("SELECT source_seq FROM catalog_meta WHERE slot=1").get();
      if (!meta || !Number.isSafeInteger(meta.source_seq) || Number(meta.source_seq) < 0) throw new DsearchError("COMPATIBILITY_FAILED");
      if (db.prepare("PRAGMA quick_check").get()!.quick_check !== "ok") throw new DsearchError("COMPATIBILITY_FAILED");
      await chmod(file, 0o600);
      return new StateStore(root, db);
    } catch (e) { db.close(); throw e; }
  }
  get sourceSeq(): number { return Number(this.db.prepare("SELECT source_seq FROM catalog_meta WHERE slot=1").get()!.source_seq); }
  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = operation(); this.db.exec("COMMIT"); return value; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  advance(): number { this.db.prepare("UPDATE catalog_meta SET source_seq=source_seq+1 WHERE slot=1").run(); return this.sourceSeq; }
  close(): void { this.db.close(); }
}
