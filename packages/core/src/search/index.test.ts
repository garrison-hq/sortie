import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '../contracts.js';
import { clampMaxResults, normalizeResults, search } from './index.js';

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: 'Title',
    url: 'https://example.com/',
    snippet: 'Snippet',
    position: 0,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('clampMaxResults', () => {
  it('defaults to 10', () => {
    expect(clampMaxResults(undefined)).toBe(10);
    expect(clampMaxResults(Number.NaN)).toBe(10);
  });

  it('clamps to 1..20 and floors fractions', () => {
    expect(clampMaxResults(0)).toBe(1);
    expect(clampMaxResults(-5)).toBe(1);
    expect(clampMaxResults(1)).toBe(1);
    expect(clampMaxResults(7.9)).toBe(7);
    expect(clampMaxResults(20)).toBe(20);
    expect(clampMaxResults(50)).toBe(20);
  });
});

describe('normalizeResults', () => {
  it('keeps only absolute http(s) URLs', () => {
    const normalized = normalizeResults(
      [
        result({ url: 'https://example.com/keep' }),
        result({ url: 'http://example.org/also-keep' }),
        result({ url: '/relative/path' }),
        result({ url: 'javascript:void(0)' }),
        result({ url: 'ftp://example.com/file' }),
        result({ url: 'not a url' }),
      ],
      10,
    );
    expect(normalized.map((r) => r.url)).toEqual([
      'https://example.com/keep',
      'http://example.org/also-keep',
    ]);
  });

  it('dedupes by URL keeping the first hit', () => {
    const normalized = normalizeResults(
      [
        result({ title: 'First', url: 'https://example.com/page' }),
        result({ title: 'Dupe', url: 'https://example.com/page' }),
        result({ title: 'Other', url: 'https://example.com/other' }),
      ],
      10,
    );
    expect(normalized.map((r) => r.title)).toEqual(['First', 'Other']);
  });

  it('reassigns fresh 1-based positions after filtering', () => {
    const normalized = normalizeResults(
      [
        result({ url: 'bad-url', position: 1 }),
        result({ url: 'https://example.com/a', position: 7 }),
        result({ url: 'https://example.com/b', position: 9 }),
      ],
      10,
    );
    expect(normalized.map((r) => r.position)).toEqual([1, 2]);
  });

  it('caps at maxResults', () => {
    const many = Array.from({ length: 30 }, (_, i) => result({ url: `https://example.com/${i}` }));
    expect(normalizeResults(many, 3)).toHaveLength(3);
  });

  it('collapses whitespace in title and snippet, preserving engine tags', () => {
    const normalized = normalizeResults(
      [
        result({
          title: '  A \n  title ',
          snippet: ' multi \t line\nsnippet ',
          engine: 'bing',
          url: 'https://example.com/a',
        }),
      ],
      10,
    );
    expect(normalized[0]).toEqual({
      title: 'A title',
      snippet: 'multi line snippet',
      engine: 'bing',
      url: 'https://example.com/a',
      position: 1,
    });
  });
});

describe('search (SearXNG path, mocked fetch)', () => {
  function stubSearxng(results: unknown[]): ReturnType<typeof vi.fn> {
    const mock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mock);
    return mock;
  }

  it('rejects empty queries before touching any backend', async () => {
    const mock = stubSearxng([]);
    await expect(search('   ')).rejects.toThrow(/non-empty/);
    expect(mock).not.toHaveBeenCalled();
  });

  it('uses the searxngBaseUrl option and normalizes its results', async () => {
    stubSearxng([
      { url: 'https://example.com/a', title: 'A', content: 's' },
      { url: 'https://example.com/a', title: 'A dupe', content: '' },
      { url: 'https://example.com/b', title: 'B', content: '' },
    ]);

    const response = await search('  test  ', { searxngBaseUrl: 'http://searxng:8080' });
    expect(response.source).toBe('searxng');
    expect(response.query).toBe('test');
    expect(response.results.map((r) => r.url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
    expect(response.results.map((r) => r.position)).toEqual([1, 2]);
  });

  it('falls back to the SEARXNG_BASE_URL env var', async () => {
    const mock = stubSearxng([{ url: 'https://example.com/a', title: 'A', content: '' }]);
    vi.stubEnv('SEARXNG_BASE_URL', 'http://from-env:8080');

    const response = await search('test');
    expect(response.source).toBe('searxng');
    expect(new URL(String(mock.mock.calls[0]?.[0])).origin).toBe('http://from-env:8080');
  });

  it('prefers the explicit option over the env var', async () => {
    const mock = stubSearxng([{ url: 'https://example.com/a', title: 'A', content: '' }]);
    vi.stubEnv('SEARXNG_BASE_URL', 'http://from-env:8080');

    await search('test', { searxngBaseUrl: 'http://from-option:8080' });
    expect(new URL(String(mock.mock.calls[0]?.[0])).origin).toBe('http://from-option:8080');
  });

  it('clamps maxResults from the options', async () => {
    stubSearxng(
      Array.from({ length: 30 }, (_, i) => ({
        url: `https://example.com/${i}`,
        title: `r${i}`,
        content: '',
      })),
    );

    const response = await search('test', {
      searxngBaseUrl: 'http://searxng:8080',
      maxResults: 50,
    });
    expect(response.results).toHaveLength(20);
  });
});
