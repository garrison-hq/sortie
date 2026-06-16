/**
 * Unit tests for the shared challenge detector (T006 — NFR-003).
 *
 * Covers every ChallengeFamily with representative fixture inputs, and
 * includes a clean-page false-positive guard (≤1 false positive allowed
 * across the whole fixture set).
 */
import { describe, expect, it } from 'vitest';
import { detectChallenge, detectChallengeForEngine } from './detect.js';

// ---------------------------------------------------------------------------
// Pure detectChallenge fixtures
// ---------------------------------------------------------------------------

describe('detectChallenge — HTTP status detection', () => {
  it('flags HTTP 403 as family=http via=http', () => {
    const result = detectChallenge({ status: 403, title: '', bodyText: '', url: '' });
    expect(result).not.toBeNull();
    expect(result?.family).toBe('http');
    expect(result?.via).toBe('http');
    expect(result?.signal).toMatch(/403/);
    expect(result?.detected).toBe(true);
  });

  it('flags HTTP 429 as family=http via=http', () => {
    const result = detectChallenge({ status: 429, title: '', bodyText: '', url: '' });
    expect(result).not.toBeNull();
    expect(result?.family).toBe('http');
    expect(result?.via).toBe('http');
    expect(result?.signal).toMatch(/429/);
  });

  it('does not flag HTTP 200 on an empty page', () => {
    expect(detectChallenge({ status: 200, title: '', bodyText: '', url: '' })).toBeNull();
  });
});

describe('detectChallenge — frame-based detection', () => {
  it('detects reCAPTCHA via google.com/recaptcha frame', () => {
    const result = detectChallenge({
      status: 200,
      title: 'Example',
      bodyText: 'Please wait',
      url: 'https://example.com',
      frameUrls: ['https://www.google.com/recaptcha/api2/anchor?ar=1'],
    });
    expect(result).not.toBeNull();
    expect(result?.family).toBe('recaptcha');
    expect(result?.via).toBe('frame');
  });

  it('detects reCAPTCHA via recaptcha.net frame', () => {
    const result = detectChallenge({
      status: 200,
      title: 'Example',
      bodyText: '',
      url: 'https://example.com',
      frameUrls: ['https://recaptcha.net/recaptcha/api2/anchor'],
    });
    expect(result).not.toBeNull();
    expect(result?.family).toBe('recaptcha');
    expect(result?.via).toBe('frame');
  });

  it('detects hCaptcha via hcaptcha.com frame', () => {
    const result = detectChallenge({
      status: 200,
      title: 'Example',
      bodyText: '',
      url: 'https://example.com',
      frameUrls: ['https://newassets.hcaptcha.com/captcha/v1/123/frame'],
    });
    expect(result).not.toBeNull();
    expect(result?.family).toBe('hcaptcha');
    expect(result?.via).toBe('frame');
  });

  it('detects Cloudflare Turnstile via challenges.cloudflare.com frame', () => {
    const result = detectChallenge({
      status: 200,
      title: 'Just a moment...',
      bodyText: '',
      url: 'https://example.com',
      frameUrls: ['https://challenges.cloudflare.com/turnstile/v0/api.js'],
    });
    expect(result).not.toBeNull();
    expect(result?.family).toBe('turnstile');
    expect(result?.via).toBe('frame');
  });
});

describe('detectChallenge — content-based detection', () => {
  it('detects Cloudflare interstitial via "cf-chl" body marker', () => {
    const result = detectChallenge({
      status: 200,
      title: 'Just a moment',
      bodyText: 'cf-chl-widget-xyz Checking browser…',
      url: 'https://example.com',
    });
    expect(result).not.toBeNull();
    expect(result?.family).toBe('cloudflare');
    expect(result?.via).toBe('content');
  });

  it('detects Cloudflare interstitial via "checking your browser" body marker', () => {
    const result = detectChallenge({
      status: 200,
      title: 'Just a moment',
      bodyText: 'Checking your browser before accessing...',
      url: 'https://example.com',
    });
    expect(result).not.toBeNull();
    expect(result?.family).toBe('cloudflare');
  });

  it('detects Cloudflare interstitial via "just a moment" body marker', () => {
    const result = detectChallenge({
      status: 200,
      title: '',
      bodyText: 'Just a moment... Please stand by',
      url: 'https://example.com',
    });
    expect(result).not.toBeNull();
    expect(result?.family).toBe('cloudflare');
  });

  it('detects generic "verify you are human" interstitial', () => {
    const result = detectChallenge({
      status: 200,
      title: 'Verify you are human',
      bodyText: '',
      url: 'https://example.com',
    });
    expect(result).not.toBeNull();
    expect(result?.family).toBe('generic');
    expect(result?.via).toBe('marker');
  });

  it('detects generic "are you a robot" interstitial', () => {
    const result = detectChallenge({
      status: 200,
      title: 'Are you a robot?',
      bodyText: '',
      url: 'https://example.com',
    });
    expect(result).not.toBeNull();
    expect(result?.family).toBe('generic');
  });

  it('detects generic "unusual traffic" block page', () => {
    const result = detectChallenge({
      status: 200,
      title: 'Our systems have detected unusual traffic',
      bodyText: '',
      url: 'https://example.com',
    });
    expect(result).not.toBeNull();
    expect(result?.family).toBe('generic');
  });

  it('detects reCAPTCHA marker in body text as family=recaptcha', () => {
    const result = detectChallenge({
      status: 200,
      title: '',
      bodyText: 'var grecaptcha = window.grecaptcha || {};',
      url: 'https://example.com',
    });
    expect(result).not.toBeNull();
    expect(result?.family).toBe('recaptcha');
    expect(result?.via).toBe('marker');
  });

  it('detects hcaptcha marker in body text as family=hcaptcha', () => {
    const result = detectChallenge({
      status: 200,
      title: '',
      bodyText: 'Please complete the hcaptcha to continue.',
      url: 'https://example.com',
    });
    expect(result).not.toBeNull();
    expect(result?.family).toBe('hcaptcha');
    expect(result?.via).toBe('marker');
  });

  it('detects generic captcha marker in body text', () => {
    const result = detectChallenge({
      status: 200,
      title: '',
      bodyText: 'Please solve this captcha to proceed.',
      url: 'https://example.com',
    });
    expect(result).not.toBeNull();
    expect(result?.family).toBe('generic');
  });

  it('does not match challenge markers buried past the 4k cap', () => {
    const body = `${'x'.repeat(5_000)} captcha`;
    expect(
      detectChallenge({ status: 200, title: '', bodyText: body, url: 'https://example.com' }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// False-positive guard — clean pages must not trigger detection
// ---------------------------------------------------------------------------

describe('detectChallenge — clean-page false-positive guard', () => {
  const cleanPages: Array<{ label: string; input: Parameters<typeof detectChallenge>[0] }> = [
    {
      label: 'Bing SERP',
      input: {
        status: 200,
        title: 'TypeScript tutorial - Search',
        bodyText: 'TypeScript is a typed superset of JavaScript...',
        url: 'https://www.bing.com/search?q=typescript+tutorial',
      },
    },
    {
      label: 'DuckDuckGo SERP',
      input: {
        status: 200,
        title: 'TypeScript tutorial at DuckDuckGo',
        bodyText: 'Web results for TypeScript tutorial. Result one. Result two.',
        url: 'https://html.duckduckgo.com/html/?q=typescript+tutorial',
      },
    },
    {
      label: 'Brave SERP',
      input: {
        status: 200,
        title: 'TypeScript tutorial - Brave Search',
        bodyText: 'Organic web results. TypeScript is a language for application-scale JS.',
        url: 'https://search.brave.com/search?q=typescript+tutorial',
      },
    },
    {
      label: 'Normal article page',
      input: {
        status: 200,
        title: 'TypeScript Handbook – The Basics',
        bodyText:
          'TypeScript is a language for application scale JavaScript development. It adds types.',
        url: 'https://www.typescriptlang.org/docs/handbook/2/basic-types.html',
      },
    },
    {
      label: 'GitHub page',
      input: {
        status: 200,
        title: 'microsoft/TypeScript: TypeScript is a superset of JavaScript',
        bodyText: 'TypeScript is a language for application scale JavaScript...',
        url: 'https://github.com/microsoft/TypeScript',
      },
    },
    {
      label: 'Wikipedia article',
      input: {
        status: 200,
        title: 'TypeScript - Wikipedia',
        bodyText:
          'TypeScript is a free and open source high-level programming language developed and maintained by Microsoft.',
        url: 'https://en.wikipedia.org/wiki/TypeScript',
      },
    },
    {
      label: 'News article',
      input: {
        status: 200,
        title: 'New features in TypeScript 5.0',
        bodyText: 'TypeScript 5.0 introduces several new features including const type parameters.',
        url: 'https://devblogs.microsoft.com/typescript/announcing-typescript-5-0/',
      },
    },
    {
      label: 'HTTP 404 page (not a challenge)',
      input: {
        status: 404,
        title: 'Page not found',
        bodyText: 'The page you requested could not be found.',
        url: 'https://example.com/missing',
      },
    },
    {
      label: 'HTTP 301 redirect (not a challenge)',
      input: {
        status: 301,
        title: '',
        bodyText: '',
        url: 'https://example.com/old-path',
      },
    },
    {
      label: 'E-commerce product page',
      input: {
        status: 200,
        title: 'Books to Scrape - Catalogue',
        bodyText: 'A Light in the Attic. Rating: Three. Price: £51.77. Add to basket.',
        url: 'https://books.toscrape.com/',
      },
    },
  ];

  for (const { label, input } of cleanPages) {
    it(`does not flag "${label}"`, () => {
      const result = detectChallenge(input);
      expect(result).toBeNull();
    });
  }

  it('has at most 1 false positive across the entire clean-page set', () => {
    // Re-run all clean pages and count false positives (guards regression).
    let count = 0;
    for (const { input } of cleanPages) {
      if (detectChallenge(input) !== null) count++;
    }
    expect(count).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// detectChallengeForEngine — engine-aware wrapper (used by search/engines.ts)
// ---------------------------------------------------------------------------

describe('detectChallengeForEngine', () => {
  it('passes normal SERP responses through', () => {
    expect(
      detectChallengeForEngine('bing', 200, 'query - Search', 'Result one\nResult two'),
    ).toBeNull();
    expect(
      detectChallengeForEngine('duckduckgo', 200, 'query at DuckDuckGo', 'results...'),
    ).toBeNull();
    expect(detectChallengeForEngine('brave', 200, 'query - Brave Search', 'results...')).toBeNull();
  });

  it('flags HTTP 403/429 on any engine', () => {
    expect(detectChallengeForEngine('bing', 403, '', '')).toMatch(/HTTP 403/);
    expect(detectChallengeForEngine('brave', 429, '', '')).toMatch(/HTTP 429/);
    expect(detectChallengeForEngine('duckduckgo', 403, '', '')).toMatch(/HTTP 403/);
  });

  it('flags HTTP 202 as a DuckDuckGo bot challenge (DDG only)', () => {
    expect(detectChallengeForEngine('duckduckgo', 202, '', '')).toMatch(/HTTP 202/);
    expect(detectChallengeForEngine('bing', 202, '', '')).toBeNull();
  });

  it('flags the DuckDuckGo anomaly modal body text', () => {
    const body = 'Unfortunately, bots use DuckDuckGo too. Please complete the following challenge.';
    expect(detectChallengeForEngine('duckduckgo', 200, 'DuckDuckGo', body)).toMatch(/anomaly/);
  });

  it('flags verify/CAPTCHA interstitials by title or body', () => {
    expect(detectChallengeForEngine('brave', 200, 'Verifying you are human', '')).toMatch(
      /challenge page/,
    );
    expect(
      detectChallengeForEngine('bing', 200, '', 'Please solve this CAPTCHA to continue'),
    ).toMatch(/captcha/);
    expect(
      detectChallengeForEngine('bing', 200, '', 'We detected unusual traffic from your network'),
    ).toMatch(/unusual traffic/);
  });

  it('only inspects the capped head of the body text', () => {
    const body = `${'x'.repeat(5_000)} captcha`;
    expect(detectChallengeForEngine('bing', 200, '', body)).toBeNull();
  });
});
