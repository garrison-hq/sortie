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
 * Security invariant: credential VALUES are resolved from process.env at
 * execution time and handed straight to the agent loop — only env var NAMES
 * ever appear in records, events, or failure reasons.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type {
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
import { createProvider } from '../llm/index.js';
import { BrowserManager } from '../browser/index.js';
import { extract, navigateOrPdfSnapshot, jsonSchemaToZod } from '../extract/index.js';
import { fetchPage } from '../fetch/index.js';
import { runAgent } from '../agent/loop.js';

const DEFAULT_CONCURRENCY = 5;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 10;
const DEFAULT_PER_DOMAIN_INTERVAL_MS = 1000;
const DEFAULT_MAX_RETRIES = 2;
const SCREENSHOT_TIMEOUT_MS = 5000;
const SCREENSHOT_JPEG_QUALITY = 55;
/** Markdown cap for queued fetch runs — tighter than fetchPage's 80k default
 * because outputs are persisted in SQLite (store bloat guard). */
const QUEUED_FETCH_MAX_CHARS = 40_000;

function defaultScreenshotDir(): string {
  return (process.env.NANOFISH_DATA_DIR ?? './data') + '/screenshots';
}

/** What a single execution attempt settles to (or it throws: infra error). */
export interface ExecuteRunOutcome {
  status: RunStatus;
  output?: unknown;
  failureReason?: string;
  usage?: TokenUsage;
  finalUrl?: string;
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

  let active = 0;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  /** Pending wake-up for rate-limited work, plus its deadline. */
  let wakeTimer: NodeJS.Timeout | null = null;
  let wakeDeadline = 0;
  const drainWaiters: Array<() => void> = [];
  const idleWaiters: Array<() => void> = [];

  function emit(ev: RunEvent): void {
    for (const listener of [...listeners]) {
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
      void runItem(item).finally(() => {
        active--;
        settleWaiters();
        pump();
      });
    }
  }

  function settleWaiters(): void {
    if (active > 0) return;
    while (idleWaiters.length > 0) {
      idleWaiters.pop()!();
    }
    if (queue.length === 0) {
      while (drainWaiters.length > 0) {
        drainWaiters.pop()!();
      }
    }
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
      const ctx: ExecuteRunCtx = {
        manager,
        onStep,
        screenshots,
        resolveProfile,
        get provider(): LlmProvider {
          return getProvider();
        },
      };
      const outcome = await exec(item.spec, ctx);
      // In-flight captures must land before 'run-finished' so the final
      // screenshot exists when consumers react to completion.
      await screenshots.flush();
      finishRun(item, outcome);
    } catch (err) {
      await screenshots.flush();
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
      const index = queue.findIndex((item) => item.id === runId);
      if (index === -1) return false;
      const [item] = queue.splice(index, 1);
      const record = store.updateRun(runId, { status: 'cancelled', finishedAt: Date.now() });
      emit({ type: 'run-finished', runId, batchId: item!.batchId, record });
      settleWaiters();
      return true;
    },

    onEvent(listener: (ev: RunEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    drain(): Promise<void> {
      if (active === 0 && queue.length === 0) return Promise.resolve();
      return new Promise((resolve) => {
        drainWaiters.push(resolve);
      });
    },

    shutdown(): Promise<void> {
      shutdownPromise ??= (async () => {
        shuttingDown = true;
        clearWakeTimer();
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
  try {
    const result = await runAgent({
      goal: spec.goal,
      startUrl: spec.url,
      schema: spec.schemaJson ? jsonSchemaToZod(spec.schemaJson) : undefined,
      maxSteps: spec.maxSteps,
      page,
      provider: ctx.provider,
      credentials,
      onStep: (step) => {
        ctx.onStep(step);
        // Queue the capture after the step event so 'run-screenshot' always
        // follows the corresponding 'run-step'.
        ctx.screenshots.capture(page, step.index);
      },
    });
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
    await page
      .context()
      .close()
      .catch(() => {});
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
