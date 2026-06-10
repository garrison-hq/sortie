/**
 * Agentic verification of the sortie MCP server: connect as a real MCP
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
  'tools/list returns the 6 sortie tools',
  names.join(',') === 'run_agent,run_saved_query,web_extract,web_fetch,web_outline,web_search',
  names.join(','),
);
const requiredFor = (toolName: string) =>
  tools.find((t) => t.name === toolName)?.inputSchema.required;
check(
  'tool schemas are object-rooted with expected required fields',
  tools.every((t) => t.inputSchema.type === 'object') &&
    ['web_outline', 'web_extract', 'web_fetch'].every((n) => {
      const required = requiredFor(n);
      return Array.isArray(required) && required.includes('url');
    }) &&
    (() => {
      const required = requiredFor('run_agent');
      return Array.isArray(required) && required.includes('goal') && required.includes('startUrl');
    })() &&
    (() => {
      const required = requiredFor('web_search');
      return Array.isArray(required) && required.includes('query');
    })() &&
    (() => {
      const required = requiredFor('run_saved_query');
      return Array.isArray(required) && required.includes('name');
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

// 5. web_fetch live: HTML page -> clean Markdown (no LLM needed)
const fetchRes = await client.callTool({
  name: 'web_fetch',
  arguments: { url: 'https://en.wikipedia.org/wiki/Web_scraping', maxChars: 20_000 },
});
const fetchText = (fetchRes.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
check('web_fetch live call succeeds', fetchRes.isError !== true, fetchText.slice(0, 200));
if (fetchRes.isError !== true) {
  const fetched = JSON.parse(fetchText);
  check('  contentType is html', fetched.contentType === 'html');
  check(
    '  markdown headings present',
    /^#{1,4} /m.test(String(fetched.markdown)),
    String(fetched.markdown).match(/^#{1,4} .*$/m)?.[0],
  );
  check('  title mentions Web scraping', /web scraping/i.test(String(fetched.title)));
}

// 6. web_fetch input validation: bad URL is a tool error, not a crash
const badFetch = await client.callTool({ name: 'web_fetch', arguments: { url: 'not-a-url' } });
check('web_fetch rejects invalid url as isError', badFetch.isError === true);

// 7. web_search live: graceful skip when every engine is challenged (anti-bot
// evasion is out of scope — a clear failure message IS the contract then).
const searchRes = await client.callTool({
  name: 'web_search',
  arguments: { query: 'playwright web automation', maxResults: 5 },
});
const searchText = (searchRes.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
if (searchRes.isError === true) {
  const graceful = /no backend produced results/i.test(searchText);
  check(
    'web_search engines unavailable -> graceful error names the fix (SKIPPED live assertions)',
    graceful && /SEARXNG_BASE_URL/.test(searchText),
    searchText.slice(0, 160),
  );
} else {
  const found = JSON.parse(searchText);
  check('web_search live call succeeds', Array.isArray(found.results), `source=${found.source}`);
  check('  >= 3 results', found.results.length >= 3, String(found.results.length));
  check(
    '  result URLs are absolute http(s)',
    found.results.every((r: { url: string }) => /^https?:\/\//.test(r.url)),
  );
}

await client.close();
console.log(failures === 0 ? '\nALL MCP CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
