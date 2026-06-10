/**
 * SearXNG search backend: structured JSON from a self-hosted instance.
 *
 * This is the preferred backend (no CAPTCHA, no SERP selector rot): point
 * `SEARXNG_BASE_URL` (or `SearchOptions.searxngBaseUrl`) at an instance and
 * `search()` queries it before falling back to browser-driven engines. The
 * instance must have the JSON output format enabled — in settings.yml:
 * `search.formats: [html, json]`.
 */
import { z } from 'zod';
import type { SearchResult } from '../contracts.js';

/** One SearXNG result — unknown extra keys are ignored by the schema. */
const searxngResultSchema = z.object({
  url: z.string().min(1),
  title: z.string().default(''),
  /** Snippet text; missing/null for some engines aggregated by SearXNG. */
  content: z.string().nullish(),
});

const searxngResponseSchema = z.object({
  results: z.array(searxngResultSchema),
});

/** Build `<base>/search?q=<query>&format=json`, respecting sub-path bases. */
function buildSearchUrl(baseUrl: string, query: string): URL {
  let url: URL;
  try {
    // Relative resolution so a base like "http://host:8080/searx" keeps its
    // path prefix ("/search" as an absolute path would discard it).
    url = new URL('search', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  } catch (err) {
    throw new Error(`searxng: invalid base URL "${baseUrl}".`, { cause: err });
  }
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  return url;
}

/**
 * Query a SearXNG instance and map its JSON results to `SearchResult[]`
 * (positions are 1-based; final normalization/dedupe happens in `search()`).
 *
 * Throws with a clear, actionable message on network failure, non-OK status
 * (403 → JSON format disabled hint), or an unexpected response shape.
 */
export async function searxngSearch(
  baseUrl: string,
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  const url = buildSearchUrl(baseUrl, query);

  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`searxng: request to ${url.origin} failed: ${reason}`, { cause: err });
  }

  if (response.status === 403) {
    throw new Error(
      `searxng: HTTP 403 from ${url.origin} — the instance likely has the JSON output ` +
        'format disabled. Enable it in settings.yml: `search.formats: [html, json]`.',
    );
  }
  if (!response.ok) {
    throw new Error(`searxng: HTTP ${response.status} from ${url.origin}.`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new Error(
      `searxng: non-JSON response from ${url.origin} — is this actually a SearXNG instance?`,
      { cause: err },
    );
  }

  const parsed = searxngResponseSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`searxng: unexpected response shape from ${url.origin} (${issues}).`);
  }

  return parsed.data.results.slice(0, maxResults).map((result, index) => ({
    title: result.title.trim(),
    url: result.url,
    snippet: (result.content ?? '').trim(),
    position: index + 1,
  }));
}
