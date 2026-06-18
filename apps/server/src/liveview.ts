/**
 * Live-view session manager: CDP screencast bridge + input relay (T021/T022).
 *
 * While a run is `awaiting_human` an operator may attach to the paused page
 * via the WebSocket live-view protocol (contracts/live-view-protocol.md).
 * This module:
 *   - Opens a CDP session for the paused page (`cdpSessionForRun`).
 *   - Starts `Page.startScreencast` and streams JPEG frames as `lv:frame`.
 *   - Acks each frame with `Page.screencastFrameAck` (backpressure: drops
 *     intermediate frames when the client lags).
 *   - Maps `lv:mouse` / `lv:key` messages to CDP input events (T022).
 *   - Stops the screencast and cleans up on resume / cancel / disconnect.
 *
 * SECURITY (C-001): this module ONLY relays human input — it never inspects
 *   or acts on page content to solve a challenge.
 * SECURITY (C-003/C-004): one session per WS connection, input accepted only
 *   for the attached run while it is `awaiting_human` (re-checked at dispatch
 *   time via `store`).
 * SECURITY (T022): navigation is constrained to the run's origin — a CDP
 *   `Page.frameNavigated` listener tears down the session if the top frame
 *   leaves the attached origin.
 * DEPLOYMENT (R9): live remote control assumes a trusted local-first operator;
 *   network-exposed deployments MUST place auth in front of the server —
 *   this module inherits the unauthenticated trust model and does NOT add auth.
 * PRIVACY: frame bytes (`dataB64`) are never logged and frames are never
 *   persisted beyond the existing screenshot capture mechanism.
 */
import type { WebSocket } from '@fastify/websocket';
import type {
  LvClientMessage,
  LvMouse,
  LvKey,
  LvStopped,
  RunQueue,
  RunStore,
} from '@garrison-hq/sortie';
import { errorMessage } from './util.js';

/**
 * Minimal CDP session surface used by this module. Matches the Playwright
 * `CDPSession` API so it can be passed directly — declared locally to avoid
 * a direct `playwright` dev-dependency in the server package.
 */
interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (params: unknown) => void): void;
  detach(): Promise<void>;
}

const SCREENCAST_JPEG_QUALITY = 75;
const SCREENCAST_MAX_WIDTH = 1280;

/** Session lifecycle state per WebSocket connection. */
export interface LiveViewSession {
  runId: string;
  /** Opaque connection id (used for scoping checks). */
  connId: symbol;
  cdpSession: CdpSession;
  viewport: { width: number; height: number };
  /**
   * Origin (scheme + host + port) of the page at attach time.
   * Navigation outside this origin is not permitted (T022 / Threat Model).
   */
  attachedOrigin: string;
  /** Monotonically increasing frame counter. */
  seq: number;
  /** When true a frame is already in-flight to the client; subsequent CDP
   *  frames are held in `pendingFrame` (backpressure: drop-to-latest). */
  sending: boolean;
  pendingFrame: ScreencastFrameParams | null;
  stopped: boolean;
  /** The RunStore for this session (used by input dispatch to re-check status). */
  store: RunStore;
  /** The WebSocket for this session (used by stopSessionForRun to send lv:stopped). */
  socket: WebSocket;
}

interface ScreencastFrameParams {
  data: string;
  metadata: {
    offsetTop: number;
    pageScaleFactor: number;
    deviceWidth: number;
    deviceHeight: number;
  };
  sessionId: number;
}

/**
 * Map from WS connection id to its live-view session (at most one per conn).
 * `store` and `socket` are fields on `LiveViewSession` so there is ONE map.
 */
const sessions = new Map<symbol, LiveViewSession>();

/** Extract the origin (scheme + host + port) from a URL string, or '' on failure. */
function extractOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * Attach a live-view session to `connId` for `runId`.
 *
 * Preconditions (enforced by caller via store):
 *   - The run exists and its status is `awaiting_human`.
 *   - No other session is already attached (if one is, it is torn down first).
 *
 * Sends `lv:started` immediately, then begins streaming frames.
 */
export async function attachSession(
  connId: symbol,
  runId: string,
  socket: WebSocket,
  queue: RunQueue,
  store: RunStore,
): Promise<void> {
  // Tear down any existing session on this connection before attaching a new one.
  await stopSession(connId);

  const record = store.getRun(runId);
  if (record?.status !== 'awaiting_human') {
    sendJson(socket, {
      t: 'lv:stopped',
      runId,
      reason: 'error' as const,
    });
    return;
  }

  const cdpSession = await queue.cdpSessionForRun(runId);
  if (!cdpSession) {
    sendJson(socket, { t: 'lv:stopped', runId, reason: 'error' as const });
    return;
  }

  // Capture the current page URL to derive the allowed origin (T022).
  // `Target.getTargetInfo` returns the page URL on the CDP target.
  let attachedOrigin = '';
  try {
    const info = (await cdpSession.send('Target.getTargetInfo')) as {
      targetInfo?: { url?: string };
    };
    attachedOrigin = extractOrigin(info?.targetInfo?.url ?? '');
  } catch {
    // Non-fatal: origin guard will block all input when origin is empty.
  }

  // Viewport is fixed per R4 (DEFAULT_VIEWPORT 1280×900).
  const viewport = { width: SCREENCAST_MAX_WIDTH, height: 900 };

  const session: LiveViewSession = {
    runId,
    connId,
    cdpSession,
    viewport,
    attachedOrigin,
    seq: 0,
    sending: false,
    pendingFrame: null,
    stopped: false,
    store,
    socket,
  };
  sessions.set(connId, session);

  // Notify client the stream is starting.
  sendJson(socket, { t: 'lv:started', runId, viewport });

  // SECURITY (T022 / Finding 1): enable the Page domain on this session so
  // that CDP actually delivers Page-domain lifecycle events (incl.
  // Page.frameNavigated) to it. Domain enablement is per-session; Playwright's
  // internal session already has Page enabled, but the fresh session returned
  // by cdpSessionForRun does not inherit that state.
  try {
    await cdpSession.send('Page.enable');
  } catch (err: unknown) {
    console.error(`[liveview] Page.enable failed for run ${runId}: ${errorMessage(err)}`);
    void stopSession(connId);
    sendJson(socket, { t: 'lv:stopped', runId, reason: 'error' as const });
    return;
  }

  // Subscribe to top-frame navigations. If the page navigates to a different
  // origin, tear down the live-view session immediately — the human must not
  // be able to drive the browser to arbitrary sites through the relay.
  cdpSession.on('Page.frameNavigated', (params: unknown) => {
    const nav = params as { frame?: { parentId?: string; url?: string } };
    const frame = nav?.frame;
    // Only react to top-frame navigations (no parentId means it's the root frame).
    if (frame?.parentId !== undefined) return;
    const navOrigin = extractOrigin(frame?.url ?? '');
    if (navOrigin && navOrigin !== session.attachedOrigin) {
      console.warn(
        `[liveview] run ${runId} navigated away from origin ${session.attachedOrigin} → ${navOrigin}; tearing down live-view session`,
      );
      void stopSession(connId);
      sendJson(socket, { t: 'lv:stopped', runId, reason: 'error' as const });
    }
  });

  // Register CDP screencast frame handler BEFORE starting the screencast.
  cdpSession.on('Page.screencastFrame', (params: ScreencastFrameParams) => {
    void handleScreencastFrame(session, params, socket);
  });

  // Start the CDP screencast.
  let screencastStarted = false;
  await cdpSession
    .send('Page.startScreencast', {
      format: 'jpeg',
      quality: SCREENCAST_JPEG_QUALITY,
      maxWidth: SCREENCAST_MAX_WIDTH,
    })
    .then(() => {
      screencastStarted = true;
    })
    .catch((err: unknown) => {
      console.error(`[liveview] startScreencast failed for run ${runId}: ${errorMessage(err)}`);
      void stopSession(connId);
      sendJson(socket, { t: 'lv:stopped', runId, reason: 'error' as const });
    });

  // For static/idle pages in headless Chromium the screencast may not emit
  // an initial frame automatically (no visual update to trigger it).
  // Force a repaint via a zero-cost DOM touch so CDP flushes the first frame.
  if (screencastStarted && !session.stopped) {
    cdpSession
      .send('Runtime.evaluate', {
        expression: `(function () {
          var el = document.documentElement;
          el.style.opacity = el.style.opacity === '0.9999' ? '1' : '0.9999';
        })()`,
        silent: true,
      })
      .catch(() => {
        // Non-fatal: the repaint hint is best-effort.
      });
  }
}

/**
 * Handle a single CDP screencast frame.
 *
 * Backpressure: if the socket is currently sending, hold the latest frame in
 * `pendingFrame` (overwriting any previous pending frame — drop-to-latest).
 * After each send completes the pending frame is flushed if present.
 *
 * Frame bytes are never logged (PRIVACY).
 */
async function handleScreencastFrame(
  session: LiveViewSession,
  params: ScreencastFrameParams,
  socket: WebSocket,
): Promise<void> {
  if (session.stopped) {
    // Ack so CDP doesn't stall, even if we're done.
    await session.cdpSession
      .send('Page.screencastFrameAck', { sessionId: params.sessionId })
      .catch(() => {});
    return;
  }

  if (session.sending) {
    // Drop-to-latest: overwrite the pending frame.
    session.pendingFrame = params;
    return;
  }

  await sendFrame(session, params, socket);

  // Flush the latest pending frame if one arrived while we were sending.
  while (session.pendingFrame !== null && !session.stopped) {
    const next = session.pendingFrame;
    session.pendingFrame = null;
    await sendFrame(session, next, socket);
  }
}

async function sendFrame(
  session: LiveViewSession,
  params: ScreencastFrameParams,
  socket: WebSocket,
): Promise<void> {
  session.sending = true;
  try {
    session.seq++;
    const msg = {
      t: 'lv:frame' as const,
      runId: session.runId,
      seq: session.seq,
      dataB64: params.data, // raw base64 from CDP — never logged
      metadata: params.metadata,
    };
    sendJson(socket, msg);
    // Ack to CDP after forwarding so it sends the next frame (backpressure).
    await session.cdpSession
      .send('Page.screencastFrameAck', { sessionId: params.sessionId })
      .catch(() => {});
  } finally {
    session.sending = false;
  }
}

/**
 * Stop and remove the live-view session attached to `connId`.
 * Safe to call multiple times (idempotent after first call).
 * The caller is responsible for sending `lv:stopped` with the appropriate reason.
 */
export async function stopSession(connId: symbol): Promise<void> {
  const session = sessions.get(connId);
  if (!session || session.stopped) return;

  session.stopped = true;
  sessions.delete(connId);

  await session.cdpSession.send('Page.stopScreencast').catch(() => {});
  await session.cdpSession.detach().catch(() => {});
}

/**
 * Stop the session for `runId` regardless of which connection owns it, and
 * optionally send `lv:stopped` to the attached client before tearing down.
 *
 * Pass `reason` when the stop is initiated by an external event (e.g. solve
 * timeout → `'timeout'`) so the client learns why the live view closed.
 * Omit `reason` when the caller has already sent `lv:stopped` (e.g.
 * `lv:resume` / `lv:cancel` handler in `handleClientMessage`).
 *
 * F-3: emits `lv:stopped{reason:'timeout'}` on the timeout teardown path so
 * the typed `reason` enum member is no longer dead.
 */
export async function stopSessionForRun(
  runId: string,
  reason?: LvStopped['reason'],
): Promise<void> {
  for (const [connId, session] of sessions) {
    if (session.runId === runId) {
      if (reason !== undefined) {
        sendJson(session.socket, { t: 'lv:stopped', runId, reason });
      }
      await stopSession(connId);
      return;
    }
  }
}

/**
 * Detach handler — called when a client sends `lv:detach` or disconnects.
 * Tears down the screencast; the run stays paused (operator just closed the view).
 */
export async function detachSession(connId: symbol): Promise<void> {
  await stopSession(connId);
}

// ---------------------------------------------------------------------------
// Input relay (T022)
// ---------------------------------------------------------------------------

/**
 * Dispatch a `lv:mouse` message as a CDP `Input.dispatchMouseEvent`.
 *
 * Coordinates arrive in page pixels from the client (client maps via frame
 * metadata, R4). Validated against the viewport before dispatch (C-003).
 *
 * SECURITY (T025 / Finding 2): the run's current status is re-read from the
 * store at dispatch time. Input is dropped unless the run is still
 * `awaiting_human` — this guards against the race where the run transitions
 * away from `awaiting_human` (timeout / auto-resume) before the live-view
 * session has been torn down.
 */
export async function dispatchMouse(connId: symbol, msg: LvMouse): Promise<void> {
  const session = sessions.get(connId);
  if (!isActiveSession(session, msg.runId)) return;
  if (!isRunAwaitingHuman(session, session.runId)) return;

  // Validate coordinates within viewport.
  const { width, height } = session.viewport;
  if (msg.x < 0 || msg.x > width || msg.y < 0 || msg.y > height) {
    console.warn(
      `[liveview] mouse coords (${msg.x},${msg.y}) out of viewport ${width}×${height} — dropped`,
    );
    return;
  }

  await session.cdpSession
    .send('Input.dispatchMouseEvent', {
      type: msg.event,
      x: msg.x,
      y: msg.y,
      button: msg.button ?? 'none',
      buttons: msg.buttons ?? 0,
      clickCount: msg.clickCount ?? 0,
      deltaX: msg.deltaX ?? 0,
      deltaY: msg.deltaY ?? 0,
      modifiers: 0,
    })
    .catch((err: unknown) => {
      console.warn(`[liveview] dispatchMouseEvent failed: ${errorMessage(err)}`);
    });
}

/**
 * Dispatch a `lv:key` message as a CDP `Input.dispatchKeyEvent`.
 *
 * SECURITY (T025 / Finding 2): same `awaiting_human` re-check as dispatchMouse.
 */
export async function dispatchKey(connId: symbol, msg: LvKey): Promise<void> {
  const session = sessions.get(connId);
  if (!isActiveSession(session, msg.runId)) return;
  if (!isRunAwaitingHuman(session, session.runId)) return;

  await session.cdpSession
    .send('Input.dispatchKeyEvent', {
      type: msg.event,
      key: msg.key ?? '',
      code: msg.code ?? '',
      text: msg.text ?? '',
      modifiers: msg.modifiers ?? 0,
    })
    .catch((err: unknown) => {
      console.warn(`[liveview] dispatchKeyEvent failed: ${errorMessage(err)}`);
    });
}

// ---------------------------------------------------------------------------
// Message dispatch entry-point (called from ws.ts)
// ---------------------------------------------------------------------------

/**
 * Route a validated inbound `LvClientMessage` to the appropriate handler.
 * This is the single entry-point called from `ws.ts` for live-view messages.
 */
export async function handleClientMessage(
  connId: symbol,
  msg: LvClientMessage,
  socket: WebSocket,
  queue: RunQueue,
  store: RunStore,
): Promise<void> {
  switch (msg.t) {
    case 'lv:attach':
      await attachSession(connId, msg.runId, socket, queue, store);
      break;
    case 'lv:detach':
      await detachSession(connId);
      break;
    case 'lv:mouse':
      await dispatchMouse(connId, msg);
      break;
    case 'lv:key':
      await dispatchKey(connId, msg);
      break;
    case 'lv:resume': {
      // Tear down live view before resuming — the agent loop takes over.
      await stopSession(connId);
      sendJson(socket, { t: 'lv:stopped', runId: msg.runId, reason: 'resumed' as const });
      const resumed = queue.resume(msg.runId);
      if (!resumed) {
        console.warn(`[liveview] lv:resume for unknown/non-paused run ${msg.runId}`);
      }
      break;
    }
    case 'lv:cancel': {
      await stopSession(connId);
      sendJson(socket, { t: 'lv:stopped', runId: msg.runId, reason: 'cancelled' as const });
      const cancelled = queue.cancel(msg.runId);
      if (!cancelled) {
        console.warn(`[liveview] lv:cancel for unknown run ${msg.runId}`);
      }
      break;
    }
  }
}

/** Returns the session if it is active and scoped to `runId`. */
function isActiveSession(
  session: LiveViewSession | undefined,
  runId: string,
): session is LiveViewSession {
  if (!session || session.stopped) return false;
  if (session.runId !== runId) {
    console.warn(
      `[liveview] input for run ${runId} rejected — connection owns run ${session.runId}`,
    );
    return false;
  }
  return true;
}

/**
 * Re-checks the run's current status against the store (Finding 2 / T025).
 * Returns true only when the run is still `awaiting_human`.
 * Drops and logs when the run has left the paused state.
 */
function isRunAwaitingHuman(session: LiveViewSession, runId: string): boolean {
  const record = session.store.getRun(runId);
  if (record?.status !== 'awaiting_human') {
    console.warn(
      `[liveview] input for run ${runId} dropped — run status is "${record?.status ?? 'unknown'}", not "awaiting_human"`,
    );
    return false;
  }
  return true;
}

/** Send a JSON message on the socket, swallowing errors. */
function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // A failing socket must never disturb the live-view loop.
  }
}
