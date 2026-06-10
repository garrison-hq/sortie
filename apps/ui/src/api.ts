/**
 * Typed REST client for the nanofish server.
 *
 * Same-origin `/api` paths: the Vite dev server proxies them to the local
 * nanofish server, and in production the server serves the UI itself.
 * Response shapes are normalized defensively (bare record vs `{ record }`
 * wrapper, bare array vs `{ runs }`) so the UI tolerates either convention.
 */
import type {
  ProfileInfo,
  ProfileStateSummary,
  QueryRunOverrides,
  RunRecord,
  RunSpec,
  SavedQuery,
  StepRecord,
} from './types';

export class ApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ApiError(
      `Cannot reach the nanofish server (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(extractErrorMessage(text) ?? `${res.status} ${res.statusText}`, res.status);
  }
  if (text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(`Server returned non-JSON for ${path}.`, res.status);
  }
}

/** Pull a human-readable message out of an error response body. */
function extractErrorMessage(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const message = obj['error'] ?? obj['message'];
      if (typeof message === 'string' && message !== '') return message;
    }
  } catch {
    // not JSON — fall through
  }
  return body.trim() !== '' && body.length < 300 ? body.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Accept a bare RunRecord or a `{ record }` / `{ run }` wrapper. */
function unwrapRunRecord(body: unknown): RunRecord | undefined {
  if (!isRecord(body)) return undefined;
  if (typeof body['id'] === 'string' && isRecord(body['spec'])) {
    return body as unknown as RunRecord;
  }
  for (const key of ['record', 'run']) {
    const nested = body[key];
    if (isRecord(nested) && typeof nested['id'] === 'string') {
      return nested as unknown as RunRecord;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export async function createRun(spec: RunSpec): Promise<RunRecord> {
  const body = await request('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ spec }),
  });
  const record = unwrapRunRecord(body);
  if (!record) throw new ApiError('POST /api/runs returned an unrecognized payload.');
  return record;
}

export async function listRuns(): Promise<RunRecord[]> {
  const body = await request('/api/runs');
  if (Array.isArray(body)) return body as RunRecord[];
  if (isRecord(body) && Array.isArray(body['runs'])) return body['runs'] as RunRecord[];
  return [];
}

export interface RunWithSteps {
  record: RunRecord;
  steps: StepRecord[];
}

export async function getRun(id: string): Promise<RunWithSteps> {
  const body = await request(`/api/runs/${encodeURIComponent(id)}`);
  const record = unwrapRunRecord(body);
  if (!record) throw new ApiError(`Run ${id} not found.`, 404);
  // Steps may ride along on the top-level body or inside the record itself.
  const steps =
    isRecord(body) && Array.isArray(body['steps'])
      ? (body['steps'] as StepRecord[])
      : Array.isArray((record as unknown as Record<string, unknown>)['steps'])
        ? ((record as unknown as Record<string, unknown>)['steps'] as StepRecord[])
        : [];
  return { record, steps };
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

export interface ScreenshotRef {
  stepIndex: number;
  /** Browser-loadable image URL. */
  url: string;
}

/**
 * Resolve a screenshot reference (WS event payload or listing entry) to an
 * image URL. Prefers a server-provided URL; otherwise derives one from the
 * stored file name under the run's screenshots endpoint.
 */
export function screenshotImageUrl(
  runId: string,
  shot: { stepIndex: number; path?: string; url?: string },
): string {
  const direct = shot.url ?? shot.path;
  if (direct !== undefined && (/^https?:\/\//.test(direct) || direct.startsWith('/api/'))) {
    return direct;
  }
  if (shot.path !== undefined) {
    const basename = shot.path.split('/').pop();
    if (basename !== undefined && basename !== '') {
      return `/api/runs/${encodeURIComponent(runId)}/screenshots/${encodeURIComponent(basename)}`;
    }
  }
  return `/api/runs/${encodeURIComponent(runId)}/screenshots/${shot.stepIndex}`;
}

/** Fetch all persisted screenshots for a run, sorted by step index. */
export async function listScreenshots(runId: string): Promise<ScreenshotRef[]> {
  const body = await request(`/api/runs/${encodeURIComponent(runId)}/screenshots`);
  // The nanofish server answers { indexes: number[] }; tolerate bare arrays
  // and { screenshots } wrappers too (same defensive stance as runs above).
  const items: unknown[] = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body['indexes'])
      ? (body['indexes'] as unknown[])
      : isRecord(body) && Array.isArray(body['screenshots'])
        ? (body['screenshots'] as unknown[])
        : [];

  const shots: ScreenshotRef[] = [];
  for (const item of items) {
    const shot = normalizeScreenshot(runId, item);
    if (shot) shots.push(shot);
  }
  return shots.sort((a, b) => a.stepIndex - b.stepIndex);
}

function normalizeScreenshot(runId: string, item: unknown): ScreenshotRef | undefined {
  if (typeof item === 'number' && Number.isInteger(item)) {
    return { stepIndex: item, url: screenshotImageUrl(runId, { stepIndex: item }) };
  }
  if (typeof item === 'string') {
    const stepIndex = stepIndexFromName(item);
    if (stepIndex === undefined) return undefined;
    return { stepIndex, url: screenshotImageUrl(runId, { stepIndex, path: item }) };
  }
  if (isRecord(item)) {
    const path = typeof item['path'] === 'string' ? item['path'] : undefined;
    const url = typeof item['url'] === 'string' ? item['url'] : undefined;
    const stepIndex =
      typeof item['stepIndex'] === 'number'
        ? item['stepIndex']
        : stepIndexFromName(path ?? url ?? '');
    if (stepIndex === undefined) return undefined;
    return { stepIndex, url: screenshotImageUrl(runId, { stepIndex, path, url }) };
  }
  return undefined;
}

/** Best-effort step index from a file name like ".../step-0007.jpg". */
function stepIndexFromName(name: string): number | undefined {
  const basename = name.split('/').pop() ?? '';
  const match = /(\d+)(?!.*\d)/.exec(basename);
  return match ? Number(match[1]) : undefined;
}

// ---------------------------------------------------------------------------
// Saved queries
// ---------------------------------------------------------------------------

export async function listQueries(): Promise<SavedQuery[]> {
  const body = await request('/api/queries');
  if (Array.isArray(body)) return body as SavedQuery[];
  if (isRecord(body) && Array.isArray(body['queries'])) return body['queries'] as SavedQuery[];
  return [];
}

export async function createQuery(name: string, spec: RunSpec): Promise<SavedQuery> {
  const body = await request('/api/queries', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, spec }),
  });
  // Accept a bare SavedQuery or a { query } wrapper.
  if (isRecord(body)) {
    if (typeof body['name'] === 'string' && isRecord(body['spec'])) {
      return body as unknown as SavedQuery;
    }
    const nested = body['query'];
    if (isRecord(nested) && typeof nested['name'] === 'string') {
      return nested as unknown as SavedQuery;
    }
  }
  throw new ApiError('POST /api/queries returned an unrecognized payload.');
}

export async function deleteQuery(name: string): Promise<void> {
  await request(`/api/queries/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

/** Replay a saved query (optionally on an overridden URL/instruction);
 * resolves to the queued RunRecord. */
export async function runQuery(name: string, overrides?: QueryRunOverrides): Promise<RunRecord> {
  const body = await request(`/api/queries/${encodeURIComponent(name)}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(overrides ?? {}),
  });
  const record = unwrapRunRecord(body);
  if (!record) {
    throw new ApiError(`POST /api/queries/${name}/run returned an unrecognized payload.`);
  }
  return record;
}

// ---------------------------------------------------------------------------
// Login profiles (metadata only — state JSON never reaches the browser)
// ---------------------------------------------------------------------------

const EMPTY_PROFILE_STATE: ProfileStateSummary = {
  exists: false,
  cookieCount: 0,
  sessionCookieCount: 0,
  expiredCookieCount: 0,
  domains: [],
};

export async function listProfiles(): Promise<ProfileInfo[]> {
  const body = await request('/api/profiles');
  const items: unknown[] = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body['profiles'])
      ? (body['profiles'] as unknown[])
      : [];
  const profiles: ProfileInfo[] = [];
  for (const item of items) {
    if (!isRecord(item) || typeof item['name'] !== 'string') continue;
    // The state summary may ride along as `state` or `summary`.
    const state = isRecord(item['state'])
      ? (item['state'] as unknown as ProfileStateSummary)
      : isRecord(item['summary'])
        ? (item['summary'] as unknown as ProfileStateSummary)
        : EMPTY_PROFILE_STATE;
    profiles.push({ ...(item as unknown as ProfileInfo), state });
  }
  return profiles;
}

export async function deleteProfile(name: string): Promise<void> {
  await request(`/api/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function batchCsvExportUrl(batchId: string): string {
  return `/api/export?batch=${encodeURIComponent(batchId)}&format=csv`;
}
