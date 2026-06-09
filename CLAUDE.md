# nanofish

Local-first web-agent automation platform: natural-language goal in → real browser actions →
schema-validated JSON out. Full spec and decisions: see PROMPT.md and README.md.

## Layout

- `packages/core` — SDK + engine: browser manager (Playwright), LLM provider layer,
  semantic extraction, agent loop, persistence.
- `apps/server` — Fastify API + WebSocket live view; serves the built UI in production.
- `apps/ui` — React/Vite playground (author, run, watch agents).

## Commands

- `pnpm dev` — run server in watch mode
- `pnpm typecheck` / `pnpm lint` / `pnpm test` — run before considering work done
- `pnpm build` — build all packages

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
