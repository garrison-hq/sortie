---
title: Server & REST API
description: The Fastify REST + WebSocket server, the playground UI, and Docker deployment.
---

`apps/server` is a Fastify server exposing the engine as a JSON API with a WebSocket live view; in production it also serves the built playground UI.

- **Production:** `pnpm build && pnpm dev` — server + UI at `http://localhost:3470`.
- **UI development:** run `pnpm dev` (API on :3470) and `pnpm dev:ui` (Vite dev server with hot reload, proxying `/api`) side by side.
- Bind address and port come from `SORTIE_HOST` / `SORTIE_PORT` — never hardcoded.

:::caution[No authentication]
The API has no authentication. It is meant for trusted networks only — localhost, VPN, or behind your own authenticating reverse proxy. Never expose the server to the open internet.
:::

## Endpoints

| Endpoint                                         | What it does                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| `POST /api/runs`                                 | Submit an extract/agent/fetch run                                          |
| `GET /api/runs[/:id]`                            | Run history / full run detail (with `?query=<name>` filtering)             |
| `POST /api/batches`                              | Submit a batch of specs                                                    |
| `GET /api/export?format=json\|csv`               | Export run results                                                         |
| `GET /api/events`                                | WebSocket event stream (live steps, screenshots)                           |
| `POST /api/search`                               | Synchronous web search                                                     |
| `POST /api/fetch`                                | Synchronous URL → Markdown fetch                                           |
| `/api/queries` (+ `POST /api/queries/:name/run`) | Saved-query CRUD and replay                                                |
| `/api/profiles`                                  | Profile management — list/delete/import; state contents are never returned |

Live `run-step` WebSocket frames truncate each step's `observation` to 2000 chars to keep frames small; the full observation is always persisted — fetch `GET /api/runs/:id` for the complete trace. Treat `run-started` events as at-least-once, keyed by `runId` (retries re-emit them).

## The playground UI

The React playground lets you author an extract or agent run, submit it, and watch it execute: live step stream over WebSocket, per-step screenshots, run history, full run detail with the recorded trace, and JSON/CSV export. The **Queries** view lists saved queries and runs them (optionally against an override URL); the **Profiles** view shows login profiles with a staleness badge. Any extract run can be promoted with "Save as query".

## Docker

For remote hosts, the included compose file builds the image (Playwright base image with Chromium bundled — no separate browser install) and runs the server:

```sh
cp .env.example .env   # provider keys; compose passes it via env_file
docker compose up -d --build
```

- The UI/API listens on port `3470`.
- All state (SQLite database, screenshots, exports, profile storage states) lives in the `sortie-data` named volume, mounted at `/data` (`SORTIE_DATA_DIR=/data`).
- `.env` is supplied through `env_file` and never baked into the image.
- `docker compose --profile search up -d` additionally starts a [SearXNG sidecar](/sortie/guides/search-fetch/#web-search) as the search backend.
