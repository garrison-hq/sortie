/**
 * REST routes for the nanofish API server.
 *
 * All endpoints speak JSON (screenshot JPEGs aside). Bodies and query
 * strings are validated manually (see validate.ts) and rejected with clear
 * 400s; unknown resources answer 404 {error}.
 */
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  VERSION,
  fetchPage,
  isSlug,
  prepareSavedQueryRun,
  search,
  summarizeProfileState,
} from '@nanofish/core';
import type {
  ProfileStateSummary,
  RunQueue,
  RunSpec,
  RunStore,
  SearchEngineId,
} from '@nanofish/core';
import {
  isRecord,
  parseListQuery,
  readQueryParam,
  toQueryRunOverrides,
  toRunSpec,
  validateFetchBody,
  validateProfileImportBody,
  validateQueryBody,
  validateQueryRunBody,
  validateRunSpec,
  validateSearchBody,
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
type NameParams = { Params: { name: string } };

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
    const spec = toRunSpec(body['spec'] as Record<string, unknown>);
    const profileProblem = unknownProfileProblem(store, spec);
    if (profileProblem) return badRequest(reply, profileProblem);
    const record = queue.submit(spec);
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
    const runSpecs = specs.map((spec) => toRunSpec(spec as Record<string, unknown>));
    runSpecs.forEach((spec, i) => {
      const problem = unknownProfileProblem(store, spec);
      if (problem) problems.push(`specs[${i}]: ${problem}`);
    });
    if (problems.length > 0) {
      return badRequest(reply, 'Invalid run specs.', problems);
    }
    const result = queue.submitBatch(runSpecs);
    return reply.code(201).send(result);
  });

  app.get<{ Querystring: Query }>('/api/runs', async (req, reply) => {
    const { opts, errors } = parseListQuery(req.query);
    if (errors.length > 0) {
      return badRequest(reply, 'Invalid query parameters.', errors);
    }
    const runs = store.listRuns(opts);
    const total = store.countRuns({
      batchId: opts.batchId,
      status: opts.status,
      queryName: opts.queryName,
    });
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

  // --- Web search & fetch (synchronous one-shots, no run record) -----------

  app.post('/api/search', async (req, reply) => {
    const problems = validateSearchBody(req.body);
    if (problems.length > 0) {
      return badRequest(reply, 'Invalid search request.', problems);
    }
    const body = req.body as Record<string, unknown>;
    try {
      return await search(body['query'] as string, {
        maxResults: body['maxResults'] as number | undefined,
        engines: body['engines'] as SearchEngineId[] | undefined,
      });
    } catch (err) {
      return badGateway(reply, errorMessage(err));
    }
  });

  app.post('/api/fetch', async (req, reply) => {
    const problems = validateFetchBody(req.body);
    if (problems.length > 0) {
      return badRequest(reply, 'Invalid fetch request.', problems);
    }
    const body = req.body as Record<string, unknown>;
    try {
      return await fetchPage({
        url: body['url'] as string,
        maxChars: body['maxChars'] as number | undefined,
        includeLinks: body['includeLinks'] as boolean | undefined,
      });
    } catch (err) {
      return badGateway(reply, errorMessage(err));
    }
  });

  // --- Saved queries --------------------------------------------------------

  app.get('/api/queries', async () => ({ queries: store.listQueries() }));

  app.post('/api/queries', async (req, reply) => {
    const problems = validateQueryBody(req.body);
    if (problems.length > 0) {
      return badRequest(reply, 'Invalid query.', problems);
    }
    const body = req.body as Record<string, unknown>;
    const name = body['name'] as string;
    if (store.getQuery(name)) {
      return conflict(reply, `A query named "${name}" already exists.`);
    }
    const query = store.createQuery(name, toRunSpec(body['spec'] as Record<string, unknown>));
    return reply.code(201).send(query);
  });

  app.get<NameParams>('/api/queries/:name', async (req, reply) => {
    const name = req.params.name;
    const query = isSlug(name) ? store.getQuery(name) : undefined;
    if (!query) return notFound(reply, 'Query not found.');
    return query;
  });

  app.put<NameParams>('/api/queries/:name', async (req, reply) => {
    const name = req.params.name;
    if (!isSlug(name) || !store.getQuery(name)) {
      return notFound(reply, 'Query not found.');
    }
    const problems = validateQueryBody(req.body, true);
    if (problems.length > 0) {
      return badRequest(reply, 'Invalid query.', problems);
    }
    const body = req.body as Record<string, unknown>;
    return store.updateQuery(name, toRunSpec(body['spec'] as Record<string, unknown>));
  });

  app.delete<NameParams>('/api/queries/:name', async (req, reply) => {
    const name = req.params.name;
    if (!isSlug(name) || !store.deleteQuery(name)) {
      return notFound(reply, 'Query not found.');
    }
    return { deleted: true };
  });

  app.post<NameParams>('/api/queries/:name/run', async (req, reply) => {
    const name = req.params.name;
    const query = isSlug(name) ? store.getQuery(name) : undefined;
    if (!query) return notFound(reply, 'Query not found.');
    const problems = validateQueryRunBody(req.body);
    if (problems.length > 0) {
      return badRequest(reply, 'Invalid run overrides.', problems);
    }
    // Fast feedback before stats are bumped: a spec pointing at a deleted
    // profile would only fail at execution time otherwise.
    const profileProblem = unknownProfileProblem(store, query.spec);
    if (profileProblem) return badRequest(reply, profileProblem);
    const spec = prepareSavedQueryRun(store, name, toQueryRunOverrides(req.body));
    const record = queue.submit(spec);
    return reply.code(201).send(record);
  });

  // --- Login profiles -------------------------------------------------------
  // Metadata + value-free staleness summaries only; the storage-state JSON
  // (live session cookies) never leaves the server's disk.

  app.get('/api/profiles', async () => ({
    profiles: store.listProfiles().map((profile) => {
      let state: ProfileStateSummary | undefined;
      let stateError: string | undefined;
      try {
        state = summarizeProfileState(store.profileStatePath(profile.name));
      } catch (err) {
        stateError = errorMessage(err);
      }
      return { ...profile, ...(state !== undefined ? { state } : { stateError }) };
    }),
  }));

  app.delete<NameParams>('/api/profiles/:name', async (req, reply) => {
    const name = req.params.name;
    if (!isSlug(name) || !store.deleteProfile(name)) {
      return notFound(reply, 'Profile not found.');
    }
    return { deleted: true };
  });

  // Write-only remote bootstrap: the state body is written straight to the
  // profile's 0600 state file and never logged or echoed back (the Fastify
  // logger is off; the response carries metadata + summary only). Intended
  // for trusted networks — the API has no auth, like the rest of the server.
  app.post('/api/profiles/import', async (req, reply) => {
    const problems = validateProfileImportBody(req.body);
    if (problems.length > 0) {
      return badRequest(reply, 'Invalid profile import.', problems);
    }
    const body = req.body as Record<string, unknown>;
    const name = body['name'] as string;
    const statePath = store.profileStatePath(name);
    const stateDir = dirname(statePath);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700); // mkdir mode is ignored when the dir already exists
    await writeFile(statePath, JSON.stringify(body['state']), { mode: 0o600 });
    await chmod(statePath, 0o600); // writeFile mode is ignored when the file already exists
    const profile = store.upsertProfile({
      name,
      domainHint: body['domainHint'] as string | undefined,
      notes: body['notes'] as string | undefined,
    });
    return reply.code(201).send({ profile, state: summarizeProfileState(statePath) });
  });
}

/**
 * 400-style problem when a spec names a profile the store doesn't know —
 * fast feedback at submission instead of a failed run at execution.
 */
function unknownProfileProblem(store: RunStore, spec: RunSpec): string | undefined {
  if (spec.profile !== undefined && !store.getProfile(spec.profile)) {
    return `unknown profile "${spec.profile}" — create it first (nanofish profile login) or import it via POST /api/profiles/import`;
  }
  return undefined;
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

function conflict(reply: FastifyReply, error: string): FastifyReply {
  return reply.code(409).send({ error });
}

/** Upstream (search backend / target site) failure on a synchronous route. */
function badGateway(reply: FastifyReply, error: string): FastifyReply {
  return reply.code(502).send({ error });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
