import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunSpec, RunStore, StepRecord } from '../contracts.js';
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

function makeStep(index: number, overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    index,
    url: 'https://example.com/page',
    title: 'Example',
    thought: `thinking about step ${index}`,
    action: { tool: 'click', input: { ref: `e${index}` } },
    observation: 'clicked',
    startedAt: 1_700_000_000_000 + index,
    durationMs: 42,
    ...overrides,
  };
}

describe('createRunStore', () => {
  let dir: string;
  let store: RunStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sortie-store-'));
    store = createRunStore(join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('createRun / getRun round trip', () => {
    it('persists the full spec (JSON column) and initial lifecycle fields', () => {
      const spec = makeSpec({
        kind: 'agent',
        goal: 'buy a book',
        maxSteps: 7,
        credentialNames: ['SHOP_PASSWORD'],
        storageStatePath: '/tmp/state.json',
      });
      const created = store.createRun(spec, 'batch-1');

      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.status).toBe('queued');
      expect(created.batchId).toBe('batch-1');
      expect(created.attempts).toBe(0);
      expect(created.createdAt).toBeGreaterThan(0);

      const fetched = store.getRun(created.id);
      expect(fetched).toEqual(created);
      expect(fetched?.spec).toEqual(spec);
      expect(fetched?.startedAt).toBeUndefined();
      expect(fetched?.output).toBeUndefined();
      expect(fetched?.usage).toBeUndefined();
    });

    it('returns undefined for unknown ids', () => {
      expect(store.getRun('does-not-exist')).toBeUndefined();
    });
  });

  describe('updateRun', () => {
    it('round-trips lifecycle patches including JSON output and usage columns', () => {
      const { id } = store.createRun(makeSpec());

      store.updateRun(id, { status: 'running', startedAt: 123, attempts: 1 });
      const output = { books: [{ title: 'A Light in the Attic', price: '£51.77' }] };
      const finished = store.updateRun(id, {
        status: 'success',
        finishedAt: 456,
        output,
        usage: { inputTokens: 10, outputTokens: 20 },
        finalUrl: 'https://books.toscrape.com/index.html',
      });

      expect(finished.status).toBe('success');
      const fetched = store.getRun(id);
      expect(fetched?.status).toBe('success');
      expect(fetched?.attempts).toBe(1);
      expect(fetched?.startedAt).toBe(123);
      expect(fetched?.finishedAt).toBe(456);
      expect(fetched?.output).toEqual(output);
      expect(fetched?.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
      expect(fetched?.finalUrl).toBe('https://books.toscrape.com/index.html');
      // The spec is immutable and survives updates intact.
      expect(fetched?.spec).toEqual(makeSpec());
    });

    it('treats undefined patch fields as unchanged but persists explicit null output', () => {
      const { id } = store.createRun(makeSpec());
      store.updateRun(id, { status: 'running', startedAt: 99 });
      const after = store.updateRun(id, { status: 'success', output: null });

      expect(after.startedAt).toBe(99); // untouched by the second patch
      expect(store.getRun(id)?.output).toBeNull();
    });

    it('throws on unknown run ids', () => {
      expect(() => store.updateRun('nope', { status: 'running' })).toThrow(/no run with id "nope"/);
    });
  });

  describe('listRuns / countRuns', () => {
    it('filters by batchId and status, newest first, with limit and offset', () => {
      const a1 = store.createRun(makeSpec(), 'batch-a');
      const a2 = store.createRun(makeSpec(), 'batch-a');
      const b1 = store.createRun(makeSpec(), 'batch-b');
      const loose = store.createRun(makeSpec());
      store.updateRun(a2.id, { status: 'success' });
      store.updateRun(b1.id, { status: 'failed' });

      // Newest first overall.
      expect(store.listRuns().map((r) => r.id)).toEqual([loose.id, b1.id, a2.id, a1.id]);

      // batchId filter.
      expect(store.listRuns({ batchId: 'batch-a' }).map((r) => r.id)).toEqual([a2.id, a1.id]);

      // status filter.
      expect(store.listRuns({ status: 'queued' }).map((r) => r.id)).toEqual([loose.id, a1.id]);

      // Combined filters.
      expect(store.listRuns({ batchId: 'batch-a', status: 'success' }).map((r) => r.id)).toEqual([
        a2.id,
      ]);

      // limit + offset paginate the newest-first ordering.
      expect(store.listRuns({ limit: 2 }).map((r) => r.id)).toEqual([loose.id, b1.id]);
      expect(store.listRuns({ limit: 2, offset: 2 }).map((r) => r.id)).toEqual([a2.id, a1.id]);

      expect(store.countRuns()).toBe(4);
      expect(store.countRuns({ batchId: 'batch-a' })).toBe(2);
      expect(store.countRuns({ status: 'failed' })).toBe(1);
      expect(store.countRuns({ batchId: 'batch-b', status: 'queued' })).toBe(0);
    });
  });

  describe('appendStep / getSteps', () => {
    it('round-trips StepRecords ordered by index regardless of append order', () => {
      const { id } = store.createRun(makeSpec({ kind: 'agent', goal: 'g' }));
      const s0 = makeStep(0);
      const s1 = makeStep(1, { action: { tool: 'type', input: { ref: 'e2', text: 'hi' } } });
      const s2 = makeStep(2, { observation: 'done' });

      store.appendStep(id, s2);
      store.appendStep(id, s0);
      store.appendStep(id, s1);

      expect(store.getSteps(id)).toEqual([s0, s1, s2]);
    });

    it('returns an empty array for runs without steps', () => {
      const { id } = store.createRun(makeSpec());
      expect(store.getSteps(id)).toEqual([]);
    });

    it('replaces a step re-appended at the same index (retry idempotency)', () => {
      const { id } = store.createRun(makeSpec({ kind: 'agent', goal: 'g' }));
      store.appendStep(id, makeStep(0, { observation: 'first attempt' }));
      store.appendStep(id, makeStep(0, { observation: 'second attempt' }));

      const steps = store.getSteps(id);
      expect(steps).toHaveLength(1);
      expect(steps[0]?.observation).toBe('second attempt');
    });
  });
});
