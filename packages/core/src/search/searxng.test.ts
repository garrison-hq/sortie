import { afterEach, describe, expect, it, vi } from 'vitest';
import { searxngSearch } from './searxng.js';

const BASE_URL = 'http://searxng.internal:8080';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searxngSearch', () => {
  it('maps results to SearchResult with 1-based positions', async () => {
    stubFetch(
      jsonResponse({
        results: [
          {
            url: 'https://example.com/a',
            title: '  Result A  ',
            content: ' snippet A ',
            engine: 'wikipedia', // extra keys are ignored
            score: 1.5,
          },
          { url: 'https://example.com/b', title: 'Result B', content: null },
          { url: 'https://example.com/c' }, // no title/content at all
        ],
      }),
    );

    const results = await searxngSearch(BASE_URL, 'test query', 10);
    expect(results).toEqual([
      { title: 'Result A', url: 'https://example.com/a', snippet: 'snippet A', position: 1 },
      { title: 'Result B', url: 'https://example.com/b', snippet: '', position: 2 },
      { title: '', url: 'https://example.com/c', snippet: '', position: 3 },
    ]);
  });

  it('slices to maxResults', async () => {
    stubFetch(
      jsonResponse({
        results: Array.from({ length: 30 }, (_, i) => ({
          url: `https://example.com/${i}`,
          title: `r${i}`,
          content: '',
        })),
      }),
    );

    const results = await searxngSearch(BASE_URL, 'q', 5);
    expect(results).toHaveLength(5);
    expect(results[4]?.position).toBe(5);
  });

  it('requests <base>/search with q and format=json', async () => {
    const mock = stubFetch(jsonResponse({ results: [] }));

    await searxngSearch(BASE_URL, 'hello world', 10);

    const requested = new URL(String(mock.mock.calls[0]?.[0]));
    expect(requested.origin).toBe('http://searxng.internal:8080');
    expect(requested.pathname).toBe('/search');
    expect(requested.searchParams.get('q')).toBe('hello world');
    expect(requested.searchParams.get('format')).toBe('json');
  });

  it('preserves a sub-path base URL (instance behind a path prefix)', async () => {
    const mock = stubFetch(jsonResponse({ results: [] }));

    await searxngSearch('http://host:8080/searx', 'q', 10);

    const requested = new URL(String(mock.mock.calls[0]?.[0]));
    expect(requested.pathname).toBe('/searx/search');
  });

  it('hints at the settings.yml JSON format on HTTP 403', async () => {
    stubFetch(new Response('Forbidden', { status: 403 }));

    await expect(searxngSearch(BASE_URL, 'q', 10)).rejects.toThrow(
      /403.*settings\.yml.*\[html, json\]/s,
    );
  });

  it('reports other non-OK statuses', async () => {
    stubFetch(new Response('boom', { status: 500 }));

    await expect(searxngSearch(BASE_URL, 'q', 10)).rejects.toThrow(/HTTP 500/);
  });

  it('wraps network failures with the instance origin', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    await expect(searxngSearch(BASE_URL, 'q', 10)).rejects.toThrow(
      /request to http:\/\/searxng\.internal:8080 failed: fetch failed/,
    );
  });

  it('rejects non-JSON bodies', async () => {
    stubFetch(new Response('<html>not json</html>', { status: 200 }));

    await expect(searxngSearch(BASE_URL, 'q', 10)).rejects.toThrow(/non-JSON response/);
  });

  it('rejects unexpected response shapes via zod', async () => {
    stubFetch(jsonResponse({ answers: [] }));

    await expect(searxngSearch(BASE_URL, 'q', 10)).rejects.toThrow(/unexpected response shape/);
  });

  it('rejects an invalid base URL without calling fetch', async () => {
    const mock = stubFetch(jsonResponse({ results: [] }));

    await expect(searxngSearch('not a url', 'q', 10)).rejects.toThrow(/invalid base URL/);
    expect(mock).not.toHaveBeenCalled();
  });
});
