/**
 * REST routes for the nanofish API server.
 *
 * All endpoints speak JSON (screenshot JPEGs aside). Bodies and query
 * strings are validated manually (see validate.ts) and rejected with clear
 * 400s; unknown resources answer 404 {error}.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { VERSION } from '@nanofish/core';
import type { RunQueue, RunStore } from '@nanofish/core';
import {
  isRecord,
  parseListQuery,
  readQueryParam,
  toRunSpec,
  validateRunSpec,
} from './validate.js';

const MAX_BATCH_SPECS = 100;
/** Run ids are UUIDs; anything outside this never touches the filesystem. */
const RUN_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const SCREENSHOT_FILE_PATTERN = /^(\d+)\.jpg$/;
const SCREENSHOT_INDEX_PATTERN = /^\d{1,9}$/;

export interface RouteDeps {
  store: RunStore;
  queue: RunQueue;
  /** Root data directory; screenshots live under <dataDir>/screenshots/<runId>/. */
  dataDir: string;
}

type Query = Record<string, unknown>;
type IdParams = { Params: { id: string } };

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, queue, dataDir } = deps;
  const screenshotsRoot = join(dataDir, 'screenshots');

  app.get('/api/health', async () => ({ ok: true, version: VERSION }));

  app.post('/api/runs', async (req, reply) => {
    const body = req.body;
    if (!isRecord(body) || body['spec'] === undefined) {
      return badRequest(reply, 'Request body must be a JSON object with a `spec` field.');
    }
    const problems = validateRunSpec(body['spec']);
    if (problems.length > 0) {
      return badRequest(reply, 'Invalid run spec.', problems);
    }
    const record = queue.submit(toRunSpec(body['spec'] as Record<string, unknown>));
    return reply.code(201).send(record);
  });

  app.post('/api/batches', async (req, reply) => {
    const body = req.body;
    if (!isRecord(body) || !Array.isArray(body['specs'])) {
      return badRequest(reply, 'Request body must be a JSON object with a `specs` array.');
    }
    const specs = body['specs'];
    if (specs.length < 1 || specs.length > MAX_BATCH_SPECS) {
      return badRequest(
        reply,
        `\`specs\` must contain between 1 and ${MAX_BATCH_SPECS} run specs (got ${specs.length}).`,
      );
    }
    const problems: string[] = [];
    specs.forEach((spec, i) => {
      for (const problem of validateRunSpec(spec)) {
        problems.push(`specs[${i}]: ${problem}`);
      }
    });
    if (problems.length > 0) {
      return badRequest(reply, 'Invalid run specs.', problems);
    }
    const result = queue.submitBatch(
      specs.map((spec) => toRunSpec(spec as Record<string, unknown>)),
    );
    return reply.code(201).send(result);
  });

  app.get<{ Querystring: Query }>('/api/runs', async (req, reply) => {
    const { opts, errors } = parseListQuery(req.query);
    if (errors.length > 0) {
      return badRequest(reply, 'Invalid query parameters.', errors);
    }
    const runs = store.listRuns(opts);
    const total = store.countRuns({ batchId: opts.batchId, status: opts.status });
    return { runs, total };
  });

  app.get<IdParams>('/api/runs/:id', async (req, reply) => {
    const record = store.getRun(req.params.id);
    if (!record) return notFound(reply, 'Run not found.');
    return { record, steps: store.getSteps(record.id) };
  });

  app.delete<IdParams>('/api/runs/:id', async (req, reply) => {
    const record = store.getRun(req.params.id);
    if (!record) return notFound(reply, 'Run not found.');
    return { cancelled: queue.cancel(record.id) };
  });

  app.get<IdParams>('/api/runs/:id/screenshots', async (req, reply) => {
    const id = req.params.id;
    if (!RUN_ID_PATTERN.test(id) || !store.getRun(id)) {
      return notFound(reply, 'Run not found.');
    }
    const indexes = await listScreenshotIndexes(join(screenshotsRoot, id));
    return { indexes };
  });

  app.get<{ Params: { id: string; idx: string } }>(
    '/api/runs/:id/screenshots/:idx',
    async (req, reply) => {
      const { id, idx } = req.params;
      if (!RUN_ID_PATTERN.test(id) || !SCREENSHOT_INDEX_PATTERN.test(idx)) {
        return notFound(reply, 'Screenshot not found.');
      }
      const dir = join(screenshotsRoot, id);
      const fileName = await findScreenshotFile(dir, Number(idx));
      if (!fileName) return notFound(reply, 'Screenshot not found.');
      const data = await readFile(join(dir, fileName)).catch(() => null);
      if (!data) return notFound(reply, 'Screenshot not found.');
      return reply.type('image/jpeg').send(data);
    },
  );

  app.get<{ Querystring: Query }>('/api/export', async (req, reply) => {
    const errors: string[] = [];
    const format = readQueryParam(req.query, 'format', errors) ?? 'json';
    const batchId = readQueryParam(req.query, 'batch', errors);
    if (format !== 'json' && format !== 'csv') {
      errors.push('format must be "json" or "csv"');
    }
    if (errors.length > 0) {
      return badRequest(reply, 'Invalid query parameters.', errors);
    }
    const body = store.exportRuns({
      format: format as 'json' | 'csv',
      ...(batchId !== undefined ? { batchId } : {}),
    });
    return reply
      .type(format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="export.${format}"`)
      .send(body);
  });
}

/** Numeric step indexes of the `<n>.jpg` files in `dir` ([] if missing). */
async function listScreenshotIndexes(dir: string): Promise<number[]> {
  const indexes: number[] = [];
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    const match = SCREENSHOT_FILE_PATTERN.exec(entry);
    if (match) indexes.push(Number(match[1]));
  }
  return indexes.sort((a, b) => a - b);
}

/**
 * Find the screenshot file for a step index by scanning the directory and
 * comparing numerically (robust to zero-padded filenames). The filename is
 * always a real directory entry, never raw client input.
 */
async function findScreenshotFile(dir: string, index: number): Promise<string | undefined> {
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    const match = SCREENSHOT_FILE_PATTERN.exec(entry);
    if (match && Number(match[1]) === index) return entry;
  }
  return undefined;
}

function badRequest(reply: FastifyReply, error: string, details?: string[]): FastifyReply {
  return reply.code(400).send(details && details.length > 0 ? { error, details } : { error });
}

function notFound(reply: FastifyReply, error: string): FastifyReply {
  return reply.code(404).send({ error });
}
