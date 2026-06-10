---
title: CLI
description: Every sortie command — extract, agent, search, fetch, query, profile, batch, runs.
---

The CLI ships as the `sortie` bin of `@garrison-hq/sortie`. From a repo checkout, run it as `node packages/core/dist/cli.js` after `pnpm build` (or alias it). It reads `.env` from the current directory or the repo root automatically.

## `extract` — one-shot semantic extraction

```sh
sortie extract <url> --schema <inline-JSON-or-@file> [--instruction <hint>] [options]
```

| Flag                           | Meaning                                                 |
| ------------------------------ | ------------------------------------------------------- |
| `--schema <json\|@file>`       | JSON Schema the output must validate against (required) |
| `--instruction <text>`         | Natural-language hint about what to extract             |
| `--out <file>`                 | Write the result to a file                              |
| `--headful`                    | Visible browser                                         |
| `--provider anthropic\|openai` | Override the default provider                           |
| `--model <m>`                  | Override the model                                      |
| `--profile <name>`             | Start from a saved login profile                        |

## `agent` — multi-step browser agent

```sh
sortie agent <startUrl> --goal <text> [--schema <json|@file>] [options]
```

| Flag                        | Meaning                                                                         |
| --------------------------- | ------------------------------------------------------------------------------- |
| `--goal <text>`             | The task, with `{{cred:NAME}}` placeholders for secrets                         |
| `--cred NAME`               | Expose env var `NAME` to the executor (repeatable; the model never sees values) |
| `--max-steps <n>`           | Step budget (default 25)                                                        |
| `--storage-state <path>`    | Reuse a Playwright storage-state JSON                                           |
| `--profile <name>`          | Start from a saved login profile (mutually exclusive with `--storage-state`)    |
| `--save-profile <name>`     | Save the session after a successful run                                         |
| `--trace <file>`            | Write the full step-by-step run trace                                           |
| `--out <file>`, `--headful` | As above                                                                        |

## `search` — web search

```sh
sortie search "<query>" [--max-results <n>] [--engine bing|duckduckgo|brave]...
```

SearXNG when `SEARXNG_BASE_URL` is set, otherwise a browser-engine fallback chain. `--max-results` defaults to 10 (capped at 20); repeat `--engine` to control fallback order. No LLM key needed.

## `fetch` — URL to clean Markdown

```sh
sortie fetch <url> [--format markdown|text|json] [--max-chars <n>] [--out <file>]
```

Renders the page (JS included), strips boilerplate, prints main-content Markdown. PDF URLs are converted with per-page markers. `--max-chars` defaults to 80000. No LLM key needed.

## `query` — saved, replayable extractions

```sh
sortie query save <name> --url <url> --schema <json|@file> [--instruction <hint>]
sortie query save <name> --from-run <run-id>     # promote a past extract run
sortie query run <name> [--url <override>] [--instruction <override>]
sortie query list | show <name> | delete <name>
```

Replays go through the run queue and are persisted as normal runs linked back to the query.

## `profile` — named login sessions

```sh
sortie profile login <name> --url <login-url>    # headful: log in, press Enter
sortie profile list | check <name> | delete <name>
```

See [Login profiles](/sortie/guides/queries-profiles/#login-profiles) for the security model.

## `batch` — run many specs concurrently

```sh
sortie batch specs.jsonl --concurrency 3 --export results.csv
```

The specs file is a `.json` array or `.jsonl` (one spec per line). Each spec:

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
  "profile": "github", // optional named login profile
}
```

Runs execute on a worker pool (default concurrency 5, clamped 1..10) with per-domain rate limiting, and persist to SQLite. `--export file.json|file.csv` writes results after the batch drains; `--data-dir <path>` selects where `sortie.db` lives.

## `runs` — inspect and export persisted runs

```sh
sortie runs list --status success --limit 20
sortie runs show 1f2e3d4c           # full id or unique short-id prefix
sortie runs export out.csv --batch <batch-id>
```

Exports support `.json` and `.csv` (CSV flattens one row per run, or one row per array item when every output is an object with a single array field).
