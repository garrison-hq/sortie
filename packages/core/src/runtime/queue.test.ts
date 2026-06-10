import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ListRunsOptions,
  RunEvent,
  RunQueue,
  RunRecord,
  RunSpec,
  RunStore,
  StepRecord,
} from '../contracts.js';
import { createRunQueue, type ExecuteRunFn } from './queue.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Minimal in-memory RunStore so queue tests need no SQLite, browser, or LLM. */
function createFakeStore(overrides: Partial<RunStore> = {}): RunStore {
  const runs = new Map<string, RunRecord>();
  const steps = new Map<string, StepRecord[]>();
  let seq = 0;

  return {
    createRun(spec: RunSpec, batchId?: string): RunRecord {
      const record: RunRecord = {
        id: `run-${seq++}`,
        spec,
        status: 'queued',
        batchId,
        attempts: 0,
        createdAt: Date.now(),
      };
      runs.set(record.id, record);
      return record;
    },
    updateRun(id, patch): RunRecord {
      const existing = runs.get(id);
      if (!existing) throw new Error(`no run with id "${id}"`);
      const next = { ...existing, ...patch };
      runs.set(id, next);
      return next;
    },
    getRun(id) {
      return runs.get(id);
    },
    listRuns(opts: ListRunsOptions = {}) {
      return [...runs.values()].filter(
        (r) =>
          (opts.batchId === undefined || r.batchId === opts.batchId) &&
          (opts.status === undefined || r.status === opts.status),
      );
    },
    countRuns(opts = {}) {
      return this.listRuns(opts).length;
    },
    appendStep(runId, step) {
      const list = steps.get(runId) ?? [];
      list.push(step);
      steps.set(runId, list);
    },
    getSteps(runId) {
      return steps.get(runId) ?? [];
    },
    exportRuns() {
      throw new Error('not supported by fake store');
    },
    // Saved queries + profiles are unused by queue tests.
    createQuery() {
      throw new Error('not supported by fake store');
    },
    updateQuery() {
      throw new Error('not supported by fake store');
    },
    getQuery() {
      return undefined;
    },
    listQueries() {
      return [];
    },
    deleteQuery() {
      return false;
    },
    recordQueryRun() {},
    upsertProfile() {
      throw new Error('not supported by fake store');
    },
    getProfile() {
      return undefined;
    },
    listProfiles() {
      return [];
    },
    deleteProfile() {
      return false;
    },
    touchProfile() {},
    profileStatePath() {
      throw new Error('not supported by fake store');
    },
    close() {},
    ...overrides,
  };
}

function spec(url: string): RunSpec {
  return { kind: 'extract', url, schemaJson: { type: 'object' } };
}

function makeStep(index: number): StepRecord {
  return {
    index,
    url: 'https://x.test/',
    title: 'X',
    thought: '',
    action: { tool: 'click', input: { ref: `e${index}` } },
    observation: 'ok',
    startedAt: Date.now(),
    durationMs: 1,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createRunQueue', () => {
  const queues: RunQueue[] = [];

  function makeQueue(
    store: RunStore,
    opts: Parameters<typeof createRunQueue>[1],
    exec?: ExecuteRunFn,
  ): RunQueue {
    const queue = createRunQueue(store, opts, exec);
    queues.push(queue);
    return queue;
  }

  afterEach(async () => {
    // Shutdown is idempotent; ensures no timers/browsers outlive a test.
    await Promise.all(queues.splice(0).map((q) => q.shutdown()));
  });

  it('holds the concurrency cap while processing a batch', async () => {
    const store = createFakeStore();
    let current = 0;
    let peak = 0;
    const exec: ExecuteRunFn = async () => {
      current++;
      peak = Math.max(peak, current);
      await sleep(20);
      current--;
      return { status: 'success', output: { ok: true } };
    };
    const queue = makeQueue(store, { concurrency: 2, perDomainIntervalMs: 0 }, exec);

    const { batchId, runs } = queue.submitBatch(
      ['a', 'b', 'c', 'd', 'e'].map((h) => spec(`https://${h}.test/`)),
    );
    expect(runs).toHaveLength(5);
    expect(runs.every((r) => r.batchId === batchId)).toBe(true);

    await queue.drain();
    expect(peak).toBe(2);
    expect(store.listRuns({ status: 'success' })).toHaveLength(5);
  });

  it('spaces same-domain starts by at least perDomainIntervalMs while other domains proceed', async () => {
    const store = createFakeStore();
    const startedAtByRun = new Map<string, number>();
    const queue = makeQueue(store, { concurrency: 4, perDomainIntervalMs: 120 }, async () => ({
      status: 'success',
    }));
    queue.onEvent((ev: RunEvent) => {
      if (ev.type === 'run-started' && ev.record?.startedAt !== undefined) {
        startedAtByRun.set(ev.runId, ev.record.startedAt);
      }
    });

    const [same1, same2, other] = [
      queue.submit(spec('https://same.test/a')),
      queue.submit(spec('https://same.test/b')),
      queue.submit(spec('https://other.test/')),
    ];
    await queue.drain();

    const t1 = startedAtByRun.get(same1.id)!;
    const t2 = startedAtByRun.get(same2.id)!;
    const tOther = startedAtByRun.get(other.id)!;
    expect(t2 - t1).toBeGreaterThanOrEqual(120);
    // The rate-limited head item must not block the other domain behind it.
    expect(tOther).toBeLessThan(t2);
  });

  it('retries infrastructure throws exactly maxRetries times, then fails with the last error', async () => {
    const store = createFakeStore();
    let calls = 0;
    const exec: ExecuteRunFn = async () => {
      calls++;
      throw new Error(`boom ${calls}`);
    };
    const queue = makeQueue(store, { maxRetries: 2, perDomainIntervalMs: 0 }, exec);

    const { id } = queue.submit(spec('https://flaky.test/'));
    await queue.drain();

    expect(calls).toBe(3); // initial attempt + 2 retries
    const record = store.getRun(id)!;
    expect(record.status).toBe('failed');
    expect(record.failureReason).toBe('boom 3');
    expect(record.attempts).toBe(3);
    expect(record.finishedAt).toBeGreaterThan(0);
  });

  it('does not retry a returned "failed" outcome (agent-reported failure is final)', async () => {
    const store = createFakeStore();
    let calls = 0;
    const exec: ExecuteRunFn = async () => {
      calls++;
      return { status: 'failed', failureReason: 'agent gave up' };
    };
    const queue = makeQueue(store, { maxRetries: 2, perDomainIntervalMs: 0 }, exec);

    const { id } = queue.submit(spec('https://final.test/'));
    await queue.drain();

    expect(calls).toBe(1);
    const record = store.getRun(id)!;
    expect(record.status).toBe('failed');
    expect(record.failureReason).toBe('agent gave up');
    expect(record.attempts).toBe(1);
  });

  it('cancels queued runs but not running or unknown ones', async () => {
    const store = createFakeStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const exec: ExecuteRunFn = async () => {
      calls++;
      await gate;
      return { status: 'success' };
    };
    const queue = makeQueue(store, { concurrency: 1, perDomainIntervalMs: 0 }, exec);

    const events: RunEvent[] = [];
    queue.onEvent((ev) => events.push(ev));

    const running = queue.submit(spec('https://a.test/'));
    const queued = queue.submit(spec('https://b.test/'));

    expect(queue.cancel(queued.id)).toBe(true);
    expect(queue.cancel(queued.id)).toBe(false); // no longer queued
    expect(queue.cancel(running.id)).toBe(false); // already running
    expect(queue.cancel('no-such-run')).toBe(false);

    const cancelled = store.getRun(queued.id)!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.finishedAt).toBeGreaterThan(0);
    const finishedEvent = events.find((ev) => ev.type === 'run-finished' && ev.runId === queued.id);
    expect(finishedEvent?.record?.status).toBe('cancelled');

    release();
    await queue.drain();
    expect(calls).toBe(1); // the cancelled run never executed
    expect(store.getRun(running.id)?.status).toBe('success');
  });

  it('drain resolves immediately when idle and after settlement when busy', async () => {
    const store = createFakeStore();
    const exec: ExecuteRunFn = async () => {
      await sleep(10);
      return { status: 'success' };
    };
    const queue = makeQueue(store, { perDomainIntervalMs: 0 }, exec);

    // Idle: resolves without any submissions.
    await queue.drain();

    let finished = 0;
    queue.onEvent((ev) => {
      if (ev.type === 'run-finished') finished++;
    });
    queue.submit(spec('https://a.test/'));
    queue.submit(spec('https://b.test/'));
    await queue.drain();
    expect(finished).toBe(2);
  });

  it('emits queued -> started -> step* -> finished per run and persists steps', async () => {
    const store = createFakeStore();
    const exec: ExecuteRunFn = async (_spec, ctx) => {
      ctx.onStep(makeStep(0));
      await sleep(1);
      ctx.onStep(makeStep(1));
      return {
        status: 'success',
        output: { done: true },
        usage: { inputTokens: 3, outputTokens: 4 },
        finalUrl: 'https://x.test/final',
      };
    };
    const queue = makeQueue(store, { perDomainIntervalMs: 0 }, exec);

    const events: RunEvent[] = [];
    const unsubscribe = queue.onEvent((ev) => events.push(ev));

    const { id } = queue.submit(spec('https://x.test/'));
    await queue.drain();

    expect(events.map((ev) => ev.type)).toEqual([
      'run-queued',
      'run-started',
      'run-step',
      'run-step',
      'run-finished',
    ]);
    expect(events.every((ev) => ev.runId === id)).toBe(true);
    expect(events[2]?.step?.index).toBe(0);
    expect(events[3]?.step?.index).toBe(1);

    const finished = events[4]?.record;
    expect(finished?.status).toBe('success');
    expect(finished?.output).toEqual({ done: true });
    expect(finished?.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(finished?.finalUrl).toBe('https://x.test/final');

    expect(store.getSteps(id).map((s) => s.index)).toEqual([0, 1]);

    // Unsubscribe stops delivery.
    unsubscribe();
    queue.submit(spec('https://y.test/'));
    await queue.drain();
    expect(events).toHaveLength(5);
  });

  it('exposes a store-backed resolveProfile on the executor context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nanofish-queue-'));
    const statePath = join(dir, 'sauce.json');
    writeFileSync(statePath, '{"cookies":[],"origins":[]}');
    const touched: string[] = [];
    const store = createFakeStore({
      getProfile: (name) =>
        name === 'sauce' ? { name: 'sauce', createdAt: Date.now() } : undefined,
      profileStatePath: () => statePath,
      touchProfile: (name) => {
        touched.push(name);
      },
    });

    try {
      const resolved: Array<string | undefined> = [];
      const exec: ExecuteRunFn = async (_spec, ctx) => {
        resolved.push(ctx.resolveProfile('sauce'), ctx.resolveProfile('ghost'));
        return { status: 'success' };
      };
      const queue = makeQueue(store, { perDomainIntervalMs: 0 }, exec);

      queue.submit(spec('https://x.test/'));
      await queue.drain();

      // Known profile -> state path (and a lastUsedAt stamp); unknown -> undefined.
      expect(resolved).toEqual([statePath, undefined]);
      expect(touched).toEqual(['sauce']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails runs referencing an unknown profile finally (attempts 1, no infra retry)', async () => {
    const store = createFakeStore();
    // Real default executor: profile resolution happens before any browser
    // page or LLM provider is touched, so no infrastructure is required.
    const queue = makeQueue(store, { maxRetries: 2, perDomainIntervalMs: 0 });

    const submitted = [
      queue.submit({
        kind: 'extract',
        url: 'https://x.test/',
        schemaJson: { type: 'object' },
        profile: 'ghost',
      }),
      queue.submit({ kind: 'agent', url: 'https://y.test/', goal: 'do things', profile: 'ghost' }),
      queue.submit({ kind: 'fetch', url: 'https://z.test/doc', profile: 'ghost' }),
    ];
    await queue.drain();

    for (const run of submitted) {
      const record = store.getRun(run.id)!;
      expect(record.status).toBe('failed');
      expect(record.failureReason).toContain('ghost');
      expect(record.attempts).toBe(1); // final outcome — never retried
    }
  });

  it('fails runs setting both profile and storageStatePath (no silent precedence)', async () => {
    const store = createFakeStore();
    const queue = makeQueue(store, { perDomainIntervalMs: 0 });

    const { id } = queue.submit({
      kind: 'fetch',
      url: 'https://x.test/',
      profile: 'sauce',
      storageStatePath: '/tmp/state.json',
    });
    await queue.drain();

    const record = store.getRun(id)!;
    expect(record.status).toBe('failed');
    expect(record.failureReason).toContain('mutually exclusive');
    expect(record.attempts).toBe(1);
  });

  it('routes fetch specs through the queue like any other run kind', async () => {
    const store = createFakeStore();
    const seen: RunSpec[] = [];
    const exec: ExecuteRunFn = async (s) => {
      seen.push(s);
      return {
        status: 'success',
        output: { markdown: '# Hi', contentType: 'html' },
        finalUrl: 'https://x.test/final',
      };
    };
    const queue = makeQueue(store, { perDomainIntervalMs: 0 }, exec);

    const { id } = queue.submit({ kind: 'fetch', url: 'https://x.test/', maxChars: 1234 });
    await queue.drain();

    expect(seen).toEqual([{ kind: 'fetch', url: 'https://x.test/', maxChars: 1234 }]);
    const record = store.getRun(id)!;
    expect(record.status).toBe('success');
    expect(record.output).toEqual({ markdown: '# Hi', contentType: 'html' });
    expect(record.finalUrl).toBe('https://x.test/final');
  });
});
