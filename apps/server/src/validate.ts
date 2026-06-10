/**
 * Manual request validation for the API server.
 *
 * zod is not directly importable from apps/server (it lives in
 * @nanofish/core's dependency tree under pnpm's strict layout), so request
 * bodies and query strings are validated with explicit checks that mirror
 * the RunSpec contract. Every validator returns human-readable problems
 * ([] = valid) so routes can answer with clear 400s.
 */
import { isSlug } from '@nanofish/core';
import type {
  ListRunsOptions,
  QueryRunOverrides,
  RunKind,
  RunSpec,
  RunStatus,
  SearchEngineId,
} from '@nanofish/core';

export const RUN_STATUSES = [
  'queued',
  'running',
  'success',
  'failed',
  'max_steps',
  'cancelled',
] as const satisfies readonly RunStatus[];

export const RUN_KINDS = ['extract', 'agent', 'fetch'] as const satisfies readonly RunKind[];

export const SEARCH_ENGINES = [
  'bing',
  'duckduckgo',
  'brave',
] as const satisfies readonly SearchEngineId[];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate an untrusted RunSpec value; returns problems ([] = valid). */
export function validateRunSpec(value: unknown): string[] {
  if (!isRecord(value)) return ['spec must be a JSON object'];
  const errors: string[] = [];

  const kind = value['kind'];
  if (!(RUN_KINDS as readonly unknown[]).includes(kind)) {
    errors.push(`kind must be one of ${RUN_KINDS.join('|')} (got ${JSON.stringify(kind)})`);
  }
  if (typeof value['url'] !== 'string' || value['url'].trim() === '') {
    errors.push('url must be a non-empty string');
  }
  if (kind === 'agent' && (typeof value['goal'] !== 'string' || value['goal'].trim() === '')) {
    errors.push('goal (non-empty string) is required when kind is "agent"');
  }
  if (kind === 'extract' && !isRecord(value['schemaJson'])) {
    errors.push('schemaJson (a JSON Schema object) is required when kind is "extract"');
  } else if (value['schemaJson'] !== undefined && !isRecord(value['schemaJson'])) {
    errors.push('schemaJson must be a JSON object when present');
  }
  if (value['goal'] !== undefined && typeof value['goal'] !== 'string') {
    errors.push('goal must be a string when present');
  }
  if (value['instruction'] !== undefined && typeof value['instruction'] !== 'string') {
    errors.push('instruction must be a string when present');
  }
  if (
    value['maxSteps'] !== undefined &&
    (typeof value['maxSteps'] !== 'number' ||
      !Number.isInteger(value['maxSteps']) ||
      value['maxSteps'] <= 0)
  ) {
    errors.push('maxSteps must be a positive integer when present');
  }
  if (
    value['credentialNames'] !== undefined &&
    (!Array.isArray(value['credentialNames']) ||
      !value['credentialNames'].every((name) => typeof name === 'string' && name.trim() !== ''))
  ) {
    errors.push(
      'credentialNames must be an array of non-empty strings (env var NAMES) when present',
    );
  }
  if (value['storageStatePath'] !== undefined && typeof value['storageStatePath'] !== 'string') {
    errors.push('storageStatePath must be a string when present');
  }
  if (
    value['profile'] !== undefined &&
    (typeof value['profile'] !== 'string' || !isSlug(value['profile']))
  ) {
    errors.push('profile must be a slug ([a-z0-9][a-z0-9_-]{0,63}) when present');
  }
  if (value['profile'] !== undefined && value['storageStatePath'] !== undefined) {
    errors.push('profile and storageStatePath are mutually exclusive — set one or the other');
  }
  if (value['queryName'] !== undefined && typeof value['queryName'] !== 'string') {
    errors.push('queryName must be a string when present');
  }
  if (
    value['maxChars'] !== undefined &&
    (typeof value['maxChars'] !== 'number' ||
      !Number.isInteger(value['maxChars']) ||
      value['maxChars'] <= 0)
  ) {
    errors.push('maxChars must be a positive integer when present');
  }
  return errors;
}

/**
 * Build a clean RunSpec from an already-validated raw object, copying only
 * the contract's fields so unknown junk never reaches the store.
 */
export function toRunSpec(raw: Record<string, unknown>): RunSpec {
  const spec: RunSpec = {
    kind: raw['kind'] as RunSpec['kind'],
    url: raw['url'] as string,
  };
  if (isRecord(raw['schemaJson'])) spec.schemaJson = raw['schemaJson'];
  if (typeof raw['instruction'] === 'string') spec.instruction = raw['instruction'];
  if (typeof raw['goal'] === 'string') spec.goal = raw['goal'];
  if (typeof raw['maxSteps'] === 'number') spec.maxSteps = raw['maxSteps'];
  if (Array.isArray(raw['credentialNames'])) {
    spec.credentialNames = raw['credentialNames'] as string[];
  }
  if (typeof raw['storageStatePath'] === 'string') {
    spec.storageStatePath = raw['storageStatePath'];
  }
  if (typeof raw['profile'] === 'string') spec.profile = raw['profile'];
  if (typeof raw['queryName'] === 'string') spec.queryName = raw['queryName'];
  if (typeof raw['maxChars'] === 'number') spec.maxChars = raw['maxChars'];
  return spec;
}

/**
 * Validate a saved-query body ({name, spec}). `nameFromPath` skips the name
 * check for PUT /api/queries/:name, where the name comes from the URL.
 */
export function validateQueryBody(value: unknown, nameFromPath = false): string[] {
  if (!isRecord(value)) return ['body must be a JSON object'];
  const errors: string[] = [];

  if (!nameFromPath && (typeof value['name'] !== 'string' || !isSlug(value['name']))) {
    errors.push('name must be a slug ([a-z0-9][a-z0-9_-]{0,63})');
  }
  const spec = value['spec'];
  if (!isRecord(spec)) {
    errors.push('spec must be a JSON object');
    return errors;
  }
  for (const problem of validateRunSpec(spec)) {
    errors.push(`spec: ${problem}`);
  }
  if (spec['kind'] === 'agent' || spec['kind'] === 'fetch') {
    errors.push('spec: only extract specs can be saved as queries');
  }
  return errors;
}

/** Validate POST /api/queries/:name/run overrides; an absent body is valid. */
export function validateQueryRunBody(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!isRecord(value)) return ['body must be a JSON object when present'];
  const errors: string[] = [];
  if (
    value['url'] !== undefined &&
    (typeof value['url'] !== 'string' || value['url'].trim() === '')
  ) {
    errors.push('url must be a non-empty string when present');
  }
  if (value['instruction'] !== undefined && typeof value['instruction'] !== 'string') {
    errors.push('instruction must be a string when present');
  }
  return errors;
}

/** Build QueryRunOverrides from an already-validated run-overrides body. */
export function toQueryRunOverrides(value: unknown): QueryRunOverrides {
  const overrides: QueryRunOverrides = {};
  if (!isRecord(value)) return overrides;
  if (typeof value['url'] === 'string') overrides.url = value['url'];
  if (typeof value['instruction'] === 'string') overrides.instruction = value['instruction'];
  return overrides;
}

/**
 * Validate a profile-import body ({name, state, domainHint?, notes?}).
 * `state` is Playwright storage-state JSON; its cookies are shape-checked
 * (domain + expires, what the staleness summary needs) but never echoed.
 */
export function validateProfileImportBody(value: unknown): string[] {
  if (!isRecord(value)) return ['body must be a JSON object'];
  const errors: string[] = [];

  if (typeof value['name'] !== 'string' || !isSlug(value['name'])) {
    errors.push('name must be a slug ([a-z0-9][a-z0-9_-]{0,63})');
  }
  const state = value['state'];
  if (!isRecord(state)) {
    errors.push('state must be a Playwright storage-state JSON object');
  } else if (state['cookies'] !== undefined) {
    const cookies = state['cookies'];
    const wellFormed =
      Array.isArray(cookies) &&
      cookies.every(
        (cookie) =>
          isRecord(cookie) &&
          typeof cookie['domain'] === 'string' &&
          typeof cookie['expires'] === 'number',
      );
    if (!wellFormed) {
      errors.push('state.cookies must be an array of cookie objects (domain, expires)');
    }
  }
  if (value['domainHint'] !== undefined && typeof value['domainHint'] !== 'string') {
    errors.push('domainHint must be a string when present');
  }
  if (value['notes'] !== undefined && typeof value['notes'] !== 'string') {
    errors.push('notes must be a string when present');
  }
  return errors;
}

/** Validate a POST /api/search body ({query, maxResults?, engines?}). */
export function validateSearchBody(value: unknown): string[] {
  if (!isRecord(value)) return ['body must be a JSON object'];
  const errors: string[] = [];

  if (typeof value['query'] !== 'string' || value['query'].trim() === '') {
    errors.push('query must be a non-empty string');
  }
  if (
    value['maxResults'] !== undefined &&
    (typeof value['maxResults'] !== 'number' ||
      !Number.isInteger(value['maxResults']) ||
      value['maxResults'] <= 0)
  ) {
    errors.push('maxResults must be a positive integer when present');
  }
  if (value['engines'] !== undefined) {
    const engines = value['engines'];
    const valid =
      Array.isArray(engines) &&
      engines.length > 0 &&
      engines.every((engine) => (SEARCH_ENGINES as readonly unknown[]).includes(engine));
    if (!valid) {
      errors.push(`engines must be a non-empty array of ${SEARCH_ENGINES.join('|')} when present`);
    }
  }
  return errors;
}

/** True when `value` parses as an absolute http(s) URL. */
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Validate a POST /api/fetch body ({url, maxChars?, includeLinks?}). */
export function validateFetchBody(value: unknown): string[] {
  if (!isRecord(value)) return ['body must be a JSON object'];
  const errors: string[] = [];

  if (typeof value['url'] !== 'string' || value['url'].trim() === '') {
    errors.push('url must be a non-empty string');
  } else if (!isAbsoluteHttpUrl(value['url'])) {
    // /api/fetch navigates synchronously — reject malformed URLs here with a
    // 400 instead of surfacing a browser protocol error as a 502.
    errors.push('url must be an absolute http(s) URL');
  }
  if (
    value['maxChars'] !== undefined &&
    (typeof value['maxChars'] !== 'number' ||
      !Number.isInteger(value['maxChars']) ||
      value['maxChars'] <= 0)
  ) {
    errors.push('maxChars must be a positive integer when present');
  }
  if (value['includeLinks'] !== undefined && typeof value['includeLinks'] !== 'boolean') {
    errors.push('includeLinks must be a boolean when present');
  }
  return errors;
}

/**
 * Read a single-valued query parameter. Repeated params (string[]) and
 * empty values are reported as problems.
 */
export function readQueryParam(
  query: Record<string, unknown>,
  name: string,
  errors: string[],
): string | undefined {
  const value = query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') {
    errors.push(`${name} must be a single non-empty value`);
    return undefined;
  }
  return value;
}

export interface ParsedListQuery {
  opts: ListRunsOptions;
  errors: string[];
}

/** Parse `GET /api/runs` query params into ListRunsOptions. */
export function parseListQuery(query: Record<string, unknown>): ParsedListQuery {
  const errors: string[] = [];
  const opts: ListRunsOptions = {};

  const limit = readQueryParam(query, 'limit', errors);
  if (limit !== undefined) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1) errors.push('limit must be a positive integer');
    else opts.limit = n;
  }

  const offset = readQueryParam(query, 'offset', errors);
  if (offset !== undefined) {
    const n = Number(offset);
    if (!Number.isInteger(n) || n < 0) errors.push('offset must be a non-negative integer');
    else opts.offset = n;
  }

  const status = readQueryParam(query, 'status', errors);
  if (status !== undefined) {
    if (!(RUN_STATUSES as readonly string[]).includes(status)) {
      errors.push(`status must be one of ${RUN_STATUSES.join('|')}`);
    } else {
      opts.status = status as RunStatus;
    }
  }

  const batch = readQueryParam(query, 'batch', errors);
  if (batch !== undefined) opts.batchId = batch;

  const queryName = readQueryParam(query, 'query', errors);
  if (queryName !== undefined) opts.queryName = queryName;

  return { opts, errors };
}
