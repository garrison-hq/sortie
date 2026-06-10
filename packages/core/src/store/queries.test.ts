import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunSpec, RunStore } from '../contracts.js';
import { buildQueryRunSpec, prepareSavedQueryRun } from './queries.js';
import { createRunStore } from './store.js';

function makeSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    kind: 'extract',
    url: 'https://books.toscrape.com/',
    schemaJson: {
      type: 'object',
      properties: { books: { type: 'array', items: { type: 'object' } } },
      required: ['books'],
    },
    instruction: 'the product list',
    ...overrides,
  };
}

describe('saved queries', () => {
  let dir: string;
  let store: RunStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nanofish-queries-'));
    store = createRunStore(join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('createQuery / getQuery / listQueries / deleteQuery', () => {
    it('round-trips the full spec and initializes run stats', () => {
      const spec = makeSpec();
      const created = store.createQuery('books', spec);

      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.name).toBe('books');
      expect(created.spec).toEqual(spec);
      expect(created.runCount).toBe(0);
      expect(created.lastRunAt).toBeUndefined();
      expect(created.createdAt).toBeGreaterThan(0);
      expect(created.updatedAt).toBe(created.createdAt);

      expect(store.getQuery('books')).toEqual(created);
      expect(store.getQuery('nope')).toBeUndefined();
    });

    it('lists queries sorted by name', () => {
      store.createQuery('zebra', makeSpec());
      store.createQuery('alpha', makeSpec());
      expect(store.listQueries().map((q) => q.name)).toEqual(['alpha', 'zebra']);
    });

    it('rejects duplicate names with a clear error', () => {
      store.createQuery('books', makeSpec());
      expect(() => store.createQuery('books', makeSpec())).toThrow(/"books" already exists/);
    });

    it('rejects non-slug names (path-traversal gate)', () => {
      for (const name of ['../evil', 'UPPER', 'a/b', '']) {
        expect(() => store.createQuery(name, makeSpec()), name).toThrow(/invalid query name/);
      }
    });

    it('restricts saved queries to extract specs (v1)', () => {
      expect(() => store.createQuery('agentish', makeSpec({ kind: 'agent', goal: 'g' }))).toThrow(
        /only extract specs/,
      );
    });

    it('deleteQuery removes the row and reports whether it existed', () => {
      store.createQuery('books', makeSpec());
      expect(store.deleteQuery('books')).toBe(true);
      expect(store.getQuery('books')).toBeUndefined();
      expect(store.deleteQuery('books')).toBe(false);
    });
  });

  describe('updateQuery', () => {
    it('replaces the spec and bumps updatedAt, preserving identity and stats', () => {
      const created = store.createQuery('books', makeSpec());
      store.recordQueryRun('books');

      const nextSpec = makeSpec({ url: 'https://books.toscrape.com/catalogue/page-2.html' });
      const updated = store.updateQuery('books', nextSpec);

      expect(updated.id).toBe(created.id);
      expect(updated.spec).toEqual(nextSpec);
      expect(updated.runCount).toBe(1);
      expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
      expect(store.getQuery('books')?.spec).toEqual(nextSpec);
    });

    it('throws on unknown names and non-extract specs', () => {
      expect(() => store.updateQuery('nope', makeSpec())).toThrow(/no query named "nope"/);
      store.createQuery('books', makeSpec());
      expect(() => store.updateQuery('books', makeSpec({ kind: 'agent', goal: 'g' }))).toThrow(
        /only extract specs/,
      );
    });
  });

  describe('recordQueryRun', () => {
    it('increments runCount and stamps lastRunAt', () => {
      store.createQuery('books', makeSpec());
      store.recordQueryRun('books');
      store.recordQueryRun('books');

      const query = store.getQuery('books');
      expect(query?.runCount).toBe(2);
      expect(query?.lastRunAt).toBeGreaterThan(0);
    });
  });

  describe('buildQueryRunSpec / prepareSavedQueryRun', () => {
    it('stamps queryName and applies url/instruction overrides', () => {
      const query = store.createQuery('books', makeSpec());

      expect(buildQueryRunSpec(query)).toEqual({ ...makeSpec(), queryName: 'books' });

      const overridden = buildQueryRunSpec(query, {
        url: 'https://books.toscrape.com/catalogue/page-2.html',
        instruction: 'only titles',
      });
      expect(overridden.url).toBe('https://books.toscrape.com/catalogue/page-2.html');
      expect(overridden.instruction).toBe('only titles');
      expect(overridden.queryName).toBe('books');
      // The saved spec itself is untouched.
      expect(store.getQuery('books')?.spec).toEqual(makeSpec());
    });

    it('prepareSavedQueryRun bumps run stats and returns the replay spec', () => {
      store.createQuery('books', makeSpec());

      const spec = prepareSavedQueryRun(store, 'books', { url: 'https://example.com/' });
      expect(spec.url).toBe('https://example.com/');
      expect(spec.queryName).toBe('books');
      expect(store.getQuery('books')?.runCount).toBe(1);
    });

    it('prepareSavedQueryRun throws on unknown names', () => {
      expect(() => prepareSavedQueryRun(store, 'nope')).toThrow(/No saved query named "nope"/);
    });
  });

  describe('listRuns / countRuns queryName filter', () => {
    it('filters runs by spec.queryName via json_extract', () => {
      const replay1 = store.createRun(
        prepareSavedQueryRun(store, store.createQuery('books', makeSpec()).name),
      );
      const replay2 = store.createRun(prepareSavedQueryRun(store, 'books'));
      store.createRun(makeSpec()); // plain run, no queryName

      expect(store.listRuns({ queryName: 'books' }).map((r) => r.id)).toEqual([
        replay2.id,
        replay1.id,
      ]);
      expect(store.listRuns({ queryName: 'other' })).toEqual([]);
      expect(store.listRuns()).toHaveLength(3);

      expect(store.countRuns({ queryName: 'books' })).toBe(2);
      expect(store.countRuns({ queryName: 'other' })).toBe(0);
      expect(store.countRuns()).toBe(3);
    });
  });
});
