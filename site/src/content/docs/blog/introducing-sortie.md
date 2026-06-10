---
title: 'Introducing sortie: local-first web agents'
date: 2026-06-11
authors: jeroen
tags:
  - announcement
excerpt: sortie is an open-source, local-first platform for autonomous web agents — natural-language goal in, real browser actions, schema-validated JSON out. AGPL-licensed, runs entirely on your machine.
---

A **sortie** is a mission launched out from a garrison: go out, do the job, come back. That's exactly what this tool does — you give it a goal, it ventures out onto the web in a real browser, and it comes back with structured data.

sortie is an open-source, local-first platform for autonomous web agents. Describe the data you want in plain language plus a schema, and sortie drives a real Chromium browser, locates content by _meaning_ rather than brittle CSS/XPath selectors, and returns clean, schema-validated JSON. For multi-step tasks — "log in, search for X, collect the first 20 results" — an agent loop plans and executes navigation, clicks, typing, and pagination, recovering from failures along the way.

## Why local-first

Plenty of hosted services will run a browser fleet for you. sortie makes the opposite bet: **everything runs on your machine.** Your sessions, your credentials, your scraped data — none of it transits someone else's cloud.

That choice shapes the security model:

- **Credentials never reach the model.** Goals and traces only ever contain `{{cred:NAME}}` placeholders; substitution happens at the moment of typing, observations are scrubbed, and values are never persisted.
- **Login sessions stay on disk.** Named profiles are stored at `0600` permissions, never enter the database, and are never returned by the API.
- **Bring your own LLM.** Anthropic, OpenAI, or any OpenAI-compatible endpoint — including a fully local Ollama or vLLM. With a local model and a SearXNG sidecar, the whole loop runs without a single external API call.

And one boundary worth stating plainly: **CAPTCHA solving and anti-bot evasion are out of scope, permanently.** Runs that hit such walls fail gracefully with a clear reason. Be polite to the sites you automate.

## What's in the box

- **CLI** — `extract`, `agent`, `search`, `fetch`, saved `query` replays, login `profile` management, concurrent `batch` runs, and `runs` history/export.
- **Typed SDK** — zod schemas in, inferred types out.
- **REST + WebSocket server** with a playground UI: author a run, watch it execute step by step with screenshots.
- **MCP server** — give Claude Code (or any MCP-capable agent) the web as an API: `web_search`, `web_fetch`, `web_extract`, `run_agent`, and more.

## Open source, AGPL

sortie is [AGPL-3.0](https://github.com/garrison-hq/sortie/blob/main/LICENSE): use it, modify it, self-host it freely — and if you run a modified version as a service, share your changes under the same terms.

The code is on GitHub at [garrison-hq/sortie](https://github.com/garrison-hq/sortie). Start with the [getting started guide](/sortie/getting-started/), and come say hi in the issues if you build something with it — or if something breaks.
