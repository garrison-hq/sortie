import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { persistProfileState, summarizeProfileState } from './profiles.js';

/** Minimal Playwright storage-state JSON. `expires` is Unix seconds, -1 = session. */
function makeState(cookies: { domain: string; expires: number }[]): string {
  return JSON.stringify({
    cookies: cookies.map((c, i) => ({
      name: `cookie-${i}`,
      value: `secret-value-${i}`,
      domain: c.domain,
      path: '/',
      expires: c.expires,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    })),
    origins: [],
  });
}

describe('summarizeProfileState', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nanofish-state-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports exists: false (all-zero) for a missing file', () => {
    expect(summarizeProfileState(join(dir, 'missing.json'))).toEqual({
      exists: false,
      cookieCount: 0,
      sessionCookieCount: 0,
      expiredCookieCount: 0,
      domains: [],
    });
  });

  it('summarizes counts, domains, and earliest expiry without exposing values', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const path = join(dir, 'state.json');
    writeFileSync(
      path,
      makeState([
        { domain: '.example.com', expires: -1 }, // session
        { domain: 'example.com', expires: nowSec + 3600 }, // valid
        { domain: 'other.test', expires: nowSec - 3600 }, // expired
      ]),
    );

    const summary = summarizeProfileState(path);
    expect(summary).toEqual({
      exists: true,
      cookieCount: 3,
      sessionCookieCount: 1,
      expiredCookieCount: 1,
      domains: ['example.com', 'other.test'], // deduped (leading dot stripped), sorted
      earliestExpiresAt: (nowSec - 3600) * 1000,
    });
    // The summary must never carry cookie names or values.
    expect(JSON.stringify(summary)).not.toContain('secret-value');
    expect(JSON.stringify(summary)).not.toContain('cookie-0');
  });

  it('handles an empty cookie jar', () => {
    const path = join(dir, 'empty.json');
    writeFileSync(path, JSON.stringify({ cookies: [], origins: [] }));

    const summary = summarizeProfileState(path);
    expect(summary.exists).toBe(true);
    expect(summary.cookieCount).toBe(0);
    expect(summary.earliestExpiresAt).toBeUndefined();
  });

  it('throws on malformed state files', () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, JSON.stringify({ cookies: 'not-an-array' }));
    expect(() => summarizeProfileState(path)).toThrow(/Invalid storage-state file/);
  });
});

describe('persistProfileState', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nanofish-persist-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Fake Page whose context writes a fixed storage state to the given path. */
  function fakePage(stateJson: string): Page {
    return {
      context() {
        return {
          async storageState({ path }: { path: string }) {
            writeFileSync(path, stateJson);
          },
        };
      },
    } as unknown as Page;
  }

  it('writes the state with directory mode 0700 and file mode 0600', async () => {
    const stateJson = makeState([{ domain: 'saucedemo.com', expires: -1 }]);
    const path = join(dir, 'profiles', 'sauce.json');

    await persistProfileState(fakePage(stateJson), path);

    expect(readFileSync(path, 'utf8')).toBe(stateJson);
    expect(statSync(join(dir, 'profiles')).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
