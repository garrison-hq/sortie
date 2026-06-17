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
// Type alias for detectChallenge's input shape
// ---------------------------------------------------------------------------

type DetectInput = Parameters<typeof detectChallenge>[0];

// ---------------------------------------------------------------------------
// Factory: build a DetectInput with sensible defaults for the common case
// ---------------------------------------------------------------------------

/** Build a DetectInput, defaulting status=200 and url='https://example.com'. */
function mkInput(
  overrides: Partial<DetectInput> & Pick<DetectInput, 'title' | 'bodyText'>,
): DetectInput {
  return {
    status: 200,
    url: 'https://example.com',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// HTTP status detection — table-driven
// ---------------------------------------------------------------------------

describe('detectChallenge — HTTP status detection', () => {
  it.each([
    {
      label: 'HTTP 403',
      input: { status: 403, title: '', bodyText: '', url: '' } satisfies DetectInput,
      family: 'http',
      via: 'http',
      signalPattern: /403/,
    },
    {
      label: 'HTTP 429',
      input: { status: 429, title: '', bodyText: '', url: '' } satisfies DetectInput,
      family: 'http',
      via: 'http',
      signalPattern: /429/,
    },
  ])('flags $label as family=http via=http', ({ input, family, via, signalPattern }) => {
    const result = detectChallenge(input);
    expect(result).not.toBeNull();
    expect(result?.family).toBe(family);
    expect(result?.via).toBe(via);
    expect(result?.signal).toMatch(signalPattern);
    expect(result?.detected).toBe(true);
  });

  it('does not flag HTTP 200 on an empty page', () => {
    expect(detectChallenge({ status: 200, title: '', bodyText: '', url: '' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Frame-based detection — table-driven
// ---------------------------------------------------------------------------

describe('detectChallenge — frame-based detection', () => {
  it.each([
    {
      label: 'reCAPTCHA via google.com/recaptcha frame',
      input: mkInput({
        title: 'Example',
        bodyText: 'Please wait',
        frameUrls: ['https://www.google.com/recaptcha/api2/anchor?ar=1'],
      }),
      family: 'recaptcha',
      via: 'frame',
    },
    {
      label: 'reCAPTCHA via recaptcha.net frame',
      input: mkInput({
        title: 'Example',
        bodyText: '',
        frameUrls: ['https://recaptcha.net/recaptcha/api2/anchor'],
      }),
      family: 'recaptcha',
      via: 'frame',
    },
    {
      label: 'hCaptcha via hcaptcha.com frame',
      input: mkInput({
        title: 'Example',
        bodyText: '',
        frameUrls: ['https://newassets.hcaptcha.com/captcha/v1/123/frame'],
      }),
      family: 'hcaptcha',
      via: 'frame',
    },
    {
      label: 'Cloudflare Turnstile via challenges.cloudflare.com frame',
      input: mkInput({
        title: 'Just a moment...',
        bodyText: '',
        frameUrls: ['https://challenges.cloudflare.com/turnstile/v0/api.js'],
      }),
      family: 'turnstile',
      via: 'frame',
    },
  ])('detects $label', ({ input, family, via }) => {
    const result = detectChallenge(input);
    expect(result).not.toBeNull();
    expect(result?.family).toBe(family);
    expect(result?.via).toBe(via);
  });
});

// ---------------------------------------------------------------------------
// Content-based detection — table-driven
// ---------------------------------------------------------------------------

describe('detectChallenge — content-based detection', () => {
  it.each([
    {
      label: 'Cloudflare interstitial via "cf-chl" body marker',
      input: mkInput({ title: 'Just a moment', bodyText: 'cf-chl-widget-xyz Checking browser…' }),
      family: 'cloudflare',
      via: 'content' as const,
    },
    {
      label: 'Cloudflare interstitial via "checking your browser" body marker',
      input: mkInput({
        title: 'Just a moment',
        bodyText: 'Checking your browser before accessing...',
      }),
      family: 'cloudflare',
      via: null,
    },
    {
      label: 'Cloudflare interstitial via "just a moment" body marker',
      input: mkInput({ title: '', bodyText: 'Just a moment... Please stand by' }),
      family: 'cloudflare',
      via: null,
    },
    {
      label: 'generic "verify you are human" interstitial',
      input: mkInput({ title: 'Verify you are human', bodyText: '' }),
      family: 'generic',
      via: 'marker' as const,
    },
    {
      label: 'generic "are you a robot" interstitial',
      input: mkInput({ title: 'Are you a robot?', bodyText: '' }),
      family: 'generic',
      via: null,
    },
    {
      label: 'generic "unusual traffic" block page',
      input: mkInput({ title: 'Our systems have detected unusual traffic', bodyText: '' }),
      family: 'generic',
      via: null,
    },
    {
      label: 'reCAPTCHA marker in body text',
      input: mkInput({ title: '', bodyText: 'var grecaptcha = window.grecaptcha || {};' }),
      family: 'recaptcha',
      via: 'marker' as const,
    },
    {
      label: 'hcaptcha marker in body text',
      input: mkInput({ title: '', bodyText: 'Please complete the hcaptcha to continue.' }),
      family: 'hcaptcha',
      via: 'marker' as const,
    },
    {
      label: 'generic captcha marker in body text',
      input: mkInput({ title: '', bodyText: 'Please solve this captcha to proceed.' }),
      family: 'generic',
      via: null,
    },
  ])('detects $label as family=$family', ({ input, family, via }) => {
    const result = detectChallenge(input);
    expect(result).not.toBeNull();
    expect(result?.family).toBe(family);
    if (via !== null) {
      expect(result?.via).toBe(via);
    }
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
  const cleanPages: Array<{ label: string; input: DetectInput }> = [
    {
      label: 'Bing SERP',
      input: mkInput({
        title: 'TypeScript tutorial - Search',
        bodyText: 'TypeScript is a typed superset of JavaScript...',
        url: 'https://www.bing.com/search?q=typescript+tutorial',
      }),
    },
    {
      label: 'DuckDuckGo SERP',
      input: mkInput({
        title: 'TypeScript tutorial at DuckDuckGo',
        bodyText: 'Web results for TypeScript tutorial. Result one. Result two.',
        url: 'https://html.duckduckgo.com/html/?q=typescript+tutorial',
      }),
    },
    {
      label: 'Brave SERP',
      input: mkInput({
        title: 'TypeScript tutorial - Brave Search',
        bodyText: 'Organic web results. TypeScript is a language for application-scale JS.',
        url: 'https://search.brave.com/search?q=typescript+tutorial',
      }),
    },
    {
      label: 'Normal article page',
      input: mkInput({
        title: 'TypeScript Handbook – The Basics',
        bodyText:
          'TypeScript is a language for application scale JavaScript development. It adds types.',
        url: 'https://www.typescriptlang.org/docs/handbook/2/basic-types.html',
      }),
    },
    {
      label: 'GitHub page',
      input: mkInput({
        title: 'microsoft/TypeScript: TypeScript is a superset of JavaScript',
        bodyText: 'TypeScript is a language for application scale JavaScript...',
        url: 'https://github.com/microsoft/TypeScript',
      }),
    },
    {
      label: 'Wikipedia article',
      input: mkInput({
        title: 'TypeScript - Wikipedia',
        bodyText:
          'TypeScript is a free and open source high-level programming language developed and maintained by Microsoft.',
        url: 'https://en.wikipedia.org/wiki/TypeScript',
      }),
    },
    {
      label: 'News article',
      input: mkInput({
        title: 'New features in TypeScript 5.0',
        bodyText: 'TypeScript 5.0 introduces several new features including const type parameters.',
        url: 'https://devblogs.microsoft.com/typescript/announcing-typescript-5-0/',
      }),
    },
    {
      label: 'HTTP 404 page (not a challenge)',
      input: mkInput({
        status: 404,
        title: 'Page not found',
        bodyText: 'The page you requested could not be found.',
        url: 'https://example.com/missing',
      }),
    },
    {
      label: 'HTTP 301 redirect (not a challenge)',
      input: mkInput({ status: 301, title: '', bodyText: '', url: 'https://example.com/old-path' }),
    },
    {
      label: 'E-commerce product page',
      input: mkInput({
        title: 'Books to Scrape - Catalogue',
        bodyText: 'A Light in the Attic. Rating: Three. Price: £51.77. Add to basket.',
        url: 'https://books.toscrape.com/',
      }),
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
