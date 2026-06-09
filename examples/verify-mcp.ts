/**
 * Agentic verification of the nanofish MCP server: connect as a real MCP
 * client over stdio, list tools, and exercise both live.
 *
 * Run from repo root: npx tsx examples/verify-mcp.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const transport = new StdioClientTransport({
  command: 'node',
  args: ['apps/mcp/dist/index.js'],
  cwd: new URL('..', import.meta.url).pathname,
});
const client = new Client({ name: 'verify-mcp', version: '0.0.1' });
await client.connect(transport);
check('initialize handshake', true);

// 1. Tool discovery
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
check(
  'tools/list returns run_agent + web_outline + web_extract',
  names.join(',') === 'run_agent,web_extract,web_outline',
  names.join(','),
);
const requiredFor = (toolName: string) =>
  tools.find((t) => t.name === toolName)?.inputSchema.required;
check(
  'tool schemas are object-rooted with expected required fields',
  tools.every((t) => t.inputSchema.type === 'object') &&
    ['web_outline', 'web_extract'].every((n) => {
      const required = requiredFor(n);
      return Array.isArray(required) && required.includes('url');
    }) &&
    (() => {
      const required = requiredFor('run_agent');
      return Array.isArray(required) && required.includes('goal') && required.includes('startUrl');
    })(),
);

// 2. Input validation: bad URL is a tool error, not a crash
const bad = await client.callTool({ name: 'web_outline', arguments: { url: 'not-a-url' } });
check('web_outline rejects invalid url as isError', bad.isError === true);

// 3. web_outline live against books.toscrape.com (no LLM key needed)
const outlineRes = await client.callTool({
  name: 'web_outline',
  arguments: { url: 'https://books.toscrape.com/' },
});
const outlineText = (outlineRes.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
const outline = JSON.parse(outlineText);
check('web_outline live call succeeds', outlineRes.isError !== true);
check('  title mentions Books', String(outline.title).includes('Books'), outline.title);
check('  element count >= 20', outline.elementCount >= 20, String(outline.elementCount));
check('  outline contains e-refs', /\[e\d+\]/.test(outline.outline));

// 4. web_extract: end-to-end if a key is configured, graceful error otherwise
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
const extractRes = await client.callTool({
  name: 'web_extract',
  arguments: {
    url: 'https://books.toscrape.com/',
    instruction: 'the first 3 books listed',
    schema: {
      type: 'object',
      properties: {
        books: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: { type: 'string' }, price: { type: 'string' } },
            required: ['title', 'price'],
          },
        },
      },
      required: ['books'],
    },
  },
});
const extractText = (extractRes.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
if (extractRes.isError) {
  check(
    'web_extract without API key fails gracefully with actionable message',
    !hasKey && /API key/i.test(extractText),
    extractText,
  );
} else {
  const extracted = JSON.parse(extractText);
  check('web_extract live extraction succeeds', Array.isArray(extracted.data?.books));
  check('  got 3 books', extracted.data.books.length === 3, JSON.stringify(extracted.data.books));
  check('  usage reported', extracted.usage?.inputTokens > 0);
}

await client.close();
console.log(failures === 0 ? '\nALL MCP CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
