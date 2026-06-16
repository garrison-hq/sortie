import { useCallback, useEffect, useState } from 'react';
import { listRuns } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { StatusChip } from '../components/StatusChip';
import type { RunRecord, RunStatus } from '../types';
import { messageOf, relativeTime, shortId } from '../util';
import { useRunEvents } from '../ws';

const POLL_INTERVAL_MS = 3000;

const FILTERS: ReadonlyArray<RunStatus | 'all'> = [
  'all',
  'queued',
  'running',
  'success',
  'failed',
  'max_steps',
  'cancelled',
];

export function Runs() {
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [filter, setFilter] = useState<RunStatus | 'all'>('all');
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const fetched = await listRuns();
      setRuns(fetched);
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // Live updates: any record-bearing event (run-queued/started/finished)
  // upserts the row immediately, between polls.
  useRunEvents((ev) => {
    const record = ev.record;
    if (!record) return;
    setRuns((prev) => {
      if (prev === null) return prev;
      const index = prev.findIndex((run) => run.id === record.id);
      if (index === -1) return [record, ...prev];
      const next = [...prev];
      next[index] = record;
      return next;
    });
    setNow(Date.now());
  });

  const visible = (runs ?? [])
    .filter((run) => filter === 'all' || run.status === filter)
    .sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div>
      <h1 className="page-title">Runs</h1>
      {error !== null && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <div className="runs-toolbar">
        {FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            className={`filter-chip ${filter === value ? 'active' : ''}`}
            onClick={() => setFilter(value)}
          >
            {value}
          </button>
        ))}
      </div>
      {runs === null && <div className="loading">Loading runs…</div>}
      {runs !== null && visible.length === 0 && (
        <div className="empty-state">
          {filter === 'all' ? (
            <>
              No runs yet — <a href="#/new">start one</a>.
            </>
          ) : (
            `No ${filter} runs.`
          )}
        </div>
      )}
      {runs !== null && visible.length > 0 && (
        <table className="runs-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Kind</th>
              <th>Status</th>
              <th>URL</th>
              <th>Created</th>
              <th>Finished</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((run) => (
              <tr
                key={run.id}
                onClick={() => {
                  globalThis.location.hash = `#/runs/${run.id}`;
                }}
              >
                <td className="mono">{shortId(run.id)}</td>
                <td>{run.spec.kind}</td>
                <td>
                  <StatusChip status={run.status} />
                </td>
                <td className="cell-url" title={run.spec.url}>
                  {run.spec.url}
                </td>
                <td className="cell-dim">{relativeTime(run.createdAt, now)}</td>
                <td className="cell-dim">
                  {run.finishedAt === undefined ? '—' : relativeTime(run.finishedAt, now)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
