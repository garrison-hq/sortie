/**
 * Web search: natural-language query -> normalized `SearchResult[]`.
 *
 * Backend resolution:
 *   1. SearXNG when configured (`SearchOptions.searxngBaseUrl`, else the
 *      `SEARXNG_BASE_URL` env var) — structured JSON, no CAPTCHA.
 *   2. Browser-engine fallback chain (default Bing -> DuckDuckGo -> Brave);
 *      a challenged engine advances the chain (no anti-bot evasion).
 *
 * All backends feed through the same normalization: absolute http(s) URLs
 * only, deduped by URL, fresh 1-based positions, capped at `maxResults`
 * (default 10, clamped to 1..20).
 */
import type { Page } from 'playwright';
import type {
  SearchEngineId,
  SearchOptions,
  SearchProvider,
  SearchResponse,
  SearchResult,
} from '../contracts.js';
import { withPage } from '../browser/manager.js';
import { searchViaEngine, SearchChallengeError } from './engines.js';
import { searxngSearch } from './searxng.js';

export { searxngSearch } from './searxng.js';
export {
  searchViaEngine,
  detectChallenge,
  resolveDdgRedirect,
  resolveBingRedirect,
  SearchChallengeError,
} from './engines.js';

const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_CAP = 20;
const DEFAULT_ENGINE_ORDER: SearchEngineId[] = ['bing', 'duckduckgo', 'brave'];

/** Clamp a requested result count to 1..20 (default 10). */
export function clampMaxResults(value?: number): number {
  if (value === undefined || Number.isNaN(value)) return DEFAULT_MAX_RESULTS;
  return Math.min(MAX_RESULTS_CAP, Math.max(1, Math.floor(value)));
}

/** Parse to an absolute http(s) URL, or undefined for anything else. */
function toAbsoluteHttpUrl(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return parsed.toString();
}

const collapse = (s: string): string => s.replaceAll(/\s+/g, ' ').trim();

/**
 * Normalize raw backend results: keep absolute http(s) URLs only, dedupe by
 * (normalized) URL keeping the first hit, collapse whitespace in title and
 * snippet, reassign 1-based positions, and cap at `maxResults`.
 */
export function normalizeResults(results: SearchResult[], maxResults: number): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const result of results) {
    if (out.length >= maxResults) break;
    const url = toAbsoluteHttpUrl(result.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      ...result,
      title: collapse(result.title),
      url,
      snippet: collapse(result.snippet),
      position: out.length + 1,
    });
  }
  return out;
}

/** Try each browser engine in order until one yields results. */
async function searchViaBrowserChain(
  query: string,
  maxResults: number,
  opts: SearchOptions | undefined,
  priorFailures: string[],
): Promise<SearchResponse> {
  const engines = opts?.engines?.length ? opts.engines : DEFAULT_ENGINE_ORDER;

  const run = async (page: Page): Promise<SearchResponse> => {
    const failures = [...priorFailures];
    for (const engine of engines) {
      try {
        const raw = await searchViaEngine(page, engine, query, maxResults, opts?.provider);
        const results = normalizeResults(raw, maxResults);
        if (results.length > 0) {
          return { query, results, source: engine };
        }
        failures.push(`${engine}: no results parsed from the page`);
      } catch (err) {
        const reason =
          err instanceof SearchChallengeError || err instanceof Error ? err.message : String(err);
        failures.push(`${engine}: ${reason}`);
      }
    }
    throw new Error(
      `search: no backend produced results for ${JSON.stringify(query)} — ` +
        `${failures.join('; ')}. ` +
        'Set SEARXNG_BASE_URL to a self-hosted SearXNG instance (JSON format ' +
        'enabled) for a CAPTCHA-free backend.',
    );
  };

  // Reuse the caller's page when given (the agent's search tool passes a
  // temporary page); otherwise own a one-shot browser.
  return opts?.page ? run(opts.page) : withPage({ headless: opts?.headless }, run);
}

/**
 * Search the web. SearXNG-first when configured; otherwise (or when SearXNG
 * errors) the browser-engine fallback chain. Throws when every backend
 * failed or was challenged, with per-backend reasons and the
 * SEARXNG_BASE_URL fix named in the message.
 */
export async function search(query: string, opts?: SearchOptions): Promise<SearchResponse> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error('search: query must be a non-empty string.');
  }
  const maxResults = clampMaxResults(opts?.maxResults);

  // Backend resolution: explicit option, then env, then browser chain.
  const baseUrl = (opts?.searxngBaseUrl ?? process.env.SEARXNG_BASE_URL)?.trim() || undefined;
  const failures: string[] = [];
  if (baseUrl) {
    try {
      const raw = await searxngSearch(baseUrl, trimmed, maxResults);
      return { query: trimmed, results: normalizeResults(raw, maxResults), source: 'searxng' };
    } catch (err) {
      // A broken SearXNG instance should not take search down entirely —
      // fall through to the browser chain, but keep the reason for the
      // all-backends-failed error.
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }

  return searchViaBrowserChain(trimmed, maxResults, opts, failures);
}

/**
 * Wrap `search()` as a `SearchProvider` with baked-in defaults (engines,
 * SearXNG base URL, LLM provider, ...). Per-call options override defaults.
 * Powers the agent's `search` tool.
 */
export function createSearchProvider(defaults?: SearchOptions): SearchProvider {
  return {
    search: (query, opts) => search(query, { ...defaults, ...opts }),
  };
}
