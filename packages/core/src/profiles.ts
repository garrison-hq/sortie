/**
 * Login-profile storage-state helpers.
 *
 * A profile's Playwright storage state (cookies + origins) lives only on
 * disk at `<dataDir>/profiles/<name>.json` — never in the database, never in
 * API responses, never in prompts or logs. These helpers keep that boundary:
 * `summarizeProfileState` reports deterministic staleness metadata (counts,
 * domains, expiry times — never cookie names or values), and
 * `persistProfileState` writes the file with restrictive permissions
 * (directory 0700, file 0600).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Page } from 'playwright';
import { z } from 'zod';

/** The slice of Playwright storage-state JSON the summary needs. Cookie
 * `expires` is Unix seconds; -1 marks a session cookie. Values are parsed
 * but never surfaced. */
const StorageStateSchema = z.object({
  cookies: z
    .array(
      z.looseObject({
        domain: z.string(),
        expires: z.number(),
      }),
    )
    .default([]),
});

/** Deterministic, value-free staleness summary of a profile's storage state. */
export interface ProfileStateSummary {
  /** False when no state file exists (all other fields are zero/empty). */
  exists: boolean;
  cookieCount: number;
  /** Cookies with no expiry (browser-session lifetime). */
  sessionCookieCount: number;
  /** Persistent cookies whose expiry is already in the past. */
  expiredCookieCount: number;
  /** Unique cookie domains, leading "." stripped, sorted. */
  domains: string[];
  /** Earliest expiry among persistent cookies (epoch ms) — when the state
   * starts going stale. Undefined if every cookie is session-scoped. */
  earliestExpiresAt?: number;
}

/**
 * Summarize the storage-state file at `path`. Never reads cookie names or
 * values into the result. Throws on unreadable or malformed state files.
 */
export function summarizeProfileState(path: string): ProfileStateSummary {
  if (!existsSync(path)) {
    return {
      exists: false,
      cookieCount: 0,
      sessionCookieCount: 0,
      expiredCookieCount: 0,
      domains: [],
    };
  }

  const parsed = StorageStateSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new Error(`Invalid storage-state file at ${path}: ${parsed.error.message}`);
  }

  const cookies = parsed.data.cookies;
  const now = Date.now();
  const persistent = cookies.filter((c) => c.expires > 0);
  const earliest = persistent.length
    ? Math.min(...persistent.map((c) => c.expires)) * 1000
    : undefined;

  return {
    exists: true,
    cookieCount: cookies.length,
    sessionCookieCount: cookies.length - persistent.length,
    expiredCookieCount: persistent.filter((c) => c.expires * 1000 < now).length,
    domains: [...new Set(cookies.map((c) => c.domain.replace(/^\./, '')))].sort((a, b) =>
      a.localeCompare(b),
    ),
    earliestExpiresAt: earliest,
  };
}

/**
 * Persist `page`'s context storage state to `path` with restrictive
 * permissions: containing directory 0700, state file 0600 (it holds live
 * session cookies).
 */
export async function persistProfileState(page: Page, path: string): Promise<void> {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // mkdir mode is ignored when the dir already exists
  await page.context().storageState({ path });
  chmodSync(path, 0o600);
}
