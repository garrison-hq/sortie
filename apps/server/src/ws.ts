/**
 * Live event stream: GET /api/events (WebSocket).
 *
 * On connect a hello frame is sent, then every queue RunEvent is forwarded
 * as JSON. Events are rewritten for the wire:
 * - 'run-screenshot': screenshot.path becomes the API URL
 *   /api/runs/<runId>/screenshots/<stepIndex> so browser clients can fetch it
 *   (the on-disk path is meaningless outside the server host).
 * - 'run-step': step.observation is truncated to keep frames small.
 * - 'run-awaiting-human' / 'run-resumed': passed through as-is.
 *
 * Wire events are shallow copies — the queue's event objects are shared with
 * other listeners and must never be mutated.
 *
 * The socket is now bidirectional (WP05): the client may send live-view
 * control messages (`lv:*`) on the same connection. All inbound text frames
 * are zod-validated; malformed messages are dropped and logged — never thrown
 * across the socket (T025).
 *
 * DEPLOYMENT (R9): live remote control assumes a trusted local-first operator;
 * network-exposed deployments MUST place auth in front of the server.
 */
import type { FastifyInstance } from 'fastify';
import type { RunEvent, RunQueue, RunStore } from '@garrison-hq/sortie';
import { VERSION, LvClientMessageSchema } from '@garrison-hq/sortie';
import { handleClientMessage, stopSession, stopSessionForRun } from './liveview.js';

const WIRE_OBSERVATION_MAX_CHARS = 2000;

export function registerEventsRoute(app: FastifyInstance, queue: RunQueue, store: RunStore): void {
  // SECURITY (T021 / Finding 3): subscribe to queue events at the server level
  // so that live-view sessions are torn down on timeout, auto-resume, and any
  // non-WS finish path that bypasses the HTTP/WS control surface.
  // This listener is registered once at startup (not per-connection).
  queue.onEvent((ev) => {
    if (ev.type === 'run-finished' || ev.type === 'run-resumed') {
      stopSessionForRun(ev.runId).catch(() => {});
    }
  });

  app.get('/api/events', { websocket: true }, (socket) => {
    /** Opaque per-connection id for live-view scoping (T025). */
    const connId = Symbol('ws-conn');

    socket.send(JSON.stringify({ type: 'hello', version: VERSION }));

    const unsubscribe = queue.onEvent((ev) => {
      if (socket.readyState !== socket.OPEN) return;
      try {
        socket.send(JSON.stringify(toWireEvent(ev)));
      } catch {
        // A failing socket must never disturb the queue's event fan-out.
      }
    });

    // Inbound message handler — live-view control messages from the client.
    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let text: string;
      try {
        text = raw.toString();
      } catch {
        // Non-text frame: ignore silently.
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        console.warn('[ws] malformed JSON from client — dropped');
        return;
      }

      const result = LvClientMessageSchema.safeParse(parsed);
      if (!result.success) {
        // Not a live-view message (could be unknown client-sent data): drop.
        console.warn('[ws] inbound message failed lv schema validation — dropped');
        return;
      }

      void handleClientMessage(connId, result.data, socket, queue, store);
    });

    socket.on('close', () => {
      unsubscribe();
      // Tear down any live-view session owned by this connection.
      void stopSession(connId);
    });
    socket.on('error', () => {
      socket.close();
    });
  });
}

/** Rewrite a RunEvent for browser clients (see module doc). */
export function toWireEvent(ev: RunEvent): RunEvent {
  if (ev.type === 'run-screenshot' && ev.screenshot) {
    return {
      ...ev,
      screenshot: {
        ...ev.screenshot,
        path: `/api/runs/${ev.runId}/screenshots/${ev.screenshot.stepIndex}`,
      },
    };
  }
  if (
    ev.type === 'run-step' &&
    ev.step &&
    ev.step.observation.length > WIRE_OBSERVATION_MAX_CHARS
  ) {
    return {
      ...ev,
      step: { ...ev.step, observation: ev.step.observation.slice(0, WIRE_OBSERVATION_MAX_CHARS) },
    };
  }
  // run-awaiting-human and run-resumed pass through unchanged.
  return ev;
}
