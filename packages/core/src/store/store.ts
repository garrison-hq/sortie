/**
 * SQLite-backed RunStore: persistence for run specs, lifecycle state,
 * step traces, result exports, saved queries, and login-profile metadata.
 *
 * All JSON columns (spec, output, usage, step data) are serialized/parsed at
 * this boundary; callers only ever see contract types. All statements are
 * prepared once at store creation.
 *
 * Profile storage-state JSON never enters the database: only metadata is
 * persisted, and the state file path is derived from the slug-validated name
 * under `<dataDir>/profiles/`.
 */
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  ListRunsOptions,
  ProfileRecord,
  RunRecord,
  RunSpec,
  RunStatus,
  RunStore,
  SavedQuery,
  StepRecord,
  TokenUsage,
} from '../contracts.js';
import { isSlug, SLUG_PATTERN } from '../naming.js';
import {
  openDatabase,
  resolveDbPath,
  type ProfileRow,
  type RunRow,
  type SavedQueryRow,
} from './db.js';
import { exportRuns } from './export.js';

const DEFAULT_LIST_LIMIT = 50;

interface ListParams {
  batchId: string | null;
  status: string | null;
  queryName: string | null;
  limit: number;
  offset: number;
}

type CountParams = Pick<ListParams, 'batchId' | 'status' | 'queryName'>;

/** Create a RunStore backed by the SQLite database at `dbPath` (or the default path). */
export function createRunStore(dbPath?: string): RunStore {
  const resolvedDbPath = resolveDbPath(dbPath);
  const db = openDatabase(resolvedDbPath);
  // Profile state files live next to the database: <dataDir>/profiles/<name>.json
  const profilesDir = join(dirname(resolvedDbPath), 'profiles');

  const insertRun = db.prepare<[string, string | null, string, string, string, number, number]>(
    `INSERT INTO runs (id, batch_id, kind, spec, status, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const selectRun = db.prepare<[string], RunRow>('SELECT * FROM runs WHERE id = ?');

  const updateRunStmt = db.prepare<
    [
      string | null,
      string,
      number,
      number | null,
      number | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string,
    ]
  >(
    `UPDATE runs
     SET batch_id = ?, status = ?, attempts = ?, started_at = ?, finished_at = ?,
         output = ?, failure_reason = ?, usage = ?, final_url = ?
     WHERE id = ?`,
  );

  // queryName lives inside the spec JSON column (no DDL change for link-back).
  const listRunsStmt = db.prepare<ListParams, RunRow>(
    `SELECT * FROM runs
     WHERE ($batchId IS NULL OR batch_id = $batchId)
       AND ($status IS NULL OR status = $status)
       AND ($queryName IS NULL OR json_extract(spec, '$.queryName') = $queryName)
     ORDER BY created_at DESC, rowid DESC
     LIMIT $limit OFFSET $offset`,
  );

  const countRunsStmt = db.prepare<CountParams, { n: number }>(
    `SELECT COUNT(*) AS n FROM runs
     WHERE ($batchId IS NULL OR batch_id = $batchId)
       AND ($status IS NULL OR status = $status)
       AND ($queryName IS NULL OR json_extract(spec, '$.queryName') = $queryName)`,
  );

  // OR REPLACE keeps step appends idempotent when a run is re-attempted and
  // its trace restarts from index 0.
  const insertStep = db.prepare<[string, number, string]>(
    'INSERT OR REPLACE INTO steps (run_id, idx, data) VALUES (?, ?, ?)',
  );

  const selectSteps = db.prepare<[string], { data: string }>(
    'SELECT data FROM steps WHERE run_id = ? ORDER BY idx ASC',
  );

  const insertQuery = db.prepare<[string, string, string, string, number, number]>(
    `INSERT INTO saved_queries (id, name, kind, spec, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const updateQueryStmt = db.prepare<[string, string, number, string]>(
    'UPDATE saved_queries SET kind = ?, spec = ?, updated_at = ? WHERE name = ?',
  );

  const selectQuery = db.prepare<[string], SavedQueryRow>(
    'SELECT * FROM saved_queries WHERE name = ?',
  );

  const selectQueries = db.prepare<[], SavedQueryRow>(
    'SELECT * FROM saved_queries ORDER BY name ASC',
  );

  const deleteQueryStmt = db.prepare<[string]>('DELETE FROM saved_queries WHERE name = ?');

  const recordQueryRunStmt = db.prepare<[number, string]>(
    'UPDATE saved_queries SET last_run_at = ?, run_count = run_count + 1 WHERE name = ?',
  );

  // Upsert keeps created_at from the original row; metadata fields replace.
  const upsertProfileStmt = db.prepare<[string, string | null, string | null, number]>(
    `INSERT INTO profiles (name, domain_hint, notes, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET domain_hint = excluded.domain_hint, notes = excluded.notes`,
  );

  const selectProfile = db.prepare<[string], ProfileRow>('SELECT * FROM profiles WHERE name = ?');

  const selectProfiles = db.prepare<[], ProfileRow>('SELECT * FROM profiles ORDER BY name ASC');

  const deleteProfileStmt = db.prepare<[string]>('DELETE FROM profiles WHERE name = ?');

  const touchProfileStmt = db.prepare<[number, string]>(
    'UPDATE profiles SET last_used_at = ? WHERE name = ?',
  );

  /** Derive the state-file path from a slug-validated name (traversal gate). */
  function statePathFor(name: string): string {
    requireSlug('profile', name);
    return join(profilesDir, `${name}.json`);
  }

  return {
    createRun(spec: RunSpec, batchId?: string): RunRecord {
      const record: RunRecord = {
        id: randomUUID(),
        spec,
        status: 'queued',
        batchId,
        attempts: 0,
        createdAt: Date.now(),
      };
      insertRun.run(
        record.id,
        batchId ?? null,
        spec.kind,
        JSON.stringify(spec),
        record.status,
        record.attempts,
        record.createdAt,
      );
      return record;
    },

    updateRun(id: string, patch: Partial<Omit<RunRecord, 'id' | 'spec' | 'createdAt'>>): RunRecord {
      const row = selectRun.get(id);
      if (!row) {
        throw new Error(`RunStore.updateRun: no run with id "${id}".`);
      }
      const existing = rowToRecord(row);
      const next: RunRecord = {
        ...existing,
        batchId: patch.batchId ?? existing.batchId,
        status: patch.status ?? existing.status,
        attempts: patch.attempts ?? existing.attempts,
        startedAt: patch.startedAt ?? existing.startedAt,
        finishedAt: patch.finishedAt ?? existing.finishedAt,
        // `output` may legitimately be null/false/0 — only `undefined` means "unchanged".
        output: patch.output === undefined ? existing.output : patch.output,
        failureReason: patch.failureReason ?? existing.failureReason,
        usage: patch.usage ?? existing.usage,
        finalUrl: patch.finalUrl ?? existing.finalUrl,
      };
      updateRunStmt.run(
        next.batchId ?? null,
        next.status,
        next.attempts,
        next.startedAt ?? null,
        next.finishedAt ?? null,
        next.output === undefined ? null : JSON.stringify(next.output),
        next.failureReason ?? null,
        next.usage ? JSON.stringify(next.usage) : null,
        next.finalUrl ?? null,
        id,
      );
      return next;
    },

    getRun(id: string): RunRecord | undefined {
      const row = selectRun.get(id);
      return row ? rowToRecord(row) : undefined;
    },

    listRuns(opts: ListRunsOptions = {}): RunRecord[] {
      const rows = listRunsStmt.all({
        batchId: opts.batchId ?? null,
        status: opts.status ?? null,
        queryName: opts.queryName ?? null,
        limit: opts.limit ?? DEFAULT_LIST_LIMIT,
        offset: opts.offset ?? 0,
      });
      return rows.map(rowToRecord);
    },

    countRuns(opts: Pick<ListRunsOptions, 'batchId' | 'status' | 'queryName'> = {}): number {
      const row = countRunsStmt.get({
        batchId: opts.batchId ?? null,
        status: opts.status ?? null,
        queryName: opts.queryName ?? null,
      });
      return row?.n ?? 0;
    },

    appendStep(runId: string, step: StepRecord): void {
      insertStep.run(runId, step.index, JSON.stringify(step));
    },

    getSteps(runId: string): StepRecord[] {
      return selectSteps.all(runId).map((row) => JSON.parse(row.data) as StepRecord);
    },

    exportRuns(opts: { batchId?: string; runIds?: string[]; format: 'json' | 'csv' }): string {
      return exportRuns(db, opts);
    },

    createQuery(name: string, spec: RunSpec): SavedQuery {
      requireSlug('query', name);
      if (spec.kind !== 'extract') {
        throw new Error(
          `RunStore.createQuery: only extract specs can be saved as queries (got kind "${spec.kind}").`,
        );
      }
      if (selectQuery.get(name)) {
        throw new Error(`RunStore.createQuery: a query named "${name}" already exists.`);
      }
      const now = Date.now();
      const query: SavedQuery = {
        id: randomUUID(),
        name,
        spec,
        createdAt: now,
        updatedAt: now,
        runCount: 0,
      };
      insertQuery.run(query.id, name, spec.kind, JSON.stringify(spec), now, now);
      return query;
    },

    updateQuery(name: string, spec: RunSpec): SavedQuery {
      if (spec.kind !== 'extract') {
        throw new Error(
          `RunStore.updateQuery: only extract specs can be saved as queries (got kind "${spec.kind}").`,
        );
      }
      const row = selectQuery.get(name);
      if (!row) {
        throw new Error(`RunStore.updateQuery: no query named "${name}".`);
      }
      const now = Date.now();
      updateQueryStmt.run(spec.kind, JSON.stringify(spec), now, name);
      return { ...queryRowToRecord(row), spec, updatedAt: now };
    },

    getQuery(name: string): SavedQuery | undefined {
      const row = selectQuery.get(name);
      return row ? queryRowToRecord(row) : undefined;
    },

    listQueries(): SavedQuery[] {
      return selectQueries.all().map(queryRowToRecord);
    },

    deleteQuery(name: string): boolean {
      return deleteQueryStmt.run(name).changes > 0;
    },

    recordQueryRun(name: string): void {
      recordQueryRunStmt.run(Date.now(), name);
    },

    upsertProfile(profile: Pick<ProfileRecord, 'name' | 'domainHint' | 'notes'>): ProfileRecord {
      requireSlug('profile', profile.name);
      upsertProfileStmt.run(
        profile.name,
        profile.domainHint ?? null,
        profile.notes ?? null,
        Date.now(),
      );
      // Re-read so created_at/last_used_at reflect a pre-existing row.
      const row = selectProfile.get(profile.name);
      if (!row) throw new Error(`RunStore.upsertProfile: failed to persist "${profile.name}".`);
      return profileRowToRecord(row);
    },

    getProfile(name: string): ProfileRecord | undefined {
      const row = selectProfile.get(name);
      return row ? profileRowToRecord(row) : undefined;
    },

    listProfiles(): ProfileRecord[] {
      return selectProfiles.all().map(profileRowToRecord);
    },

    deleteProfile(name: string): boolean {
      // Remove the on-disk storage state too — deleting a profile must not
      // leave session cookies behind. statePathFor re-gates the slug.
      rmSync(statePathFor(name), { force: true });
      return deleteProfileStmt.run(name).changes > 0;
    },

    touchProfile(name: string): void {
      touchProfileStmt.run(Date.now(), name);
    },

    profileStatePath(name: string): string {
      return statePathFor(name);
    },

    close(): void {
      db.close();
    },
  };
}

/** Reject non-slug names with a clear, caller-attributable error message. */
function requireSlug(kind: 'query' | 'profile', name: string): void {
  if (!isSlug(name)) {
    throw new Error(
      `RunStore: invalid ${kind} name "${name}" — must match ${SLUG_PATTERN.source} ` +
        '(lowercase letters, digits, "_" and "-"; max 64 chars).',
    );
  }
}

function queryRowToRecord(row: SavedQueryRow): SavedQuery {
  return {
    id: row.id,
    name: row.name,
    spec: JSON.parse(row.spec) as RunSpec,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at ?? undefined,
    runCount: row.run_count,
  };
}

function profileRowToRecord(row: ProfileRow): ProfileRecord {
  return {
    name: row.name,
    domainHint: row.domain_hint ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
  };
}

function rowToRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    spec: JSON.parse(row.spec) as RunSpec,
    status: row.status as RunStatus,
    batchId: row.batch_id ?? undefined,
    attempts: row.attempts,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    output: row.output === null ? undefined : (JSON.parse(row.output) as unknown),
    failureReason: row.failure_reason ?? undefined,
    usage: row.usage === null ? undefined : (JSON.parse(row.usage) as TokenUsage),
    finalUrl: row.final_url ?? undefined,
  };
}
