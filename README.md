# nanofish

**Query and act on the web like it were an API.**

nanofish is a local-first platform for autonomous web agents. Describe the data you want in plain language plus a JSON Schema, and nanofish drives a real Chromium browser, locates content by _meaning_ rather than brittle CSS/XPath selectors, and returns clean, schema-validated JSON — extractions keep working when a site's layout changes. For multi-step tasks ("log in, search for X, collect the first 20 results"), an agent loop plans and executes navigation, clicks, typing, and pagination, recovering from failures along the way. Everything runs on your machine: local browser automation, a SQLite-backed run queue, and your choice of LLM (Anthropic, OpenAI, or any OpenAI-compatible endpoint such as Ollama, vLLM, or OpenRouter).

- **Semantic extraction** — pages are distilled into a compact, LLM-readable outline; data is located by meaning and validated against your schema.
- **Multi-step agents** — goal in, browser actions out, structured output at the end. Credentials are referenced by name and never shown to the model.
- **Reliability built in** — retries, per-domain rate limiting, self-healing element references, concurrent batch runs.
- **Local-first** — CLI, typed SDK, REST/WebSocket server, playground UI, and an MCP server. No hosted dependency for the core loop.

## Quickstart

Requires Node >= 22 and pnpm.

```sh
pnpm install
npx playwright install chromium   # browser binary for local runs
cp .env.example .env              # then fill in your provider key (see below)
pnpm build
pnpm dev                          # server + playground at http://localhost:3470
```

In `.env`, set at least one LLM provider:

- `ANTHROPIC_API_KEY` (+ optional `ANTHROPIC_MODEL`), or
- `OPENAI_API_KEY` (+ optional `OPENAI_MODEL`), or
- `OPENAI_BASE_URL` pointing at any OpenAI-compatible endpoint (Ollama, vLLM, OpenRouter, ...) — no key required for local endpoints.

`NANOFISH_PROVIDER` (`anthropic` | `openai`, default `anthropic`) picks which one is used by default.

## CLI

The CLI ships as the `nanofish` bin of `@nanofish/core`. After `pnpm build`, run it from the repo root:

```sh
node packages/core/dist/cli.js --help
# Optional convenience alias:
alias nanofish="node $(pwd)/packages/core/dist/cli.js"
```

It reads `.env` from the current directory or the repo root automatically.

### `extract` — one-shot semantic extraction

```sh
nanofish extract https://books.toscrape.com \
  --schema '{"type":"object","properties":{"books":{"type":"array","items":{"type":"object","properties":{"title":{"type":"string"},"price":{"type":"number"}},"required":["title","price"]}}},"required":["books"]}' \
  --instruction "the list of books on the page"
```

`--schema` accepts inline JSON or `@path/to/schema.json`. Useful flags: `--instruction` (natural-language hint), `--out <file>`, `--headful` (visible browser), `--provider anthropic|openai`, `--model <m>`.

### `agent` — multi-step browser agent

```sh
SAUCE_PASSWORD=... nanofish agent https://www.saucedemo.com \
  --goal "log in as standard_user with password {{cred:SAUCE_PASSWORD}}, add the backpack to the cart, and report the cart total" \
  --cred SAUCE_PASSWORD \
  --schema '{"type":"object","properties":{"total":{"type":"string"}},"required":["total"]}'
```

**Credential security model:** `--cred NAME` (repeatable) exposes the value of environment variable `NAME` to the action executor only. The model never sees the value — prompts, goals, and traces contain only the `{{cred:NAME}}` placeholder; substitution happens at the moment of typing, and outgoing observations are scrubbed for raw credential values. Values are never printed or persisted.

Other flags: `--max-steps <n>` (default 25), `--storage-state <path>` (reuse a Playwright storage-state JSON for logins), `--out <file>` (final output), `--trace <file>` (full step-by-step run trace), `--headful`.

### `batch` — run many specs concurrently

```sh
nanofish batch specs.jsonl --concurrency 3 --export results.csv
```

The specs file is either a `.json` array or a `.jsonl` file (one spec per line). Each spec:

```jsonc
{
  "kind": "extract", // or "agent"
  "url": "https://books.toscrape.com", // target URL (extract) / start URL (agent)
  "schemaJson": { "type": "object", "...": "..." }, // required for extract
  "goal": "…", // required for agent
  "instruction": "…", // optional extraction hint
  "maxSteps": 15, // optional (agent)
  "credentialNames": ["SHOP_PASSWORD"], // env var NAMES; values resolved at run time, never stored
  "storageStatePath": "…", // optional
}
```

Runs execute on a worker pool (default concurrency 5, clamped 1..10) with per-domain rate limiting, and persist to SQLite. `--export file.json|file.csv` writes the batch results after it drains; `--data-dir <path>` selects where `nanofish.db` lives.

### `runs` — inspect and export persisted runs

```sh
nanofish runs list --status success --limit 20
nanofish runs show 1f2e3d4c           # full id or unique short-id prefix
nanofish runs export out.csv --batch <batch-id>
```

Exports support `.json` and `.csv` (CSV flattens one row per run, or one row per array item when every output is an object with a single array field).

## Programmatic SDK

`@nanofish/core` exposes a fully typed API. zod schemas are the source of truth for output shapes.

```ts
import { z } from 'zod';
import { extract } from '@nanofish/core';

const Books = z.object({
  books: z.array(z.object({ title: z.string(), price: z.number() })),
});

const { data, usage } = await extract({
  url: 'https://books.toscrape.com',
  schema: Books,
  instruction: 'the books listed on the page',
});
// data is typed as { books: { title: string; price: number }[] }
```

```ts
import { z } from 'zod';
import { runAgent } from '@nanofish/core';

const result = await runAgent({
  goal: 'log in as standard_user with password {{cred:SAUCE_PASSWORD}}, add the backpack to the cart, and report the cart total',
  startUrl: 'https://www.saucedemo.com',
  schema: z.object({ total: z.string() }),
  credentials: { SAUCE_PASSWORD: process.env.SAUCE_PASSWORD! }, // value never reaches the model
  maxSteps: 15,
  onStep: (step) => console.error(`[${step.index + 1}] ${step.action.tool}`),
});

if (result.status === 'success') {
  console.log(result.output); // { total: string }
}
```

Also exported: `createProvider()` (env-driven provider construction with overrides), the browser layer (`BrowserManager`, `withPage`, `distillPage`, `resolveRef`), `jsonSchemaToZod()` for JSON Schema inputs, and the runtime (`createRunStore`, `createRunQueue`). All shared types live in [`packages/core/src/contracts.ts`](packages/core/src/contracts.ts).

## MCP server

`apps/mcp` exposes nanofish over the Model Context Protocol (stdio), so any MCP-capable agent — Claude Code included — can use the web like an API:

| Tool          | What it does                                                                              |
| ------------- | ----------------------------------------------------------------------------------------- |
| `web_outline` | Distill a URL into title + interactive-element outline + visible text. No LLM key needed. |
| `web_extract` | Schema-grounded semantic extraction from a URL (uses the configured provider).            |
| `run_agent`   | Multi-step browser agent: goal + startUrl in, schema-validated output out.                |

Wire it up in `.mcp.json` (already present at the repo root):

```json
{
  "mcpServers": {
    "nanofish": {
      "command": "node",
      "args": ["apps/mcp/dist/index.js"]
    }
  }
}
```

For `run_agent` credentials, prefer `env:` references — `{"PASSWORD": "env:SHOP_PASSWORD"}` is resolved from the _server's_ environment at call time, so secrets never travel through the MCP client, and (as everywhere in nanofish) the model only ever sees `{{cred:NAME}}` placeholders.

## Playground UI

The React playground (`apps/ui`) lets you author an extract or agent run, submit it, and watch it execute: live step stream over WebSocket, per-step screenshots, run history, full run detail with the recorded trace, and JSON/CSV export.

- **Production:** `pnpm build && pnpm dev` — the server serves the built UI at `http://localhost:3470`.
- **UI development:** run `pnpm dev` (API server on :3470) and `pnpm dev:ui` (Vite dev server with hot reload, proxying `/api` to :3470) side by side.

The server also works headless as a pure JSON API: `POST /api/runs`, `POST /api/batches`, `GET /api/runs[/:id]`, `GET /api/export?format=json|csv`, and `GET /api/events` (WebSocket event stream).

## Docker

For remote hosts, the included compose file builds the image (Playwright base image with Chromium bundled — no separate browser install) and runs the server:

```sh
cp .env.example .env   # provider keys; compose passes it via env_file
docker compose up -d --build
```

- The UI/API listens on port `3470`.
- All state (SQLite database, screenshots, exports) lives in the `nanofish-data` named volume, mounted at `/data` (`NANOFISH_DATA_DIR=/data`).
- `.env` is supplied through `env_file` and is never baked into the image. Keep it out of version control.

## Architecture

```
packages/core          the engine + SDK + CLI (contracts.ts is the single source of truth)
  llm/                 provider layer: Anthropic + OpenAI-compatible (base URL overridable)
  browser/             Playwright manager + page distillation (refs, outline, text)
  extract/             semantic extraction: snapshot + schema -> validated JSON
  agent/               multi-step loop: tools, prompts, credential substitution
  store/               SQLite persistence: runs, steps, JSON/CSV export
  runtime/             in-process run queue: worker pool, rate limiting, retries
apps/server            Fastify REST + WebSocket; serves the built UI in production
apps/ui                React/Vite playground
apps/mcp               MCP server (stdio) over the core engine
examples/              live verification scripts
```

Every cross-module type is defined once in `packages/core/src/contracts.ts`; modules implement against those interfaces, and zod schemas validate all structured data crossing a boundary (LLM output, API payloads, user-supplied schemas).

**Reliability:** the page is re-distilled before every agent step, so element refs self-heal after navigations and layout changes — a stale ref produces an error observation the model recovers from, never a crashed run. Extraction outputs that fail schema validation are fed back to the model for correction (up to 2 retries). The run queue retries infrastructure failures (timeouts, crashes — not agent-reported failures, default 2 attempts) and rate-limits run starts per domain (default 1/s).

**Scope boundaries:** CAPTCHA solving and anti-bot evasion are deliberately out of scope. Runs that hit such walls fail gracefully with a clear reason instead. Be polite to the sites you automate.

## Notes & limitations

- **CSV export flattening:** CSV is one row per run. When _every_ exported output is an object with a single array-valued field, the export flattens to one row per array item instead. Mixed or deeply nested outputs are better served by JSON export.
- **Retries re-emit `run-started`:** the queue retries infrastructure failures (timeouts, browser crashes) up to `maxRetries` times. Each attempt emits a fresh `run-started` event and increments the run's `attempts` counter — event consumers (WebSocket clients, custom `onEvent` listeners) should treat `run-started` as at-least-once, keyed by `runId`.
- **Drain before shutdown:** `queue.shutdown()` waits only for runs already _in flight_, then closes the browser — runs still queued are left in `queued` status, not executed. Call `await queue.drain()` first if you want all submitted work to finish (the CLI `batch` command does this).
- **WebSocket observation truncation:** live `run-step` frames truncate each step's `observation` to 2000 chars to keep frames small. The full observation is always persisted — fetch `GET /api/runs/:id` (or `runs show <id>`) for the complete trace.

## Examples & tests

`examples/` contains live verification scripts run with `npx tsx` from the repo root (e.g. `npx tsx examples/verify-browser.ts`); see each file's header for what it checks and whether it needs an LLM key.

```sh
pnpm test                       # unit/integration tests (vitest, no LLM calls)
pnpm typecheck && pnpm lint     # static checks
pnpm --filter @nanofish/ui e2e  # full-stack Playwright e2e (builds the monorepo,
                                # boots the real server, includes one live LLM extraction)
```
