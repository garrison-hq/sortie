/**
 * SQLite bootstrap for the nanofish run store.
 *
 * Owns the physical schema: a `runs` table (one row per queued/executed run,
 * JSON columns for spec/output/usage) and a `steps` table (one row per agent
 * step, cascading with its run).
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
  final_url      TEXT
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
}

/**
 * Open (creating if needed) the nanofish SQLite database and apply the schema.
 *
 * Defaults to `$NANOFISH_DATA_DIR/nanofish.db` (or `./data/nanofish.db`);
 * the containing directory is created if missing. WAL journaling and foreign
 * keys are enabled on every connection.
 */
export function openDatabase(dbPath?: string): Database.Database {
  const path = dbPath ?? join(process.env.NANOFISH_DATA_DIR ?? './data', 'nanofish.db');
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
