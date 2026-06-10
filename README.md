# sortie

[![CI](https://github.com/garrison-hq/sortie/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/garrison-hq/sortie/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178C6.svg)](./tsconfig.base.json)

**Query and act on the web like it were an API.**

> **Status:** pre-1.0, built alongside other work by one person. APIs and schemas may still change between commits. Production use at your own risk.

sortie is a local-first platform for autonomous web agents. Describe the data you want in plain language plus a JSON Schema, and sortie drives a real Chromium browser, locates content by _meaning_ rather than brittle CSS/XPath selectors, and returns clean, schema-validated JSON — extractions keep working when a site's layout changes. For multi-step tasks ("log in, search for X, collect the first 20 results"), an agent loop plans and executes navigation, clicks, typing, and pagination, recovering from failures along the way. Everything runs on your machine: local browser automation, a SQLite-backed run queue, and your choice of LLM (Anthropic, OpenAI, or any OpenAI-compatible endpoint such as Ollama, vLLM, or OpenRouter).

- **Semantic extraction** — pages are distilled into a compact, LLM-readable outline; data is located by meaning and validated against your schema.
- **Multi-step agents** — goal in, browser actions out, structured output at the end. Credentials are referenced by name and never shown to the model.
- **Research tools** — web search (SearXNG or a browser-engine fallback chain), URL → clean Markdown fetch with PDF support, saved replayable queries, and named login profiles.
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

`SORTIE_PROVIDER` (`anthropic` | `openai`, default `anthropic`) picks which one is used by default.

## CLI

The CLI ships as the `sortie` bin of `@garrison-hq/sortie`. After `pnpm build`, run it from the repo root:

```sh
node packages/core/dist/cli.js --help
# Optional convenience alias:
alias sortie="node $(pwd)/packages/core/dist/cli.js"
```

It reads `.env` from the current directory or the repo root automatically.

### `extract` — one-shot semantic extraction

```sh
sortie extract https://books.toscrape.com \
  --schema '{"type":"object","properties":{"books":{"type":"array","items":{"type":"object","properties":{"title":{"type":"string"},"price":{"type":"number"}},"required":["title","price"]}}},"required":["books"]}' \
  --instruction "the list of books on the page"
```

`--schema` accepts inline JSON or `@path/to/schema.json`. Useful flags: `--instruction` (natural-language hint), `--out <file>`, `--headful` (visible browser), `--provider anthropic|openai`, `--model <m>`.

### `agent` — multi-step browser agent

```sh
SAUCE_PASSWORD=... sortie agent https://www.saucedemo.com \
  --goal "log in as standard_user with password {{cred:SAUCE_PASSWORD}}, add the backpack to the cart, and report the cart total" \
  --cred SAUCE_PASSWORD \
  --schema '{"type":"object","properties":{"total":{"type":"string"}},"required":["total"]}'
```

**Credential security model:** `--cred NAME` (repeatable) exposes the value of environment variable `NAME` to the action executor only. The model never sees the value — prompts, goals, and traces contain only the `{{cred:NAME}}` placeholder; substitution happens at the moment of typing, and outgoing observations are scrubbed for raw credential values. Values are never printed or persisted.

Other flags: `--max-steps <n>` (default 25), `--storage-state <path>` (reuse a Playwright storage-state JSON for logins), `--profile <name>` / `--save-profile <name>` (named login profiles, see [Login profiles](#login-profiles)), `--out <file>` (final output), `--trace <file>` (full step-by-step run trace), `--headful`.

### `search` — web search

```sh
sortie search "playwright storage state docs" --max-results 5
```

Returns ranked results (title, url, snippet) as JSON. Uses a SearXNG instance when `SEARXNG_BASE_URL` is set, otherwise drives real engines in a headless browser — see [Web search & fetch](#web-search--fetch). No LLM key needed. Flags: `--max-results <n>` (default 10, capped at 20), `--engine bing|duckduckgo|brave` (repeatable; order given = fallback order), `--out <file>`.

### `fetch` — URL to clean Markdown

```sh
sortie fetch https://en.wikipedia.org/wiki/Transformer_(deep_learning) > article.md
sortie fetch https://arxiv.org/pdf/1706.03762 --format text
```

Renders the page (JS included), strips boilerplate (nav, ads, footers), and prints main-content Markdown. PDF URLs are downloaded and converted with per-page markers. No LLM key needed. Flags: `--format markdown|text|json` (json = the full result object incl. `finalUrl`, `title`, `contentType`, `truncated`), `--max-chars <n>` (default 80000), `--out <file>`.

### `query` — saved, replayable extractions

```sh
sortie query save books --url https://books.toscrape.com --schema @schema.json
sortie query run books                                                  # replay as saved
sortie query run books --url https://books.toscrape.com/catalogue/page-2.html
sortie query save books2 --from-run 1f2e3d4c   # copy the spec of a past extract run
sortie query list | sortie query show books | sortie query delete books
```

`query run` goes through the run queue, so every replay is persisted as a normal run linked back to the query (`runs list`, `GET /api/runs?query=books`). See [Saved queries](#saved-queries).

### `profile` — named login sessions

```sh
sortie profile login github --url https://github.com/login   # headful: log in, press Enter
sortie extract https://github.com/notifications --profile github --schema @notif.json
sortie profile list | sortie profile check github | sortie profile delete github
```

`profile login` opens a visible browser; log in by hand, press Enter in the terminal, and the session (cookies + localStorage) is saved as a named profile. Use it via `--profile` on extract/agent (or the `"profile"` field of batch/REST specs — fetch included), or capture one from a successful agent login with `agent ... --save-profile <name>`. See [Login profiles](#login-profiles) for the security model.

### `batch` — run many specs concurrently

```sh
sortie batch specs.jsonl --concurrency 3 --export results.csv
```

The specs file is either a `.json` array or a `.jsonl` file (one spec per line). Each spec:

```jsonc
{
  "kind": "extract", // or "agent" or "fetch"
  "url": "https://books.toscrape.com", // target URL (extract/fetch) / start URL (agent)
  "schemaJson": { "type": "object", "...": "..." }, // required for extract
  "goal": "…", // required for agent
  "instruction": "…", // optional extraction hint
  "maxSteps": 15, // optional (agent)
  "maxChars": 40000, // optional (fetch): markdown cap, default 40000
  "credentialNames": ["SHOP_PASSWORD"], // env var NAMES; values resolved at run time, never stored
  "storageStatePath": "…", // optional
  "profile": "github", // optional named login profile (mutually exclusive with storageStatePath)
}
```

Runs execute on a worker pool (default concurrency 5, clamped 1..10) with per-domain rate limiting, and persist to SQLite. `--export file.json|file.csv` writes the batch results after it drains; `--data-dir <path>` selects where `sortie.db` lives.

### `runs` — inspect and export persisted runs

```sh
sortie runs list --status success --limit 20
sortie runs show 1f2e3d4c           # full id or unique short-id prefix
sortie runs export out.csv --batch <batch-id>
```

Exports support `.json` and `.csv` (CSV flattens one row per run, or one row per array item when every output is an object with a single array field).

## Web search & fetch

sortie can _discover_ pages as well as read them — available as `search`/`fetch` CLI commands, `search()`/`fetchPage()` SDK functions, `POST /api/search` / `POST /api/fetch` endpoints, and `web_search`/`web_fetch` MCP tools. The agent gets the same powers as tools: `search` (find pages without leaving the current one) and `read_page` (read the current page as Markdown without an LLM round-trip).

**Search backends, in order:**

1. **SearXNG (preferred)** — if `SEARXNG_BASE_URL` points at a [SearXNG](https://docs.searxng.org) instance, search hits its JSON API: structured results, no CAPTCHAs, no browser. The included compose profile spins one up next to sortie:

   ```sh
   # 1. change secret_key in searxng/settings.yml (e.g. openssl rand -hex 32)
   # 2. start sortie together with searxng:
   docker compose --profile search up -d --build
   # 3. in .env: SEARXNG_BASE_URL=http://searxng:8080
   ```

   Bring-your-own instance works too — the only requirement is `json` in the `search.formats` list of its `settings.yml` (a 403 from the instance is the telltale sign it's missing).

2. **Browser-engine fallback** — without SearXNG, sortie drives real search engines in a headless browser, trying Bing → DuckDuckGo → Brave until one answers. In line with the project's scope rules, an engine that presents a CAPTCHA or anti-bot challenge is _skipped, never bypassed_; if every engine challenges, the search fails with a clear reason (and names `SEARXNG_BASE_URL` as the durable fix).

**Fetch** turns any URL into clean, main-content Markdown: the page is rendered in the real browser (so JS-built content is included), boilerplate is stripped with a Readability pass, and the result is converted to GitHub-flavored Markdown. Neither search nor fetch needs an LLM key.

### PDF support

`fetch`, `extract`, and agent runs all work on PDF URLs (arXiv papers, reports, invoices). PDFs are detected three ways (`.pdf` URL, `application/pdf` content-type, or Chromium's aborted-navigation behavior), downloaded through the browser's request context (so cookies apply — authenticated PDFs work), and converted to text with `--- Page N ---` markers. Caps: 20 MB download, 100 pages, 200k chars; oversized documents are truncated with a flag, not failed. An agent that navigates to a PDF gets the text as an observation and can keep working from it.

## Saved queries

A saved query is a named, replayable extract spec — URL + schema + instruction stored once, run whenever you need fresh data:

```sh
sortie query save books --url https://books.toscrape.com --schema @schema.json
sortie query run books                       # later, and again, and again
sortie query run books --url https://books.toscrape.com/catalogue/page-2.html
```

- Save a spec inline, or promote a past run that worked with `query save <name> --from-run <run-id>`.
- Replays are real queue runs persisted to SQLite and linked back by name — filter history with `runs list` / `GET /api/runs?query=<name>`; the query tracks `lastRunAt` and `runCount`.
- One-off overrides (`--url`, `--instruction`) apply to a single replay without touching the saved spec — ideal for running the same schema across many pages.
- Available everywhere: CLI, REST (`/api/queries`, `POST /api/queries/:name/run`), the MCP `run_saved_query` tool, and the playground's **Queries** view (plus "Save as query" on any extract run).

## Login profiles

Many useful pages live behind a login. A profile is a named, locally stored browser session (Playwright storage state: cookies + localStorage) that any run can start from:

```sh
sortie profile login github --url https://github.com/login    # log in by hand, press Enter
sortie extract https://github.com/notifications --profile github --schema @notif.json
sortie agent https://shop.example --goal "…" --cred SHOP_PASSWORD --save-profile shop
```

Create one by logging in manually in a headful browser (`profile login`), or capture the session from a successful agent login (`--save-profile`). `profile list` / `profile check` show a staleness summary (cookie counts, domains, earliest expiry) so you know when to re-login.

**Security model:** profile state lives only on disk at `<dataDir>/profiles/<name>.json` (directory `0700`, file `0600`) — never in the database, never in logs or prompts, and never returned by the API. Profile names are slug-gated (`a-z0-9_-`) as a path-traversal defense, and `--profile` is mutually exclusive with `--storage-state` so there's no silent precedence.

**Profiles on a remote/Docker host:** sessions are created interactively, so bootstrap a headless server from a machine with a display:

```sh
# Option A — import over the API (write-only: the server stores the file 0600
# and responds with metadata + cookie summary only, never the state itself):
sortie profile login shop --url https://shop.example     # locally
curl -X POST http://your-host:3470/api/profiles/import \
  -H 'content-type: application/json' \
  -d "{\"name\":\"shop\",\"state\":$(cat data/profiles/shop.json)}"

# Option B — docker cp fallback (no API call): copy the storage-state file
# into the data volume and reference it per-run via "storageStatePath"
# (named profiles need the registration step that import performs):
docker compose cp data/profiles/shop.json sortie:/data/shop-state.json
docker compose exec sortie chmod 600 /data/shop-state.json
# then in run/batch specs: "storageStatePath": "/data/shop-state.json"
```

> **Warning:** the import request body carries live session cookies, and the sortie API has no authentication — like the rest of the API, `/api/profiles/import` is meant for trusted networks only (localhost, VPN, or behind your own authenticating reverse proxy). Never expose the server to the open internet.

## Programmatic SDK

`@garrison-hq/sortie` exposes a fully typed API. zod schemas are the source of truth for output shapes.

```ts
import { z } from 'zod';
import { extract } from '@garrison-hq/sortie';

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
import { runAgent } from '@garrison-hq/sortie';

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

`apps/mcp` exposes sortie over the Model Context Protocol (stdio), so any MCP-capable agent — Claude Code included — can use the web like an API:

| Tool              | What it does                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `web_outline`     | Distill a URL into title + interactive-element outline + visible text. No LLM key needed.  |
| `web_search`      | Web search via SearXNG or the browser-engine fallback chain. No LLM key needed.            |
| `web_fetch`       | Fetch a URL — HTML or PDF — as clean main-content Markdown. No LLM key needed.             |
| `web_extract`     | Schema-grounded semantic extraction from a URL (uses the configured provider).             |
| `run_agent`       | Multi-step browser agent: goal + startUrl in, schema-validated output out.                 |
| `run_saved_query` | Replay a saved query by name (optional URL/instruction override); persisted as a real run. |

`web_extract` and `run_agent` also accept a `profile` parameter to start from a saved login session (see [Login profiles](#login-profiles)).

Wire it up in `.mcp.json` (already present at the repo root):

```json
{
  "mcpServers": {
    "sortie": {
      "command": "node",
      "args": ["apps/mcp/dist/index.js"]
    }
  }
}
```

For `run_agent` credentials, prefer `env:` references — `{"PASSWORD": "env:SHOP_PASSWORD"}` is resolved from the _server's_ environment at call time, so secrets never travel through the MCP client, and (as everywhere in sortie) the model only ever sees `{{cred:NAME}}` placeholders.

## Playground UI

The React playground (`apps/ui`) lets you author an extract or agent run, submit it, and watch it execute: live step stream over WebSocket, per-step screenshots, run history, full run detail with the recorded trace, and JSON/CSV export. The **Queries** view lists saved queries and runs them (optionally against an override URL); the **Profiles** view shows login profiles with a staleness badge. Any extract run can be promoted with "Save as query".

- **Production:** `pnpm build && pnpm dev` — the server serves the built UI at `http://localhost:3470`.
- **UI development:** run `pnpm dev` (API server on :3470) and `pnpm dev:ui` (Vite dev server with hot reload, proxying `/api` to :3470) side by side.

The server also works headless as a pure JSON API: `POST /api/runs`, `POST /api/batches`, `GET /api/runs[/:id]` (with `?query=<name>` filtering), `GET /api/export?format=json|csv`, `GET /api/events` (WebSocket event stream), synchronous `POST /api/search` and `POST /api/fetch`, saved-query CRUD under `/api/queries` (+ `POST /api/queries/:name/run`), and profile management under `/api/profiles` (list/delete/import — state contents are never returned).

## Docker

For remote hosts, the included compose file builds the image (Playwright base image with Chromium bundled — no separate browser install) and runs the server:

```sh
cp .env.example .env   # provider keys; compose passes it via env_file
docker compose up -d --build
```

- The UI/API listens on port `3470`.
- All state (SQLite database, screenshots, exports, profile storage states) lives in the `sortie-data` named volume, mounted at `/data` (`SORTIE_DATA_DIR=/data`).
- `.env` is supplied through `env_file` and is never baked into the image. Keep it out of version control.
- `docker compose --profile search up -d` additionally starts a SearXNG sidecar as the search backend — see [Web search & fetch](#web-search--fetch).

## Architecture

```
packages/core          the engine + SDK + CLI (contracts.ts is the single source of truth)
  llm/                 provider layer: Anthropic + OpenAI-compatible (base URL overridable)
  browser/             Playwright manager + page distillation (refs, outline, text)
  extract/             semantic extraction: snapshot + schema -> validated JSON
  agent/               multi-step loop: tools, prompts, credential substitution
  search/              web search: SearXNG client + browser-engine fallback chain
  fetch/               URL -> clean main-content Markdown (Readability + turndown)
  pdf/                 PDF download + text extraction (page markers, size caps)
  store/               SQLite persistence: runs, steps, saved queries, profiles, JSON/CSV export
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
pnpm --filter @garrison-hq/sortie-ui e2e  # full-stack Playwright e2e (builds the monorepo,
                                # boots the real server, includes one live LLM extraction)
```

## Contributing

Issues and PRs are welcome — please read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first; it covers the hard scope boundaries (no CAPTCHA/anti-bot work, credentials never reach the model), the live-verification standard, and what to expect from a solo-maintained project. Security-sensitive bugs go through the private path in [`SECURITY.md`](./SECURITY.md), not the issue tracker.

## License

[AGPL-3.0-only](./LICENSE). In short: use it, modify it, self-host it freely — but if you distribute it or run a modified version as a network service, the source of your version must be available under the same license. For commercial licensing questions, open an issue.
