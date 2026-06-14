import { useCallback, useEffect, useState } from 'react';
import { deleteProfile, listProfiles } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import type { ProfileInfo } from '../types';
import { messageOf, relativeTime } from '../util';

/** All persistent cookies expired (or the state file is gone) — the profile
 * almost certainly needs a fresh login. */
function isStale(profile: ProfileInfo): boolean {
  const { state } = profile;
  if (!state.exists) return true;
  const persistent = state.cookieCount - state.sessionCookieCount;
  return persistent > 0 && state.expiredCookieCount >= persistent;
}

/**
 * Login profiles: named Playwright storage states kept on the server. This
 * view only ever sees value-free metadata (counts/domains) — never cookie
 * contents. Creation happens via the CLI, which needs a headful browser.
 */
export function Profiles() {
  const [profiles, setProfiles] = useState<ProfileInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setProfiles(await listProfiles());
      setError(null);
    } catch (err) {
      setError(messageOf(err));
      setProfiles((prev) => prev ?? []);
    }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function remove(name: string): Promise<void> {
    if (
      !globalThis.confirm(
        `Delete profile "${name}"? Its stored login state is removed from the server.`,
      )
    ) {
      return;
    }
    setBusy(name);
    setError(null);
    try {
      await deleteProfile(name);
      setProfiles((prev) => (prev === null ? prev : prev.filter((p) => p.name !== name)));
    } catch (err) {
      setError(messageOf(err));
    }
    setBusy(null);
  }

  return (
    <div>
      <h1 className="page-title">Login profiles</h1>
      {error !== null && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <p className="hint">
        Profiles are created on the machine running sortie:{' '}
        <code>sortie profile login &lt;name&gt; --url &lt;loginUrl&gt;</code> (log in by hand, then
        press Enter to save). Pick a profile on the New Run form to reuse its session.
      </p>
      {profiles === null && <div className="loading">Loading profiles…</div>}
      {profiles !== null && profiles.length === 0 && (
        <div className="empty-state">
          No profiles yet — create one with{' '}
          <code>sortie profile login &lt;name&gt; --url &lt;loginUrl&gt;</code>.
        </div>
      )}
      {profiles !== null && profiles.length > 0 && (
        <table className="runs-table profiles-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Domains</th>
              <th>Cookies</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((profile) => {
              const { state } = profile;
              const domains = state.domains.length > 0 ? state.domains.join(', ') : '';
              return (
                <tr key={profile.name}>
                  <td>
                    <span className="mono">{profile.name}</span>
                    {isStale(profile) && (
                      <span
                        className="chip chip-stale"
                        title={
                          state.exists
                            ? 'Every persistent cookie has expired — log in again to refresh.'
                            : 'Storage-state file is missing on the server.'
                        }
                      >
                        stale
                      </span>
                    )}
                  </td>
                  <td className="cell-url" title={domains}>
                    {domains === '' ? (profile.domainHint ?? '—') : domains}
                  </td>
                  <td className="cell-dim">
                    {state.exists
                      ? `${state.cookieCount} (${state.sessionCookieCount} session, ${state.expiredCookieCount} expired)`
                      : 'no state file'}
                  </td>
                  <td className="cell-dim">{relativeTime(profile.createdAt, now)}</td>
                  <td className="cell-dim">
                    {profile.lastUsedAt === undefined
                      ? 'never'
                      : relativeTime(profile.lastUsedAt, now)}
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn btn-small btn-danger"
                        disabled={busy === profile.name}
                        onClick={() => void remove(profile.name)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
