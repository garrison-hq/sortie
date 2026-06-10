---
title: Saved queries & login profiles
description: Replayable extractions and named login sessions, with a write-only security model.
---

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

### Security model

- Profile state lives only on disk at `<dataDir>/profiles/<name>.json` (directory `0700`, file `0600`).
- Never in the database, never in logs or prompts, and **never returned by the API**.
- Profile names are slug-gated (`a-z0-9_-`) as a path-traversal defense.
- `--profile` is mutually exclusive with `--storage-state`, so there's no silent precedence.

### Profiles on a remote/Docker host

Sessions are created interactively, so bootstrap a headless server from a machine with a display:

```sh
# Option A — import over the API (write-only: the server stores the file 0600
# and responds with metadata + cookie summary only, never the state itself):
sortie profile login shop --url https://shop.example     # locally
curl -X POST http://your-host:3470/api/profiles/import \
  -H 'content-type: application/json' \
  -d "{\"name\":\"shop\",\"state\":$(cat data/profiles/shop.json)}"

# Option B — docker cp fallback (no API call): copy the storage-state file
# into the data volume and reference it per-run via "storageStatePath":
docker compose cp data/profiles/shop.json sortie:/data/shop-state.json
docker compose exec sortie chmod 600 /data/shop-state.json
# then in run/batch specs: "storageStatePath": "/data/shop-state.json"
```

:::caution
The import request body carries live session cookies, and the sortie API has no authentication — like the rest of the API, `/api/profiles/import` is meant for trusted networks only (localhost, VPN, or behind your own authenticating reverse proxy). Never expose the server to the open internet.
:::
