import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunSpec, RunStore } from '../contracts.js';
import { createRunStore } from './store.js';

function makeSpec(url: string, overrides: Partial<RunSpec> = {}): RunSpec {
  return { kind: 'extract', url, schemaJson: { type: 'object' }, ...overrides };
}

/** Create a finished run and return its id. */
function finishedRun(
  store: RunStore,
  url: string,
  status: 'success' | 'failed' | 'max_steps',
  output?: unknown,
  batchId?: string,
): string {
  const { id } = store.createRun(makeSpec(url), batchId);
  store.updateRun(id, {
    status,
    finishedAt: 1_700_000_000_000,
    output,
    failureReason: status === 'success' ? undefined : `reason for ${status}`,
    usage: { inputTokens: 1, outputTokens: 2 },
  });
  return id;
}

describe('RunStore.exportRuns', () => {
  let dir: string;
  let store: RunStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nanofish-export-'));
    store = createRunStore(join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('json format', () => {
    it('exports only finished runs with output, usage, and failure details', () => {
      const okId = finishedRun(store, 'https://a.com/1', 'success', { value: 7 });
      const failId = finishedRun(store, 'https://a.com/2', 'failed');
      store.createRun(makeSpec('https://a.com/3')); // still queued: excluded

      const parsed = JSON.parse(store.exportRuns({ format: 'json' })) as Array<
        Record<string, unknown>
      >;
      expect(parsed.map((r) => r.id)).toEqual([okId, failId]);
      expect(parsed[0]).toMatchObject({
        id: okId,
        url: 'https://a.com/1',
        kind: 'extract',
        status: 'success',
        output: { value: 7 },
        usage: { inputTokens: 1, outputTokens: 2 },
        finishedAt: 1_700_000_000_000,
      });
      expect(parsed[1]).toMatchObject({ status: 'failed', failureReason: 'reason for failed' });
    });

    it('filters by batchId and runIds', () => {
      const inBatch = finishedRun(store, 'https://a.com', 'success', { x: 1 }, 'batch-1');
      finishedRun(store, 'https://b.com', 'success', { x: 2 }, 'batch-2');
      const stray = finishedRun(store, 'https://c.com', 'success', { x: 3 });

      const byBatch = JSON.parse(
        store.exportRuns({ format: 'json', batchId: 'batch-1' }),
      ) as Array<{ id: string }>;
      expect(byBatch.map((r) => r.id)).toEqual([inBatch]);

      const byIds = JSON.parse(store.exportRuns({ format: 'json', runIds: [stray] })) as Array<{
        id: string;
      }>;
      expect(byIds.map((r) => r.id)).toEqual([stray]);
    });
  });

  describe('csv format — flattened (all outputs have a single array-of-objects field)', () => {
    it('emits one row per array item with a first-seen union of item keys', () => {
      const id1 = finishedRun(store, 'https://a.com', 'success', {
        books: [
          { title: 'One', price: 1 },
          { title: 'Two', price: 2, inStock: true },
        ],
      });
      const id2 = finishedRun(store, 'https://b.com', 'success', {
        books: [{ title: 'Three', rating: 5 }],
      });

      const lines = store.exportRuns({ format: 'csv' }).split('\r\n');
      expect(lines[0]).toBe('id,url,title,price,inStock,rating');
      expect(lines[1]).toBe(`${id1},https://a.com,One,1,,`);
      expect(lines[2]).toBe(`${id1},https://a.com,Two,2,true,`);
      expect(lines[3]).toBe(`${id2},https://b.com,Three,,,5`);
      expect(lines).toHaveLength(4);
    });

    it('applies RFC 4180 escaping to commas, quotes, and newlines in cells', () => {
      const id = finishedRun(store, 'https://a.com', 'success', {
        rows: [{ name: 'a, "quoted"', note: 'line1\nline2', plain: 'ok' }],
      });

      const csv = store.exportRuns({ format: 'csv' });
      const [header, ...rest] = csv.split('\r\n');
      expect(header).toBe('id,url,name,note,plain');
      // The embedded \n keeps the quoted record spanning two physical lines.
      expect(rest.join('\r\n')).toBe(`${id},https://a.com,"a, ""quoted""","line1\nline2",ok`);
    });
  });

  describe('csv format — per-run fallback (mixed output shapes)', () => {
    it('falls back to one row per run with JSON-stringified output', () => {
      const flatId = finishedRun(store, 'https://a.com', 'success', { books: [{ t: 1 }] });
      const scalarId = finishedRun(store, 'https://b.com', 'success', { total: 42, name: 'x' });
      const failedId = finishedRun(store, 'https://c.com', 'failed');

      const lines = store.exportRuns({ format: 'csv' }).split('\r\n');
      expect(lines[0]).toBe('id,url,kind,status,output,failureReason');
      expect(lines[1]).toBe(`${flatId},https://a.com,extract,success,"{""books"":[{""t"":1}]}",`);
      expect(lines[2]).toBe(
        `${scalarId},https://b.com,extract,success,"{""total"":42,""name"":""x""}",`,
      );
      expect(lines[3]).toBe(`${failedId},https://c.com,extract,failed,,reason for failed`);
      expect(lines).toHaveLength(4);
    });

    it('emits a header-only CSV when nothing matches', () => {
      expect(store.exportRuns({ format: 'csv', batchId: 'no-such-batch' })).toBe(
        'id,url,kind,status,output,failureReason',
      );
    });
  });
});
