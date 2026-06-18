/**
 * SQLite bootstrap for the sortie run store.
 *
 * Owns the physical schema: a `runs` table (one row per queued/executed run,
 * JSON columns for spec/output/usage), a `steps` table (one row per agent
 * step, cascading with its run), a `saved_queries` table (named replayable
 * run specs), and a `profiles` table (login-profile metadata — the
 * storage-state JSON itself lives on disk, never in the database).
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  batch_id       TEXT,
  kind           TEXT NOT NULL,
  spec           TEXT NOT NULL,
  status         TEXT NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  started_at     INTEGER,
  finished_at    INTEGER,
  output         TEXT,
  failure_reason TEXT,
  usage          TEXT,
  final_url      TEXT,
  assist         TEXT
);

CREATE TABLE IF NOT EXISTS steps (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  idx    INTEGER NOT NULL,
  data   TEXT NOT NULL,
  PRIMARY KEY (run_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_runs_batch_id   ON runs(batch_id);
CREATE INDEX IF NOT EXISTS idx_runs_status     ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at);

CREATE TABLE IF NOT EXISTS saved_queries (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL,
  spec        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  last_run_at INTEGER,
  run_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS profiles (
  name         TEXT PRIMARY KEY,
  domain_hint  TEXT,
  notes        TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
`;

/** Raw shape of a `runs` row as returned by better-sqlite3. */
export interface RunRow {
  id: string;
  batch_id: string | null;
  kind: string;
  spec: string;
  status: string;
  attempts: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  output: string | null;
  failure_reason: string | null;
  usage: string | null;
  final_url: string | null;
  /** JSON-serialized AssistState — present when the run paused for CAPTCHA. */
  assist: string | null;
}

/** Raw shape of a `saved_queries` row as returned by better-sqlite3. */
export interface SavedQueryRow {
  id: string;
  name: string;
  kind: string;
  spec: string;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  run_count: number;
}

/** Raw shape of a `profiles` row as returned by better-sqlite3. */
export interface ProfileRow {
  name: string;
  domain_hint: string | null;
  notes: string | null;
  created_at: number;
  last_used_at: number | null;
}

/**
 * Resolve the database path: explicit argument, else
 * `$SORTIE_DATA_DIR/sortie.db`, else `./data/sortie.db`. The store
 * derives its data directory (profiles/, screenshots/) from this path.
 */
export function resolveDbPath(dbPath?: string): string {
  return dbPath ?? join(process.env.SORTIE_DATA_DIR ?? './data', 'sortie.db');
}

/**
 * Open (creating if needed) the sortie SQLite database and apply the schema.
 *
 * Defaults to `$SORTIE_DATA_DIR/sortie.db` (or `./data/sortie.db`);
 * the containing directory is created if missing. WAL journaling and foreign
 * keys are enabled on every connection.
 */
export function openDatabase(dbPath?: string): Database.Database {
  const path = resolveDbPath(dbPath);
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // Additive migration: add `assist` column to existing databases that
  // predate WP04. SQLite silently ignores this when the column already exists.
  try {
    db.exec('ALTER TABLE runs ADD COLUMN assist TEXT');
  } catch {
    // Column already present — safe to ignore.
  }
  return db;
}
