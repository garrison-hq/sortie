---
name: Bug report
about: Something is broken in the CLI, SDK, server, UI, or MCP server.
title: '[bug] '
labels: bug
---

## What happened

<!-- One or two sentences. What did you observe? -->

## What you expected

<!-- One sentence. What should have happened instead? -->

## Reproduction

Minimal steps from a fresh clone. The closer to a shell transcript, the
better. If the bug involves a specific website, include the URL and
whether it reproduces on one of the stable test targets
(books.toscrape.com, saucedemo.com, the-internet.herokuapp.com).

```sh
pnpm install && pnpm build
node packages/core/dist/cli.js ...
```

## Environment

- sortie commit: <!-- `git rev-parse HEAD` -->
- OS: <!-- e.g. Linux 6.19 Fedora 43 / macOS 15 -->
- Node version: <!-- `node --version` -->
- LLM provider + model: <!-- e.g. openai / gpt-4.1-mini, or "n/a — no LLM involved" -->
- Headless or headful: <!-- default is headless -->

## Logs / trace

<!--
CLI output, server logs, or an agent run trace (`--trace out.json` or
`runs show <id>`). ⚠️ Scrub before posting: traces should only ever
contain {{cred:NAME}} placeholders — if you see a raw credential value
in a trace, STOP and report it privately per SECURITY.md instead.
-->

```

```

## Additional context

<!-- Anything else. Related issues, hypothesis, screenshots. -->
