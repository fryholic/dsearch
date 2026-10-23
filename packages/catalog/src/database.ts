import { DatabaseSync, backup } from "node:sqlite";
import { mkdir, realpath, chmod, lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { STATE_SCHEMA, POLICY_MIGRATION_SCHEMA } from "./schema.js";
import { DsearchError, CollectionRequest } from "@dsearch/contracts";
import { randomUUID } from "node:crypto";
import { upgradeLegacyScope } from "./legacy-scope.js";
import { canonicalJSON, digest, type ScopePolicy } from "./policy.js";

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
      } else if ([2, 3, 4].includes(version)) {
        // SQLite backup includes committed WAL data; create the destination privately before writing it.
        const folder = join(root, 'backups');await mkdir(folder, { recursive: true, mode: 0o700 });
        const folderInfo = await lstat(folder);
        if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink() || await realpath(folder) !== folder || (folderInfo.mode & 0o077)) throw new DsearchError('SCOPE_DENIED');
        const backupFile = 'state-before-policy-v2-' + randomUUID() + '.sqlite', backupPath = join(folder, backupFile);
        const handle = await open(backupPath, 'wx', 0o600);await handle.close();
        await backup(db, backupPath);const durable = await open(backupPath, 'r');try { await durable.sync(); } finally { await durable.close(); }
        const directory = await open(folder, 'r');try { await directory.sync(); } finally { await directory.close(); }
        db.exec("BEGIN IMMEDIATE");
        try {
          if (version === 2) db.exec("CREATE TABLE collection_scans (collection_id TEXT PRIMARY KEY REFERENCES collections(collection_id),scope_fp TEXT NOT NULL,incomplete INTEGER NOT NULL CHECK(incomplete IN (0,1)),boundaries_json TEXT NOT NULL,checked_at TEXT);");
          db.exec("CREATE TABLE IF NOT EXISTS collection_registrations (collection_id TEXT PRIMARY KEY REFERENCES collections(collection_id),removed INTEGER NOT NULL CHECK(removed IN (0,1)),previous_name TEXT NOT NULL,detached_at TEXT);");
          db.exec(POLICY_MIGRATION_SCHEMA);
          let changed = false;
          for (const row of db.prepare('SELECT collection_id,name,root_path,scope_json,scope_fp FROM collections').all()) {
            if (digest(String(row.scope_json)) !== row.scope_fp) throw new DsearchError('COMPATIBILITY_FAILED');
            const prior = JSON.parse(String(row.scope_json)) as ScopePolicy;
            if (prior.version === 2) continue;
            if (!['general','learning'].includes(prior.preset)) throw new DsearchError('COMPATIBILITY_FAILED');
            const policy = upgradeLegacyScope(prior);
            const checked = CollectionRequest.safeParse({ name: row.name, root: row.root_path, preset: 'general', include: policy.include, exclude: policy.exclude, path_prefixes: policy.path_prefixes, metadata_filter: policy.metadata_filter, navigation_headings: policy.navigation_headings });
            if (!checked.success || typeof policy.root_file_key !== 'string') throw new DsearchError('COMPATIBILITY_FAILED');
            const scope = canonicalJSON(policy);
            db.prepare('INSERT INTO scope_migrations VALUES (?,?,?,?,?,0,0,0)').run(String(row.collection_id), String(row.scope_json), String(row.scope_fp), 'backups/' + backupFile, 'unverified');
            db.prepare('UPDATE collections SET scope_json=?,scope_fp=? WHERE collection_id=?').run(scope, digest(scope), String(row.collection_id));changed = true;
          }
          if (changed) db.exec('UPDATE catalog_meta SET source_seq=source_seq+1 WHERE slot=1');
          db.exec('PRAGMA user_version=5; COMMIT');
        } catch (e) { db.exec("ROLLBACK");throw e; }
      } else if (version !== 5) throw new DsearchError("COMPATIBILITY_FAILED");
      db.prepare("SELECT eligibility_reason FROM source_documents LIMIT 0").all();
      db.prepare("SELECT previous_scope_json,previous_scope_fp,backup_file,status,checked_entries,reindexed,reviewed FROM scope_migrations LIMIT 0").all();
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
