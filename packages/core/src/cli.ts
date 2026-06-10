#!/usr/bin/env node
/**
 * sortie CLI — semantic extraction, multi-step agent runs, web search,
 * URL→Markdown fetch, saved queries, login profiles, batches, and persisted
 * run inspection.
 *
 *   sortie extract <url> --schema <inline-JSON-or-@file>
 *     [--instruction <text>] [--provider anthropic|openai] [--model <m>]
 *     [--out <file>] [--headful] [--profile <name>]
 *
 *   sortie agent <startUrl> --goal <text>
 *     [--schema <inline-JSON-or-@file>] [--max-steps N] [--cred NAME ...]
 *     [--headful] [--out <file>] [--storage-state <path>] [--trace <file>]
 *     [--profile <name>] [--save-profile <name>]
 *
 *   sortie search "<query>" [--max-results N] [--engine <id> ...] [--out <file>]
 *   sortie fetch <url> [--format markdown|text|json] [--max-chars N] [--out <file>]
 *
 *   sortie query save <name> (--url <u> --schema <s> [--instruction <t>] | --from-run <id>)
 *   sortie query list | show <name> | run <name> [--url <u>] [--instruction <t>] | delete <name>
 *
 *   sortie profile login <name> --url <loginUrl> [--notes <text>]
 *   sortie profile list | check <name> | delete <name>
 *
 *   sortie batch <specs-file>
 *     [--concurrency N] [--data-dir <path>] [--export <file.json|file.csv>]
 *     [--provider anthropic|openai] [--model <m>]
 *
 *   sortie runs list [--limit N] [--status <s>] [--batch <id>] [--data-dir <path>]
 *   sortie runs show <id> [--data-dir <path>]
 *   sortie runs export <file.json|file.csv> [--batch <id>] [--data-dir <path>]
 */
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Page } from 'playwright';
import type { z } from 'zod';
import type {
  ListRunsOptions,
  LlmProvider,
  PageSnapshot,
  ProviderConfig,
  RunEvent,
  RunRecord,
  RunSpec,
  RunStatus,
  RunStore,
  SearchEngineId,
  StepRecord,
} from './contracts.js';
import { createProvider } from './llm/index.js';
import { BrowserManager } from './browser/index.js';
import { extract, navigateAndSettle, navigateOrPdfSnapshot } from './extract/index.js';
import { jsonSchemaToZod } from './extract/schema.js';
import { runAgent } from './agent/loop.js';
import { search } from './search/index.js';
import { fetchPage } from './fetch/index.js';
import { isSlug } from './naming.js';
import { persistProfileState, summarizeProfileState } from './profiles.js';
import { createRunStore, prepareSavedQueryRun } from './store/index.js';
import { createRunQueue } from './runtime/index.js';

const HELP = `sortie — semantic web extraction & web agents

Usage:
  sortie extract <url> --schema <inline-JSON-or-@file> [options]
  sortie agent <startUrl> --goal <text> [options]
  sortie search "<query>" [options]
  sortie fetch <url> [options]
  sortie query <save|list|show|run|delete> [args] [options]
  sortie profile <login|list|check|delete> [args] [options]
  sortie batch <specs-file> [options]
  sortie runs <list|show|export> [args] [options]

Extract options:
  --schema <value>        JSON Schema for the result. Inline JSON, or @path/to/file.json
  --instruction <text>    Natural-language hint about what to extract
  --profile <name>        Use a saved login profile's session (see "profile login");
                          mutually exclusive with --storage-state
  --out <file>            Also write the extracted JSON to this file

Agent options:
  --goal <text>           Natural-language goal for the agent (required)
  --schema <value>        JSON Schema for the agent's final output (inline or @file)
  --max-steps <n>         Hard cap on agent steps (default 25)
  --cred <NAME>           Pass the secret in env var NAME to the agent (repeatable).
                          The model only ever sees the name as {{cred:NAME}};
                          the value is read from the environment and never printed.
  --storage-state <path>  Playwright storage-state JSON for session reuse (logins)
  --profile <name>        Use a saved login profile's session; mutually
                          exclusive with --storage-state
  --save-profile <name>   After a SUCCESSFUL run, save the browser session
                          (cookies + localStorage) as login profile <name>
  --out <file>            Write the agent's output data (JSON) to this file
  --trace <file>          Write the full run trace (all steps) as JSON to this file

Search options:
  --max-results <n>       Number of results (default 10, capped at 20)
  --engine <id>           Browser fallback engine: bing | duckduckgo | brave.
                          Repeatable; order given = fallback order. Not used
                          when a SearXNG instance (SEARXNG_BASE_URL) answers.
  --out <file>            Also write the result JSON to this file

Fetch options:
  --format <f>            Output format: markdown (default) | text | json
                          (json = the full result object: url, finalUrl,
                          title, markdown, text, contentType, truncated)
  --max-chars <n>         Cap on markdown/text length (default 80000)
  --out <file>            Also write the output to this file

Query subcommands (named, replayable extract specs):
  query save <name>       Save an extract spec under a slug name. Either:
    --url <url> --schema <value> [--instruction <text>]
                            define the spec inline, or
    --from-run <id>         copy the spec of a persisted extract run (full id
                            or unique short-id prefix); --url, --instruction,
                            and --schema override the copied fields
  query list              Table of saved queries on stdout
  query show <name>       Full saved query (spec included) as JSON on stdout
  query run <name>        Replay the query through the run queue — the run is
                          persisted and linked back via its queryName
    --url <url>             Override the saved URL for this replay only
    --instruction <text>    Override the saved instruction for this replay only
    --out <file>            Also write the run output JSON to this file
  query delete <name>     Delete the saved query (run history is kept)

Profile subcommands (named login sessions):
  profile login <name>    Open a HEADFUL browser at --url; log in manually in
                          the window, then press Enter in the terminal to save
                          the session as profile <name>
    --url <loginUrl>        Login page to open (required)
    --notes <text>          Free-form note stored with the profile
  profile list            Table of profiles with a cookie summary on stdout
  profile check <name>    Metadata + storage-state staleness summary (cookie
                          counts, domains, earliest expiry) as JSON on stdout
  profile delete <name>   Remove the profile AND its storage-state file

  Security: profiles contain live session cookies. The storage-state JSON is
  written with mode 0600 under <dataDir>/profiles/ and is never printed,
  logged, stored in the database, or sent to the model.

Batch options:
  <specs-file>            Run specs: a .json file (array of specs) or a .jsonl file
                          (one spec per line). Each spec: {"kind":"extract"|"agent"|
                          "fetch", "url":"...", "schemaJson":{...} (required for
                          extract), "goal":"..." (required for agent), plus optional
                          "instruction", "maxSteps", "credentialNames" (env var
                          NAMES — values are resolved at execution time, never
                          stored), "storageStatePath", "profile" (named login
                          profile — mutually exclusive with storageStatePath), and
                          "maxChars" (fetch markdown cap, default 40000).
  --concurrency <n>       Parallel browser workers (default 5, clamped 1..10)
  --export <file>         After the batch drains, export run outputs for the
                          batch to this file; format from extension (.json|.csv)

Runs subcommands:
  runs list               Table of persisted runs (newest first) on stdout
    --limit <n>             Max rows to show
    --status <s>            Filter: queued|running|success|failed|max_steps|cancelled
    --batch <id>            Only runs from this batch
  runs show <id>          Full run record (including steps) as JSON on stdout.
                          Accepts a full id or a unique short-id prefix.
  runs export <file>      Export run outputs to <file>; format from extension
                          (.json|.csv); use --batch <id> to scope to one batch

Shared options:
  --provider <name>       LLM provider: anthropic | openai
  --model <model>         Model override for the provider
  --headful               Run the browser with a visible window (extract/agent/
                          search/fetch; profile login is always headful)
  --data-dir <path>       Directory holding the sortie.db SQLite database and
                          the profiles/ state files (batch, runs, query,
                          profile, and --profile/--save-profile resolution)
  -h, --help              Show this help

Environment:
  Reads .env from the current directory or the repo root if present.
  ANTHROPIC_API_KEY / OPENAI_API_KEY (and optionally OPENAI_BASE_URL) configure providers.
  SEARXNG_BASE_URL points search at a self-hosted SearXNG instance (preferred,
  CAPTCHA-free); otherwise search falls back to a browser-engine chain.

Examples:
  sortie extract https://books.toscrape.com \\
    --schema '{"type":"object","properties":{"books":{"type":"array","items":{"type":"object","properties":{"title":{"type":"string"},"price":{"type":"number"}},"required":["title","price"]}}},"required":["books"]}' \\
    --instruction "the list of books on the page"

  SAUCE_PASSWORD=... sortie agent https://www.saucedemo.com \\
    --goal "log in as standard_user with password {{cred:SAUCE_PASSWORD}}, add the backpack to the cart, and report the cart total" \\
    --cred SAUCE_PASSWORD \\
    --schema '{"type":"object","properties":{"total":{"type":"string"}},"required":["total"]}'

  sortie search "playwright storage state docs" --max-results 5
  sortie fetch https://arxiv.org/pdf/1706.03762 --format text

  sortie query save books --url https://books.toscrape.com --schema @schema.json
  sortie query run books --url https://books.toscrape.com/catalogue/page-2.html

  sortie profile login sauce --url https://www.saucedemo.com
  sortie agent https://www.saucedemo.com/inventory.html --profile sauce --goal "..."

  sortie batch specs.jsonl --concurrency 3 --export results.csv

  sortie runs list --status success --limit 20
  sortie runs show 1f2e3d4c
  sortie runs export batch-output.json --batch <batch-id>`;

const OBSERVATION_PREVIEW_CHARS = 100;
const INPUT_PREVIEW_CHARS = 120;
const SHORT_RUN_ID_CHARS = 8;
const LIST_URL_PREVIEW_CHARS = 48;
/** Upper bound when scanning the store for a short-id prefix match. */
const PREFIX_SCAN_LIMIT = 10_000;

const RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'running',
  'success',
  'failed',
  'max_steps',
  'cancelled',
];

const SEARCH_ENGINE_IDS: readonly SearchEngineId[] = ['bing', 'duckduckgo', 'brave'];
const FETCH_FORMATS = ['markdown', 'text', 'json'] as const;
type FetchFormat = (typeof FETCH_FORMATS)[number];

const LIST_NAME_CHARS = 20;
const LIST_DOMAINS_PREVIEW_CHARS = 40;

interface CliValues {
  schema?: string;
  instruction?: string;
  provider?: string;
  model?: string;
  out?: string;
  goal?: string;
  'max-steps'?: string;
  cred?: string[];
  'storage-state'?: string;
  trace?: string;
  headful?: boolean;
  help?: boolean;
  concurrency?: string;
  'data-dir'?: string;
  export?: string;
  limit?: string;
  status?: string;
  batch?: string;
  'max-results'?: string;
  engine?: string[];
  format?: string;
  'max-chars'?: string;
  'from-run'?: string;
  notes?: string;
  url?: string;
  profile?: string;
  'save-profile'?: string;
}

function usageError(message: string): never {
  process.stderr.write(`Error: ${message}\n\n${HELP}\n`);
  process.exit(2);
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

function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) || existsSync(join(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadSchemaArg(value: string): Record<string, unknown> {
  let raw: string;
  let source: string;
  if (value.startsWith('@')) {
    const filePath = resolve(value.slice(1));
    source = filePath;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (err) {
      usageError(
        `cannot read schema file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    raw = value;
    source = 'inline --schema value';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    usageError(`invalid JSON in ${source}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    usageError(`schema (${source}) must be a JSON object describing a JSON Schema.`);
  }
  return parsed as Record<string, unknown>;
}

function buildProviderOverride(values: CliValues): LlmProvider | undefined {
  if (values.provider === undefined && values.model === undefined) {
    return undefined;
  }
  const overrides: Partial<ProviderConfig> = {};
  if (values.provider !== undefined) {
    overrides.provider = values.provider as ProviderConfig['provider'];
  }
  if (values.model !== undefined) {
    overrides.model = values.model;
  }
  return createProvider(overrides);
}

/** One-line progress entry for a completed agent step, written to stderr. */
function formatStepLine(step: StepRecord): string {
  let input = JSON.stringify(step.action.input);
  if (input.length > INPUT_PREVIEW_CHARS) {
    input = `${input.slice(0, INPUT_PREVIEW_CHARS)}…`;
  }
  const observation = step.observation
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, OBSERVATION_PREVIEW_CHARS);
  // StepRecord.index is 0-based; display 1-based for humans.
  return `[step ${step.index + 1}] ${step.action.tool} ${input} -> ${observation}\n`;
}

async function runExtractCommand(url: string, values: CliValues): Promise<void> {
  if (!values.schema) {
    usageError('--schema is required for the extract command.');
  }
  if (values.profile !== undefined && values['storage-state'] !== undefined) {
    usageError('--profile and --storage-state are mutually exclusive.');
  }

  loadDotEnv();

  const jsonSchema = loadSchemaArg(values.schema);
  const schema = jsonSchemaToZod(jsonSchema);
  const provider = buildProviderOverride(values);
  const profileStatePath = resolveProfileFlag(values);

  process.stderr.write(`Extracting from ${url} ...\n`);

  let manager: BrowserManager | undefined;
  try {
    let page: Page | undefined;
    let snapshot: PageSnapshot | undefined;
    if (values.headful || profileStatePath !== undefined) {
      // extract() cannot configure headfulness or a login profile itself,
      // so open the page here (PDF-aware: a PDF URL yields a snapshot).
      manager = new BrowserManager();
      await manager.launch({ headless: !values.headful });
      page = await manager.newPage({ storageStatePath: profileStatePath });
      snapshot = await navigateOrPdfSnapshot(page, url);
    }

    const result = await extract({
      ...(page ? { page } : { url }),
      ...(snapshot ? { snapshot } : {}),
      schema,
      instruction: values.instruction,
      provider,
    });

    const output = JSON.stringify(result.data, null, 2);
    process.stdout.write(`${output}\n`);

    if (values.out) {
      const outPath = resolve(values.out);
      writeFileSync(outPath, `${output}\n`, 'utf8');
      process.stderr.write(`Wrote result to ${outPath}\n`);
    }
    process.stderr.write(
      `Done. Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out.\n`,
    );
  } finally {
    if (manager) {
      await manager.close();
    }
  }
}

async function runAgentCommand(startUrl: string, values: CliValues): Promise<void> {
  if (!values.goal) {
    usageError('--goal is required for the agent command.');
  }
  if (values.profile !== undefined && values['storage-state'] !== undefined) {
    usageError('--profile and --storage-state are mutually exclusive.');
  }
  const saveProfile = values['save-profile'];
  if (saveProfile !== undefined && !isSlug(saveProfile)) {
    usageError(
      `--save-profile must be a slug (lowercase letters, digits, "_" and "-"; got "${saveProfile}").`,
    );
  }

  let maxSteps: number | undefined;
  if (values['max-steps'] !== undefined) {
    maxSteps = Number(values['max-steps']);
    if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
      usageError(`--max-steps must be a positive integer (got "${values['max-steps']}").`);
    }
  }

  loadDotEnv();

  // Resolve credential values from the environment. Values are passed to the
  // agent executor only — they are never printed, logged, or sent to the model.
  let credentials: Record<string, string> | undefined;
  if (values.cred !== undefined && values.cred.length > 0) {
    credentials = {};
    for (const name of values.cred) {
      const value = process.env[name];
      if (value === undefined) {
        usageError(`--cred ${name}: environment variable "${name}" is not set.`);
      }
      credentials[name] = value;
    }
  }

  const schema: z.ZodType<unknown> | undefined = values.schema
    ? jsonSchemaToZod(loadSchemaArg(values.schema))
    : undefined;
  const provider = buildProviderOverride(values);
  const storageStatePath =
    resolveProfileFlag(values) ??
    (values['storage-state'] ? resolve(values['storage-state']) : undefined);

  process.stderr.write(`Running agent at ${startUrl} ...\n`);

  let exitCode = 0;
  let manager: BrowserManager | undefined;
  try {
    let page: Page | undefined;
    if (saveProfile !== undefined) {
      // The CLI owns the page so the context's storage state can be
      // persisted as a profile after a successful run.
      manager = new BrowserManager();
      await manager.launch({ headless: !values.headful });
      page = await manager.newPage({ storageStatePath });
    }

    const result = await runAgent({
      goal: values.goal,
      startUrl,
      schema,
      provider,
      page,
      maxSteps,
      headless: !values.headful,
      storageStatePath,
      credentials,
      onStep: (step: StepRecord) => {
        process.stderr.write(formatStepLine(step));
      },
    });

    if (values.trace) {
      const tracePath = resolve(values.trace);
      writeFileSync(tracePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      process.stderr.write(`Wrote trace to ${tracePath}\n`);
    }

    if (result.status !== 'success') {
      const reason = (result.failureReason ?? 'no reason given').replace(/\s*\n\s*/g, ' ').trim();
      process.stderr.write(
        `Agent ${result.status} after ${result.steps.length} step(s): ${reason}\n`,
      );
      if (saveProfile !== undefined) {
        process.stderr.write(`Profile "${saveProfile}" NOT saved (run did not succeed).\n`);
      }
      exitCode = 1;
    }

    if (exitCode === 0 && saveProfile !== undefined && page) {
      // Persist the session only on success — a failed login must never
      // overwrite (or create) a profile with a broken state.
      const store = openRunStore(values);
      try {
        const statePath = store.profileStatePath(saveProfile);
        await persistProfileState(page, statePath);
        store.upsertProfile({
          name: saveProfile,
          domainHint: hostnameOf(result.finalUrl),
          notes: values.notes,
        });
        process.stderr.write(`Saved profile "${saveProfile}" to ${statePath} (mode 0600).\n`);
      } finally {
        store.close();
      }
    }

    if (exitCode === 0) {
      const output = JSON.stringify(result.output ?? null, null, 2);
      process.stdout.write(`${output}\n`);

      if (values.out) {
        const outPath = resolve(values.out);
        writeFileSync(outPath, `${output}\n`, 'utf8');
        process.stderr.write(`Wrote output to ${outPath}\n`);
      }
      process.stderr.write(
        `Done in ${result.steps.length} step(s). Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out.\n`,
      );
    }
  } finally {
    if (manager) {
      await manager.close();
    }
  }
  // Deferred past the finally block: process.exit() would skip cleanup.
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

/**
 * Resolve `--profile <name>` to its storage-state path (stamping lastUsedAt),
 * or undefined when the flag was not given. Exits with a clear fix when the
 * profile is unknown or its state file is missing.
 */
function resolveProfileFlag(values: CliValues): string | undefined {
  if (values.profile === undefined) return undefined;
  const name = values.profile;
  if (!isSlug(name)) {
    usageError(`--profile must be a slug (lowercase letters, digits, "_" and "-"; got "${name}").`);
  }
  const store = openRunStore(values);
  try {
    const record = store.getProfile(name);
    const statePath = store.profileStatePath(name);
    if (!record || !existsSync(statePath)) {
      throw new Error(
        `profile "${name}" ${record ? 'has no storage-state file' : 'does not exist'} — ` +
          `create it with: sortie profile login ${name} --url <loginUrl>`,
      );
    }
    store.touchProfile(name);
    return statePath;
  } finally {
    store.close();
  }
}

/** Hostname of `url` for a profile's domainHint; undefined when unparsable. */
function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// search + fetch commands
// ---------------------------------------------------------------------------

/** Validate repeatable --engine values against the known engine ids. */
function parseEngines(values: string[] | undefined): SearchEngineId[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  for (const value of values) {
    if (!(SEARCH_ENGINE_IDS as readonly string[]).includes(value)) {
      usageError(`--engine must be one of ${SEARCH_ENGINE_IDS.join('|')} (got "${value}").`);
    }
  }
  return values as SearchEngineId[];
}

async function runSearchCommand(query: string, values: CliValues): Promise<void> {
  loadDotEnv();

  const maxResults =
    values['max-results'] !== undefined
      ? parsePositiveInt(values['max-results'], '--max-results')
      : undefined;
  const engines = parseEngines(values.engine);

  // The semantic SERP-parse fallback needs an LLM, but search must keep
  // working without one (SearXNG / fast selector parse) — so a provider is
  // attached only when configuration allows building one.
  let provider = buildProviderOverride(values);
  if (provider === undefined) {
    try {
      provider = createProvider();
    } catch {
      // No LLM configured — search proceeds without the semantic fallback.
    }
  }

  process.stderr.write(`Searching for ${JSON.stringify(query)} ...\n`);

  const response = await search(query, {
    maxResults,
    engines,
    provider,
    headless: !values.headful,
  });

  const output = JSON.stringify(response, null, 2);
  process.stdout.write(`${output}\n`);

  if (values.out) {
    const outPath = resolve(values.out);
    writeFileSync(outPath, `${output}\n`, 'utf8');
    process.stderr.write(`Wrote results to ${outPath}\n`);
  }
  process.stderr.write(`${response.results.length} result(s) via ${response.source}.\n`);
}

/** Validate --format for the fetch command (default markdown). */
function parseFetchFormat(value: string | undefined): FetchFormat {
  if (value === undefined) return 'markdown';
  if (!(FETCH_FORMATS as readonly string[]).includes(value)) {
    usageError(`--format must be one of ${FETCH_FORMATS.join('|')} (got "${value}").`);
  }
  return value as FetchFormat;
}

async function runFetchCommand(url: string, values: CliValues): Promise<void> {
  loadDotEnv();

  const format = parseFetchFormat(values.format);
  const maxChars =
    values['max-chars'] !== undefined
      ? parsePositiveInt(values['max-chars'], '--max-chars')
      : undefined;

  process.stderr.write(`Fetching ${url} ...\n`);

  const result = await fetchPage({ url, maxChars, headless: !values.headful });

  const output =
    format === 'json'
      ? JSON.stringify(result, null, 2)
      : format === 'text'
        ? result.text
        : result.markdown;
  process.stdout.write(`${output}\n`);

  if (values.out) {
    const outPath = resolve(values.out);
    writeFileSync(outPath, `${output}\n`, 'utf8');
    process.stderr.write(`Wrote ${format} to ${outPath}\n`);
  }
  process.stderr.write(
    `Fetched ${result.finalUrl} (${result.contentType}${result.truncated ? ', truncated' : ''}).\n`,
  );
}

// ---------------------------------------------------------------------------
// batch + runs commands (persisted runtime)
// ---------------------------------------------------------------------------

function parsePositiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    usageError(`${flag} must be a positive integer (got "${value}").`);
  }
  return n;
}

function parseStatusFilter(value: string): RunStatus {
  if (!(RUN_STATUSES as readonly string[]).includes(value)) {
    usageError(`--status must be one of ${RUN_STATUSES.join('|')} (got "${value}").`);
  }
  return value as RunStatus;
}

/** Derive the export format from a file extension; usage error otherwise. */
function exportFormatFromPath(filePath: string, flag: string): 'json' | 'csv' {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.csv') return 'csv';
  usageError(`${flag} file must end in .json or .csv (got "${filePath}").`);
}

/** Open the SQLite-backed run store, honoring --data-dir. */
function openRunStore(values: CliValues): RunStore {
  const dataDir = values['data-dir'];
  return createRunStore(dataDir ? join(resolve(dataDir), 'sortie.db') : undefined);
}

function shortRunId(id: string): string {
  return id.slice(0, SHORT_RUN_ID_CHARS);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Validate a parsed spec value; returns human-readable problems ([] = valid). */
function validateSpec(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return ['spec must be a JSON object'];
  }
  const spec = value as Record<string, unknown>;
  const errors: string[] = [];
  if (spec['kind'] !== 'extract' && spec['kind'] !== 'agent' && spec['kind'] !== 'fetch') {
    errors.push(
      `kind must be "extract", "agent", or "fetch" (got ${JSON.stringify(spec['kind'])})`,
    );
  }
  if (typeof spec['url'] !== 'string' || spec['url'].trim() === '') {
    errors.push('url must be a non-empty string');
  }
  if (
    spec['kind'] === 'agent' &&
    (typeof spec['goal'] !== 'string' || spec['goal'].trim() === '')
  ) {
    errors.push('goal (non-empty string) is required for agent specs');
  }
  if (
    spec['kind'] === 'extract' &&
    (spec['schemaJson'] === null ||
      typeof spec['schemaJson'] !== 'object' ||
      Array.isArray(spec['schemaJson']))
  ) {
    errors.push('schemaJson (a JSON Schema object) is required for extract specs');
  }
  if (spec['profile'] !== undefined) {
    if (typeof spec['profile'] !== 'string' || !isSlug(spec['profile'])) {
      errors.push('profile must be a slug (lowercase letters, digits, "_" and "-"; max 64 chars)');
    }
    if (spec['storageStatePath'] !== undefined) {
      errors.push('profile and storageStatePath are mutually exclusive');
    }
  }
  if (
    spec['maxChars'] !== undefined &&
    (typeof spec['maxChars'] !== 'number' ||
      !Number.isInteger(spec['maxChars']) ||
      spec['maxChars'] <= 0)
  ) {
    errors.push('maxChars must be a positive integer');
  }
  return errors;
}

/**
 * Load and minimally validate a specs file (.json array or .jsonl).
 * Prints every problem with its line/entry number and exits 2 on any error.
 */
function loadSpecsFile(specsFile: string): RunSpec[] {
  const filePath = resolve(specsFile);
  const ext = extname(filePath).toLowerCase();
  if (ext !== '.json' && ext !== '.jsonl') {
    usageError(`specs file must end in .json or .jsonl (got "${specsFile}").`);
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    usageError(
      `cannot read specs file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const errors: string[] = [];
  const specs: RunSpec[] = [];

  if (ext === '.jsonl') {
    raw.split('\n').forEach((line, i) => {
      if (line.trim() === '') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        errors.push(
          `line ${i + 1}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      const problems = validateSpec(parsed);
      if (problems.length > 0) {
        errors.push(...problems.map((p) => `line ${i + 1}: ${p}`));
      } else {
        specs.push(parsed as RunSpec);
      }
    });
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      usageError(
        `invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!Array.isArray(parsed)) {
      usageError(`${filePath} must contain a JSON array of run specs.`);
    }
    parsed.forEach((entry: unknown, i: number) => {
      const problems = validateSpec(entry);
      if (problems.length > 0) {
        errors.push(...problems.map((p) => `entry ${i + 1}: ${p}`));
      } else {
        specs.push(entry as RunSpec);
      }
    });
  }

  if (errors.length > 0) {
    process.stderr.write(`Error: invalid specs in ${filePath}:\n`);
    for (const error of errors) {
      process.stderr.write(`  ${error}\n`);
    }
    process.exit(2);
  }
  if (specs.length === 0) {
    usageError(`specs file ${filePath} contains no run specs.`);
  }
  return specs;
}

/** Warn (names only — never values) about credential env vars that are unset. */
function warnMissingCredentialEnv(specs: RunSpec[]): void {
  const missing = new Set<string>();
  for (const spec of specs) {
    for (const name of spec.credentialNames ?? []) {
      if (process.env[name] === undefined) {
        missing.add(name);
      }
    }
  }
  if (missing.size > 0) {
    process.stderr.write(
      `Warning: credential environment variable(s) not set: ${[...missing].join(', ')}\n`,
    );
  }
}

/** One-line progress entry for a run lifecycle event, written to stderr. */
function formatRunEvent(ev: RunEvent): string {
  const id = shortRunId(ev.runId);
  switch (ev.type) {
    case 'run-queued':
      return `[${id}] queued\n`;
    case 'run-started':
      return `[${id}] started\n`;
    case 'run-step':
      // StepRecord.index is 0-based; display 1-based for humans.
      return ev.step ? `[${id}] step ${ev.step.index + 1} ${ev.step.action.tool}\n` : '';
    case 'run-screenshot':
      // Screenshots are a live-view concern; keep CLI progress output quiet.
      return '';
    case 'run-finished': {
      const record = ev.record;
      const seconds =
        record?.startedAt !== undefined && record.finishedAt !== undefined
          ? ((record.finishedAt - record.startedAt) / 1000).toFixed(1)
          : '?';
      return `[${id}] finished ${record?.status ?? 'unknown'} (${seconds}s)\n`;
    }
  }
}

async function runBatchCommand(specsFile: string, values: CliValues): Promise<void> {
  loadDotEnv();

  const specs = loadSpecsFile(specsFile);
  warnMissingCredentialEnv(specs);

  const concurrency =
    values.concurrency !== undefined
      ? parsePositiveInt(values.concurrency, '--concurrency')
      : undefined;
  // Validate the export target up front so a bad extension fails before any work.
  const exportPath = values.export ? resolve(values.export) : undefined;
  const exportFormat = exportPath ? exportFormatFromPath(exportPath, '--export') : undefined;
  const provider = buildProviderOverride(values);

  const store = openRunStore(values);
  const queue = createRunQueue(store, { concurrency, provider });
  let exitCode: number | undefined;
  try {
    queue.onEvent((ev: RunEvent) => {
      process.stderr.write(formatRunEvent(ev));
    });

    const { batchId, runs } = queue.submitBatch(specs);
    process.stderr.write(`Submitted ${runs.length} run(s) as batch ${batchId}.\n`);

    await queue.drain();

    const total = store.countRuns({ batchId });
    const success = store.countRuns({ batchId, status: 'success' });
    const failed = store.countRuns({ batchId, status: 'failed' });
    const maxSteps = store.countRuns({ batchId, status: 'max_steps' });
    process.stderr.write(
      [
        `Batch ${batchId} summary:`,
        `  total      ${total}`,
        `  success    ${success}`,
        `  failed     ${failed}`,
        `  max_steps  ${maxSteps}`,
        '',
      ].join('\n'),
    );

    if (exportPath && exportFormat) {
      writeFileSync(exportPath, store.exportRuns({ batchId, format: exportFormat }), 'utf8');
      process.stderr.write(`Wrote ${exportFormat} export to ${exportPath}\n`);
    }

    exitCode = success > 0 ? 0 : 1;
  } finally {
    await queue.shutdown();
    store.close();
  }
  // Deferred past the finally block: process.exit() would skip cleanup.
  if (exitCode !== undefined && exitCode !== 0) {
    process.exit(exitCode);
  }
}

function runRunsListCommand(values: CliValues): void {
  const opts: ListRunsOptions = {};
  if (values.limit !== undefined) opts.limit = parsePositiveInt(values.limit, '--limit');
  if (values.status !== undefined) opts.status = parseStatusFilter(values.status);
  if (values.batch !== undefined) opts.batchId = values.batch;

  const store = openRunStore(values);
  try {
    const runs = store.listRuns(opts);
    if (runs.length === 0) {
      process.stderr.write('No runs found.\n');
      return;
    }
    const header = [
      'ID'.padEnd(SHORT_RUN_ID_CHARS),
      'KIND'.padEnd(7),
      'STATUS'.padEnd(9),
      'URL'.padEnd(LIST_URL_PREVIEW_CHARS),
      'FINISHED',
    ].join('  ');
    process.stdout.write(`${header}\n`);
    for (const run of runs) {
      const finished = run.finishedAt !== undefined ? new Date(run.finishedAt).toISOString() : '-';
      const row = [
        shortRunId(run.id).padEnd(SHORT_RUN_ID_CHARS),
        run.spec.kind.padEnd(7),
        run.status.padEnd(9),
        truncate(run.spec.url, LIST_URL_PREVIEW_CHARS).padEnd(LIST_URL_PREVIEW_CHARS),
        finished,
      ].join('  ');
      process.stdout.write(`${row}\n`);
    }
  } finally {
    store.close();
  }
}

/**
 * Resolve a run by full id or unique short-id prefix (the list/batch output
 * prints short ids). Returns the record, or a human-readable error.
 */
function findRunByIdOrPrefix(store: RunStore, id: string): { record?: RunRecord; error?: string } {
  const record = store.getRun(id);
  if (record) return { record };
  const matches = store
    .listRuns({ limit: PREFIX_SCAN_LIMIT })
    .filter((run) => run.id.startsWith(id));
  if (matches.length === 1) return { record: matches[0] };
  if (matches.length > 1) {
    return { error: `run id "${id}" is ambiguous (${matches.length} matches) — use the full id.` };
  }
  return { error: `run "${id}" not found.` };
}

function runRunsShowCommand(id: string, values: CliValues): void {
  const store = openRunStore(values);
  let errorMessage: string | undefined;
  try {
    const { record, error } = findRunByIdOrPrefix(store, id);
    if (record) {
      const full = { ...record, steps: store.getSteps(record.id) };
      process.stdout.write(`${JSON.stringify(full, null, 2)}\n`);
    } else {
      errorMessage = error ?? `run "${id}" not found.`;
    }
  } finally {
    store.close();
  }
  if (errorMessage) {
    process.stderr.write(`Error: ${errorMessage}\n`);
    process.exit(1);
  }
}

function runRunsExportCommand(file: string, values: CliValues): void {
  const exportPath = resolve(file);
  const format = exportFormatFromPath(exportPath, 'export');
  const store = openRunStore(values);
  try {
    const data = store.exportRuns({ batchId: values.batch, format });
    writeFileSync(exportPath, data, 'utf8');
    process.stderr.write(`Wrote ${format} export to ${exportPath}\n`);
  } finally {
    store.close();
  }
}

function runRunsCommand(args: string[], values: CliValues): void {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list':
      if (rest.length > 0) usageError(`unexpected extra arguments: ${rest.join(' ')}`);
      runRunsListCommand(values);
      return;
    case 'show': {
      const id = rest[0];
      if (!id) usageError('runs show: missing <id> argument.');
      if (rest.length > 1) usageError(`unexpected extra arguments: ${rest.slice(1).join(' ')}`);
      runRunsShowCommand(id, values);
      return;
    }
    case 'export': {
      const file = rest[0];
      if (!file) usageError('runs export: missing <file.json|file.csv> argument.');
      if (rest.length > 1) usageError(`unexpected extra arguments: ${rest.slice(1).join(' ')}`);
      runRunsExportCommand(file, values);
      return;
    }
    default:
      usageError(
        sub === undefined
          ? 'runs: missing subcommand (list | show | export).'
          : `runs: unknown subcommand "${sub}" (expected list | show | export).`,
      );
  }
}

// ---------------------------------------------------------------------------
// query commands (saved, replayable extract specs)
// ---------------------------------------------------------------------------

/** Usage-gate a positional slug name (query/profile commands). */
function requireSlugName(context: string, name: string | undefined): string {
  if (!name) {
    usageError(`${context}: missing <name> argument.`);
  }
  if (!isSlug(name)) {
    usageError(
      `${context}: name must be a slug (lowercase letters, digits, "_" and "-"; ` +
        `max 64 chars; got "${name}").`,
    );
  }
  return name;
}

function runQuerySaveCommand(name: string, values: CliValues): void {
  const store = openRunStore(values);
  try {
    let spec: RunSpec;
    if (values['from-run'] !== undefined) {
      const { record, error } = findRunByIdOrPrefix(store, values['from-run']);
      if (!record) {
        throw new Error(error ?? `run "${values['from-run']}" not found.`);
      }
      if (record.spec.kind !== 'extract') {
        throw new Error(
          `run ${shortRunId(record.id)} is a ${record.spec.kind} run — only extract runs can be saved as queries.`,
        );
      }
      // Copy the run's spec, dropping any link-back to the query it was
      // itself replayed from; --url/--instruction/--schema override the copy.
      spec = { ...record.spec };
      delete spec.queryName;
      if (values.url !== undefined) spec.url = values.url;
      if (values.instruction !== undefined) spec.instruction = values.instruction;
      if (values.schema !== undefined) spec.schemaJson = loadSchemaArg(values.schema);
    } else {
      if (!values.url || !values.schema) {
        usageError('query save: --url and --schema are required (or use --from-run <id>).');
      }
      spec = {
        kind: 'extract',
        url: values.url,
        schemaJson: loadSchemaArg(values.schema),
        ...(values.instruction !== undefined ? { instruction: values.instruction } : {}),
      };
    }

    const saved = store.createQuery(name, spec);
    process.stderr.write(`Saved query "${saved.name}" (${saved.spec.kind} ${saved.spec.url}).\n`);
  } finally {
    store.close();
  }
}

function runQueryListCommand(values: CliValues): void {
  const store = openRunStore(values);
  try {
    const queries = store.listQueries();
    if (queries.length === 0) {
      process.stderr.write('No saved queries.\n');
      return;
    }
    const header = [
      'NAME'.padEnd(LIST_NAME_CHARS),
      'KIND'.padEnd(7),
      'URL'.padEnd(LIST_URL_PREVIEW_CHARS),
      'RUNS'.padEnd(5),
      'LAST RUN',
    ].join('  ');
    process.stdout.write(`${header}\n`);
    for (const query of queries) {
      const lastRun = query.lastRunAt !== undefined ? new Date(query.lastRunAt).toISOString() : '-';
      const row = [
        truncate(query.name, LIST_NAME_CHARS).padEnd(LIST_NAME_CHARS),
        query.spec.kind.padEnd(7),
        truncate(query.spec.url, LIST_URL_PREVIEW_CHARS).padEnd(LIST_URL_PREVIEW_CHARS),
        String(query.runCount).padEnd(5),
        lastRun,
      ].join('  ');
      process.stdout.write(`${row}\n`);
    }
  } finally {
    store.close();
  }
}

function runQueryShowCommand(name: string, values: CliValues): void {
  const store = openRunStore(values);
  let errorMessage: string | undefined;
  try {
    const query = store.getQuery(name);
    if (query) {
      process.stdout.write(`${JSON.stringify(query, null, 2)}\n`);
    } else {
      errorMessage = `no saved query named "${name}".`;
    }
  } finally {
    store.close();
  }
  if (errorMessage) {
    process.stderr.write(`Error: ${errorMessage}\n`);
    process.exit(1);
  }
}

/**
 * Replay a saved query through a 1-concurrency run queue: the replay is
 * persisted as a regular run (linked back via spec.queryName) and gets the
 * queue's retries and screenshots for free.
 */
async function runQueryRunCommand(name: string, values: CliValues): Promise<void> {
  loadDotEnv();

  const provider = buildProviderOverride(values);
  const store = openRunStore(values);
  let queue: ReturnType<typeof createRunQueue> | undefined;
  let exitCode = 0;
  try {
    const spec = prepareSavedQueryRun(store, name, {
      ...(values.url !== undefined ? { url: values.url } : {}),
      ...(values.instruction !== undefined ? { instruction: values.instruction } : {}),
    });

    queue = createRunQueue(store, { concurrency: 1, provider });
    queue.onEvent((ev: RunEvent) => {
      process.stderr.write(formatRunEvent(ev));
    });

    const record = queue.submit(spec);
    process.stderr.write(`Replaying query "${name}" as run ${shortRunId(record.id)} ...\n`);
    await queue.drain();

    const finished = store.getRun(record.id);
    if (finished?.status === 'success') {
      const output = JSON.stringify(finished.output ?? null, null, 2);
      process.stdout.write(`${output}\n`);
      if (values.out) {
        const outPath = resolve(values.out);
        writeFileSync(outPath, `${output}\n`, 'utf8');
        process.stderr.write(`Wrote output to ${outPath}\n`);
      }
    } else {
      const reason = (finished?.failureReason ?? 'no reason given')
        .replace(/\s*\n\s*/g, ' ')
        .trim();
      process.stderr.write(`Run ${finished?.status ?? 'unknown'}: ${reason}\n`);
      exitCode = 1;
    }
  } finally {
    if (queue) await queue.shutdown();
    store.close();
  }
  // Deferred past the finally block: process.exit() would skip cleanup.
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

function runQueryDeleteCommand(name: string, values: CliValues): void {
  const store = openRunStore(values);
  let deleted: boolean;
  try {
    deleted = store.deleteQuery(name);
  } finally {
    store.close();
  }
  if (!deleted) {
    process.stderr.write(`Error: no saved query named "${name}".\n`);
    process.exit(1);
  }
  process.stderr.write(`Deleted query "${name}" (run history is kept).\n`);
}

async function runQueryCommand(args: string[], values: CliValues): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'save': {
      const name = requireSlugName('query save', rest[0]);
      if (rest.length > 1) usageError(`unexpected extra arguments: ${rest.slice(1).join(' ')}`);
      runQuerySaveCommand(name, values);
      return;
    }
    case 'list':
      if (rest.length > 0) usageError(`unexpected extra arguments: ${rest.join(' ')}`);
      runQueryListCommand(values);
      return;
    case 'show': {
      const name = requireSlugName('query show', rest[0]);
      if (rest.length > 1) usageError(`unexpected extra arguments: ${rest.slice(1).join(' ')}`);
      runQueryShowCommand(name, values);
      return;
    }
    case 'run': {
      const name = requireSlugName('query run', rest[0]);
      if (rest.length > 1) usageError(`unexpected extra arguments: ${rest.slice(1).join(' ')}`);
      await runQueryRunCommand(name, values);
      return;
    }
    case 'delete': {
      const name = requireSlugName('query delete', rest[0]);
      if (rest.length > 1) usageError(`unexpected extra arguments: ${rest.slice(1).join(' ')}`);
      runQueryDeleteCommand(name, values);
      return;
    }
    default:
      usageError(
        sub === undefined
          ? 'query: missing subcommand (save | list | show | run | delete).'
          : `query: unknown subcommand "${sub}" (expected save | list | show | run | delete).`,
      );
  }
}

// ---------------------------------------------------------------------------
// profile commands (named login sessions)
// ---------------------------------------------------------------------------

/** Block until the user presses Enter (prompt written to stderr). */
async function promptEnter(message: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    await rl.question(message);
  } finally {
    rl.close();
  }
}

/**
 * Headful manual login: open the login URL in a visible browser, wait for
 * the user to finish logging in, then persist the session as a profile.
 * The state file (live session cookies) is written 0600 and never printed.
 */
async function runProfileLoginCommand(name: string, values: CliValues): Promise<void> {
  if (!values.url) {
    usageError('profile login: --url <loginUrl> is required.');
  }
  const loginUrl = values.url;

  const store = openRunStore(values);
  const manager = new BrowserManager();
  try {
    // Always headful — the whole point is a human doing the login.
    await manager.launch({ headless: false });
    const page = await manager.newPage();
    await navigateAndSettle(page, loginUrl);

    process.stderr.write(`A browser window is open at ${loginUrl}.\n`);
    await promptEnter(
      `Log in there, then press Enter here to save the session as profile "${name}" ` +
        '(Ctrl+C aborts without saving) ... ',
    );

    const statePath = store.profileStatePath(name);
    await persistProfileState(page, statePath);
    store.upsertProfile({ name, domainHint: hostnameOf(loginUrl), notes: values.notes });
    process.stderr.write(`Saved profile "${name}" to ${statePath} (mode 0600).\n`);
  } finally {
    await manager.close();
    store.close();
  }
}

function runProfileListCommand(values: CliValues): void {
  const store = openRunStore(values);
  try {
    const profiles = store.listProfiles();
    if (profiles.length === 0) {
      process.stderr.write(
        'No profiles. Create one with: sortie profile login <name> --url <loginUrl>\n',
      );
      return;
    }
    const header = [
      'NAME'.padEnd(LIST_NAME_CHARS),
      'COOKIES'.padEnd(7),
      'EXPIRED'.padEnd(7),
      'DOMAINS'.padEnd(LIST_DOMAINS_PREVIEW_CHARS),
      'LAST USED',
    ].join('  ');
    process.stdout.write(`${header}\n`);
    for (const profile of profiles) {
      // Cookie summary is metadata only (counts + domains) — never values.
      let cookies = '-';
      let expired = '-';
      let domains = '(no state file)';
      try {
        const state = summarizeProfileState(store.profileStatePath(profile.name));
        if (state.exists) {
          cookies = String(state.cookieCount);
          expired = String(state.expiredCookieCount);
          domains = state.domains.join(', ') || profile.domainHint || '-';
        }
      } catch {
        domains = '(unreadable state file)';
      }
      const lastUsed =
        profile.lastUsedAt !== undefined ? new Date(profile.lastUsedAt).toISOString() : '-';
      const row = [
        truncate(profile.name, LIST_NAME_CHARS).padEnd(LIST_NAME_CHARS),
        cookies.padEnd(7),
        expired.padEnd(7),
        truncate(domains, LIST_DOMAINS_PREVIEW_CHARS).padEnd(LIST_DOMAINS_PREVIEW_CHARS),
        lastUsed,
      ].join('  ');
      process.stdout.write(`${row}\n`);
    }
  } finally {
    store.close();
  }
}

function runProfileCheckCommand(name: string, values: CliValues): void {
  const store = openRunStore(values);
  let errorMessage: string | undefined;
  try {
    const record = store.getProfile(name);
    if (!record) {
      errorMessage = `profile "${name}" not found.`;
    } else {
      // Staleness summary only: counts, domains, expiry — never cookie
      // names or values.
      const state = summarizeProfileState(store.profileStatePath(name));
      process.stdout.write(`${JSON.stringify({ ...record, state }, null, 2)}\n`);
      if (!state.exists) {
        errorMessage =
          `profile "${name}" has no storage-state file — recreate it with: ` +
          `sortie profile login ${name} --url <loginUrl>`;
      } else if (state.expiredCookieCount > 0) {
        process.stderr.write(
          `Warning: ${state.expiredCookieCount} cookie(s) already expired — the login may be stale.\n`,
        );
      }
    }
  } finally {
    store.close();
  }
  if (errorMessage) {
    process.stderr.write(`Error: ${errorMessage}\n`);
    process.exit(1);
  }
}

function runProfileDeleteCommand(name: string, values: CliValues): void {
  const store = openRunStore(values);
  let deleted: boolean;
  try {
    deleted = store.deleteProfile(name);
  } finally {
    store.close();
  }
  if (!deleted) {
    process.stderr.write(`Error: profile "${name}" not found.\n`);
    process.exit(1);
  }
  process.stderr.write(`Deleted profile "${name}" and its storage-state file.\n`);
}

async function runProfileCommand(args: string[], values: CliValues): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'login': {
      const name = requireSlugName('profile login', rest[0]);
      if (rest.length > 1) usageError(`unexpected extra arguments: ${rest.slice(1).join(' ')}`);
      await runProfileLoginCommand(name, values);
      return;
    }
    case 'list':
      if (rest.length > 0) usageError(`unexpected extra arguments: ${rest.join(' ')}`);
      runProfileListCommand(values);
      return;
    case 'check': {
      const name = requireSlugName('profile check', rest[0]);
      if (rest.length > 1) usageError(`unexpected extra arguments: ${rest.slice(1).join(' ')}`);
      runProfileCheckCommand(name, values);
      return;
    }
    case 'delete': {
      const name = requireSlugName('profile delete', rest[0]);
      if (rest.length > 1) usageError(`unexpected extra arguments: ${rest.slice(1).join(' ')}`);
      runProfileDeleteCommand(name, values);
      return;
    }
    default:
      usageError(
        sub === undefined
          ? 'profile: missing subcommand (login | list | check | delete).'
          : `profile: unknown subcommand "${sub}" (expected login | list | check | delete).`,
      );
  }
}

async function main(): Promise<void> {
  let values: CliValues;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        schema: { type: 'string' },
        instruction: { type: 'string' },
        provider: { type: 'string' },
        model: { type: 'string' },
        out: { type: 'string' },
        goal: { type: 'string' },
        'max-steps': { type: 'string' },
        cred: { type: 'string', multiple: true },
        'storage-state': { type: 'string' },
        trace: { type: 'string' },
        headful: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        concurrency: { type: 'string' },
        'data-dir': { type: 'string' },
        export: { type: 'string' },
        limit: { type: 'string' },
        status: { type: 'string' },
        batch: { type: 'string' },
        'max-results': { type: 'string' },
        engine: { type: 'string', multiple: true },
        format: { type: 'string' },
        'max-chars': { type: 'string' },
        'from-run': { type: 'string' },
        notes: { type: 'string' },
        url: { type: 'string' },
        profile: { type: 'string' },
        'save-profile': { type: 'string' },
      },
    }));
  } catch (err) {
    usageError(err instanceof Error ? err.message : String(err));
  }

  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  if (
    values.provider !== undefined &&
    values.provider !== 'anthropic' &&
    values.provider !== 'openai'
  ) {
    usageError(`--provider must be "anthropic" or "openai" (got "${values.provider}").`);
  }

  const [command, ...args] = positionals;
  switch (command) {
    case 'extract':
    case 'agent': {
      const url = args[0];
      if (!url) {
        usageError(
          command === 'agent' ? 'missing <startUrl> argument.' : 'missing <url> argument.',
        );
      }
      if (args.length > 1) {
        usageError(`unexpected extra arguments: ${args.slice(1).join(' ')}`);
      }
      if (command === 'agent') {
        await runAgentCommand(url, values);
      } else {
        await runExtractCommand(url, values);
      }
      return;
    }
    case 'search': {
      const query = args[0];
      if (!query) {
        usageError('missing <query> argument.');
      }
      if (args.length > 1) {
        usageError(`unexpected extra arguments: ${args.slice(1).join(' ')} (quote the query).`);
      }
      await runSearchCommand(query, values);
      return;
    }
    case 'fetch': {
      const url = args[0];
      if (!url) {
        usageError('missing <url> argument.');
      }
      if (args.length > 1) {
        usageError(`unexpected extra arguments: ${args.slice(1).join(' ')}`);
      }
      await runFetchCommand(url, values);
      return;
    }
    case 'query':
      await runQueryCommand(args, values);
      return;
    case 'profile':
      await runProfileCommand(args, values);
      return;
    case 'batch': {
      const specsFile = args[0];
      if (!specsFile) {
        usageError('missing <specs-file> argument.');
      }
      if (args.length > 1) {
        usageError(`unexpected extra arguments: ${args.slice(1).join(' ')}`);
      }
      await runBatchCommand(specsFile, values);
      return;
    }
    case 'runs':
      runRunsCommand(args, values);
      return;
    default:
      usageError(command === undefined ? 'missing command.' : `unknown command "${command}".`);
  }
}

main().catch((err: unknown) => {
  const message = (err instanceof Error ? err.message : String(err)).replace(/\s*\n\s*/g, ' ');
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
