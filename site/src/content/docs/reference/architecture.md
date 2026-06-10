---
title: Architecture
description: How the monorepo fits together, the reliability model, and known limitations.
---

```
packages/core          the engine + SDK + CLI (contracts.ts is the single source of truth)
  llm/                 provider layer: Anthropic + OpenAI-compatible (base URL overridable)
  browser/             Playwright manager + page distillation (refs, outline, text)
  extract/             semantic extraction: snapshot + schema -> validated JSON
  agent/               multi-step loop: tools, prompts, credential substitution
  search/              web search: SearXNG client + browser-engine fallback chain
  fetch/               URL -> clean main-content Markdown (Readability + turndown)
  pdf/                 PDF download + text extraction (page markers, size caps)
  store/               SQLite persistence: runs, steps, saved queries, profiles, export
  runtime/             in-process run queue: worker pool, rate limiting, retries
apps/server            Fastify REST + WebSocket; serves the built UI in production
apps/ui                React/Vite playground
apps/mcp               MCP server (stdio) over the core engine
examples/              live verification scripts
```

Every cross-module type is defined once in `packages/core/src/contracts.ts`; modules implement against those interfaces, and zod schemas validate all structured data crossing a boundary (LLM output, API payloads, user-supplied schemas).

## Reliability

- The page is re-distilled before every agent step, so element refs self-heal after navigations and layout changes — a stale ref produces an error observation the model recovers from, never a crashed run.
- Extraction outputs that fail schema validation are fed back to the model for correction (up to 2 retries).
- The run queue retries infrastructure failures (timeouts, crashes — not agent-reported failures, default 2 attempts) and rate-limits run starts per domain (default 1/s).

## Scope boundaries

CAPTCHA solving and anti-bot evasion are deliberately out of scope. Runs that hit such walls fail gracefully with a clear reason instead. Be polite to the sites you automate.

## Notes & limitations

- **CSV export flattening:** CSV is one row per run. When _every_ exported output is an object with a single array-valued field, the export flattens to one row per array item instead. Mixed or deeply nested outputs are better served by JSON export.
- **Retries re-emit `run-started`:** each retry attempt emits a fresh `run-started` event and increments the run's `attempts` counter — event consumers should treat `run-started` as at-least-once, keyed by `runId`.
- **Drain before shutdown:** `queue.shutdown()` waits only for runs already _in flight_, then closes the browser. Call `await queue.drain()` first if you want all submitted work to finish (the CLI `batch` command does this).
- **WebSocket observation truncation:** live frames truncate observations to 2000 chars; the full observation is always persisted.
