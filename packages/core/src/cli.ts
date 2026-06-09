#!/usr/bin/env node
/**
 * nanofish CLI — semantic extraction and multi-step agent runs.
 *
 *   nanofish extract <url> --schema <inline-JSON-or-@file>
 *     [--instruction <text>] [--provider anthropic|openai] [--model <m>]
 *     [--out <file>] [--headful]
 *
 *   nanofish agent <startUrl> --goal <text>
 *     [--schema <inline-JSON-or-@file>] [--max-steps N] [--cred NAME ...]
 *     [--headful] [--out <file>] [--storage-state <path>] [--trace <file>]
 */
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Page } from 'playwright';
import type { z } from 'zod';
import type { LlmProvider, ProviderConfig, StepRecord } from './contracts.js';
import { createProvider } from './llm/index.js';
import { BrowserManager } from './browser/index.js';
import { extract, navigateAndSettle } from './extract/index.js';
import { jsonSchemaToZod } from './extract/schema.js';
import { runAgent } from './agent/loop.js';

const HELP = `nanofish — semantic web extraction & web agents

Usage:
  nanofish extract <url> --schema <inline-JSON-or-@file> [options]
  nanofish agent <startUrl> --goal <text> [options]

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

Shared options:
  --provider <name>       LLM provider: anthropic | openai
  --model <model>         Model override for the provider
  --headful               Run the browser with a visible window
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
    --schema '{"type":"object","properties":{"total":{"type":"string"}},"required":["total"]}'`;

const OBSERVATION_PREVIEW_CHARS = 100;
const INPUT_PREVIEW_CHARS = 120;

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
      },
    }));
  } catch (err) {
    usageError(err instanceof Error ? err.message : String(err));
  }

  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const [command, url, ...rest] = positionals;
  if (command !== 'extract' && command !== 'agent') {
    usageError(command === undefined ? 'missing command.' : `unknown command "${command}".`);
  }
  if (!url) {
    usageError(command === 'agent' ? 'missing <startUrl> argument.' : 'missing <url> argument.');
  }
  if (rest.length > 0) {
    usageError(`unexpected extra arguments: ${rest.join(' ')}`);
  }
  if (
    values.provider !== undefined &&
    values.provider !== 'anthropic' &&
    values.provider !== 'openai'
  ) {
    usageError(`--provider must be "anthropic" or "openai" (got "${values.provider}").`);
  }

  if (command === 'agent') {
    await runAgentCommand(url, values);
  } else {
    await runExtractCommand(url, values);
  }
}

main().catch((err: unknown) => {
  const message = (err instanceof Error ? err.message : String(err)).replace(/\s*\n\s*/g, ' ');
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
