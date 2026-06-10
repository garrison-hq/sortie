---
title: Getting started
description: Install sortie, configure an LLM provider, and run your first extraction.
---

sortie is a local-first platform for autonomous web agents. Describe the data you want in plain language plus a JSON Schema, and sortie drives a real Chromium browser, locates content by _meaning_ rather than brittle selectors, and returns clean, schema-validated JSON. Everything runs on your machine.

## Prerequisites

- Node >= 22 and [pnpm](https://pnpm.io)
- An LLM API key (Anthropic, OpenAI, or any OpenAI-compatible endpoint — local Ollama/vLLM works too)

## Install and run

```sh
git clone https://github.com/garrison-hq/sortie
cd sortie
pnpm install
pnpm browsers                     # Playwright Chromium binary for local runs
cp .env.example .env                    # then fill in your provider key
pnpm build
pnpm dev                                # server + playground at http://localhost:3470
```

## Configure a provider

In `.env`, set at least one:

- `ANTHROPIC_API_KEY` (+ optional `ANTHROPIC_MODEL`), or
- `OPENAI_API_KEY` (+ optional `OPENAI_MODEL`), or
- `OPENAI_BASE_URL` pointing at any OpenAI-compatible endpoint (Ollama, vLLM, OpenRouter, ...) — no key required for local endpoints.

`SORTIE_PROVIDER` (`anthropic` | `openai`, default `anthropic`) picks which one is used by default. Never hardcoded — every run can override with `--provider` / `--model`.

## First extraction

```sh
node packages/core/dist/cli.js extract https://books.toscrape.com \
  --schema '{"type":"object","properties":{"books":{"type":"array","items":{"type":"object","properties":{"title":{"type":"string"},"price":{"type":"number"}},"required":["title","price"]}}},"required":["books"]}' \
  --instruction "the list of books on the page"
```

For convenience, alias the CLI:

```sh
alias sortie="node $(pwd)/packages/core/dist/cli.js"
```

It reads `.env` from the current directory or the repo root automatically.

## Where to go next

- [Semantic extraction](/sortie/guides/extraction/) — schemas, instructions, and how self-healing extraction works.
- [Web agents](/sortie/guides/agents/) — multi-step goals and the credential security model.
- [Search & fetch](/sortie/guides/search-fetch/) — discover pages and turn URLs into Markdown, no LLM key needed.
- [CLI reference](/sortie/reference/cli/) — every command and flag.
