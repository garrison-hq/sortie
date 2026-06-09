#!/usr/bin/env node
/**
 * nanofish CLI — semantic extraction from the command line.
 *
 *   nanofish extract <url> --schema <inline-JSON-or-@file>
 *     [--instruction <text>] [--provider anthropic|openai] [--model <m>]
 *     [--out <file>] [--headful]
 */
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Page } from 'playwright';
import type { LlmProvider, ProviderConfig } from './contracts.js';
import { createProvider } from './llm/index.js';
import { BrowserManager } from './browser/index.js';
import { extract, navigateAndSettle } from './extract/index.js';
import { jsonSchemaToZod } from './extract/schema.js';

const HELP = `nanofish — semantic web extraction

Usage:
  nanofish extract <url> --schema <inline-JSON-or-@file> [options]

Options:
  --schema <value>        JSON Schema for the result. Inline JSON, or @path/to/file.json
  --instruction <text>    Natural-language hint about what to extract
  --provider <name>       LLM provider: anthropic | openai
  --model <model>         Model override for the provider
  --out <file>            Also write the extracted JSON to this file
  --headful               Run the browser with a visible window
  -h, --help              Show this help

Environment:
  Reads .env from the current directory or the repo root if present.
  ANTHROPIC_API_KEY / OPENAI_API_KEY (and optionally OPENAI_BASE_URL) configure providers.

Example:
  nanofish extract https://books.toscrape.com \\
    --schema '{"type":"object","properties":{"books":{"type":"array","items":{"type":"object","properties":{"title":{"type":"string"},"price":{"type":"number"}},"required":["title","price"]}}},"required":["books"]}' \\
    --instruction "the list of books on the page"`;

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

async function main(): Promise<void> {
  let values: {
    schema?: string;
    instruction?: string;
    provider?: string;
    model?: string;
    out?: string;
    headful?: boolean;
    help?: boolean;
  };
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
  if (command !== 'extract') {
    usageError(command === undefined ? 'missing command.' : `unknown command "${command}".`);
  }
  if (!url) {
    usageError('missing <url> argument.');
  }
  if (rest.length > 0) {
    usageError(`unexpected extra arguments: ${rest.join(' ')}`);
  }
  if (!values.schema) {
    usageError('--schema is required.');
  }
  if (
    values.provider !== undefined &&
    values.provider !== 'anthropic' &&
    values.provider !== 'openai'
  ) {
    usageError(`--provider must be "anthropic" or "openai" (got "${values.provider}").`);
  }

  loadDotEnv();

  const jsonSchema = loadSchemaArg(values.schema);
  const schema = jsonSchemaToZod(jsonSchema);

  let provider: LlmProvider | undefined;
  if (values.provider !== undefined || values.model !== undefined) {
    const overrides: Partial<ProviderConfig> = {};
    if (values.provider !== undefined) {
      overrides.provider = values.provider as ProviderConfig['provider'];
    }
    if (values.model !== undefined) {
      overrides.model = values.model;
    }
    provider = createProvider(overrides);
  }

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

main().catch((err: unknown) => {
  const message = (err instanceof Error ? err.message : String(err)).replace(/\s*\n\s*/g, ' ');
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
