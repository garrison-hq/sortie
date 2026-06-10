/**
 * Run export: serialize finished runs (success / failed / max_steps) to
 * JSON or RFC 4180 CSV. Standalone so it can be used by RunStore.exportRuns
 * and by callers holding a raw database handle.
 */
import type Database from 'better-sqlite3';
import type { RunSpec, TokenUsage } from '../contracts.js';
import type { RunRow } from './db.js';

const FINISHED_STATUSES = ['success', 'failed', 'max_steps'] as const;

export interface ExportRunsOptions {
  batchId?: string;
  runIds?: string[];
  format: 'json' | 'csv';
}

interface ExportRun {
  id: string;
  url: string;
  kind: string;
  status: string;
  output: unknown;
  failureReason?: string;
  usage?: TokenUsage;
  finishedAt?: number;
}

/**
 * Serialize finished runs, optionally filtered by batch and/or explicit run
 * ids. JSON: a pretty-printed array of result summaries. CSV: when every
 * successful output is an object with exactly one array-of-objects field,
 * one row per array item (prefixed with run id + url); otherwise one row per
 * run with the output JSON-stringified into an `output` column.
 */
export function exportRuns(db: Database.Database, opts: ExportRunsOptions): string {
  const rows = db
    .prepare<{ batchId: string | null }, RunRow>(
      `SELECT * FROM runs
       WHERE status IN ('${FINISHED_STATUSES.join("','")}')
         AND ($batchId IS NULL OR batch_id = $batchId)
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all({ batchId: opts.batchId ?? null });

  const wanted = opts.runIds ? new Set(opts.runIds) : undefined;
  const runs = rows
    .filter((row) => !wanted || wanted.has(row.id))
    .map((row): ExportRun => {
      const spec = JSON.parse(row.spec) as RunSpec;
      return {
        id: row.id,
        url: spec.url,
        kind: row.kind,
        status: row.status,
        output: row.output !== null ? (JSON.parse(row.output) as unknown) : undefined,
        failureReason: row.failure_reason ?? undefined,
        usage: row.usage !== null ? (JSON.parse(row.usage) as TokenUsage) : undefined,
        finishedAt: row.finished_at ?? undefined,
      };
    });

  return opts.format === 'json' ? JSON.stringify(runs, null, 2) : toCsv(runs);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function toCsv(runs: ExportRun[]): string {
  const successes = runs.filter((run) => run.status === 'success');
  const flattenable =
    successes.length > 0 && successes.every((run) => singleArrayField(run.output) !== undefined);

  return flattenable ? flattenedCsv(successes) : perRunCsv(runs);
}

/** One row per item of each successful run's single array field. */
function flattenedCsv(successes: ExportRun[]): string {
  // Union of item keys across all runs, in first-seen order.
  const itemColumns: string[] = [];
  const seen = new Set<string>();
  const itemsByRun = successes.map((run) => {
    // Safe: flattenable mode is only entered when every success matches.
    const items = singleArrayField(run.output) ?? [];
    for (const item of items) {
      for (const key of Object.keys(item)) {
        if (!seen.has(key)) {
          seen.add(key);
          itemColumns.push(key);
        }
      }
    }
    return { run, items };
  });

  const lines = [encodeRow(['id', 'url', ...itemColumns])];
  for (const { run, items } of itemsByRun) {
    for (const item of items) {
      lines.push(encodeRow([run.id, run.url, ...itemColumns.map((col) => cell(item[col]))]));
    }
  }
  return lines.join('\r\n');
}

/** One row per run; the output is JSON-stringified into an `output` column. */
function perRunCsv(runs: ExportRun[]): string {
  const lines = [encodeRow(['id', 'url', 'kind', 'status', 'output', 'failureReason'])];
  for (const run of runs) {
    lines.push(
      encodeRow([
        run.id,
        run.url,
        run.kind,
        run.status,
        run.output !== undefined ? JSON.stringify(run.output) : '',
        run.failureReason ?? '',
      ]),
    );
  }
  return lines.join('\r\n');
}

/**
 * If `output` is a plain object with exactly one field whose value is an
 * array of plain objects, return that array; otherwise undefined.
 */
function singleArrayField(output: unknown): Record<string, unknown>[] | undefined {
  if (!isPlainObject(output)) return undefined;
  const values = Object.values(output);
  if (Object.keys(output).length !== 1 || !Array.isArray(values[0])) return undefined;
  const items = values[0] as unknown[];
  if (!items.every(isPlainObject)) return undefined;
  return items as Record<string, unknown>[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Render an arbitrary value into a single CSV cell string. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

/** RFC 4180: quote fields containing commas, quotes, or line breaks; double quotes. */
function encodeRow(fields: string[]): string {
  return fields
    .map((field) => (/[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field))
    .join(',');
}
