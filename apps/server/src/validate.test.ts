import { describe, expect, it } from 'vitest';
import { parseListQuery, readQueryParam, toRunSpec, validateRunSpec } from './validate.js';

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
        storageStatePath: '/tmp/state.json',
        instruction: undefined,
      }),
    ).toEqual([]);
  });

  it('rejects non-object bodies', () => {
    expect(validateRunSpec(null)).toEqual(['spec must be a JSON object']);
    expect(validateRunSpec([])).toEqual(['spec must be a JSON object']);
    expect(validateRunSpec('extract')).toEqual(['spec must be a JSON object']);
  });

  it('rejects an unknown kind and a missing url', () => {
    const errors = validateRunSpec({ kind: 'bogus' });
    expect(errors).toContain('kind must be "extract" or "agent" (got "bogus")');
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
    expect(Object.keys(spec).sort()).toEqual(['goal', 'kind', 'url']);
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
    });
    expect(errors).toEqual([]);
    expect(opts).toEqual({ limit: 20, offset: 40, status: 'success', batchId: 'batch-1' });
  });

  it('returns empty options for an empty query', () => {
    expect(parseListQuery({})).toEqual({ opts: {}, errors: [] });
  });

  it('rejects non-integer limit, negative offset, and unknown status', () => {
    const { errors } = parseListQuery({ limit: '1.5', offset: '-1', status: 'done' });
    expect(errors).toEqual([
      'limit must be a positive integer',
      'offset must be a non-negative integer',
      'status must be one of queued|running|success|failed|max_steps|cancelled',
    ]);
  });
});
