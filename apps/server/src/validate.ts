/**
 * Manual request validation for the API server.
 *
 * zod is not directly importable from apps/server (it lives in
 * @nanofish/core's dependency tree under pnpm's strict layout), so request
 * bodies and query strings are validated with explicit checks that mirror
 * the RunSpec contract. Every validator returns human-readable problems
 * ([] = valid) so routes can answer with clear 400s.
 */
import type { ListRunsOptions, RunSpec, RunStatus } from '@nanofish/core';

export const RUN_STATUSES = [
  'queued',
  'running',
  'success',
  'failed',
  'max_steps',
  'cancelled',
] as const satisfies readonly RunStatus[];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate an untrusted RunSpec value; returns problems ([] = valid). */
export function validateRunSpec(value: unknown): string[] {
  if (!isRecord(value)) return ['spec must be a JSON object'];
  const errors: string[] = [];

  const kind = value['kind'];
  if (kind !== 'extract' && kind !== 'agent') {
    errors.push(`kind must be "extract" or "agent" (got ${JSON.stringify(kind)})`);
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
  return spec;
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

  return { opts, errors };
}
