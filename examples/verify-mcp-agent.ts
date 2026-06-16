/**
 * Agentic verification of the sortie MCP server's run_agent tool: connect
 * as a real MCP client over stdio and drive a live multi-step login flow on
 * the-internet.herokuapp.com (public demo credentials — not secrets).
 *
 * Requires an LLM provider key (.env at the repo root, loaded by the server).
 * Run from repo root: npx tsx examples/verify-mcp-agent.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let failures = 0;
// `detail` can carry live page / LLM output; replace control characters so the
// terminal can't be driven by escape sequences and log lines can't be forged.
const sanitize = (s: string): string =>
  [...s].map((c) => ((c.codePointAt(0) ?? 0) < 0x20 ? ' ' : c)).join('');
function check(label: string, ok: boolean, detail = '') {
  const suffix = detail ? ` — ${sanitize(detail)}` : '';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${sanitize(label)}${suffix}`);
  if (!ok) failures++;
}

const transport = new StdioClientTransport({
  command: 'node',
  args: ['apps/mcp/dist/index.js'],
  cwd: new URL('..', import.meta.url).pathname,
});
const client = new Client({ name: 'verify-mcp-agent', version: '0.0.1' });
await client.connect(transport);
check('initialize handshake', true);

// 1. Input validation: missing goal is a tool error, not a crash
const bad = await client.callTool({
  name: 'run_agent',
  arguments: { startUrl: 'https://the-internet.herokuapp.com/login' },
});
check('run_agent rejects missing goal as isError', bad.isError === true);

// 2. Live multi-step login run. These are the site's public demo credentials,
// so literal values are fine here; real deployments should use "env:VARNAME".
const res = await client.callTool({
  name: 'run_agent',
  arguments: {
    goal: 'log in with the provided credentials and report the flash message text',
    startUrl: 'https://the-internet.herokuapp.com/login',
    // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- public demo credentials published by the-internet.herokuapp.com; not a secret
    credentials: { USERNAME: 'tomsmith', PASSWORD: 'SuperSecretPassword!' },
    schema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
});
const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
check('run_agent live call succeeds', res.isError !== true, text.slice(0, 200));

const payload = JSON.parse(text) as {
  status: string;
  output?: { message?: string };
  finalUrl: string;
  stepCount: number;
  usage: { inputTokens: number; outputTokens: number };
};
check('  status is success', payload.status === 'success', payload.status);
const message = String(payload.output?.message ?? '');
check("  message mentions 'logged into'", message.includes('logged into'), message);
check('  final URL is the secure area', payload.finalUrl.includes('/secure'), payload.finalUrl);
check('  step count reported', payload.stepCount > 0, String(payload.stepCount));
check('  usage reported', payload.usage.inputTokens > 0);
check(
  '  password value never appears in the result payload',
  !text.includes('SuperSecretPassword!'),
);

await client.close();
console.log(failures === 0 ? '\nALL MCP AGENT CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
