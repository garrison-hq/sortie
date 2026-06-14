/**
 * Browser-driven search engines (fallback path when SearXNG is not set up).
 *
 * `searchViaEngine()` navigates a page to the engine's SERP and runs a fast
 * in-page selector parse. Engines that present a bot challenge throw
 * `SearchChallengeError` so the caller advances the chain — anti-bot evasion
 * is explicitly out of scope. When the fast parse finds nothing but the page
 * is *not* a challenge (selector rot), an LLM provider — if available — gets
 * a chance to parse the SERP semantically via `extract()`.
 */
import { z } from 'zod';
import type { Page } from 'playwright';
import type { LlmProvider, SearchEngineId, SearchResult } from '../contracts.js';
import { extract } from '../extract/index.js';

const SETTLE_TIMEOUT_MS = 5_000;
const TITLE_LIMIT = 200;
const SNIPPET_LIMIT = 300;
const CHALLENGE_TEXT_LIMIT = 4_000;

/** An engine refused to serve results (CAPTCHA / rate limit / bot wall). */
export class SearchChallengeError extends Error {
  readonly engine: SearchEngineId;

  constructor(engine: SearchEngineId, reason: string) {
    super(`challenge detected (${reason}); anti-bot evasion is out of scope — skipping engine`);
    this.name = 'SearchChallengeError';
    this.engine = engine;
  }
}

// ---------------------------------------------------------------------------
// Challenge detection (pure — unit-testable without a browser)
// ---------------------------------------------------------------------------

/** Phrases that mark a bot-challenge page on any engine. */
const CHALLENGE_MARKERS = [
  'captcha',
  'unusual traffic',
  'are you a robot',
  'verify you are human',
  'verifying you are human',
  'verify you are not a robot',
] as const;

/**
 * Decide whether an engine response is a bot challenge rather than a SERP.
 * Returns a short human-readable reason, or `null` for a normal page.
 *
 * Known signals (verified live): DuckDuckGo html answers HTTP 202 with an
 * "anomaly modal" ("Unfortunately, bots use DuckDuckGo too..."); Brave and
 * Bing use verify/CAPTCHA interstitials and 403/429 statuses.
 */
export function detectChallenge(
  engine: SearchEngineId,
  status: number,
  title: string,
  bodyText: string,
): string | null {
  if (status === 403 || status === 429) {
    return `HTTP ${status} (blocked or rate-limited)`;
  }
  if (engine === 'duckduckgo' && status === 202) {
    return 'HTTP 202 (DuckDuckGo bot challenge)';
  }

  const haystack = `${title}\n${bodyText.slice(0, CHALLENGE_TEXT_LIMIT)}`.toLowerCase();
  for (const marker of CHALLENGE_MARKERS) {
    if (haystack.includes(marker)) {
      return `challenge page detected ("${marker}")`;
    }
  }
  if (engine === 'duckduckgo' && haystack.includes('bots use duckduckgo')) {
    return 'DuckDuckGo anomaly challenge modal';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Engine configs (selectors are best-effort by design — see fallback above)
// ---------------------------------------------------------------------------

interface EngineConfig {
  searchUrl(query: string): string;
  /** Selector for one organic result container. */
  container: string;
  /** Selector (within the container) for the result link. */
  link: string;
  /** Optional selector for the title text; defaults to the link itself. */
  title: string;
  /** Selector for the snippet text. */
  snippet: string;
  /** Containers matching this are skipped (ads, "more results" stubs). */
  exclude: string;
}

const ENGINE_CONFIGS: Record<SearchEngineId, EngineConfig> = {
  bing: {
    searchUrl: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    container: 'li.b_algo',
    link: 'h2 a',
    title: '',
    snippet: '.b_caption p, p',
    exclude: '',
  },
  duckduckgo: {
    searchUrl: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    container: 'div.result',
    link: 'a.result__a',
    title: '',
    snippet: '.result__snippet',
    exclude: '.result--ad, .result--more',
  },
  brave: {
    searchUrl: (query) => `https://search.brave.com/search?q=${encodeURIComponent(query)}`,
    container: '[data-type="web"]',
    link: 'a[href]',
    title: '.title',
    snippet: '.snippet-content, .snippet-description, p',
    exclude: '',
  },
};

/**
 * DuckDuckGo html wraps result links in a redirect
 * (`https://duckduckgo.com/l/?uddg=<encoded target>&...`) — unwrap to the
 * real target so dedupe and downstream fetches see the actual URL.
 */
export function resolveDdgRedirect(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname.startsWith('/l/')) {
      // searchParams.get() already percent-decodes the target.
      const target = parsed.searchParams.get('uddg');
      if (target) return target;
    }
  } catch {
    // Not parseable — return as-is; normalization will drop it if invalid.
  }
  return url;
}

/**
 * Bing wraps organic result links in a tracking redirect
 * (`https://www.bing.com/ck/a?...&u=a1<base64url target>&...`) — unwrap to
 * the real target so dedupe and downstream fetches see the actual URL.
 */
export function resolveBingRedirect(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('bing.com') && parsed.pathname === '/ck/a') {
      const wrapped = parsed.searchParams.get('u');
      // The `u` param is "a1" + base64url-encoded target URL.
      if (wrapped !== null && wrapped.startsWith('a1')) {
        const decoded = Buffer.from(wrapped.slice(2), 'base64url').toString('utf8');
        if (/^https?:\/\//.test(decoded)) return decoded;
      }
    }
  } catch {
    // Not parseable — return as-is; normalization will drop it if invalid.
  }
  return url;
}

/** Unwrap engine-specific tracking redirects to the real target URL. */
function resolveEngineRedirect(engine: SearchEngineId, url: string): string {
  if (engine === 'duckduckgo') return resolveDdgRedirect(url);
  if (engine === 'bing') return resolveBingRedirect(url);
  return url;
}

// ---------------------------------------------------------------------------
// Minimal structural DOM types — same approach as browser/distill.ts: this
// package compiles without the "dom" lib and the evaluate callbacks run in
// the browser, so we describe only what the SERP parser touches.
// ---------------------------------------------------------------------------
interface MinimalSerpElement {
  querySelector(selector: string): MinimalSerpElement | null;
  matches(selector: string): boolean;
  innerText?: string;
  href?: string;
}
interface MinimalSerpNodeList {
  length: number;
  [index: number]: MinimalSerpElement | undefined;
}
interface MinimalSerpDocument {
  querySelectorAll(selector: string): MinimalSerpNodeList;
  body: { innerText?: string } | null;
}
interface MinimalSerpWindow {
  document: MinimalSerpDocument;
}

/** Raw fast-parse hit before redirect-unwrapping and normalization. */
interface RawSerpHit {
  title: string;
  url: string;
  snippet: string;
}

/** In-page selector parse — self-contained callback, no Node closure. */
async function fastParseSerp(
  page: Page,
  config: EngineConfig,
  maxResults: number,
): Promise<RawSerpHit[]> {
  return page.evaluate(
    (cfg: {
      container: string;
      link: string;
      title: string;
      snippet: string;
      exclude: string;
      max: number;
      titleLimit: number;
      snippetLimit: number;
    }): RawSerpHit[] => {
      const doc = (globalThis as unknown as MinimalSerpWindow).document;
      const collapse = (s: string): string => s.replaceAll(/\s+/g, ' ').trim();

      // Parse a single container into a hit, or null if it should be skipped
      // (excluded, no usable link, or empty title). Pulled out of the loop to
      // keep the per-result branching out of the iteration body.
      const parseContainer = (item: MinimalSerpElement): RawSerpHit | null => {
        if (cfg.exclude && item.matches(cfg.exclude)) return null;

        const linkEl = item.querySelector(cfg.link);
        if (!linkEl || typeof linkEl.href !== 'string' || !linkEl.href) return null;

        const titleEl = (cfg.title ? item.querySelector(cfg.title) : null) ?? linkEl;
        const title = collapse(typeof titleEl.innerText === 'string' ? titleEl.innerText : '');
        if (!title) return null;

        const snippetEl = item.querySelector(cfg.snippet);
        const snippet = collapse(
          snippetEl && typeof snippetEl.innerText === 'string' ? snippetEl.innerText : '',
        );

        return {
          title: title.slice(0, cfg.titleLimit),
          url: linkEl.href,
          snippet: snippet.slice(0, cfg.snippetLimit),
        };
      };

      const out: RawSerpHit[] = [];
      const containers = doc.querySelectorAll(cfg.container);
      for (let i = 0; i < containers.length && out.length < cfg.max; i++) {
        const item = containers[i];
        if (!item) continue;
        const hit = parseContainer(item);
        if (hit) out.push(hit);
      }
      return out;
    },
    {
      container: config.container,
      link: config.link,
      title: config.title,
      snippet: config.snippet,
      exclude: config.exclude,
      // Headroom over maxResults: normalization may drop dupes/invalid URLs.
      max: maxResults + 10,
      titleLimit: TITLE_LIMIT,
      snippetLimit: SNIPPET_LIMIT,
    },
  );
}

/** Visible body text (capped) for challenge detection; best-effort. */
async function readBodyText(page: Page): Promise<string> {
  try {
    return await page.evaluate((limit: number): string => {
      const doc = (globalThis as unknown as MinimalSerpWindow).document;
      const text = doc.body && typeof doc.body.innerText === 'string' ? doc.body.innerText : '';
      return text.slice(0, limit);
    }, CHALLENGE_TEXT_LIMIT);
  } catch {
    return '';
  }
}

/** Schema for the semantic SERP-parse fallback (LLM output boundary). */
const serpResultsSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      snippet: z.string().default(''),
    }),
  ),
});

/** Selector-free fallback: let the LLM read the SERP snapshot. */
async function semanticParseSerp(
  page: Page,
  query: string,
  maxResults: number,
  provider: LlmProvider,
): Promise<RawSerpHit[]> {
  const { data } = await extract({
    page,
    schema: serpResultsSchema,
    instruction:
      `the organic web search results for the query ${JSON.stringify(query)} — ` +
      'title, absolute URL, and snippet for each; skip ads, related-search ' +
      'suggestions, and navigation links',
    provider,
  });
  return data.results.slice(0, maxResults);
}

/**
 * Run one browser-engine search on `page`: navigate to the SERP, detect bot
 * challenges (throws `SearchChallengeError`), fast-parse via selectors, and
 * fall back to a semantic `extract()` when the fast parse comes up empty on
 * an unchallenged page and a provider is available.
 *
 * Returns raw results tagged with `engine` and 1-based positions — final
 * URL filtering/dedupe happens in `search()`.
 */
export async function searchViaEngine(
  page: Page,
  engine: SearchEngineId,
  query: string,
  maxResults: number,
  provider?: LlmProvider,
): Promise<SearchResult[]> {
  const config = ENGINE_CONFIGS[engine];

  const response = await page.goto(config.searchUrl(query), { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});

  const status = response?.status() ?? 0;
  const title = await page.title().catch(() => '');
  const bodyText = await readBodyText(page);
  const challenge = detectChallenge(engine, status, title, bodyText);
  if (challenge) {
    throw new SearchChallengeError(engine, challenge);
  }

  let hits = await fastParseSerp(page, config, maxResults);
  if (hits.length === 0 && provider) {
    // Empty but unchallenged — likely selector rot. Parse semantically.
    hits = await semanticParseSerp(page, query, maxResults, provider);
  }

  return hits.map((hit, index) => ({
    title: hit.title,
    url: resolveEngineRedirect(engine, hit.url),
    snippet: hit.snippet,
    engine,
    position: index + 1,
  }));
}
