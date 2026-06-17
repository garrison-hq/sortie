/**
 * Tests for WP05: live-view session management, input scoping, and HTTP
 * resume/cancel endpoints (T026).
 *
 * All tests mock the CDP session and RunQueue so no real browser is required.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, vi, type MockedFunction } from 'vitest';
import type { WebSocket } from '@fastify/websocket';
import type { RunStore } from '@garrison-hq/sortie';
import { buildApp } from './app.js';

/** Safe temp dir path via os.tmpdir() (avoids sonarjs/publicly-writable-directories). */
const TEST_DATA_DIR = join(tmpdir(), 'sortie-server-test');

// ---------------------------------------------------------------------------
// CDP session mock
// ---------------------------------------------------------------------------

function makeCdpSession() {
  const handlers = new Map<string, ((params: unknown) => void)[]>();
  return {
    send: vi.fn().mockResolvedValue({}),
    on: vi.fn((event: string, handler: (params: unknown) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    detach: vi.fn().mockResolvedValue(undefined),
    /** Test helper: emit a CDP screencast frame. */
    emitFrame(data: string, sessionId: number): void {
      const frame = {
        data,
        sessionId,
        metadata: { offsetTop: 0, pageScaleFactor: 1, deviceWidth: 1280, deviceHeight: 900 },
      };
      for (const h of handlers.get('Page.screencastFrame') ?? []) {
        h(frame);
      }
    },
    /** Test helper: emit any named CDP event with arbitrary params. */
    emitEvent(event: string, params: unknown): void {
      for (const h of handlers.get(event) ?? []) {
        h(params);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// RunQueue mock
// ---------------------------------------------------------------------------

type RunStatus = 'pending' | 'running' | 'awaiting_human' | 'completed' | 'failed' | 'cancelled';

interface MockRunRecord {
  id: string;
  status: RunStatus;
}

function makeQueue(
  runs: Map<string, MockRunRecord>,
  cdpSession: ReturnType<typeof makeCdpSession>,
) {
  return {
    submit: vi.fn(),
    submitBatch: vi.fn(),
    cancel: vi.fn().mockReturnValue(true),
    resume: vi.fn().mockReturnValue(true),
    cdpSessionForRun: vi.fn().mockResolvedValue(cdpSession),
    onEvent: vi.fn().mockReturnValue(() => {}),
    drain: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    _runs: runs,
  };
}

// ---------------------------------------------------------------------------
// RunStore mock
// ---------------------------------------------------------------------------

function makeStore(runs: Map<string, MockRunRecord>) {
  return {
    getRun: vi.fn((id: string) => runs.get(id) ?? null),
    listRuns: vi.fn().mockReturnValue([]),
    countRuns: vi.fn().mockReturnValue(0),
    getSteps: vi.fn().mockReturnValue([]),
    updateRun: vi.fn((id: string, patch: Partial<MockRunRecord>) => {
      const rec = runs.get(id);
      if (rec) {
        Object.assign(rec, patch);
        return { ...rec };
      }
      return null;
    }),
    listQueries: vi.fn().mockReturnValue([]),
    getQuery: vi.fn().mockReturnValue(null),
    createQuery: vi.fn(),
    updateQuery: vi.fn(),
    deleteQuery: vi.fn().mockReturnValue(false),
    listProfiles: vi.fn().mockReturnValue([]),
    getProfile: vi.fn().mockReturnValue(null),
    upsertProfile: vi.fn(),
    deleteProfile: vi.fn().mockReturnValue(false),
    profileStatePath: vi.fn().mockReturnValue(join(TEST_DATA_DIR, 'profile.json')),
    touchProfile: vi.fn(),
    exportRuns: vi.fn().mockReturnValue('[]'),
    close: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Test helpers — consolidate cast sites to a single location (S4325)
// ---------------------------------------------------------------------------

/** Build a typed WebSocket stand-in. The cast lives here, not at every call site. */
function makeMockSocket(): WebSocket {
  return { readyState: 1, OPEN: 1, send: vi.fn() } as unknown as WebSocket;
}

/** Build a WebSocket that records every sent message into `sent`. */
function makeSentSocket<T = { t: string }>(): { socket: WebSocket; sent: T[] } {
  const sent: T[] = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    send: vi.fn((m: string) => sent.push(JSON.parse(m) as T)),
  } as unknown as WebSocket;
  return { socket, sent };
}

/** Find the first lv:stopped message in a sent-messages array. */
function findStopped<T extends { t: string }>(sent: T[]): T | undefined {
  return sent.find((m) => m.t === 'lv:stopped');
}

/** Attach a test session, performing all required type coercions in one place. */
async function attachTestSession(
  connId: symbol,
  runId: string,
  queue: ReturnType<typeof makeQueue>,
  store: ReturnType<typeof makeStore>,
  socket: WebSocket = makeMockSocket(),
): Promise<void> {
  const { attachSession } = await import('./liveview.js');
  // `store` mock needs a bridging cast: a NodeNext dual-module RunStatus
  // mismatch makes the structurally-complete mock non-assignable to RunStore.
  await attachSession(connId, runId, socket, queue, store as unknown as RunStore);
}

/** Build a runs map + cdp + queue + store in one call. */
function setupLiveTest(runId: string, status: RunStatus = 'awaiting_human') {
  const runs = new Map<string, MockRunRecord>([[runId, { id: runId, status }]]);
  const cdp = makeCdpSession();
  const queue = makeQueue(runs, cdp);
  const store = makeStore(runs);
  return { runs, cdp, queue, store };
}

// ---------------------------------------------------------------------------
// App builder helper
// ---------------------------------------------------------------------------

async function buildTestApp(
  runs: Map<string, MockRunRecord>,
  cdpSession: ReturnType<typeof makeCdpSession>,
) {
  const queue = makeQueue(runs, cdpSession);
  const store = makeStore(runs);
  const app = await buildApp({
    store: store as never,
    queue: queue as never,
    dataDir: TEST_DATA_DIR,
  });
  return { app, queue, store };
}

/**
 * Build an app whose queue captures all onEvent listeners into an array so
 * tests can fire synthetic events. Returns the app + the captured listeners
 * array alongside the underlying queue/store/cdp from setupLiveTest.
 */
async function buildEventCapturingApp(runId: string, status: RunStatus = 'awaiting_human') {
  const { cdp, queue: baseQueue, store } = setupLiveTest(runId, status);
  const eventListeners: ((ev: unknown) => void)[] = [];
  const queue = {
    ...baseQueue,
    onEvent: vi.fn((cb: (ev: unknown) => void) => {
      eventListeners.push(cb);
      return () => {};
    }),
  };
  const app = await buildApp({
    store: store as never,
    queue: queue as never,
    dataDir: TEST_DATA_DIR,
  });
  return { app, cdp, queue, store, eventListeners };
}

/** Fire an event through every captured listener and flush microtasks. */
async function fireEvent(eventListeners: ((ev: unknown) => void)[], ev: unknown): Promise<void> {
  for (const listener of eventListeners) {
    listener(ev);
  }
  await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// T026: Resume endpoint tests
// ---------------------------------------------------------------------------

describe('POST /api/runs/:id/resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 when run does not exist', async () => {
    const { app } = await buildTestApp(new Map(), makeCdpSession());
    const res = await app.inject({ method: 'POST', url: '/api/runs/nonexistent/resume' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 409 when run is not awaiting_human', async () => {
    const runs = new Map([['run-1', { id: 'run-1', status: 'running' as RunStatus }]]);
    const { app } = await buildTestApp(runs, makeCdpSession());
    const res = await app.inject({ method: 'POST', url: '/api/runs/run-1/resume' });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('returns 200 and calls queue.resume when run is awaiting_human', async () => {
    const runs = new Map([['run-2', { id: 'run-2', status: 'awaiting_human' as RunStatus }]]);
    const { app, queue } = await buildTestApp(runs, makeCdpSession());
    const res = await app.inject({ method: 'POST', url: '/api/runs/run-2/resume' });
    expect(res.statusCode).toBe(200);
    expect(queue.resume).toHaveBeenCalledWith('run-2');
    await app.close();
  });

  it('returns 409 when queue.resume returns false (race condition)', async () => {
    const runs = new Map([['run-3', { id: 'run-3', status: 'awaiting_human' as RunStatus }]]);
    const { app, queue } = await buildTestApp(runs, makeCdpSession());
    (queue.resume as MockedFunction<() => boolean>).mockReturnValue(false);
    const res = await app.inject({ method: 'POST', url: '/api/runs/run-3/resume' });
    expect(res.statusCode).toBe(409);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// T026: DELETE /api/runs/:id — awaiting_human extension
// ---------------------------------------------------------------------------

describe('DELETE /api/runs/:id with awaiting_human', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 when run does not exist', async () => {
    const { app } = await buildTestApp(new Map(), makeCdpSession());
    const res = await app.inject({ method: 'DELETE', url: '/api/runs/nonexistent' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('calls queue.cancel for awaiting_human run', async () => {
    const runs = new Map([['run-4', { id: 'run-4', status: 'awaiting_human' as RunStatus }]]);
    const { app, queue } = await buildTestApp(runs, makeCdpSession());
    const res = await app.inject({ method: 'DELETE', url: '/api/runs/run-4' });
    expect(res.statusCode).toBe(200);
    expect(queue.cancel).toHaveBeenCalledWith('run-4');
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// T026: input rejected when run not awaiting_human or not owned by connection
// ---------------------------------------------------------------------------

describe('live-view input scoping (T025/T026)', () => {
  it('dispatchMouse is a no-op when no session is attached for connId', async () => {
    const { dispatchMouse } = await import('./liveview.js');
    const connId = Symbol('orphan-conn');
    // Should not throw — just silently ignore.
    await expect(
      dispatchMouse(connId, {
        t: 'lv:mouse',
        runId: 'run-x',
        event: 'mousePressed',
        x: 100,
        y: 100,
        button: 'left',
      }),
    ).resolves.toBeUndefined();
  });

  it('dispatchKey is a no-op when no session is attached for connId', async () => {
    const { dispatchKey } = await import('./liveview.js');
    const connId = Symbol('orphan-conn');
    await expect(
      dispatchKey(connId, {
        t: 'lv:key',
        runId: 'run-x',
        event: 'keyDown',
        key: 'Enter',
      }),
    ).resolves.toBeUndefined();
  });

  it('attachSession sends lv:stopped when run is not awaiting_human', async () => {
    const connId = Symbol('test-conn');
    const { queue, store } = setupLiveTest('run-active', 'running');
    const { socket, sent } = makeSentSocket<{ t: string }>();

    await attachTestSession(connId, 'run-active', queue, store, socket);

    expect(sent.some((m) => m.t === 'lv:stopped')).toBe(true);
    // CDP session should not have been requested.
    expect(queue.cdpSessionForRun).not.toHaveBeenCalled();
  });

  it('stopSession is idempotent', async () => {
    const { stopSession } = await import('./liveview.js');
    const connId = Symbol('idem-conn');
    // Calling on a non-existent session should be safe.
    await expect(stopSession(connId)).resolves.toBeUndefined();
    await expect(stopSession(connId)).resolves.toBeUndefined();
  });

  // --- Security: Finding 2 — awaiting_human re-check at dispatch time --------

  it('SECURITY: dispatchMouse drops input when run status has left awaiting_human (Finding 2)', async () => {
    // This test verifies T025: input MUST be re-checked against the store at
    // dispatch time. Without the fix, CDP dispatchMouseEvent would be called
    // even after the run transitions to a non-paused state.
    const { dispatchMouse } = await import('./liveview.js');
    const connId = Symbol('status-flip-mouse');
    const { runs, cdp, queue, store } = setupLiveTest('run-flip');

    // Attach while awaiting_human — session is created successfully.
    await attachTestSession(connId, 'run-flip', queue, store);

    // Simulate the run finishing / resuming (status leaves awaiting_human).
    runs.set('run-flip', { id: 'run-flip', status: 'running' });

    // Input after status flip should be rejected — CDP must NOT be called.
    cdp.send.mockClear();
    await dispatchMouse(connId, {
      t: 'lv:mouse',
      runId: 'run-flip',
      event: 'mousePressed',
      x: 100,
      y: 100,
      button: 'left',
    });

    // Without Finding-2 fix, cdp.send would have been called with
    // 'Input.dispatchMouseEvent'. With the fix it must NOT be called.
    const mouseDispatches = cdp.send.mock.calls.filter(
      (call) => call[0] === 'Input.dispatchMouseEvent',
    );
    expect(mouseDispatches).toHaveLength(0);
  });

  it('SECURITY: dispatchKey drops input when run status has left awaiting_human (Finding 2)', async () => {
    const { dispatchKey } = await import('./liveview.js');
    const connId = Symbol('status-flip-key');
    const { runs, cdp, queue, store } = setupLiveTest('run-flip-key');

    await attachTestSession(connId, 'run-flip-key', queue, store);

    // Status transitions away from awaiting_human.
    runs.set('run-flip-key', { id: 'run-flip-key', status: 'completed' });

    cdp.send.mockClear();
    await dispatchKey(connId, {
      t: 'lv:key',
      runId: 'run-flip-key',
      event: 'keyDown',
      key: 'Enter',
    });

    const keyDispatches = cdp.send.mock.calls.filter(
      (call) => call[0] === 'Input.dispatchKeyEvent',
    );
    expect(keyDispatches).toHaveLength(0);
  });

  // --- Security: runId mismatch — cross-run input injection -----------------

  it('SECURITY: connection attached to run A cannot dispatch input for run B (runId mismatch)', async () => {
    // Guards the isActiveSession runId-mismatch branch. Without this guard a
    // connection owning run A could send input carrying run B's runId and have
    // it dispatched to B's CDP session.
    const { dispatchMouse } = await import('./liveview.js');
    const connId = Symbol('run-a-conn');
    const runs = new Map<string, MockRunRecord>([
      ['run-a', { id: 'run-a', status: 'awaiting_human' }],
      ['run-b', { id: 'run-b', status: 'awaiting_human' }],
    ]);
    const cdp = makeCdpSession();
    const queue = makeQueue(runs, cdp);
    const store = makeStore(runs);

    // Attach to run-a.
    await attachTestSession(connId, 'run-a', queue, store);
    cdp.send.mockClear();

    // Send input claiming to target run-b — must be dropped.
    await dispatchMouse(connId, {
      t: 'lv:mouse',
      runId: 'run-b',
      event: 'mousePressed',
      x: 50,
      y: 50,
      button: 'left',
    });

    const mouseDispatches = cdp.send.mock.calls.filter(
      (call) => call[0] === 'Input.dispatchMouseEvent',
    );
    expect(mouseDispatches).toHaveLength(0);
  });

  // --- Security: connection hijack — second connection cannot take over ------

  it('SECURITY: second connection cannot attach to a run already owned by another connection', async () => {
    // Guards against unauthorized takeover / connection hijack.
    // The second attach on a different connId for the SAME run returns lv:stopped
    // (cdpSessionForRun returns null for already-attached runs per the queue contract),
    // or at minimum does NOT create a second active session pointing at the same run.
    const connA = Symbol('hijack-conn-a');
    const connB = Symbol('hijack-conn-b');
    const { queue, store } = setupLiveTest('run-owned');

    const { socket: socketA, sent: sentA } = makeSentSocket<{ t: string }>();
    const { socket: socketB, sent: sentB } = makeSentSocket<{ t: string }>();

    // First connection attaches successfully.
    await attachTestSession(connA, 'run-owned', queue, store, socketA);
    expect(sentA.some((m) => m.t === 'lv:started')).toBe(true);

    // Second connection tries to attach to the same run — simulate the queue
    // returning null for an already-attached run (the expected contract).
    queue.cdpSessionForRun.mockResolvedValueOnce(null);
    await attachTestSession(connB, 'run-owned', queue, store, socketB);

    // The second connection must receive lv:stopped (error), not lv:started.
    expect(sentB.some((m) => m.t === 'lv:stopped')).toBe(true);
    expect(sentB.some((m) => m.t === 'lv:started')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T026 / Finding 1: navigation to foreign origin tears down the live-view session
// ---------------------------------------------------------------------------

describe('SECURITY: origin constraint enforcement (Finding 1 / T022)', () => {
  it('SECURITY: attachSession sends Page.enable on the CDP session (production delivery guard)', async () => {
    // Guards the production enforcement path: Page-domain lifecycle events
    // (including Page.frameNavigated) are ONLY delivered by Chromium to a CDP
    // session that has itself called Page.enable. Without this call the origin
    // guard handler is registered but dead — it will never fire in production.
    // This test MUST fail against any implementation that omits Page.enable.
    const connId = Symbol('page-enable-guard');
    const { cdp, queue, store } = setupLiveTest('run-pe');

    await attachTestSession(connId, 'run-pe', queue, store);

    // Page.enable MUST have been sent on the live-view CDP session. Without it
    // Chromium will never emit Page.frameNavigated to this session and the
    // origin guard will be inert in production.
    expect(cdp.send).toHaveBeenCalledWith('Page.enable');
  });

  it('navigating the top frame to a foreign origin tears down the session', async () => {
    // Guards Finding 1. Before the fix, Page.frameNavigated was never subscribed
    // to, so navigation to a foreign origin left the session alive and input would
    // continue to be dispatched.
    const { dispatchMouse } = await import('./liveview.js');
    const connId = Symbol('nav-guard-conn');
    const { cdp, queue, store } = setupLiveTest('run-nav');

    // Simulate Target.getTargetInfo returning a known origin.
    cdp.send.mockImplementation((method: string) => {
      if (method === 'Target.getTargetInfo') {
        return Promise.resolve({ targetInfo: { url: 'https://example.com/challenge' } });
      }
      return Promise.resolve({});
    });

    const { socket, sent } = makeSentSocket<{ t: string; reason?: string }>();
    await attachTestSession(connId, 'run-nav', queue, store, socket);

    // Verify Page.enable was sent — without it the handler is dead in production.
    expect(cdp.send).toHaveBeenCalledWith('Page.enable');

    // Simulate the page navigating to a foreign origin (top frame: no parentId).
    cdp.emitEvent('Page.frameNavigated', {
      frame: { url: 'https://evil.example.org/phishing' },
    });

    // Allow the async teardown to settle.
    await Promise.resolve();

    // The session must have been torn down — lv:stopped with reason 'error'.
    const stopped = findStopped(sent);
    expect(stopped).toBeDefined();
    expect(stopped?.reason).toBe('error');

    // Subsequent input must be dropped (session.stopped === true).
    cdp.send.mockClear();
    await dispatchMouse(connId, {
      t: 'lv:mouse',
      runId: 'run-nav',
      event: 'mousePressed',
      x: 50,
      y: 50,
    });
    const mouseDispatches = cdp.send.mock.calls.filter(
      (call) => call[0] === 'Input.dispatchMouseEvent',
    );
    expect(mouseDispatches).toHaveLength(0);
  });

  it('navigation within the same origin does NOT tear down the session', async () => {
    // Guards against false-positives: same-origin navigations (e.g. challenge
    // step redirects within the same site) must not kill the session.
    const { dispatchMouse } = await import('./liveview.js');
    const connId = Symbol('same-origin-nav-conn');
    const { cdp, queue, store } = setupLiveTest('run-same-origin');

    cdp.send.mockImplementation((method: string) => {
      if (method === 'Target.getTargetInfo') {
        return Promise.resolve({ targetInfo: { url: 'https://example.com/step1' } });
      }
      return Promise.resolve({});
    });

    const { socket, sent } = makeSentSocket<{ t: string }>();
    await attachTestSession(connId, 'run-same-origin', queue, store, socket);

    // Same-origin navigation — should NOT trigger teardown.
    cdp.emitEvent('Page.frameNavigated', {
      frame: { url: 'https://example.com/step2' },
    });
    await Promise.resolve();

    expect(findStopped(sent)).toBeUndefined();

    // Input must still work.
    cdp.send.mockClear();
    await dispatchMouse(connId, {
      t: 'lv:mouse',
      runId: 'run-same-origin',
      event: 'mouseMoved',
      x: 200,
      y: 200,
    });
    const mouseDispatches = cdp.send.mock.calls.filter(
      (call) => call[0] === 'Input.dispatchMouseEvent',
    );
    expect(mouseDispatches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// T021 / Finding 3: live-view session teardown on run-finished / run-resumed
// ---------------------------------------------------------------------------

describe('SECURITY: live-view session torn down on queue finish/resume (Finding 3 / T021)', () => {
  it('stopSessionForRun stops the CDP session and removes it from the sessions map', async () => {
    // Directly verify Finding 3's teardown seam. Before the fix, timeout/auto-
    // resume left CDP sessions dangling because stopSessionForRun was never called.
    const { stopSessionForRun } = await import('./liveview.js');
    const connId = Symbol('teardown-conn');
    const { cdp, queue, store } = setupLiveTest('run-td');

    await attachTestSession(connId, 'run-td', queue, store);

    // Verify session is active (CDP should be alive).
    expect(cdp.detach).not.toHaveBeenCalled();

    // Simulate queue emitting run-finished (timeout path).
    await stopSessionForRun('run-td');

    // CDP screencast must be stopped and session detached.
    expect(cdp.send).toHaveBeenCalledWith('Page.stopScreencast');
    expect(cdp.detach).toHaveBeenCalled();
  });

  it('run-finished event via queue.onEvent triggers stopSessionForRun (server-level listener)', async () => {
    // This test verifies the global onEvent listener added in ws.ts (Finding 3).
    // Before the fix, onEvent was only used per-connection for forwarding events;
    // there was no server-level listener to call stopSessionForRun on run-finished.
    const connId = Symbol('global-event-teardown');
    // buildEventCapturingApp registers the server-level onEvent listener
    // (Finding 3 fix in ws.ts) and exposes the captured listeners.
    const { app, cdp, queue, store, eventListeners } = await buildEventCapturingApp('run-evtd');

    // Manually attach a live-view session (simulates a WS client attaching).
    await attachTestSession(connId, 'run-evtd', queue, store);

    // Confirm session is alive.
    expect(cdp.detach).not.toHaveBeenCalled();

    // Fire a run-finished event through all registered listeners (simulates timeout).
    await fireEvent(eventListeners, { type: 'run-finished', runId: 'run-evtd' });

    // CDP must be detached — session was torn down.
    expect(cdp.detach).toHaveBeenCalled();

    await app.close();
  });

  it('run-resumed event via queue.onEvent also triggers session teardown (auto-resume path)', async () => {
    const connId = Symbol('auto-resume-teardown');
    const { app, cdp, queue, store, eventListeners } = await buildEventCapturingApp('run-resume');

    await attachTestSession(connId, 'run-resume', queue, store);
    expect(cdp.detach).not.toHaveBeenCalled();

    // Simulate auto-resume (detector solved the challenge internally).
    await fireEvent(eventListeners, {
      type: 'run-resumed',
      runId: 'run-resume',
      resolution: 'solved',
      solveSource: 'auto',
    });

    expect(cdp.detach).toHaveBeenCalled();

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// F-3: lv:stopped{reason:'timeout'} is emitted on solve-timeout teardown
// ---------------------------------------------------------------------------

describe('F-3: lv:stopped{reason:"timeout"} emitted on solve-timeout (LvStoppedSchema)', () => {
  it('stopSessionForRun with reason:"timeout" sends lv:stopped{reason:"timeout"} before tearing down', async () => {
    // Directly verify that passing reason:'timeout' to stopSessionForRun causes
    // the message to be sent to the attached socket before CDP teardown.
    const { stopSessionForRun } = await import('./liveview.js');
    const connId = Symbol('timeout-reason-conn');
    const { cdp, queue, store } = setupLiveTest('run-timeout');
    const { socket, sent } = makeSentSocket<{ t: string; reason?: string; runId?: string }>();

    await attachTestSession(connId, 'run-timeout', queue, store, socket);

    // Simulate the timeout teardown path — pass reason:'timeout'.
    await stopSessionForRun('run-timeout', 'timeout');

    // lv:stopped{reason:'timeout'} must have been sent to the client socket.
    const stopped = findStopped(sent);
    expect(stopped).toBeDefined();
    expect(stopped?.reason).toBe('timeout');
    expect(stopped?.runId).toBe('run-timeout');

    // CDP must also have been torn down.
    expect(cdp.detach).toHaveBeenCalled();
  });

  it('stopSessionForRun without reason does NOT send lv:stopped (caller handles it)', async () => {
    // When no reason is passed the socket must NOT receive lv:stopped — the
    // caller (e.g. lv:resume handler) has already sent it.
    const { stopSessionForRun } = await import('./liveview.js');
    const connId = Symbol('no-reason-conn');
    const { cdp, queue, store } = setupLiveTest('run-no-reason');
    const { socket, sent } = makeSentSocket<{ t: string }>();

    await attachTestSession(connId, 'run-no-reason', queue, store, socket);
    (socket.send as unknown as ReturnType<typeof vi.fn>).mockClear();
    sent.length = 0;

    await stopSessionForRun('run-no-reason');

    // No lv:stopped should have been sent by stopSessionForRun itself.
    expect(findStopped(sent)).toBeUndefined();
    expect(cdp.detach).toHaveBeenCalled();
  });

  it('captcha_unsolved run-finished emits lv:stopped{reason:"timeout"} via server-level listener', async () => {
    // End-to-end: verify the ws.ts server-level onEvent handler detects a
    // captcha_unsolved failure and passes reason:'timeout' to stopSessionForRun.
    const connId = Symbol('captcha-unsolved-conn');
    const { app, cdp, queue, store, eventListeners } = await buildEventCapturingApp('run-cu');

    const { socket, sent } = makeSentSocket<{ t: string; reason?: string }>();
    await attachTestSession(connId, 'run-cu', queue, store, socket);

    // Simulate the timeout-triggered run-finished event (failureReason = captcha_unsolved).
    await fireEvent(eventListeners, {
      type: 'run-finished',
      runId: 'run-cu',
      record: { id: 'run-cu', status: 'failed', failureReason: 'captcha_unsolved' },
    });

    // lv:stopped{reason:'timeout'} must have been sent to the attached socket.
    const stopped = findStopped(sent);
    expect(stopped).toBeDefined();
    expect(stopped?.reason).toBe('timeout');

    // CDP torn down.
    expect(cdp.detach).toHaveBeenCalled();

    await app.close();
  });

  it('non-captcha run-finished does NOT send lv:stopped{timeout} (normal finish)', async () => {
    // A run that finishes successfully should NOT trigger lv:stopped{timeout}.
    const connId = Symbol('normal-finish-conn');
    const { app, queue, store, eventListeners } = await buildEventCapturingApp('run-ok');

    const { socket, sent } = makeSentSocket<{ t: string; reason?: string }>();
    await attachTestSession(connId, 'run-ok', queue, store, socket);
    (socket.send as unknown as ReturnType<typeof vi.fn>).mockClear();
    sent.length = 0;

    // Normal success finish — no captcha_unsolved failureReason.
    await fireEvent(eventListeners, {
      type: 'run-finished',
      runId: 'run-ok',
      record: { id: 'run-ok', status: 'success' },
    });

    // No lv:stopped should have been sent via the timeout path.
    expect(findStopped(sent)).toBeUndefined();

    await app.close();
  });
});
