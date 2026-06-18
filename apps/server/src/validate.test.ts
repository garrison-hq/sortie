import { describe, expect, it } from 'vitest';
import {
  parseListQuery,
  readQueryParam,
  toQueryRunOverrides,
  toRunSpec,
  validateFetchBody,
  validateProfileImportBody,
  validateQueryBody,
  validateQueryRunBody,
  validateRunSpec,
  validateSearchBody,
} from './validate.js';

describe('validateRunSpec', () => {
  it('accepts a minimal extract spec', () => {
    expect(
      validateRunSpec({
        kind: 'extract',
        url: 'https://books.toscrape.com',
        schemaJson: { type: 'object' },
      }),
    ).toEqual([]);
  });

  it('accepts a full agent spec', () => {
    expect(
      validateRunSpec({
        kind: 'agent',
        url: 'https://the-internet.herokuapp.com/login',
        goal: 'log in',
        maxSteps: 10,
        credentialNames: ['DEMO_USER', 'DEMO_PASS'],
        storageStatePath: 'state.json',
        instruction: undefined,
      }),
    ).toEqual([]);
  });

  it('rejects non-object bodies', () => {
    expect(validateRunSpec(null)).toEqual(['spec must be a JSON object']);
    expect(validateRunSpec([])).toEqual(['spec must be a JSON object']);
    expect(validateRunSpec('extract')).toEqual(['spec must be a JSON object']);
  });

  it('accepts a fetch spec without schemaJson or goal', () => {
    expect(
      validateRunSpec({ kind: 'fetch', url: 'https://example.com', maxChars: 10_000 }),
    ).toEqual([]);
  });

  it('rejects an unknown kind and a missing url', () => {
    const errors = validateRunSpec({ kind: 'bogus' });
    expect(errors).toContain('kind must be one of extract|agent|fetch (got "bogus")');
    expect(errors).toContain('url must be a non-empty string');
  });

  it('requires schemaJson for extract specs', () => {
    const errors = validateRunSpec({ kind: 'extract', url: 'https://example.com' });
    expect(errors).toEqual([
      'schemaJson (a JSON Schema object) is required when kind is "extract"',
    ]);
  });

  it('requires a non-empty goal for agent specs', () => {
    const errors = validateRunSpec({ kind: 'agent', url: 'https://example.com', goal: '  ' });
    expect(errors).toEqual(['goal (non-empty string) is required when kind is "agent"']);
  });

  it('rejects bad optional fields', () => {
    const errors = validateRunSpec({
      kind: 'agent',
      url: 'https://example.com',
      goal: 'go',
      maxSteps: 0,
      credentialNames: ['OK', ''],
      instruction: 42,
      storageStatePath: 7,
    });
    expect(errors).toContain('maxSteps must be a positive integer when present');
    expect(errors).toContain(
      'credentialNames must be an array of non-empty strings (env var NAMES) when present',
    );
    expect(errors).toContain('instruction must be a string when present');
    expect(errors).toContain('storageStatePath must be a string when present');
  });

  it('accepts a valid profile slug', () => {
    expect(
      validateRunSpec({
        kind: 'agent',
        url: 'https://www.saucedemo.com/inventory.html',
        goal: 'list inventory',
        profile: 'sauce',
      }),
    ).toEqual([]);
  });

  it('rejects non-slug profiles (path-traversal defense)', () => {
    for (const profile of ['../etc/passwd', 'Sauce', 'a b', '']) {
      expect(
        validateRunSpec({ kind: 'agent', url: 'https://x.test', goal: 'go', profile }),
      ).toEqual(['profile must be a slug ([a-z0-9][a-z0-9_-]{0,63}) when present']);
    }
  });

  it('rejects profile + storageStatePath together', () => {
    const errors = validateRunSpec({
      kind: 'agent',
      url: 'https://x.test',
      goal: 'go',
      profile: 'sauce',
      storageStatePath: 'state.json',
    });
    expect(errors).toEqual([
      'profile and storageStatePath are mutually exclusive — set one or the other',
    ]);
  });

  it('rejects bad queryName and maxChars', () => {
    const errors = validateRunSpec({
      kind: 'fetch',
      url: 'https://x.test',
      queryName: 42,
      maxChars: -1,
    });
    expect(errors).toEqual([
      'queryName must be a string when present',
      'maxChars must be a positive integer when present',
    ]);
  });
});

describe('toRunSpec', () => {
  it('copies only contract fields, dropping unknown junk', () => {
    const spec = toRunSpec({
      kind: 'extract',
      url: 'https://books.toscrape.com',
      schemaJson: { type: 'object' },
      instruction: 'the book list',
      junk: 'nope',
      __proto__pollution: true,
    });
    expect(spec).toEqual({
      kind: 'extract',
      url: 'https://books.toscrape.com',
      schemaJson: { type: 'object' },
      instruction: 'the book list',
    });
  });

  it('omits optional fields that are absent or mistyped', () => {
    const spec = toRunSpec({ kind: 'agent', url: 'https://example.com', goal: 'go' });
    expect(Object.keys(spec).sort((a, b) => a.localeCompare(b))).toEqual(['goal', 'kind', 'url']);
  });

  it('copies profile, queryName, and maxChars', () => {
    const spec = toRunSpec({
      kind: 'fetch',
      url: 'https://example.com',
      profile: 'sauce',
      queryName: 'books',
      maxChars: 5000,
    });
    expect(spec).toEqual({
      kind: 'fetch',
      url: 'https://example.com',
      profile: 'sauce',
      queryName: 'books',
      maxChars: 5000,
    });
  });
});

describe('readQueryParam', () => {
  it('returns single string values', () => {
    const errors: string[] = [];
    expect(readQueryParam({ status: 'queued' }, 'status', errors)).toBe('queued');
    expect(errors).toEqual([]);
  });

  it('reports repeated and empty params', () => {
    const errors: string[] = [];
    expect(readQueryParam({ status: ['a', 'b'] }, 'status', errors)).toBeUndefined();
    expect(readQueryParam({ batch: '' }, 'batch', errors)).toBeUndefined();
    expect(errors).toEqual([
      'status must be a single non-empty value',
      'batch must be a single non-empty value',
    ]);
  });
});

describe('parseListQuery', () => {
  it('parses a full valid query', () => {
    const { opts, errors } = parseListQuery({
      limit: '20',
      offset: '40',
      status: 'success',
      batch: 'batch-1',
      query: 'books',
    });
    expect(errors).toEqual([]);
    expect(opts).toEqual({
      limit: 20,
      offset: 40,
      status: 'success',
      batchId: 'batch-1',
      queryName: 'books',
    });
  });

  it('returns empty options for an empty query', () => {
    expect(parseListQuery({})).toEqual({ opts: {}, errors: [] });
  });

  it('rejects non-integer limit, negative offset, and unknown status', () => {
    const { errors } = parseListQuery({ limit: '1.5', offset: '-1', status: 'done' });
    expect(errors).toEqual([
      'limit must be a positive integer',
      'offset must be a non-negative integer',
      'status must be one of queued|running|awaiting_human|success|failed|max_steps|cancelled',
    ]);
  });

  it('M-2: awaiting_human is a valid status filter (RUN_STATUSES includes it)', () => {
    const { opts, errors } = parseListQuery({ status: 'awaiting_human' });
    expect(errors).toEqual([]);
    expect(opts.status).toBe('awaiting_human');
  });
});

describe('validateQueryBody', () => {
  const extractSpec = {
    kind: 'extract',
    url: 'https://books.toscrape.com',
    schemaJson: { type: 'object' },
  };

  it('accepts a valid {name, spec} body', () => {
    expect(validateQueryBody({ name: 'books', spec: extractSpec })).toEqual([]);
  });

  it('skips the name check when the name comes from the path', () => {
    expect(validateQueryBody({ spec: extractSpec }, true)).toEqual([]);
  });

  it('rejects non-object bodies, non-slug names, and missing specs', () => {
    expect(validateQueryBody(null)).toEqual(['body must be a JSON object']);
    expect(validateQueryBody({ name: '../oops', spec: extractSpec })).toEqual([
      'name must be a slug ([a-z0-9][a-z0-9_-]{0,63})',
    ]);
    expect(validateQueryBody({ name: 'books' })).toEqual(['spec must be a JSON object']);
  });

  it('rejects non-extract specs and surfaces nested spec problems', () => {
    expect(
      validateQueryBody({ name: 'go', spec: { kind: 'agent', url: 'https://x.test', goal: 'go' } }),
    ).toEqual(['spec: only extract specs can be saved as queries']);
    expect(validateQueryBody({ name: 'books', spec: { ...extractSpec, url: '' } })).toEqual([
      'spec: url must be a non-empty string',
    ]);
  });
});

describe('validateQueryRunBody / toQueryRunOverrides', () => {
  it('accepts an absent or empty body', () => {
    expect(validateQueryRunBody(undefined)).toEqual([]);
    expect(validateQueryRunBody(null)).toEqual([]);
    expect(validateQueryRunBody({})).toEqual([]);
  });

  it('accepts url and instruction overrides', () => {
    expect(
      validateQueryRunBody({ url: 'https://books.toscrape.com/page-2.html', instruction: 'x' }),
    ).toEqual([]);
  });

  it('rejects non-object bodies and mistyped overrides', () => {
    expect(validateQueryRunBody('books')).toEqual(['body must be a JSON object when present']);
    expect(validateQueryRunBody({ url: ' ', instruction: 7 })).toEqual([
      'url must be a non-empty string when present',
      'instruction must be a string when present',
    ]);
  });

  it('builds overrides from validated bodies only', () => {
    expect(toQueryRunOverrides(undefined)).toEqual({});
    expect(toQueryRunOverrides({ url: 'https://x.test', instruction: 'y', junk: 1 })).toEqual({
      url: 'https://x.test',
      instruction: 'y',
    });
  });
});

describe('validateProfileImportBody', () => {
  const state = {
    cookies: [{ name: 'session', value: 's3cret', domain: '.saucedemo.com', expires: -1 }],
    origins: [],
  };

  it('accepts a valid import body', () => {
    expect(
      validateProfileImportBody({ name: 'sauce', state, domainHint: 'saucedemo.com', notes: 'n' }),
    ).toEqual([]);
  });

  it('accepts a state without cookies', () => {
    expect(validateProfileImportBody({ name: 'sauce', state: { origins: [] } })).toEqual([]);
  });

  it('rejects non-slug names and malformed state', () => {
    expect(validateProfileImportBody(null)).toEqual(['body must be a JSON object']);
    expect(validateProfileImportBody({ name: '../sauce', state })).toEqual([
      'name must be a slug ([a-z0-9][a-z0-9_-]{0,63})',
    ]);
    expect(validateProfileImportBody({ name: 'sauce', state: 'cookies' })).toEqual([
      'state must be a Playwright storage-state JSON object',
    ]);
    expect(validateProfileImportBody({ name: 'sauce', state: { cookies: [{}] } })).toEqual([
      'state.cookies must be an array of cookie objects (domain, expires)',
    ]);
  });

  it('rejects mistyped domainHint and notes', () => {
    expect(validateProfileImportBody({ name: 'sauce', state, domainHint: 1, notes: [] })).toEqual([
      'domainHint must be a string when present',
      'notes must be a string when present',
    ]);
  });
});

describe('validateSearchBody', () => {
  it('accepts a minimal and a full body', () => {
    expect(validateSearchBody({ query: 'attention is all you need' })).toEqual([]);
    expect(
      validateSearchBody({ query: 'x', maxResults: 5, engines: ['bing', 'duckduckgo'] }),
    ).toEqual([]);
  });

  it('rejects missing query, bad maxResults, and unknown engines', () => {
    expect(validateSearchBody(null)).toEqual(['body must be a JSON object']);
    expect(validateSearchBody({ query: '  ' })).toEqual(['query must be a non-empty string']);
    expect(validateSearchBody({ query: 'x', maxResults: 0, engines: ['google'] })).toEqual([
      'maxResults must be a positive integer when present',
      'engines must be a non-empty array of bing|duckduckgo|brave when present',
    ]);
    expect(validateSearchBody({ query: 'x', engines: [] })).toEqual([
      'engines must be a non-empty array of bing|duckduckgo|brave when present',
    ]);
  });
});

describe('validateFetchBody', () => {
  it('accepts a minimal and a full body', () => {
    expect(validateFetchBody({ url: 'https://example.com' })).toEqual([]);
    expect(
      validateFetchBody({ url: 'https://example.com', maxChars: 10_000, includeLinks: true }),
    ).toEqual([]);
  });

  it('rejects missing url, bad maxChars, and mistyped includeLinks', () => {
    expect(validateFetchBody(null)).toEqual(['body must be a JSON object']);
    expect(validateFetchBody({ url: '', maxChars: 1.5, includeLinks: 'yes' })).toEqual([
      'url must be a non-empty string',
      'maxChars must be a positive integer when present',
      'includeLinks must be a boolean when present',
    ]);
  });

  it('rejects non-absolute and non-http(s) urls', () => {
    expect(validateFetchBody({ url: 'not-a-url' })).toEqual([
      'url must be an absolute http(s) URL',
    ]);
    expect(validateFetchBody({ url: 'ftp://example.com/file' })).toEqual([
      'url must be an absolute http(s) URL',
    ]);
  });
});
