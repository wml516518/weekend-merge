import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as SQLiteDatabase } from 'node:sqlite';

// Vite 5's built-in module list predates node:sqlite. Resolve through Node.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export function transaction<T>(db: SQLiteDatabase, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function openDatabase(path: string): SQLiteDatabase {
  const existed = path !== ':memory:' && existsSync(path);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version > 1) throw new Error('UNSUPPORTED_DATABASE_VERSION');
    if (version === 0) {
      // VACUUM INTO includes committed WAL pages; copying only the main file does not.
      if (existed) db.prepare('VACUUM INTO ?').run(`${path}.before-v1-${Date.now()}-${Math.random().toString(16).slice(2)}.bak`);
      transaction(db, () => db.exec(`
        CREATE TABLE IF NOT EXISTS groups (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, target_count INTEGER NOT NULL CHECK(target_count BETWEEN 2 AND 6),
          setup TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, state_version INTEGER NOT NULL DEFAULT 0,
          state TEXT NOT NULL DEFAULT 'collecting', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
          invite_hash TEXT UNIQUE, invite_expires_at INTEGER NOT NULL, selected_plan_id TEXT, final_plan_id TEXT,
          locked_stop_ids TEXT NOT NULL DEFAULT '[]', replan_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS members (
          group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE, id TEXT NOT NULL, nickname TEXT NOT NULL,
          owner INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(group_id,id)
        );
        CREATE TABLE IF NOT EXISTS preferences (
          group_id TEXT NOT NULL, member_id TEXT NOT NULL, revision INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0,
          payload TEXT, submitted INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(group_id,member_id,revision), FOREIGN KEY(group_id,member_id) REFERENCES members(group_id,id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS access_grants (
          id TEXT PRIMARY KEY, session_hash TEXT NOT NULL, group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
          member_id TEXT, role TEXT NOT NULL CHECK(role IN ('owner','member')), expires_at INTEGER NOT NULL,
          CHECK((role='owner' AND member_id IS NULL) OR (role='member' AND member_id IS NOT NULL)),
          FOREIGN KEY(group_id,member_id) REFERENCES members(group_id,id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS grant_identity ON access_grants(session_hash,group_id,COALESCE(member_id,''),role);
        CREATE TABLE IF NOT EXISTS recovery_capabilities (
          token_hash TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
          member_id TEXT, role TEXT NOT NULL CHECK(role IN ('owner','member')), expires_at INTEGER NOT NULL,
          CHECK((role='owner' AND member_id IS NULL) OR (role='member' AND member_id IS NOT NULL)),
          FOREIGN KEY(group_id,member_id) REFERENCES members(group_id,id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS planning_snapshots (
          group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
          payload TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(group_id,revision)
        );
        CREATE TRIGGER IF NOT EXISTS snapshots_immutable BEFORE UPDATE ON planning_snapshots
          BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SNAPSHOT'); END;
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, group_id TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL,
          attempt INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'queued', lease TEXT, request TEXT NOT NULL,
          created_at INTEGER NOT NULL, started_at INTEGER, error TEXT, result TEXT,
          UNIQUE(group_id,revision,kind,attempt), UNIQUE(group_id,id),
          FOREIGN KEY(group_id,revision) REFERENCES planning_snapshots(group_id,revision) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS events (
          group_id TEXT NOT NULL, job_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY(job_id,sequence), FOREIGN KEY(group_id,job_id) REFERENCES jobs(group_id,id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS idempotency (
          group_id TEXT NOT NULL, member_id TEXT NOT NULL, revision INTEGER NOT NULL, key TEXT NOT NULL, response TEXT NOT NULL,
          PRIMARY KEY(group_id,member_id,revision,key), FOREIGN KEY(group_id,member_id) REFERENCES members(group_id,id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(state,created_at);
        CREATE INDEX IF NOT EXISTS grants_session ON access_grants(session_hash,group_id);
        CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
        INSERT INTO schema_migrations(version,applied_at) VALUES(1,CAST(strftime('%s','now') AS INTEGER)*1000);
        PRAGMA user_version=1;
      `));
    }
    return db;
  } catch (error) { db.close(); throw error; }
}
