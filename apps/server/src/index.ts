/**
 * sortie API server entry point.
 *
 * Boot order: load .env (cwd, then repo root) -> open the shared RunStore
 * and RunQueue -> assemble the Fastify app -> listen on
 * SORTIE_HOST:SORTIE_PORT (defaults 0.0.0.0:3470 — the deployment
 * target is a remote Docker host, so localhost is never assumed).
 *
 * SIGINT/SIGTERM close the HTTP server, drain the queue's active work via
 * shutdown(), close the store, and exit 0.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRunQueue, createRunStore } from '@garrison-hq/sortie';
import { buildApp } from './app.js';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 3470;

function log(message: string): void {
  process.stderr.write(`[sortie-server] ${message}\n`);
}

function loadDotEnv(): void {
  const candidates: string[] = [join(process.cwd(), '.env')];
  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot) {
    candidates.push(join(repoRoot, '.env'));
  }
  for (const candidate of candidates) {
    try {
      process.loadEnvFile(candidate);
      return; // first hit wins
    } catch {
      // file missing or unreadable — try the next location
    }
  }
}

function findRepoRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) || existsSync(join(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    log(`invalid SORTIE_PORT "${value}" — using ${DEFAULT_PORT}`);
    return DEFAULT_PORT;
  }
  return port;
}

async function main(): Promise<void> {
  loadDotEnv();

  const host = process.env.SORTIE_HOST ?? DEFAULT_HOST;
  const port = parsePort(process.env.SORTIE_PORT);
  const dataDir = resolve(process.env.SORTIE_DATA_DIR ?? './data');

  // One shared store + queue back every route and the WebSocket stream.
  const store = createRunStore();
  const queue = createRunQueue(store);
  const app = await buildApp({ store, queue, dataDir });

  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    log(`${signal} received — shutting down`);
    void (async () => {
      try {
        await app.close();
        await queue.shutdown();
        store.close();
      } catch (err) {
        log(`shutdown error: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(0);
    })();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const address = await app.listen({ host, port });
  log(`listening on ${address} (data dir: ${dataDir})`);
}

try {
  await main();
} catch (err: unknown) {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
}
