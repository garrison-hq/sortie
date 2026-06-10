/**
 * Saved-query replay helpers: turn a stored query (plus optional per-run
 * overrides) into a submittable RunSpec, stamping `queryName` so run history
 * stays filterable by the query it came from.
 */
import type { QueryRunOverrides, RunSpec, RunStore, SavedQuery } from '../contracts.js';

/**
 * Build the RunSpec for one replay of `query`: the saved spec with url /
 * instruction overrides applied and `queryName` set for run-history link-back.
 */
export function buildQueryRunSpec(query: SavedQuery, overrides: QueryRunOverrides = {}): RunSpec {
  return {
    ...query.spec,
    url: overrides.url ?? query.spec.url,
    instruction: overrides.instruction ?? query.spec.instruction,
    queryName: query.name,
  };
}

/**
 * Look up a saved query by name, bump its run stats (runCount, lastRunAt),
 * and return the spec to submit. Throws when no query by that name exists.
 */
export function prepareSavedQueryRun(
  store: RunStore,
  name: string,
  overrides?: QueryRunOverrides,
): RunSpec {
  const query = store.getQuery(name);
  if (!query) {
    throw new Error(`No saved query named "${name}".`);
  }
  store.recordQueryRun(name);
  return buildQueryRunSpec(query, overrides);
}
