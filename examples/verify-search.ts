/**
 * Live verification of @nanofish/core's web search against real engines.
 *
 * Run from the repo root:
 *   npx tsx examples/verify-search.ts
 *
 * Backend selection mirrors the library: when SEARXNG_BASE_URL is set the
 * SearXNG path is exercised (and the source is asserted to be 'searxng');
 * otherwise the browser-engine fallback chain (bing -> duckduckgo -> brave)
 * runs against the live SERPs.
 *
 * Checks:
 *   1. search() returns >= 3 results for a plain-English query.
 *   2. Every result URL is an absolute http(s) URL.
 *   3. Positions are 1-based and sequential; URLs are deduped.
 *   4. source is 'searxng' when SEARXNG_BASE_URL is set, an engine id otherwise.
 *
 * Scope note: anti-bot evasion is out of scope. If every engine in the chain
 * serves a challenge page, search() fails with a clear reason — this script
 * reports that as SKIPPED (graceful failure is the contracted behavior) and
 * exits 0.
 */
// Import the built package directly (the repo root is not a workspace consumer
// of @nanofish/core, so the bare specifier is not resolvable from examples/).
import { createProvider, search } from '../packages/core/dist/index.js';
import type { LlmProvider } from '../packages/core/dist/index.js';

const QUERY = 'playwright web automation';

let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  const status = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  console.log(`[${status}] ${label}${detail ? ` — ${detail}` : ''}`);
}

function loadDotEnv(): void {
  try {
    process.loadEnvFile(new URL('../.env', import.meta.url).pathname);
  } catch {
    // .env missing — rely on the ambient environment.
  }
}

function isAllChallengedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /challenge/i.test(err.message) && /SEARXNG_BASE_URL/i.test(err.message);
}

async function main(): Promise<void> {
  loadDotEnv();
  const searxng = process.env.SEARXNG_BASE_URL;
  console.log(
    searxng
      ? `Backend: SearXNG at ${searxng}`
      : 'Backend: browser-engine fallback chain (SEARXNG_BASE_URL not set)',
  );

  // Attach an LLM provider when one is configured — it powers the semantic
  // SERP-parse fallback (fast selector parse empty + not challenged). Search
  // must keep working without one, so this is best-effort, like the CLI.
  let provider: LlmProvider | undefined;
  try {
    provider = createProvider();
  } catch {
    provider = undefined;
  }

  let response;
  try {
    response = await search(QUERY, { maxResults: 8, provider });
  } catch (err) {
    if (isAllChallengedError(err)) {
      console.log(
        `[SKIPPED] all engines in the fallback chain are currently challenged — graceful failure per scope policy.\n  reason: ${(err as Error).message}`,
      );
      process.exitCode = 0;
      return;
    }
    throw err;
  }

  console.log(`source=${response.source}, ${response.results.length} result(s)\n`);
  for (const r of response.results) {
    console.log(`  ${r.position}. ${r.title}\n     ${r.url}`);
  }
  console.log('');

  check(
    `search("${QUERY}") returns >= 3 results`,
    response.results.length >= 3,
    `${response.results.length} results from ${response.source}`,
  );

  const absolute = response.results.every((r) => /^https?:\/\//.test(r.url));
  check('every result URL is absolute http(s)', absolute);

  const positionsOk = response.results.every((r, i) => r.position === i + 1);
  check('positions are 1-based and sequential', positionsOk);

  const urls = response.results.map((r) => r.url);
  check('result URLs are deduped', new Set(urls).size === urls.length);

  check(
    'every result has a non-empty title',
    response.results.every((r) => r.title.trim().length > 0),
  );

  if (searxng) {
    check('source is searxng when SEARXNG_BASE_URL is set', response.source === 'searxng');
  } else {
    check(
      'source is a browser engine id',
      ['bing', 'duckduckgo', 'brave'].includes(response.source),
      `source=${response.source}`,
    );
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error('verify-search failed:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
