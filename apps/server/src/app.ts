/**
 * Fastify app assembly: WebSocket events, REST routes, and (when a UI build
 * exists) static serving with an SPA fallback.
 *
 * The Fastify logger stays off — the server logs concisely to stderr from
 * index.ts and keeps response bodies as the only stdout-equivalent output.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { RunQueue, RunStore } from '@garrison-hq/sortie';
import { registerRoutes } from './routes.js';
import { registerEventsRoute } from './ws.js';

export interface AppDeps {
  store: RunStore;
  queue: RunQueue;
  /** Root data directory; screenshots live under <dataDir>/screenshots/<runId>/. */
  dataDir: string;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(websocket);
  registerEventsRoute(app, deps.queue);
  registerRoutes(app, deps);

  const uiDist = resolveUiDist();
  if (uiDist) {
    await app.register(fastifyStatic, { root: uiDist });
    // SPA fallback: unknown non-API GETs serve the UI shell so client-side
    // routes deep-link correctly; everything else is a JSON 404.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  } else {
    app.get('/', async () => ({
      ok: true,
      name: '@garrison-hq/sortie-server',
      message: 'UI build not found — API only. See /api/health.',
    }));
  }

  return app;
}

/**
 * Locate the built UI (apps/ui/dist), resolved relative to the server
 * package dir so it works from both src/ (tsx dev) and dist/ (production).
 */
function resolveUiDist(): string | undefined {
  const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const uiDist = resolve(packageDir, '../ui/dist');
  return existsSync(uiDist) ? uiDist : undefined;
}
