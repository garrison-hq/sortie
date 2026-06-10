#!/usr/bin/env node
/**
 * nanofish CLI — semantic extraction, multi-step agent runs, batches,
 * and persisted run inspection.
 *
 *   nanofish extract <url> --schema <inline-JSON-or-@file>
 *     [--instruction <text>] [--provider anthropic|openai] [--model <m>]
 *     [--out <file>] [--headful]
 *
 *   nanofish agent <startUrl> --goal <text>
 *     [--schema <inline-JSON-or-@file>] [--max-steps N] [--cred NAME ...]
 *     [--headful] [--out <file>] [--storage-state <path>] [--trace <file>]
 *
 *   nanofish batch <specs-file>
 *     [--concurrency N] [--data-dir <path>] [--export <file.json|file.csv>]
 *     [--provider anthropic|openai] [--model <m>]
 *
 *   nanofish runs list [--limit N] [--status <s>] [--batch <id>] [--data-dir <path>]
 *   nanofish runs show <id> [--data-dir <path>]
 *   nanofish runs export <file.json|file.csv> [--batch <id>] [--data-dir <path>]
 */
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import type { Page } from 'playwright';
import type { z } from 'zod';
import type {
  ListRunsOptions,
  LlmProvider,
  ProviderConfig,
  RunEvent,
  RunSpec,
  RunStatus,
  RunStore,
  StepRecord,
} from './contracts.js';
import { createProvider } from './llm/index.js';
import { BrowserManager } from './browser/index.js';
import { extract, navigateAndSettle } from './extract/index.js';
import { jsonSchemaToZod } from './extract/schema.js';
import { runAgent } from './agent/loop.js';
import { createRunStore } from './store/index.js';
import { createRunQueue } from './runtime/index.js';

const HELP = `nanofish — semantic web extraction & web agents

Usage:
  nanofish extract <url> --schema <inline-JSON-or-@file> [options]
  nanofish agent <startUrl> --goal <text> [options]
  nanofish batch <specs-file> [options]
  nanofish runs <list|show|export> [args] [options]

Extract options:
  --schema <value>        JSON Schema for the result. Inline JSON, or @path/to/file.json
  --instruction <text>    Natural-language hint about what to extract
  --out <file>            Also write the extracted JSON to this file

Agent options:
  --goal <text>           Natural-language goal for the agent (required)
  --schema <value>        JSON Schema for the agent's final output (inline or @file)
  --max-steps <n>         Hard cap on agent steps (default 25)
  --cred <NAME>           Pass the secret in env var NAME to the agent (repeatable).
                          The model only ever sees the name as {{cred:NAME}};
                          the value is read from the environment and never printed.
  --storage-state <path>  Playwright storage-state JSON for session reuse (logins)
  --out <file>            Write the agent's output data (JSON) to this file
  --trace <file>          Write the full run trace (all steps) as JSON to this file

Batch options:
  <specs-file>            Run specs: a .json file (array of specs) or a .jsonl file
                          (one spec per line). Each spec: {"kind":"extract"|"agent",
                          "url":"...", "schemaJson":{...} (required for extract),
                          "goal":"..." (required for agent), plus optional
                          "instruction", "maxSteps", "credentialNames" (env var
                          NAMES — values are resolved at execution time, never
                          stored), and "storageStatePath".
  --concurrency <n>       Parallel browser workers (default 5, clamped 1..10)
  --data-dir <path>       Directory holding the nanofish.db SQLite database
                          (default: the store's standard location)
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
  --data-dir <path>       Directory holding the nanofish.db SQLite database

Shared options:
  --provider <name>       LLM provider: anthropic | openai
  --model <model>         Model override for the provider
  --headful               Run the browser with a visible window (extract/agent)
  -h, --help              Show this help

Environment:
  Reads .env from the current directory or the repo root if present.
  ANTHROPIC_API_KEY / OPENAI_API_KEY (and optionally OPENAI_BASE_URL) configure providers.

Examples:
  nanofish extract https://books.toscrape.com \\
    --schema '{"type":"object","properties":{"books":{"type":"array","items":{"type":"object","properties":{"title":{"type":"string"},"price":{"type":"number"}},"required":["title","price"]}}},"required":["books"]}' \\
    --instruction "the list of books on the page"

  SAUCE_PASSWORD=... nanofish agent https://www.saucedemo.com \\
    --goal "log in as standard_user with password {{cred:SAUCE_PASSWORD}}, add the backpack to the cart, and report the cart total" \\
    --cred SAUCE_PASSWORD \\
    --schema '{"type":"object","properties":{"total":{"type":"string"}},"required":["total"]}'

  nanofish batch specs.jsonl --concurrency 3 --export results.csv

  nanofish runs list --status success --limit 20
  nanofish runs show 1f2e3d4c
  nanofish runs export batch-output.json --batch <batch-id>`;

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

  loadDotEnv();

  const jsonSchema = loadSchemaArg(values.schema);
  const schema = jsonSchemaToZod(jsonSchema);
  const provider = buildProviderOverride(values);

  process.stderr.write(`Extracting from ${url} ...\n`);

  let manager: BrowserManager | undefined;
  try {
    let page: Page | undefined;
    if (values.headful) {
      // extract() cannot configure headfulness itself, so open the page here.
      manager = new BrowserManager();
      await manager.launch({ headless: false });
      page = await manager.newPage();
      await navigateAndSettle(page, url);
    }

    const result = await extract({
      ...(page ? { page } : { url }),
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

  process.stderr.write(`Running agent at ${startUrl} ...\n`);

  const result = await runAgent({
    goal: values.goal,
    startUrl,
    schema,
    provider,
    maxSteps,
    headless: !values.headful,
    storageStatePath: values['storage-state'] ? resolve(values['storage-state']) : undefined,
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
    process.exit(1);
  }

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
  return createRunStore(dataDir ? join(resolve(dataDir), 'nanofish.db') : undefined);
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
  if (spec['kind'] !== 'extract' && spec['kind'] !== 'agent') {
    errors.push(`kind must be "extract" or "agent" (got ${JSON.stringify(spec['kind'])})`);
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

function runRunsShowCommand(id: string, values: CliValues): void {
  const store = openRunStore(values);
  let errorMessage: string | undefined;
  try {
    let record = store.getRun(id);
    if (!record) {
      // The list/batch output prints short ids — accept a unique prefix too.
      const matches = store
        .listRuns({ limit: PREFIX_SCAN_LIMIT })
        .filter((run) => run.id.startsWith(id));
      if (matches.length === 1) {
        record = matches[0];
      } else if (matches.length > 1) {
        errorMessage = `run id "${id}" is ambiguous (${matches.length} matches) — use the full id.`;
      }
    }
    if (record) {
      const full = { ...record, steps: store.getSteps(record.id) };
      process.stdout.write(`${JSON.stringify(full, null, 2)}\n`);
    } else {
      errorMessage ??= `run "${id}" not found.`;
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
