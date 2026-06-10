# nanofish

Local-first web-agent automation platform: natural-language goal in → real browser actions →
schema-validated JSON out. Full spec and decisions: see PROMPT.md and README.md.

## Layout

- `packages/core` — SDK + engine + CLI: `contracts.ts` (single source of truth for all
  cross-module types), `llm/`, `browser/`, `extract/`, `agent/`, `search/` (SearXNG
  with browser-engine fallback), `fetch/` (URL→Markdown), `pdf/`, `profiles.ts` (login
  profiles), `store/` (SQLite: runs, saved queries, profiles), `runtime/` (run queue),
  `cli.ts` (bin `nanofish`: extract | agent | search | fetch | query | profile | batch | runs).
- `apps/server` — Fastify API + WebSocket live view; serves the built UI in production.
- `apps/ui` — React/Vite playground (author, run, watch agents). Playwright e2e in `e2e/`.
- `apps/mcp` — MCP server (stdio): web_outline, web_search, web_fetch, web_extract,
  run_agent, run_saved_query. Wired in `.mcp.json`.
- `examples/` — live verification scripts (`npx tsx examples/<name>.ts` from repo root).

## Commands

- `pnpm dev` — run server in watch mode (serves built UI if present); `pnpm dev:ui` — Vite dev server with `/api` proxy
- `pnpm typecheck` / `pnpm lint` / `pnpm test` — run before considering work done
- `pnpm build` — build all packages (core → ui → server → mcp)
- `pnpm --filter @nanofish/ui e2e` — full-stack e2e (rebuilds, boots real server, one live LLM call)
- CLI after build: `node packages/core/dist/cli.js <extract|agent|search|fetch|query|profile|batch|runs> ...`

## Conventions

- TypeScript strict, ESM only (`type: module`, NodeNext resolution).
- zod schemas are the source of truth for all structured data crossing a boundary
  (LLM output, API payloads, user-supplied extraction schemas).
- LLM providers: Anthropic + OpenAI-compatible. Never hardcode a model or base URL —
  always read from config/env (`OPENAI_BASE_URL` may point at Ollama/vLLM/etc.).
- Verification standard: features touching browser automation must be verified against a
  live page (books.toscrape.com, saucedemo.com, the-internet.herokuapp.com), not only unit tests.
- Deployment target is a remote Docker host (docker compose); never bind hardcoded
  `localhost` in server code — use `NANOFISH_HOST`/`NANOFISH_PORT`.
- Anti-bot evasion and CAPTCHA bypass are explicitly out of scope; fail runs gracefully
  with a clear reason instead.
