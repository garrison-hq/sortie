#!/usr/bin/env node
/**
 * sortie MCP server (stdio).
 *
 * Exposes sortie's web capabilities as MCP tools so any agent can query
 * and act on the web like it were an API:
 *   - web_outline: distill a page into an LLM-readable outline (no LLM needed)
 *   - web_search: web search via SearXNG or browser-driven engines (no LLM needed)
 *   - web_fetch: URL (HTML or PDF) -> clean main-content Markdown (no LLM needed)
 *   - web_extract: schema-grounded semantic extraction (uses the configured provider)
 *   - run_agent: multi-step browser agent driven by a natural-language goal
 *   - run_saved_query: replay a named extraction query, persisted to the run store
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  extract,
  distillPage,
  navigateAndSettle,
  navigateOrPdfSnapshot,
  jsonSchemaToZod,
  runAgent,
  search,
  fetchPage,
  withPage,
  createRunStore,
  prepareSavedQueryRun,
  isSlug,
  VERSION,
  type RunStore,
} from '@garrison-hq/sortie';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env like the CLI does: cwd first, then the repo root relative to this file.
const here = path.dirname(fileURLToPath(import.meta.url));
for (const candidate of [path.join(process.cwd(), '.env'), path.resolve(here, '../../../.env')]) {
  try {
    process.loadEnvFile(candidate);
    break;
  } catch {
    // keep looking
  }
}

// Run store, opened lazily on the first tool call that needs it (saved-query
// replay, profile resolution). WAL journaling means the API server can hold
// the same database open concurrently.
let runStore: RunStore | undefined;
function getStore(): RunStore {
  runStore ??= createRunStore();
  return runStore;
}

/**
 * Resolve an optional `profile` tool argument to its storage-state path:
 * slug check -> metadata lookup -> on-disk state file check, stamping
 * lastUsedAt on success. Throws a clear, tool-prefixed error on any failure
 * (the call handler's catch turns it into an MCP error result).
 */
function resolveProfileArg(tool: string, profile: unknown): string | undefined {
  if (profile === undefined) return undefined;
  if (typeof profile !== 'string' || !isSlug(profile)) {
    throw new Error(
      `${tool}: "profile" must be a slug (lowercase letters, digits, "-", "_"; max 64 chars)`,
    );
  }
  const store = getStore();
  if (!store.getProfile(profile)) {
    throw new Error(
      `${tool}: login profile "${profile}" does not exist — create it with \`sortie profile login ${profile} --url <loginUrl>\``,
    );
  }
  const statePath = store.profileStatePath(profile);
  if (!existsSync(statePath)) {
    throw new Error(
      `${tool}: login profile "${profile}" has no storage-state file on disk — re-create it with \`sortie profile login ${profile} --url <loginUrl>\``,
    );
  }
  store.touchProfile(profile);
  return statePath;
}

const TOOLS = [
  {
    name: 'web_outline',
    description:
      'Open a URL in a real headless browser and return a distilled snapshot: page title, a compact outline of interactive elements (links, buttons, inputs with stable refs), and the visible text. Use this to understand what is on a page. Does not require an LLM API key.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL to open, e.g. https://example.com' },
      },
      required: ['url'],
    },
  },
  {
    name: 'web_search',
    description:
      'Search the web and return ranked results (title, url, snippet). Uses a configured SearXNG instance when SEARXNG_BASE_URL is set on the server, otherwise drives real search engines in a headless browser (Bing -> DuckDuckGo -> Brave fallback chain). Engines that present CAPTCHAs are skipped, never bypassed. Does not require an LLM API key.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query, e.g. "attention is all you need arxiv"',
        },
        maxResults: {
          type: 'number',
          description: 'Number of results to return (default 10, clamped to 1..20)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description:
      'Fetch a URL — HTML or PDF — and convert it to clean, main-content Markdown (boilerplate like navigation, ads, and footers stripped; PDFs are downloaded and converted with per-page markers). Use this to read articles, documentation, and papers. Does not require an LLM API key.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute URL to fetch, e.g. https://example.com/post',
        },
        maxChars: {
          type: 'number',
          description:
            'Cap on returned Markdown length (default 80000); content beyond it is truncated',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'web_extract',
    description:
      'Open a URL in a real headless browser and semantically extract structured data matching a JSON Schema, located by meaning rather than CSS selectors. Returns validated JSON. Requires an LLM provider key (ANTHROPIC_API_KEY or OPENAI_API_KEY/OPENAI_BASE_URL) on the server.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL to extract from' },
        schema: {
          type: 'object',
          description:
            'JSON Schema (root must be type:"object") describing the data to extract, e.g. {"type":"object","properties":{"books":{"type":"array","items":{...}}}}',
        },
        instruction: {
          type: 'string',
          description: 'Optional natural-language hint, e.g. "the first 5 books listed"',
        },
        profile: {
          type: 'string',
          description:
            'Optional named login profile (created via `sortie profile login`) whose saved session cookies are loaded before navigating, so extraction starts already signed in.',
        },
      },
      required: ['url', 'schema'],
    },
  },
  {
    name: 'run_agent',
    description:
      'Drive a real headless browser through a multi-step web task described in natural language: navigate, click, type, paginate, log in, and finally return structured, schema-validated results. Use this when a single extraction is not enough (e.g. "log in and fetch the order history", "page through all results and collect every item"). CAPTCHAs and anti-bot walls are not bypassed — the run fails gracefully with a clear reason. Requires an LLM provider key on the server.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description:
            'Natural-language goal, e.g. "log in as standard_user, add the backpack to the cart, and report the cart total". Reference credentials as {{cred:NAME}} — never put secret values in the goal text.',
        },
        startUrl: { type: 'string', description: 'Absolute URL where the agent starts' },
        schema: {
          type: 'object',
          description:
            'Optional JSON Schema (root must be type:"object") that the final output must validate against',
        },
        maxSteps: {
          type: 'number',
          description: 'Hard cap on agent steps (default 25)',
        },
        credentials: {
          type: 'object',
          description:
            'Named secrets the agent may type via {{cred:NAME}} placeholders. STRONGLY PREFER values of the form "env:VARNAME" (e.g. {"PASSWORD": "env:SHOP_PASSWORD"}), which are resolved from the server\'s environment at call time so secrets never travel through the client. Raw literal values are accepted but discouraged. Credential values are never shown to the model or included in results.',
          additionalProperties: { type: 'string' },
        },
        profile: {
          type: 'string',
          description:
            'Optional named login profile (created via `sortie profile login`) whose saved session cookies are loaded before the agent starts, so it begins already signed in.',
        },
      },
      required: ['goal', 'startUrl'],
    },
  },
  {
    name: 'run_saved_query',
    description:
      'Execute a saved extraction query by name, optionally overriding its URL or instruction for this run (e.g. replay the same schema against page 2). The run is persisted to the sortie run store like any other run (inspect with `sortie runs`). Requires an LLM provider key on the server.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Saved query name (created via `sortie query save` or the API)',
        },
        urlOverride: {
          type: 'string',
          description: 'Absolute URL to extract from instead of the saved one',
        },
        instructionOverride: {
          type: 'string',
          description: 'Extraction hint to use instead of the saved one',
        },
      },
      required: ['name'],
    },
  },
] as const;

function textResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

const server = new Server({ name: 'sortie', version: VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...TOOLS] }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    switch (name) {
      case 'web_outline': {
        const url = String((args as { url?: unknown })?.url ?? '');
        if (!/^https?:\/\//.test(url)) {
          return errorResult(new Error('web_outline: "url" must be an absolute http(s) URL'));
        }
        const snapshot = await withPage(undefined, async (page) => {
          await navigateAndSettle(page, url);
          return distillPage(page);
        });
        return textResult({
          url: snapshot.url,
          title: snapshot.title,
          elementCount: snapshot.elements.length,
          outline: snapshot.outline,
          text: snapshot.text,
        });
      }
      case 'web_search': {
        const { query, maxResults } = (args ?? {}) as { query?: unknown; maxResults?: unknown };
        if (typeof query !== 'string' || query.trim().length === 0) {
          return errorResult(new Error('web_search: "query" must be a non-empty string'));
        }
        if (
          maxResults !== undefined &&
          (typeof maxResults !== 'number' || !Number.isInteger(maxResults) || maxResults <= 0)
        ) {
          return errorResult(new Error('web_search: "maxResults" must be a positive integer'));
        }
        const response = await search(query, { maxResults: maxResults as number | undefined });
        return textResult(response);
      }
      case 'web_fetch': {
        const { url, maxChars } = (args ?? {}) as { url?: unknown; maxChars?: unknown };
        if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
          return errorResult(new Error('web_fetch: "url" must be an absolute http(s) URL'));
        }
        if (
          maxChars !== undefined &&
          (typeof maxChars !== 'number' || !Number.isInteger(maxChars) || maxChars <= 0)
        ) {
          return errorResult(new Error('web_fetch: "maxChars" must be a positive integer'));
        }
        const result = await fetchPage({ url, maxChars: maxChars as number | undefined });
        // Markdown only — the plain-text rendering would double the payload.
        return textResult({
          url: result.url,
          finalUrl: result.finalUrl,
          title: result.title,
          contentType: result.contentType,
          truncated: result.truncated,
          markdown: result.markdown,
        });
      }
      case 'web_extract': {
        const { url, schema, instruction, profile } = (args ?? {}) as {
          url?: unknown;
          schema?: unknown;
          instruction?: unknown;
          profile?: unknown;
        };
        if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
          return errorResult(new Error('web_extract: "url" must be an absolute http(s) URL'));
        }
        if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
          return errorResult(new Error('web_extract: "schema" must be a JSON Schema object'));
        }
        const storageStatePath = resolveProfileArg('web_extract', profile);
        const zodSchema = jsonSchemaToZod(schema as Record<string, unknown>);
        // Own the page (instead of letting extract() navigate) so the
        // profile's storage state can be loaded into the browser context.
        const result = await withPage({ storageStatePath }, async (page) => {
          const snapshot = await navigateOrPdfSnapshot(page, url);
          return extract({
            ...(snapshot ? { snapshot } : { page }),
            schema: zodSchema,
            instruction: typeof instruction === 'string' ? instruction : undefined,
          });
        });
        return textResult({ data: result.data, url: result.url, usage: result.usage });
      }
      case 'run_agent': {
        const { goal, startUrl, schema, maxSteps, credentials, profile } = (args ?? {}) as {
          goal?: unknown;
          startUrl?: unknown;
          schema?: unknown;
          maxSteps?: unknown;
          credentials?: unknown;
          profile?: unknown;
        };
        if (typeof goal !== 'string' || goal.trim().length === 0) {
          return errorResult(new Error('run_agent: "goal" must be a non-empty string'));
        }
        if (typeof startUrl !== 'string' || !/^https?:\/\//.test(startUrl)) {
          return errorResult(new Error('run_agent: "startUrl" must be an absolute http(s) URL'));
        }
        if (
          schema !== undefined &&
          (typeof schema !== 'object' || schema === null || Array.isArray(schema))
        ) {
          return errorResult(new Error('run_agent: "schema" must be a JSON Schema object'));
        }
        if (
          maxSteps !== undefined &&
          (typeof maxSteps !== 'number' || !Number.isInteger(maxSteps) || maxSteps <= 0)
        ) {
          return errorResult(new Error('run_agent: "maxSteps" must be a positive integer'));
        }
        if (
          credentials !== undefined &&
          (typeof credentials !== 'object' || credentials === null || Array.isArray(credentials))
        ) {
          return errorResult(
            new Error('run_agent: "credentials" must be an object of name -> value strings'),
          );
        }

        // Resolve credentials. "env:VARNAME" values are read from the server's
        // environment at call time. Resolved values are passed straight to the
        // agent executor and never appear in prompts, results, or errors.
        let resolvedCredentials: Record<string, string> | undefined;
        if (credentials !== undefined) {
          resolvedCredentials = {};
          for (const [credName, credValue] of Object.entries(
            credentials as Record<string, unknown>,
          )) {
            if (typeof credValue !== 'string') {
              return errorResult(
                new Error(`run_agent: credential "${credName}" must be a string value`),
              );
            }
            if (credValue.startsWith('env:')) {
              const envName = credValue.slice('env:'.length);
              const envValue = process.env[envName];
              if (envValue === undefined) {
                return errorResult(
                  new Error(
                    `run_agent: credential "${credName}" references environment variable "${envName}", which is not set on the server`,
                  ),
                );
              }
              resolvedCredentials[credName] = envValue;
            } else {
              resolvedCredentials[credName] = credValue;
            }
          }
        }

        const storageStatePath = resolveProfileArg('run_agent', profile);
        const zodSchema =
          schema !== undefined ? jsonSchemaToZod(schema as Record<string, unknown>) : undefined;
        const result = await runAgent({
          goal,
          startUrl,
          schema: zodSchema,
          maxSteps: maxSteps as number | undefined,
          credentials: resolvedCredentials,
          storageStatePath,
        });

        // Deliberately compact: step records contain page text and would bloat
        // (and could leak into) the client's context.
        const payload = {
          status: result.status,
          output: result.output,
          failureReason: result.failureReason,
          finalUrl: result.finalUrl,
          stepCount: result.steps.length,
          usage: result.usage,
        };
        return result.status === 'success'
          ? textResult(payload)
          : { ...textResult(payload), isError: true };
      }
      case 'run_saved_query': {
        const {
          name: queryName,
          urlOverride,
          instructionOverride,
        } = (args ?? {}) as {
          name?: unknown;
          urlOverride?: unknown;
          instructionOverride?: unknown;
        };
        if (typeof queryName !== 'string' || queryName.trim().length === 0) {
          return errorResult(new Error('run_saved_query: "name" must be a non-empty string'));
        }
        if (
          urlOverride !== undefined &&
          (typeof urlOverride !== 'string' || !/^https?:\/\//.test(urlOverride))
        ) {
          return errorResult(
            new Error('run_saved_query: "urlOverride" must be an absolute http(s) URL'),
          );
        }
        if (instructionOverride !== undefined && typeof instructionOverride !== 'string') {
          return errorResult(new Error('run_saved_query: "instructionOverride" must be a string'));
        }

        const store = getStore();
        // Throws with a clear message when no query by that name exists;
        // bumps the query's runCount/lastRunAt and stamps spec.queryName.
        const spec = prepareSavedQueryRun(store, queryName, {
          url: urlOverride,
          instruction: instructionOverride,
        });
        if (!spec.schemaJson) {
          return errorResult(
            new Error(`run_saved_query: saved query "${queryName}" has no schema (schemaJson)`),
          );
        }

        // Persist the replay as a run, mirroring the queue's lifecycle:
        // queued -> running -> success/failed.
        const record = store.createRun(spec);
        store.updateRun(record.id, { status: 'running', startedAt: Date.now(), attempts: 1 });
        try {
          // Resolved inside the try so a missing profile persists as a
          // failed run (matching the queue's final no-retry 'failed').
          let storageStatePath = spec.storageStatePath;
          if (spec.profile !== undefined) {
            if (spec.storageStatePath !== undefined) {
              throw new Error(
                '`profile` and `storageStatePath` are mutually exclusive — fix the saved spec.',
              );
            }
            storageStatePath = resolveProfileArg('run_saved_query', spec.profile);
          }
          const zodSchema = jsonSchemaToZod(spec.schemaJson);
          const result = await withPage({ storageStatePath }, async (page) => {
            const snapshot = await navigateOrPdfSnapshot(page, spec.url);
            return extract({
              ...(snapshot ? { snapshot } : { page }),
              schema: zodSchema,
              instruction: spec.instruction,
            });
          });
          store.updateRun(record.id, {
            status: 'success',
            finishedAt: Date.now(),
            output: result.data,
            usage: result.usage,
            finalUrl: result.url,
          });
          return textResult({
            runId: record.id,
            query: queryName,
            status: 'success',
            data: result.data,
            url: result.url,
            usage: result.usage,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          store.updateRun(record.id, {
            status: 'failed',
            finishedAt: Date.now(),
            failureReason: message,
          });
          return errorResult(new Error(`run_saved_query: run ${record.id} failed — ${message}`));
        }
      }
      default:
        return errorResult(new Error(`Unknown tool: ${name}`));
    }
  } catch (err) {
    return errorResult(err);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`sortie MCP server v${VERSION} ready (stdio)`);
