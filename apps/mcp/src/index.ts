#!/usr/bin/env node
/**
 * nanofish MCP server (stdio).
 *
 * Exposes nanofish's web capabilities as MCP tools so any agent can query
 * and act on the web like it were an API:
 *   - web_outline: distill a page into an LLM-readable outline (no LLM needed)
 *   - web_extract: schema-grounded semantic extraction (uses the configured provider)
 *   - run_agent: multi-step browser agent driven by a natural-language goal
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  extract,
  distillPage,
  navigateAndSettle,
  jsonSchemaToZod,
  runAgent,
  withPage,
  VERSION,
} from '@nanofish/core';
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
      },
      required: ['goal', 'startUrl'],
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

const server = new Server({ name: 'nanofish', version: VERSION }, { capabilities: { tools: {} } });

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
      case 'web_extract': {
        const { url, schema, instruction } = (args ?? {}) as {
          url?: unknown;
          schema?: unknown;
          instruction?: unknown;
        };
        if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
          return errorResult(new Error('web_extract: "url" must be an absolute http(s) URL'));
        }
        if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
          return errorResult(new Error('web_extract: "schema" must be a JSON Schema object'));
        }
        const zodSchema = jsonSchemaToZod(schema as Record<string, unknown>);
        const result = await extract({
          url,
          schema: zodSchema,
          instruction: typeof instruction === 'string' ? instruction : undefined,
        });
        return textResult({ data: result.data, url: result.url, usage: result.usage });
      }
      case 'run_agent': {
        const { goal, startUrl, schema, maxSteps, credentials } = (args ?? {}) as {
          goal?: unknown;
          startUrl?: unknown;
          schema?: unknown;
          maxSteps?: unknown;
          credentials?: unknown;
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

        const zodSchema =
          schema !== undefined ? jsonSchemaToZod(schema as Record<string, unknown>) : undefined;
        const result = await runAgent({
          goal,
          startUrl,
          schema: zodSchema,
          maxSteps: maxSteps as number | undefined,
          credentials: resolvedCredentials,
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
      default:
        return errorResult(new Error(`Unknown tool: ${name}`));
    }
  } catch (err) {
    return errorResult(err);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`nanofish MCP server v${VERSION} ready (stdio)`);
