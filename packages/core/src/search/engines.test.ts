import { describe, expect, it } from 'vitest';
import { detectChallenge, resolveBingRedirect, resolveDdgRedirect } from './engines.js';

describe('detectChallenge', () => {
  it('passes normal SERP responses through', () => {
    expect(detectChallenge('bing', 200, 'query - Search', 'Result one\nResult two')).toBeNull();
    expect(detectChallenge('duckduckgo', 200, 'query at DuckDuckGo', 'results...')).toBeNull();
    expect(detectChallenge('brave', 200, 'query - Brave Search', 'results...')).toBeNull();
  });

  it('flags HTTP 403/429 on any engine', () => {
    expect(detectChallenge('bing', 403, '', '')).toMatch(/HTTP 403/);
    expect(detectChallenge('brave', 429, '', '')).toMatch(/HTTP 429/);
    expect(detectChallenge('duckduckgo', 403, '', '')).toMatch(/HTTP 403/);
  });

  it('flags HTTP 202 as a DuckDuckGo bot challenge (DDG only)', () => {
    expect(detectChallenge('duckduckgo', 202, '', '')).toMatch(/HTTP 202/);
    expect(detectChallenge('bing', 202, '', '')).toBeNull();
  });

  it('flags the DuckDuckGo anomaly modal body text', () => {
    const body = 'Unfortunately, bots use DuckDuckGo too. Please complete the following challenge.';
    expect(detectChallenge('duckduckgo', 200, 'DuckDuckGo', body)).toMatch(/anomaly/);
  });

  it('flags verify/CAPTCHA interstitials by title or body', () => {
    expect(detectChallenge('brave', 200, 'Verifying you are human', '')).toMatch(/challenge page/);
    expect(detectChallenge('bing', 200, '', 'Please solve this CAPTCHA to continue')).toMatch(
      /captcha/,
    );
    expect(
      detectChallenge('bing', 200, '', 'We detected unusual traffic from your network'),
    ).toMatch(/unusual traffic/);
  });

  it('only inspects the capped head of the body text', () => {
    // A challenge phrase buried past the 4k cap must not trigger.
    const body = `${'x'.repeat(5_000)} captcha`;
    expect(detectChallenge('bing', 200, '', body)).toBeNull();
  });
});

describe('resolveDdgRedirect', () => {
  it('unwraps the uddg redirect target', () => {
    const wrapped =
      'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fa%3D1&rut=abc';
    expect(resolveDdgRedirect(wrapped)).toBe('https://example.com/page?a=1');
  });

  it('leaves direct URLs untouched', () => {
    expect(resolveDdgRedirect('https://example.com/direct')).toBe('https://example.com/direct');
  });

  it('leaves duckduckgo URLs without a uddg param untouched', () => {
    expect(resolveDdgRedirect('https://duckduckgo.com/about')).toBe('https://duckduckgo.com/about');
  });

  it('returns unparseable values as-is', () => {
    expect(resolveDdgRedirect('not a url')).toBe('not a url');
  });
});

describe('resolveBingRedirect', () => {
  it('unwraps the /ck/a base64url redirect target', () => {
    // "a1" + base64url("https://playwright.dev/")
    const wrapped =
      'https://www.bing.com/ck/a?!&&p=tracking&u=a1aHR0cHM6Ly9wbGF5d3JpZ2h0LmRldi8&ntb=1';
    expect(resolveBingRedirect(wrapped)).toBe('https://playwright.dev/');
  });

  it('leaves direct URLs untouched', () => {
    expect(resolveBingRedirect('https://example.com/direct')).toBe('https://example.com/direct');
  });

  it('leaves bing URLs without a decodable u param untouched', () => {
    expect(resolveBingRedirect('https://www.bing.com/ck/a?u=zz123')).toBe(
      'https://www.bing.com/ck/a?u=zz123',
    );
    expect(resolveBingRedirect('https://www.bing.com/search?q=x')).toBe(
      'https://www.bing.com/search?q=x',
    );
  });

  it('ignores u params that do not decode to an http(s) URL', () => {
    // "a1" + base64url("not a url")
    const wrapped = `https://www.bing.com/ck/a?u=a1${Buffer.from('not a url').toString('base64url')}`;
    expect(resolveBingRedirect(wrapped)).toBe(wrapped);
  });

  it('returns unparseable values as-is', () => {
    expect(resolveBingRedirect('not a url')).toBe('not a url');
  });
});
