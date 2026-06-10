/**
 * Live event stream: GET /api/events (WebSocket).
 *
 * On connect a hello frame is sent, then every queue RunEvent is forwarded
 * as JSON. Events are rewritten for the wire:
 * - 'run-screenshot': screenshot.path becomes the API URL
 *   /api/runs/<runId>/screenshots/<stepIndex> so browser clients can fetch it
 *   (the on-disk path is meaningless outside the server host).
 * - 'run-step': step.observation is truncated to keep frames small.
 *
 * Wire events are shallow copies — the queue's event objects are shared with
 * other listeners and must never be mutated.
 */
import type { FastifyInstance } from 'fastify';
import type { RunEvent, RunQueue } from '@garrison-hq/sortie';
import { VERSION } from '@garrison-hq/sortie';

const WIRE_OBSERVATION_MAX_CHARS = 2000;

export function registerEventsRoute(app: FastifyInstance, queue: RunQueue): void {
  app.get('/api/events', { websocket: true }, (socket) => {
    socket.send(JSON.stringify({ type: 'hello', version: VERSION }));

    const unsubscribe = queue.onEvent((ev) => {
      if (socket.readyState !== socket.OPEN) return;
      try {
        socket.send(JSON.stringify(toWireEvent(ev)));
      } catch {
        // A failing socket must never disturb the queue's event fan-out.
      }
    });

    socket.on('close', unsubscribe);
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
  return ev;
}
