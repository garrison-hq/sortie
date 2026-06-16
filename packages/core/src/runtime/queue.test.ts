import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ChallengeDetection,
  ChatResponse,
  ListRunsOptions,
  LlmProvider,
  RunEvent,
  RunQueue,
  RunRecord,
  RunSpec,
  RunStore,
  StepRecord,
} from '../contracts.js';
import { FAILURE_REASON_CAPTCHA_UNSOLVED } from '../contracts.js';
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
    const finishedEvent = events.find(
      (ev) => ev.type === 'run-finished' && ev.runId === queued.id,
    ) as
      | Extract<
          RunEvent,
          { type: 'run-queued' | 'run-started' | 'run-step' | 'run-screenshot' | 'run-finished' }
        >
      | undefined;
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
    type CoreRunEvent = Extract<
      RunEvent,
      { type: 'run-queued' | 'run-started' | 'run-step' | 'run-screenshot' | 'run-finished' }
    >;
    expect((events[2] as CoreRunEvent | undefined)?.step?.index).toBe(0);
    expect((events[3] as CoreRunEvent | undefined)?.step?.index).toBe(1);

    const finished = (events[4] as CoreRunEvent | undefined)?.record;
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
    const dir = mkdtempSync(join(tmpdir(), 'sortie-queue-'));
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
      storageStatePath: 'state.json',
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

  // ---------------------------------------------------------------------------
  // T020 — WP04: non-blocking pause/resume/timeout + cookie banking
  // ---------------------------------------------------------------------------

  /** Minimal Page/BrowserContext stub for queue unit tests (no real browser).
   * The queue only calls page.url(), page.context(), context.close(), and
   * context.storageState() (the latter only on the resume banking path). */
  function makeMockPage() {
    const context = {
      close: () => Promise.resolve(),
      storageState: () => Promise.resolve({ cookies: [], origins: [] }),
    };
    return {
      url: () => 'https://captcha.test/',
      context: () => context,
    } as unknown as Parameters<NonNullable<Parameters<ExecuteRunFn>[1]['onAwaitingHuman']>>[0];
  }

  const fakeDetection: ChallengeDetection = {
    detected: true,
    family: 'recaptcha',
    signal: 'g-recaptcha',
    via: 'content',
  };

  it('T020-FR016 non-blocking: a paused run frees the worker slot so a second run completes', async () => {
    const store = createFakeStore();

    // pausedSignal resolves once the hook is entered and the worker slot freed.
    let notifyPaused!: () => void;
    const pausedSignal = new Promise<void>((r) => {
      notifyPaused = r;
    });

    const exec: ExecuteRunFn = async (s, ctx) => {
      if (s.assist) {
        const mockPage = makeMockPage();
        // Signal the test that we reached the pause point before awaiting the hook.
        notifyPaused();
        await ctx.onAwaitingHuman!(mockPage, fakeDetection, 0);
        return { status: 'awaiting_human', livePage: mockPage };
      }
      return { status: 'success' };
    };

    // concurrency=1: without non-blocking behaviour run B would be blocked by run A.
    const queue = makeQueue(store, { concurrency: 1, perDomainIntervalMs: 0 }, exec);

    const runA = queue.submit({
      kind: 'agent',
      url: 'https://captcha.test/',
      goal: 'test',
      assist: true,
    });
    const runB = queue.submit({ kind: 'agent', url: 'https://other.test/', goal: 'test' });

    // Wait until run A has reached the hook (it will free the slot right after).
    await pausedSignal;

    // Yield once so the hook's active--, settleWaiters(), pump() can fire and
    // run B can start and finish (run B's exec is synchronous → resolves in one microtask tick).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getRun(runA.id)?.status).toBe('awaiting_human');
    expect(store.getRun(runB.id)?.status).toBe('success');

    // Clean up: resume run A so drain() can settle.
    queue.resume(runA.id);
    await queue.drain();
  });

  it('T020-timeout: an unsolved paused run ends failed/captcha_unsolved after the deadline', async () => {
    const store = createFakeStore();

    const exec: ExecuteRunFn = async (s, ctx) => {
      const mockPage = makeMockPage();
      await ctx.onAwaitingHuman!(mockPage, fakeDetection, 0);
      return { status: 'awaiting_human', livePage: mockPage };
    };

    vi.useFakeTimers();
    try {
      const queue = makeQueue(store, { perDomainIntervalMs: 0 }, exec);

      const events: RunEvent[] = [];
      queue.onEvent((ev) => events.push(ev));

      const { id } = queue.submit({
        kind: 'agent',
        url: 'https://captcha.test/',
        goal: 'test',
        assist: true,
        assistSolveTimeoutMs: 30_000, // clamped minimum; fired with fake timers
      });

      // Drain the microtask queue: runItem starts, hook suspends on wakeSignal.
      await vi.runAllTimersAsync();
      // Advance past the solve window; fires the deadline setTimeout.
      await vi.advanceTimersByTimeAsync(30_001);

      const record = store.getRun(id)!;
      expect(record.status).toBe('failed');
      expect(record.failureReason).toBe(FAILURE_REASON_CAPTCHA_UNSOLVED);
      expect(record.assist?.resolution).toBe('timeout');
      expect(events.some((ev) => ev.type === 'run-finished' && ev.runId === id)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('T020-resume: resuming a paused run re-enters the loop and finishes as success', async () => {
    const store = createFakeStore();

    let hookResumed = false;
    // pausedSignal fires when the hook has been entered (run is now in pausedRuns).
    let notifyPaused!: () => void;
    const pausedSignal = new Promise<void>((r) => {
      notifyPaused = r;
    });

    const exec: ExecuteRunFn = async (s, ctx) => {
      const mockPage = makeMockPage();
      notifyPaused();
      await ctx.onAwaitingHuman!(mockPage, fakeDetection, 0);
      hookResumed = true; // hook returned → run was resumed (not timed-out)
      return { status: 'success' };
    };

    const queue = makeQueue(store, { perDomainIntervalMs: 0 }, exec);
    const events: RunEvent[] = [];
    queue.onEvent((ev) => events.push(ev));

    // Set up run-finished listener before submitting (no runId race: listener
    // registered before any event can fire).
    let notifyFinished!: () => void;
    const finishedSignal = new Promise<void>((r) => {
      notifyFinished = r;
    });
    queue.onEvent((ev) => {
      if (ev.type === 'run-finished') notifyFinished();
    });

    const { id } = queue.submit({
      kind: 'agent',
      url: 'https://captcha.test/',
      goal: 'test',
      assist: true,
    });

    // Wait until the hook is entered; by then pausedRuns has the entry.
    await pausedSignal;

    expect(store.getRun(id)?.status).toBe('awaiting_human');

    // Resume the run (no profile → banking is a no-op).
    expect(queue.resume(id)).toBe(true);

    // drain() resolves too early (before active++ in resume's .finally());
    // wait for run-finished instead.
    await finishedSignal;

    expect(hookResumed).toBe(true);
    expect(store.getRun(id)?.status).toBe('success');
    expect(events.some((ev) => ev.type === 'run-resumed' && ev.runId === id)).toBe(true);
  });

  it('T020-resume-banking: resume stamps touchProfile when the run uses a named profile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sortie-queue-assist-'));
    const statePath = join(dir, 'myprofile.json');
    writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }));
    const touched: string[] = [];

    const store = createFakeStore({
      getProfile: (name) =>
        name === 'myprofile' ? { name: 'myprofile', createdAt: Date.now() } : undefined,
      profileStatePath: () => statePath,
      touchProfile: (name) => {
        touched.push(name);
      },
    });

    let notifyPaused!: () => void;
    const pausedSignal = new Promise<void>((r) => {
      notifyPaused = r;
    });
    const exec: ExecuteRunFn = async (s, ctx) => {
      const mockPage = makeMockPage();
      notifyPaused();
      await ctx.onAwaitingHuman!(mockPage, fakeDetection, 0);
      return { status: 'success' };
    };

    try {
      const queue = makeQueue(store, { perDomainIntervalMs: 0 }, exec);

      // Set up run-finished listener before submitting to avoid a race.
      let notifyFinished!: () => void;
      const finishedSignal = new Promise<void>((r) => {
        notifyFinished = r;
      });
      queue.onEvent((ev) => {
        if (ev.type === 'run-finished') notifyFinished();
      });

      const { id } = queue.submit({
        kind: 'agent',
        url: 'https://captcha.test/',
        goal: 'test',
        assist: true,
        profile: 'myprofile',
      });

      await pausedSignal;
      await Promise.resolve(); // let store.updateRun('awaiting_human') complete

      queue.resume(id);
      // drain() resolves too early (before active++ in resume's .finally());
      // wait for run-finished instead.
      await finishedSignal;

      expect(store.getRun(id)?.status).toBe('success');
      // bankAssistSolve stamps touchProfile as its final step (FR-012 cookie banking).
      expect(touched).toContain('myprofile');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T020-timeout-slot: concurrency cap holds after a paused run times out', async () => {
    // Regression for Bug 1: expirePausedRun did NOT do active++ before wakeResolve(),
    // so the pump .finally active-- underflowed → effective concurrency crept above the cap.
    // This test submits one assist run, lets it time out, then submits N normal runs and
    // asserts that peak concurrent in-flight exec invocations never exceeds concurrency=1.
    const store = createFakeStore();

    let current = 0;
    let peakAfterTimeout = 0;

    // Gate: normal runs wait until we explicitly release them so we can observe
    // peak concurrency after the timeout.
    let releaseNormalRuns!: () => void;
    const normalRunsGate = new Promise<void>((r) => {
      releaseNormalRuns = r;
    });

    const exec: ExecuteRunFn = async (s, ctx) => {
      if (s.assist) {
        // This is the assist run — pause and wait to be woken by the timeout.
        const mockPage = makeMockPage();
        await ctx.onAwaitingHuman!(mockPage, fakeDetection, 0);
        // After timeout wakes the hook, return awaiting_human so runItem exits cleanly.
        return { status: 'awaiting_human', livePage: mockPage };
      }
      // Normal run: track concurrency.
      current++;
      peakAfterTimeout = Math.max(peakAfterTimeout, current);
      await normalRunsGate;
      current--;
      return { status: 'success' };
    };

    vi.useFakeTimers();
    try {
      const queue = makeQueue(store, { concurrency: 1, perDomainIntervalMs: 0 }, exec);

      const assistRun = queue.submit({
        kind: 'agent',
        url: 'https://captcha.test/',
        goal: 'test',
        assist: true,
        assistSolveTimeoutMs: 30_000,
      });

      // Drain microtasks so runItem starts and the hook suspends on wakeSignal.
      await vi.runAllTimersAsync();
      // Fire the deadline → expirePausedRun → active++ then wakeResolve.
      await vi.advanceTimersByTimeAsync(30_001);
      // Let the timeout path settle completely (run-finished emitted).
      await vi.runAllTimersAsync();

      // Confirm the assist run timed out before we start measuring.
      expect(store.getRun(assistRun.id)?.status).toBe('failed');

      // Switch back to real timers so normal runs can settle.
      vi.useRealTimers();

      // Submit 4 normal runs — with the bug, active underflowed to -1 so pump
      // would admit 2 workers simultaneously even at concurrency=1.
      queue.submit(spec('https://a.test/'));
      queue.submit(spec('https://b.test/'));
      queue.submit(spec('https://c.test/'));
      queue.submit(spec('https://d.test/'));

      // Let all normal runs start (they block on normalRunsGate).
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Release all normal runs and drain.
      releaseNormalRuns();
      await queue.drain();

      // Peak must be 1 — the concurrency cap must not have been violated.
      expect(peakAfterTimeout).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('T020-timeout-no-requeue: a timed-out run ends exactly once and is never re-queued', async () => {
    // Regression for Bug 2: after expirePausedRun closed the context, the real loop's
    // detectChallengeOnPage call on the closed page threw; runItem's catch treated it as
    // an infra error and re-queued the already-failed run → double-execute, status flip-flop.
    // The mock exec here models the real loop: after the hook resolves it tries to re-detect
    // on the page; if the context was closed it throws — the run must still end exactly once.
    const store = createFakeStore();

    let execCallCount = 0;
    const finishedEvents: RunEvent[] = [];

    // This models the real loop's handleChallengeStep post-resume re-detect:
    // after onAwaitingHuman resolves, attempt detectChallengeOnPage (simulated by
    // checking if the page context is "closed") — throw if closed.
    let contextClosed = false;

    const mockPage = {
      url: () => 'https://captcha.test/',
      context: () => ({
        close: () => {
          contextClosed = true;
          return Promise.resolve();
        },
        storageState: () => Promise.resolve({ cookies: [], origins: [] }),
      }),
    } as unknown as Parameters<NonNullable<Parameters<ExecuteRunFn>[1]['onAwaitingHuman']>>[0];

    const exec: ExecuteRunFn = async (_s, ctx) => {
      execCallCount++;
      await ctx.onAwaitingHuman!(mockPage, fakeDetection, 0);
      // Simulate what the real loop does after the hook resolves: call
      // detectChallengeOnPage on the (now-closed) page. The queue already
      // closed the context via expirePausedRun before waking us.
      if (contextClosed) {
        throw new Error('Target page, context or browser has been closed');
      }
      return { status: 'awaiting_human', livePage: mockPage };
    };

    vi.useFakeTimers();
    try {
      const queue = makeQueue(store, { maxRetries: 2, perDomainIntervalMs: 0 }, exec);

      queue.onEvent((ev) => {
        if (ev.type === 'run-finished') finishedEvents.push(ev);
      });

      const { id } = queue.submit({
        kind: 'agent',
        url: 'https://captcha.test/',
        goal: 'test',
        assist: true,
        assistSolveTimeoutMs: 30_000,
      });

      // Let runItem start and hook suspend.
      await vi.runAllTimersAsync();
      // Fire the deadline → expirePausedRun closes the context, active++, wakeResolve.
      await vi.advanceTimersByTimeAsync(30_001);
      // Let all settled async work complete.
      await vi.runAllTimersAsync();

      vi.useRealTimers();
      // Give real microtasks a moment to drain (runItem catch and any queued work).
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // exec was called exactly once — the timeout must not cause a re-run.
      expect(execCallCount).toBe(1);

      // Exactly one run-finished for this runId, status=failed/captcha_unsolved.
      const finished = finishedEvents.filter((ev) => ev.runId === id);
      expect(finished).toHaveLength(1);

      const record = store.getRun(id)!;
      expect(record.status).toBe('failed');
      expect(record.failureReason).toBe(FAILURE_REASON_CAPTCHA_UNSOLVED);
    } finally {
      vi.useRealTimers();
    }
  });

  it('T020-cap: exceeding maxConcurrentAwaitingHuman degrades the additional run to failed', async () => {
    const store = createFakeStore();

    // pausedASignal fires once run A is in the pausedRuns map.
    let notifyPausedA!: () => void;
    const pausedASignal = new Promise<void>((r) => {
      notifyPausedA = r;
    });

    const exec: ExecuteRunFn = async (s, ctx) => {
      if (ctx.onAwaitingHuman) {
        const mockPage = makeMockPage();
        notifyPausedA();
        await ctx.onAwaitingHuman(mockPage, fakeDetection, 0);
        return { status: 'awaiting_human', livePage: mockPage };
      }
      return { status: 'success' };
    };

    // cap=1: the second assist run is over-cap and must degrade to failed.
    const queue = makeQueue(
      store,
      { concurrency: 3, perDomainIntervalMs: 0, maxConcurrentAwaitingHuman: 1 },
      exec,
    );

    const runA = queue.submit({
      kind: 'agent',
      url: 'https://captcha-a.test/',
      goal: 'test',
      assist: true,
    });

    // Wait until run A occupies the sole pause slot.
    await pausedASignal;
    await Promise.resolve(); // let pausedRuns.set() complete

    // Register a run-finished listener before submitting run B so we can
    // deterministically wait for runItem(B) to fully settle — the cap-exceeded
    // path goes through several async hops (exec return → screenshots.flush →
    // finishRun) before the event fires.
    let notifyBFinished!: () => void;
    const bFinishedSignal = new Promise<void>((resolve) => {
      notifyBFinished = resolve;
    });
    queue.onEvent((ev) => {
      if (ev.type === 'run-finished') notifyBFinished();
    });

    // Submit run B with assist — cap already full, must degrade to failed.
    const runB = queue.submit({
      kind: 'agent',
      url: 'https://captcha-b.test/',
      goal: 'test',
      assist: true,
    });

    // Wait until run B has fully settled (run-finished event fired).
    await bFinishedSignal;

    const recordB = store.getRun(runB.id)!;
    expect(recordB.status).toBe('failed');
    expect(recordB.failureReason).toContain('concurrent-pause cap');

    // Clean up: resume run A.
    queue.resume(runA.id);
    await queue.drain();
  });

  // ---------------------------------------------------------------------------
  // Regression: injected provider must reach agent-spec runs (WP07 cycle-2 fix)
  // ---------------------------------------------------------------------------

  it('T-reg-injected-provider: queue-injected provider is forwarded to agent-spec runs, not dropped', async () => {
    const store = createFakeStore();

    // Stub provider — identity check confirms the queue forwards it, not drops it.
    // chat() is never called (an injected executor short-circuits before runAgent).
    const stubChatResponse: ChatResponse = {
      text: null,
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const stubProvider: LlmProvider = {
      id: 'stub:stub-model',
      chat: vi.fn(async () => stubChatResponse),
    };

    // Capture the injectedProvider the executor receives.
    let receivedInjected: LlmProvider | undefined;
    const exec: ExecuteRunFn = async (_spec, ctx) => {
      receivedInjected = ctx.injectedProvider;
      return { status: 'success', output: { ok: true } };
    };

    // Inject the stub provider at queue construction time (mirrors CLI batch path).
    const queue = makeQueue(store, { perDomainIntervalMs: 0, provider: stubProvider }, exec);

    const { id } = queue.submit({ kind: 'agent', url: 'https://x.test/', goal: 'do things' });
    await queue.drain();

    const record = store.getRun(id)!;
    expect(record.status).toBe('success');
    // The executor must have received the injected stub provider, not undefined.
    expect(receivedInjected).toBe(stubProvider);
    expect(receivedInjected?.id).toBe('stub:stub-model');
  });

  it('T-reg-no-inject: no injectedProvider when queue constructed without one (assist/server path)', async () => {
    const store = createFakeStore();

    const sentinelResponse: ChatResponse = {
      text: null,
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
    let receivedInjected: LlmProvider | undefined = {
      id: 'sentinel',
      chat: vi.fn(async () => sentinelResponse),
    };

    const exec: ExecuteRunFn = async (_spec, ctx) => {
      receivedInjected = ctx.injectedProvider;
      return { status: 'success' };
    };

    // No provider injected: mirrors server / assist path.
    const queue = makeQueue(store, { perDomainIntervalMs: 0 }, exec);

    queue.submit({ kind: 'agent', url: 'https://x.test/', goal: 'do things' });
    await queue.drain();

    // injectedProvider must be undefined so runAgent stays lazy.
    expect(receivedInjected).toBeUndefined();
  });
});
