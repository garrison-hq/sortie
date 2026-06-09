#!/usr/bin/env node
/**
 * nanofish MCP server (stdio).
 *
 * Exposes nanofish's web capabilities as MCP tools so any agent can query
 * and act on the web like it were an API:
 *   - web_outline: distill a page into an LLM-readable outline (no LLM needed)
 *   - web_extract: schema-grounded semantic extraction (uses the configured provider)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  extract,
  distillPage,
  navigateAndSettle,
  jsonSchemaToZod,
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
