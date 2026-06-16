/**
 * In-process run queue: executes persisted RunSpecs against a pool of
 * browser workers with per-domain rate limiting and infrastructure retries.
 *
 * - One shared, lazily-launched BrowserManager backs all workers; each run
 *   gets its own context/page, always closed when the run settles.
 * - Workers pull FIFO with an eligibility scan: a head-of-queue item whose
 *   domain is still inside its rate-limit window never blocks eligible work
 *   for other domains behind it.
 * - `executeRun` is injectable so unit tests can drive the queue without
 *   browsers or LLM calls; the default executor dispatches on RunSpec.kind.
 *
 * WP04 — Non-blocking pause/resume/timeout + cookie banking:
 * When an agent run yields `awaiting_human` the worker slot is immediately
 * freed (`active` is decremented and `pump()` is called) so other runs keep
 * processing (FR-016). The live browser context is kept alive in `pausedRuns`
 * until the human resumes or the solve window expires. `resume(runId)` banks
 * cookies into the profile (if any) and signals the loop to continue on the
 * same page. A per-run deadline timer enforces `assistSolveTimeoutMs` and
 * produces `failed` + `captcha_unsolved` on expiry. A cap on concurrent
 * paused runs (`maxConcurrentAwaitingHuman`, default 3) degrades additional
 * challenged runs to a graceful fail instead of an unbounded pause queue.
 *
 * Security invariant: credential VALUES are resolved from process.env at
 * execution time and handed straight to the agent loop — only env var NAMES
 * ever appear in records, events, or failure reasons.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import type {
  AssistState,
  ChallengeDetection,
  LlmProvider,
  QueueOptions,
  RunEvent,
  RunQueue,
  RunRecord,
  RunSpec,
  RunStatus,
  RunStore,
  StepRecord,
  TokenUsage,
} from '../contracts.js';
import { FAILURE_REASON_CAPTCHA_UNSOLVED } from '../contracts.js';
import { createProvider } from '../llm/index.js';
import { BrowserManager } from '../browser/index.js';
import { extract, navigateOrPdfSnapshot, jsonSchemaToZod } from '../extract/index.js';
import { fetchPage } from '../fetch/index.js';
import { runAgent } from '../agent/loop.js';
import { bankAssistSolve } from '../profiles.js';

const DEFAULT_CONCURRENCY = 5;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 10;
const DEFAULT_PER_DOMAIN_INTERVAL_MS = 1000;
const DEFAULT_MAX_RETRIES = 2;
const SCREENSHOT_TIMEOUT_MS = 5000;
const SCREENSHOT_JPEG_QUALITY = 55;
/** Default solve window for paused CAPTCHA runs: 10 minutes. FR-014. */
const DEFAULT_ASSIST_SOLVE_TIMEOUT_MS = 600_000;
/** Minimum and maximum allowed solve window (mirrors RunSpecSchema). */
const MIN_ASSIST_SOLVE_TIMEOUT_MS = 30_000;
const MAX_ASSIST_SOLVE_TIMEOUT_MS = 3_600_000;
/** Default cap on simultaneously-paused runs. FR-016. */
const DEFAULT_MAX_CONCURRENT_AWAITING_HUMAN = 3;
/** Markdown cap for queued fetch runs — tighter than fetchPage's 80k default
 * because outputs are persisted in SQLite (store bloat guard). */
const QUEUED_FETCH_MAX_CHARS = 40_000;

function defaultScreenshotDir(): string {
  return (process.env.SORTIE_DATA_DIR ?? './data') + '/screenshots';
}

/** What a single execution attempt settles to (or it throws: infra error). */
export interface ExecuteRunOutcome {
  status: RunStatus;
  output?: unknown;
  failureReason?: string;
  usage?: TokenUsage;
  finalUrl?: string;
  /** Present when the run paused for CAPTCHA assistance. */
  assist?: AssistState;
  /**
   * When status is `awaiting_human`, the queue must NOT close the browser
   * context — it is kept alive so the human can interact with the page.
   * The executor sets this to the live page so the queue can reach the
   * context for cookie banking and teardown on timeout/cancel.
   */
  livePage?: Page;
}

/**
 * Executes one RunSpec attempt. A THROW is an infrastructure error and is
 * retried by the queue; a returned 'failed'/'max_steps' status is a final
 * outcome. Injectable so the queue is unit-testable without browsers/LLMs.
 */
export type ExecuteRunFn = (
  spec: RunSpec,
  ctx: {
    provider: LlmProvider;
    manager: BrowserManager;
    onStep: (step: StepRecord) => void;
    /**
     * Best-effort per-step screenshot capture (no-op when disabled). Captures
     * are serialized per run and never affect the run outcome; the queue emits
     * a 'run-screenshot' event once the JPEG is on disk. `flush` (never
     * rejects) lets the executor let in-flight captures land before it tears
     * the page down.
     */
    screenshots: { capture(page: Page, stepIndex: number): void; flush(): Promise<void> };
    /**
     * Resolve a named login profile to its storage-state path: metadata row
     * present AND state file on disk → path (lastUsedAt is stamped);
     * otherwise undefined. Never throws — a missing profile is a final
     * 'failed' outcome, not an infrastructure error.
     */
    resolveProfile: (name: string) => string | undefined;
    /**
     * Called by the executor when the agent loop detects a CAPTCHA with
     * assist enabled. The executor passes the live `page` so the queue can
     * keep the context alive. The queue wires this to suspend the run
     * non-blocking; the returned promise resolves when the queue is ready for
     * the loop to continue (on resume or when the cap is exceeded).
     */
    onAwaitingHuman?: (
      page: Page,
      detection: ChallengeDetection,
      stepIndex: number,
    ) => Promise<void>;
    /**
     * The provider that was injected into the queue at construction time, or
     * `undefined` when none was injected (server / assist path). Already
     * constructed — forwarding it to `runAgent` does NOT trigger any key
     * validation. When undefined, `runAgent` lazily constructs its own provider
     * on the first `chat()` call (after CAPTCHA detection can pause the run).
     */
    injectedProvider?: LlmProvider;
  },
) => Promise<ExecuteRunOutcome>;

type ExecuteRunCtx = Parameters<ExecuteRunFn>[1];

/**
 * Per-run screenshot pipeline. Captures are chained so they never interleave
 * (the JPEG for step N is always taken before the one for step N+1), but the
 * chain is fire-and-forget from the executor's perspective: a failed capture
 * (page closed, navigation in flight, timeout) is swallowed and never fails
 * or delays the run outcome. The queue awaits `flush()` before emitting
 * 'run-finished' so the final screenshot exists when consumers react to it.
 */
interface ScreenshotSink {
  capture(page: Page, stepIndex: number): void;
  /** Resolves when all queued captures have settled; never rejects. */
  flush(): Promise<void>;
}

const noopScreenshotSink: ScreenshotSink = {
  capture() {},
  flush: () => Promise.resolve(),
};

function createScreenshotSink(args: {
  runId: string;
  batchId?: string;
  dir: string;
  emit: (ev: RunEvent) => void;
}): ScreenshotSink {
  const runDir = join(args.dir, args.runId);
  /** mkdir -p happens once per run, lazily on the first capture. */
  let dirReady: Promise<unknown> | undefined;
  let chain: Promise<void> = Promise.resolve();

  return {
    capture(page: Page, stepIndex: number): void {
      chain = chain.then(async () => {
        try {
          dirReady ??= mkdir(runDir, { recursive: true });
          await dirReady;
          const path = join(runDir, `${stepIndex}.jpg`);
          await page.screenshot({
            type: 'jpeg',
            quality: SCREENSHOT_JPEG_QUALITY,
            timeout: SCREENSHOT_TIMEOUT_MS,
            path,
          });
          args.emit({
            type: 'run-screenshot',
            runId: args.runId,
            batchId: args.batchId,
            screenshot: { stepIndex, path },
          });
        } catch {
          // Best-effort by design: screenshots must never affect correctness.
        }
      });
    },
    flush: () => chain,
  };
}

/** Internal queue entry; `attempts` counts execution attempts so far. */
interface QueueItem {
  id: string;
  spec: RunSpec;
  batchId?: string;
  attempts: number;
}

/**
 * Live state for a run paused in `awaiting_human`.
 * The browser context is kept alive; worker slot is freed.
 */
interface PausedRun {
  item: QueueItem;
  page: Page;
  context: BrowserContext;
  assist: AssistState;
  /** NodeJS timer that fires on solve-window expiry. */
  deadlineTimer: NodeJS.Timeout;
  /**
   * Resolving this promise wakes the suspended hook (and thus the agent
   * loop). Both the resume path AND the timeout path call this; the hook
   * reads `terminated` to know which path won.
   */
  wakeResolve: () => void;
  /**
   * Set to true by `expirePausedRun` before calling `wakeResolve`. When
   * true, the hook returns without further action (finishRun was already
   * called by the expiry path).
   */
  terminated: boolean;
}

/**
 * Create a RunQueue executing specs against `store` with a shared browser.
 * Pass `executeRun` to replace the real extract/agent execution (tests).
 */
export function createRunQueue(
  store: RunStore,
  opts?: QueueOptions,
  executeRun?: ExecuteRunFn,
): RunQueue {
  const concurrency = clamp(
    Math.floor(opts?.concurrency ?? DEFAULT_CONCURRENCY),
    MIN_CONCURRENCY,
    MAX_CONCURRENCY,
  );
  const perDomainIntervalMs = opts?.perDomainIntervalMs ?? DEFAULT_PER_DOMAIN_INTERVAL_MS;
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const screenshotsEnabled = opts?.screenshots?.enabled ?? true;
  const screenshotsDir = opts?.screenshots?.dir ?? defaultScreenshotDir();
  const maxConcurrentAwaitingHuman =
    opts?.maxConcurrentAwaitingHuman ?? DEFAULT_MAX_CONCURRENT_AWAITING_HUMAN;
  const exec = executeRun ?? defaultExecuteRun;

  const manager = new BrowserManager();
  // Provider is created lazily so constructing a queue (e.g. with an
  // injected executeRun in tests) never requires provider env/config.
  let provider: LlmProvider | undefined = opts?.provider;
  function getProvider(): LlmProvider {
    provider ??= createProvider();
    return provider;
  }

  /** Profile slug → storage-state path (and lastUsedAt stamp), or undefined
   * when the profile is missing its metadata row or on-disk state file. */
  function resolveProfile(name: string): string | undefined {
    try {
      if (!store.getProfile(name)) return undefined;
      const path = store.profileStatePath(name);
      if (!existsSync(path)) return undefined;
      store.touchProfile(name);
      return path;
    } catch {
      // Non-slug names (profileStatePath throws) resolve like missing
      // profiles — executors turn that into a final 'failed' outcome.
      return undefined;
    }
  }

  const queue: QueueItem[] = [];
  const listeners = new Set<(ev: RunEvent) => void>();
  /** Epoch ms of the last run START per hostname (rate-limit windows). */
  const lastStartByHost = new Map<string, number>();

  /**
   * Runs currently paused awaiting human CAPTCHA assistance.
   * Worker slot is NOT counted in `active` for paused runs.
   */
  const pausedRuns = new Map<string, PausedRun>();

  let active = 0;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  /** Pending wake-up for rate-limited work, plus its deadline. */
  let wakeTimer: NodeJS.Timeout | null = null;
  let wakeDeadline = 0;
  const drainWaiters: Array<() => void> = [];
  const idleWaiters: Array<() => void> = [];

  function emit(ev: RunEvent): void {
    for (const listener of listeners) {
      try {
        listener(ev);
      } catch {
        // Listener exceptions must never disturb the queue.
      }
    }
  }

  function clearWakeTimer(): void {
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
  }

  /** Schedule a pump() wake-up, keeping only the earliest deadline. */
  function scheduleWake(waitMs: number): void {
    const deadline = Date.now() + waitMs;
    if (wakeTimer && wakeDeadline <= deadline) return;
    clearWakeTimer();
    wakeDeadline = deadline;
    wakeTimer = setTimeout(
      () => {
        wakeTimer = null;
        pump();
      },
      Math.max(waitMs, 1),
    );
  }

  /**
   * Eligibility-scan pull: the first item (FIFO) whose domain is outside its
   * rate-limit window is removed and returned. When everything queued is
   * still rate-limited, returns the shortest wait instead.
   */
  function pickEligible(): { item?: QueueItem; waitMs?: number } {
    const now = Date.now();
    let minWait: number | undefined;
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i]!;
      const last = lastStartByHost.get(hostnameOf(item.spec.url));
      const wait = last === undefined ? 0 : last + perDomainIntervalMs - now;
      if (wait <= 0) {
        queue.splice(i, 1);
        return { item };
      }
      if (minWait === undefined || wait < minWait) {
        minWait = wait;
      }
    }
    return minWait === undefined ? {} : { waitMs: minWait };
  }

  function pump(): void {
    if (shuttingDown) return;
    while (active < concurrency) {
      const { item, waitMs } = pickEligible();
      if (!item) {
        if (waitMs !== undefined) scheduleWake(waitMs);
        return;
      }
      active++;
      // Fire-and-forget: runItem never rejects (it catches internally), so
      // finally() simply drives the pump forward as each item settles.
      runItem(item).finally(() => {
        active--;
        settleWaiters();
        pump();
      });
    }
  }

  function settleWaiters(): void {
    // Drain waiters only once all active runs AND all paused runs are done.
    const totalBusy = active + pausedRuns.size;
    if (totalBusy > 0) return;
    while (idleWaiters.length > 0) {
      idleWaiters.pop()!();
    }
    if (queue.length === 0) {
      while (drainWaiters.length > 0) {
        drainWaiters.pop()!();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pause/resume helpers (T015, T016, T017)
  // ---------------------------------------------------------------------------

  /**
   * Build an `onAwaitingHuman` hook (attached to ExecuteRunCtx) that the
   * executor calls when the agent loop detects a challenge. The executor
   * supplies the live `page` directly so the queue can keep the context alive.
   *
   * Returns a function that:
   * - When cap is not exceeded: pauses the run (frees the worker slot),
   *   arms the deadline timer, and suspends until resume or timeout.
   * - When cap is exceeded: resolves immediately with a side-effect that
   *   marks a pending "cap exceeded" state so `runItem` can fail gracefully.
   */
  function buildOnAwaitingHuman(item: QueueItem): {
    hook: (page: Page, detection: ChallengeDetection, stepIndex: number) => Promise<void>;
    wasCapExceeded: () => boolean;
    wasTerminated: () => boolean;
  } {
    let capExceeded = false;
    // Set to true when the deadline fires (or shutdown) so runItem knows
    // the run was already finalized and must not call finishRun again.
    let hookTerminated = false;

    async function hook(
      page: Page,
      detection: ChallengeDetection,
      stepIndex: number,
    ): Promise<void> {
      // Cap check: if too many runs are already paused, degrade gracefully.
      if (pausedRuns.size >= maxConcurrentAwaitingHuman) {
        capExceeded = true;
        // Resolve immediately — runItem will detect capExceeded and fail.
        return;
      }

      const context = page.context();

      const solveTimeoutMs = clamp(
        item.spec.assistSolveTimeoutMs ?? DEFAULT_ASSIST_SOLVE_TIMEOUT_MS,
        MIN_ASSIST_SOLVE_TIMEOUT_MS,
        MAX_ASSIST_SOLVE_TIMEOUT_MS,
      );
      const pausedAt = Date.now();
      const deadlineAt = pausedAt + solveTimeoutMs;

      const assist: AssistState = {
        family: detection.family,
        signal: detection.signal,
        stepIndex,
        challengeUrl: page.url(),
        pausedAt,
        deadlineAt,
      };

      // Build the wake signal: a promise the hook awaits until either
      // resume() or expirePausedRun() resolves it. The `terminated` flag
      // on `PausedRun` distinguishes the two paths.
      let wakeResolve!: () => void;
      const wakeSignal = new Promise<void>((resolve) => {
        wakeResolve = resolve;
      });

      // Persist the awaiting_human transition + assist snapshot (T019).
      store.updateRun(item.id, { status: 'awaiting_human', assist });

      // Arm the deadline timer (T017).
      const deadlineTimer = setTimeout(() => {
        expirePausedRun(item.id);
      }, solveTimeoutMs);

      const paused: PausedRun = {
        item,
        page,
        context,
        assist,
        deadlineTimer,
        wakeResolve,
        terminated: false,
      };
      pausedRuns.set(item.id, paused);

      emit({ type: 'run-awaiting-human', runId: item.id, batchId: item.batchId, assist });

      // Free the worker slot so other runs proceed (FR-016).
      active--;
      settleWaiters();
      pump();

      // Suspend until resume() or timeout wakes us.
      await wakeSignal;

      // Propagate the terminated flag so runItem can skip finishRun.
      if (paused.terminated) {
        hookTerminated = true;
      }
    }

    return {
      hook,
      wasCapExceeded: () => capExceeded,
      wasTerminated: () => hookTerminated,
    };
  }

  /**
   * Deadline timer callback (or shutdown): tear down the paused run with
   * `captcha_unsolved`. Sets `terminated = true` then resolves the hook's
   * wake signal so the suspended coroutine can unblock and exit cleanly.
   */
  function expirePausedRun(runId: string): void {
    const paused = pausedRuns.get(runId);
    if (!paused) return;
    pausedRuns.delete(runId);
    clearTimeout(paused.deadlineTimer);

    const resolvedAt = Date.now();
    const assistFinal: AssistState = {
      ...paused.assist,
      resolvedAt,
      resolution: 'timeout',
    };

    // Close the browser context — no more use for it.
    paused.context.close().catch(() => {});

    const record = store.updateRun(runId, {
      status: 'failed',
      failureReason: FAILURE_REASON_CAPTCHA_UNSOLVED,
      finishedAt: resolvedAt,
      assist: assistFinal,
    });
    emit({ type: 'run-finished', runId, batchId: paused.item.batchId, record });

    // Wake the suspended hook so the coroutine can exit. The `terminated`
    // flag tells runItem not to call finishRun a second time.
    paused.terminated = true;

    // Mirror resume()'s slot re-accounting: the hook freed the slot with
    // active-- when pausing; pump's .finally will decrement active again when
    // the suspended runItem settles. We must add back the slot now so the net
    // effect is zero (one active++ matched by one active-- in .finally).
    active++;

    paused.wakeResolve();

    // The worker slot was freed when we paused; settleWaiters checks both
    // active and pausedRuns, so now that pausedRuns shrank we re-evaluate.
    settleWaiters();
    pump();
  }

  /** One execution attempt; settles the run or requeues on infra errors. */
  async function runItem(item: QueueItem): Promise<void> {
    const startedAt = Date.now();
    lastStartByHost.set(hostnameOf(item.spec.url), startedAt);
    item.attempts += 1;

    const onStep = (step: StepRecord): void => {
      store.appendStep(item.id, step);
      emit({ type: 'run-step', runId: item.id, batchId: item.batchId, step });
    };

    // Fresh sink per attempt: a retry re-captures into the same paths.
    const screenshots = screenshotsEnabled
      ? createScreenshotSink({ runId: item.id, batchId: item.batchId, dir: screenshotsDir, emit })
      : noopScreenshotSink;

    const { hook: onAwaitingHuman, wasCapExceeded, wasTerminated } = buildOnAwaitingHuman(item);

    try {
      const started = store.updateRun(item.id, {
        status: 'running',
        startedAt,
        attempts: item.attempts,
      });
      emit({ type: 'run-started', runId: item.id, batchId: item.batchId, record: started });

      // `provider` is a lazy getter: it is only created (from opts/env) when
      // the executor actually uses it, so injected test executors never
      // require provider configuration.
      // `injectedProvider` carries the raw opts.provider value (already
      // constructed, never undefined-or-lazy) so executeAgent can forward it
      // to runAgent without going through the forcing getter.
      const ctx: ExecuteRunCtx = {
        manager,
        onStep,
        screenshots,
        resolveProfile,
        onAwaitingHuman: item.spec.assist ? onAwaitingHuman : undefined,
        injectedProvider: opts?.provider,
        get provider(): LlmProvider {
          return getProvider();
        },
      };
      const outcome = await exec(item.spec, ctx);

      // Cap-exceeded path: the hook resolved immediately (no pause) but
      // set the cap-exceeded flag. The executor may have left the context
      // open (livePage). Close it and fail gracefully.
      if (wasCapExceeded()) {
        await screenshots.flush();
        if (outcome.livePage) {
          await outcome.livePage
            .context()
            .close()
            .catch(() => {});
        }
        finishRun(item, {
          status: 'failed',
          failureReason:
            `Run paused for CAPTCHA but the concurrent-pause cap ` +
            `(${maxConcurrentAwaitingHuman}) was already reached — ` +
            'try again when a slot is free.',
        });
        return;
      }

      if (outcome.status === 'awaiting_human') {
        // The run is paused in `pausedRuns` — the hook already:
        //   - moved the run into pausedRuns
        //   - freed the worker slot (active--)
        //   - called pump() so other runs proceeded
        // We must NOT call finishRun here; the resume or timeout path does.
        // Screenshots were flushed inside the hook before yielding.
        return;
      }

      // Normal terminal outcome (success, failed, max_steps, cancelled).
      await screenshots.flush();
      finishRun(item, outcome);
    } catch (err) {
      await screenshots.flush();
      // Belt-and-suspenders: if the queue's timeout/shutdown path already
      // finalized this run (terminated = true) we must not re-queue or
      // double-finish it, even if an error somehow escaped the guarded
      // re-detect path in the loop (e.g. a race on a closed page).
      if (wasTerminated()) return;
      const message = err instanceof Error ? err.message : String(err);
      if (item.attempts <= maxRetries && !shuttingDown) {
        // Infrastructure error with retry budget left: back to the queue tail.
        store.updateRun(item.id, { status: 'queued' });
        queue.push(item);
        return;
      }
      finishRun(item, { status: 'failed', failureReason: message });
    }
  }

  function finishRun(item: QueueItem, outcome: ExecuteRunOutcome): void {
    const patch: Partial<Omit<RunRecord, 'id' | 'spec' | 'createdAt'>> = {
      status: outcome.status,
      finishedAt: Date.now(),
    };
    if (outcome.output !== undefined) patch.output = outcome.output;
    if (outcome.failureReason !== undefined) patch.failureReason = outcome.failureReason;
    if (outcome.usage !== undefined) patch.usage = outcome.usage;
    if (outcome.finalUrl !== undefined) patch.finalUrl = outcome.finalUrl;
    if (outcome.assist !== undefined) patch.assist = outcome.assist;

    const record = store.updateRun(item.id, patch);
    emit({ type: 'run-finished', runId: item.id, batchId: item.batchId, record });
  }

  function enqueue(record: RunRecord): void {
    queue.push({
      id: record.id,
      spec: record.spec,
      batchId: record.batchId,
      attempts: 0,
    });
    emit({ type: 'run-queued', runId: record.id, batchId: record.batchId, record });
  }

  return {
    submit(spec: RunSpec): RunRecord {
      const record = store.createRun(spec);
      enqueue(record);
      pump();
      return record;
    },

    submitBatch(specs: RunSpec[]): { batchId: string; runs: RunRecord[] } {
      const batchId = randomUUID();
      const runs = specs.map((spec) => {
        const record = store.createRun(spec, batchId);
        enqueue(record);
        return record;
      });
      pump();
      return { batchId, runs };
    },

    cancel(runId: string): boolean {
      // Case 1: run is still waiting in the queue (not yet started).
      const index = queue.findIndex((item) => item.id === runId);
      if (index !== -1) {
        const [item] = queue.splice(index, 1);
        const record = store.updateRun(runId, { status: 'cancelled', finishedAt: Date.now() });
        emit({ type: 'run-finished', runId, batchId: item!.batchId, record });
        settleWaiters();
        return true;
      }

      // Case 2: run is paused in awaiting_human — tear down the live context.
      const paused = pausedRuns.get(runId);
      if (paused) {
        clearTimeout(paused.deadlineTimer);
        pausedRuns.delete(runId);

        const resolvedAt = Date.now();
        const assistFinal: AssistState = {
          ...paused.assist,
          resolvedAt,
          resolution: 'cancelled',
        };

        // Close the browser context — the operator cancelled, no further use.
        paused.context.close().catch(() => {});

        const record = store.updateRun(runId, {
          status: 'cancelled',
          finishedAt: resolvedAt,
          assist: assistFinal,
        });
        emit({ type: 'run-resumed', runId, batchId: paused.item.batchId, resolution: 'cancelled' });
        emit({ type: 'run-finished', runId, batchId: paused.item.batchId, record });

        // Re-account for the worker slot that was freed on pause.
        paused.terminated = true;
        active++;
        paused.wakeResolve();

        settleWaiters();
        pump();
        return true;
      }

      return false;
    },

    resume(runId: string): boolean {
      const paused = pausedRuns.get(runId);
      if (!paused) return false;

      // Clear the deadline timer — we're resuming before expiry.
      clearTimeout(paused.deadlineTimer);
      pausedRuns.delete(runId);

      // Persist transition back to running.
      store.updateRun(runId, { status: 'running' });

      // Bank cookies into the profile if the run uses one (T018).
      const profileName = paused.item.spec.profile;
      const doBanking =
        profileName === undefined
          ? Promise.resolve()
          : bankAssistSolve(paused.page, profileName, store);

      doBanking
        .catch(() => {
          // Banking failures must not abort the resume.
        })
        .finally(() => {
          const resolvedAt = Date.now();
          const assistFinal: AssistState = {
            ...paused.assist,
            resolvedAt,
            resolution: 'solved',
            solveSource: 'manual',
          };
          // Persist the resolved assist state before signalling.
          store.updateRun(runId, { assist: assistFinal });

          emit({
            type: 'run-resumed',
            runId,
            batchId: paused.item.batchId,
            resolution: 'solved',
            solveSource: 'manual',
          });

          // Re-account for the worker slot: the loop continuation will
          // complete inside runItem's .finally(), which decrements active and
          // calls pump. We must increment active NOW so the concurrency cap
          // accounts for this work resuming.
          active++;

          // Wake the suspended hook so the agent loop can continue on the
          // same live page. `terminated` remains false so runItem proceeds.
          paused.wakeResolve();
        });

      return true;
    },

    async cdpSessionForRun(runId: string) {
      const paused = pausedRuns.get(runId);
      if (!paused) return null;
      return manager.cdpSessionFor(paused.page);
    },

    onEvent(listener: (ev: RunEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    drain(): Promise<void> {
      if (active === 0 && queue.length === 0 && pausedRuns.size === 0) return Promise.resolve();
      return new Promise((resolve) => {
        drainWaiters.push(resolve);
      });
    },

    shutdown(): Promise<void> {
      shutdownPromise ??= (async () => {
        shuttingDown = true;
        clearWakeTimer();

        // Expire all paused runs immediately on shutdown.
        for (const runId of pausedRuns.keys()) {
          expirePausedRun(runId);
        }

        if (active > 0) {
          await new Promise<void>((resolve) => {
            idleWaiters.push(resolve);
          });
        }
        await manager.close();
      })();
      return shutdownPromise;
    },
  };
}

// ---------------------------------------------------------------------------
// Default execution: real extract / agent / fetch runs
// ---------------------------------------------------------------------------

const defaultExecuteRun: ExecuteRunFn = async (spec, ctx) => {
  switch (spec.kind) {
    case 'extract':
      return executeExtract(spec, ctx);
    case 'agent':
      return executeAgent(spec, ctx);
    case 'fetch':
      return executeFetch(spec, ctx);
  }
};

/**
 * Resolve `spec.profile` / `spec.storageStatePath` into the storage-state
 * path a run should use. Problems are returned as final 'failed' outcomes
 * (never thrown): a missing profile cannot heal through infra retries, so
 * retrying would only burn budget.
 */
function resolveSessionState(
  spec: RunSpec,
  ctx: ExecuteRunCtx,
): { storageStatePath?: string } | { failure: ExecuteRunOutcome } {
  if (spec.profile === undefined) {
    return { storageStatePath: spec.storageStatePath };
  }
  if (spec.storageStatePath !== undefined) {
    return {
      failure: {
        status: 'failed',
        failureReason:
          '`profile` and `storageStatePath` are mutually exclusive — set one or the other.',
      },
    };
  }
  const path = ctx.resolveProfile(spec.profile);
  if (path === undefined) {
    return {
      failure: {
        status: 'failed',
        failureReason:
          `Login profile "${spec.profile}" does not exist ` +
          '(no profile metadata or no storage-state file on disk).',
      },
    };
  }
  return { storageStatePath: path };
}

async function executeExtract(spec: RunSpec, ctx: ExecuteRunCtx): Promise<ExecuteRunOutcome> {
  if (!spec.schemaJson) {
    // Spec defect, not an infrastructure error — final failure, no retry.
    return {
      status: 'failed',
      failureReason: 'Extract runs require `schemaJson` (a JSON Schema for the output).',
    };
  }
  const session = resolveSessionState(spec, ctx);
  if ('failure' in session) return session.failure;
  const schema = jsonSchemaToZod(spec.schemaJson);

  const page = await ctx.manager.newPage({ storageStatePath: session.storageStatePath });
  try {
    // Navigate with PDF detection: PDF URLs are parsed into a pre-built
    // snapshot (headless Chromium aborts PDF navigations — routing them here
    // avoids burning infrastructure retries on those aborts).
    const pdfSnapshot = await navigateOrPdfSnapshot(page, spec.url);
    if (!pdfSnapshot) {
      // Single screenshot per extract run: the settled page, as step 0.
      // (PDFs never render — the page stayed blank.)
      ctx.screenshots.capture(page, 0);
    }
    const result = await extract({
      ...(pdfSnapshot ? { snapshot: pdfSnapshot } : { page }),
      schema,
      instruction: spec.instruction,
      provider: ctx.provider,
    });
    return {
      status: 'success',
      output: result.data,
      usage: result.usage,
      finalUrl: result.url,
    };
  } finally {
    // Let in-flight captures land while the page is still alive.
    await ctx.screenshots.flush();
    await page
      .context()
      .close()
      .catch(() => {});
  }
}

async function executeAgent(spec: RunSpec, ctx: ExecuteRunCtx): Promise<ExecuteRunOutcome> {
  if (!spec.goal) {
    return {
      status: 'failed',
      failureReason: 'Agent runs require `goal` (the natural-language objective).',
    };
  }
  const session = resolveSessionState(spec, ctx);
  if ('failure' in session) return session.failure;

  // Resolve credentials from the environment by NAME; values never enter
  // records, events, or failure reasons.
  const credentials: Record<string, string> = {};
  for (const name of spec.credentialNames ?? []) {
    const value = process.env[name];
    if (value === undefined) {
      return {
        status: 'failed',
        failureReason: `Credential environment variable "${name}" is not set.`,
      };
    }
    credentials[name] = value;
  }

  const page = await ctx.manager.newPage({ storageStatePath: session.storageStatePath });
  // Track whether the agent loop paused for CAPTCHA — when true, the page
  // context must NOT be closed here (the queue keeps it alive until resume
  // or timeout). In all other cases the finally block closes it.
  let pausing = false;
  try {
    const result = await runAgent({
      goal: spec.goal,
      startUrl: spec.url,
      schema: spec.schemaJson ? jsonSchemaToZod(spec.schemaJson) : undefined,
      maxSteps: spec.maxSteps,
      page,
      // Forward the queue-injected provider when one exists (CLI --provider /
      // --model override): it is already constructed so forwarding it never
      // triggers eager key validation. When no provider was injected (server /
      // assist path), pass undefined so runAgent's lazy thunk defers
      // createProvider() to the first chat() call — after challenge detection
      // can pause the run, preserving the keyless-pause behaviour.
      provider: ctx.injectedProvider,
      credentials,
      assistEnabled: spec.assist === true,
      // Wrap the queue hook to inject `page` — the agent loop only supplies
      // (detection, stepIndex); the queue needs the live page for context
      // banking and timeout teardown (T015, T016, T018).
      onAwaitingHuman: ctx.onAwaitingHuman
        ? (detection, stepIndex) => ctx.onAwaitingHuman!(page, detection, stepIndex)
        : undefined,
      onStep: (step) => {
        ctx.onStep(step);
        // Queue the capture after the step event so 'run-screenshot' always
        // follows the corresponding 'run-step'.
        ctx.screenshots.capture(page, step.index);
      },
    });
    if (result.status === 'awaiting_human') {
      // Return the live page so the queue can keep the context alive.
      // Mark pausing so the finally block skips context teardown.
      pausing = true;
      return {
        status: result.status,
        assist: result.assist,
        failureReason: result.failureReason,
        usage: result.usage,
        finalUrl: result.finalUrl,
        livePage: page,
      };
    }
    return {
      status: result.status,
      output: result.output,
      failureReason: result.failureReason,
      usage: result.usage,
      finalUrl: result.finalUrl,
    };
  } finally {
    // Let in-flight captures land while the page is still alive.
    await ctx.screenshots.flush();
    // For awaiting_human, do NOT close the context — the queue owns teardown.
    if (!pausing) {
      await page
        .context()
        .close()
        .catch(() => {});
    }
  }
}

async function executeFetch(spec: RunSpec, ctx: ExecuteRunCtx): Promise<ExecuteRunOutcome> {
  const session = resolveSessionState(spec, ctx);
  if ('failure' in session) return session.failure;

  const page = await ctx.manager.newPage({ storageStatePath: session.storageStatePath });
  try {
    const result = await fetchPage({
      url: spec.url,
      page,
      maxChars: spec.maxChars ?? QUEUED_FETCH_MAX_CHARS,
    });
    // Single screenshot per fetch run: the settled page, as step 0 — HTML
    // only (PDFs never render; the page stayed blank or aborted navigation).
    if (result.contentType === 'html') {
      ctx.screenshots.capture(page, 0);
    }
    return {
      status: 'success',
      output: result,
      finalUrl: result.finalUrl,
    };
  } finally {
    // Let in-flight captures land while the page is still alive.
    await ctx.screenshots.flush();
    await page
      .context()
      .close()
      .catch(() => {});
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    // Unparseable URLs share one rate-limit bucket; execution will surface
    // the real navigation error.
    return '';
  }
}
