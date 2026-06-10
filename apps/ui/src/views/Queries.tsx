import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { deleteQuery, listQueries, runQuery } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import type { SavedQuery } from '../types';
import { messageOf, relativeTime } from '../util';

/**
 * Saved queries: named, replayable extract specs. Each row can be replayed
 * as-is, replayed against an overridden URL, or deleted. Queries are created
 * from the New Run form, a run's detail page, or `sortie query save`.
 */
export function Queries() {
  const [queries, setQueries] = useState<SavedQuery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** Name of the query whose "Run on URL" input is open, plus its draft URL. */
  const [urlFor, setUrlFor] = useState<{ name: string; url: string } | null>(null);
  /** Name of the query currently being submitted/deleted (disables its row). */
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setQueries(await listQueries());
      setError(null);
    } catch (err) {
      setError(messageOf(err));
      setQueries((prev) => prev ?? []);
    }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(name: string, urlOverride?: string): Promise<void> {
    setBusy(name);
    setError(null);
    try {
      const overrides = urlOverride !== undefined ? { url: urlOverride } : undefined;
      const record = await runQuery(name, overrides);
      window.location.hash = `#/runs/${record.id}`;
    } catch (err) {
      setError(messageOf(err));
      setBusy(null);
    }
  }

  async function remove(name: string): Promise<void> {
    if (!window.confirm(`Delete saved query "${name}"? Past runs keep their results.`)) return;
    setBusy(name);
    setError(null);
    try {
      await deleteQuery(name);
      setQueries((prev) => (prev === null ? prev : prev.filter((q) => q.name !== name)));
    } catch (err) {
      setError(messageOf(err));
    }
    setBusy(null);
  }

  function submitRunOnUrl(e: FormEvent, name: string): void {
    e.preventDefault();
    const url = urlFor?.url.trim() ?? '';
    if (url === '') return;
    void run(name, url);
  }

  return (
    <div>
      <h1 className="page-title">Saved queries</h1>
      {error !== null && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {queries === null ? (
        <div className="loading">Loading queries…</div>
      ) : queries.length === 0 ? (
        <div className="empty-state">
          No saved queries yet — save one from <a href="#/new">a new extract run</a>, a finished
          run's detail page, or <code>sortie query save</code>.
        </div>
      ) : (
        <table className="runs-table queries-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>URL</th>
              <th>Runs</th>
              <th>Last run</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {queries.map((query) => (
              <tr key={query.name}>
                <td className="mono">{query.name}</td>
                <td className="cell-url" title={query.spec.url}>
                  {query.spec.url}
                </td>
                <td className="cell-dim">{query.runCount}</td>
                <td className="cell-dim">
                  {query.lastRunAt !== undefined ? relativeTime(query.lastRunAt, now) : '—'}
                </td>
                <td>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={busy === query.name}
                      onClick={() => void run(query.name)}
                    >
                      Run
                    </button>
                    {urlFor?.name === query.name ? (
                      <form
                        className="inline-url-form"
                        onSubmit={(e) => submitRunOnUrl(e, query.name)}
                      >
                        <input
                          type="url"
                          className="inline-url-input"
                          value={urlFor.url}
                          onChange={(e) => setUrlFor({ name: query.name, url: e.target.value })}
                          placeholder="https://…"
                          autoFocus
                          required
                        />
                        <button
                          type="submit"
                          className="btn btn-small"
                          disabled={busy === query.name || urlFor.url.trim() === ''}
                        >
                          Go
                        </button>
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => setUrlFor(null)}
                        >
                          ×
                        </button>
                      </form>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={busy === query.name}
                        onClick={() => setUrlFor({ name: query.name, url: query.spec.url })}
                      >
                        Run on URL…
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-small btn-danger"
                      disabled={busy === query.name}
                      onClick={() => void remove(query.name)}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
