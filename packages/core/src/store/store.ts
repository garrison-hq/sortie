/**
 * SQLite-backed RunStore: persistence for run specs, lifecycle state,
 * step traces, and result exports.
 *
 * All JSON columns (spec, output, usage, step data) are serialized/parsed at
 * this boundary; callers only ever see contract types. All statements are
 * prepared once at store creation.
 */
import { randomUUID } from 'node:crypto';
import type {
  ListRunsOptions,
  RunRecord,
  RunSpec,
  RunStatus,
  RunStore,
  StepRecord,
  TokenUsage,
} from '../contracts.js';
import { openDatabase, type RunRow } from './db.js';
import { exportRuns } from './export.js';

const DEFAULT_LIST_LIMIT = 50;

interface ListParams {
  batchId: string | null;
  status: string | null;
  limit: number;
  offset: number;
}

type CountParams = Pick<ListParams, 'batchId' | 'status'>;

/** Create a RunStore backed by the SQLite database at `dbPath` (or the default path). */
export function createRunStore(dbPath?: string): RunStore {
  const db = openDatabase(dbPath);

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

  const listRunsStmt = db.prepare<ListParams, RunRow>(
    `SELECT * FROM runs
     WHERE ($batchId IS NULL OR batch_id = $batchId)
       AND ($status IS NULL OR status = $status)
     ORDER BY created_at DESC, rowid DESC
     LIMIT $limit OFFSET $offset`,
  );

  const countRunsStmt = db.prepare<CountParams, { n: number }>(
    `SELECT COUNT(*) AS n FROM runs
     WHERE ($batchId IS NULL OR batch_id = $batchId)
       AND ($status IS NULL OR status = $status)`,
  );

  // OR REPLACE keeps step appends idempotent when a run is re-attempted and
  // its trace restarts from index 0.
  const insertStep = db.prepare<[string, number, string]>(
    'INSERT OR REPLACE INTO steps (run_id, idx, data) VALUES (?, ?, ?)',
  );

  const selectSteps = db.prepare<[string], { data: string }>(
    'SELECT data FROM steps WHERE run_id = ? ORDER BY idx ASC',
  );

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
        output: patch.output !== undefined ? patch.output : existing.output,
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
        next.output !== undefined ? JSON.stringify(next.output) : null,
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
        limit: opts.limit ?? DEFAULT_LIST_LIMIT,
        offset: opts.offset ?? 0,
      });
      return rows.map(rowToRecord);
    },

    countRuns(opts: Pick<ListRunsOptions, 'batchId' | 'status'> = {}): number {
      const row = countRunsStmt.get({
        batchId: opts.batchId ?? null,
        status: opts.status ?? null,
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

    close(): void {
      db.close();
    },
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
    output: row.output !== null ? (JSON.parse(row.output) as unknown) : undefined,
    failureReason: row.failure_reason ?? undefined,
    usage: row.usage !== null ? (JSON.parse(row.usage) as TokenUsage) : undefined,
    finalUrl: row.final_url ?? undefined,
  };
}
