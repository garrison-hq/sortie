---
title: Search, fetch & PDFs
description: Discover pages and turn any URL into clean Markdown — no LLM key needed.
---

sortie can _discover_ pages as well as read them. Both capabilities are available as CLI commands (`search`, `fetch`), SDK functions (`search()`, `fetchPage()`), REST endpoints (`POST /api/search`, `POST /api/fetch`), and MCP tools (`web_search`, `web_fetch`). Neither needs an LLM key.

## Web search

```sh
sortie search "playwright storage state docs" --max-results 5
```

Returns ranked results (title, url, snippet) as JSON. Flags: `--max-results <n>` (default 10, capped at 20), `--engine bing|duckduckgo|brave` (repeatable; order given = fallback order), `--out <file>`.

**Backends, in order:**

1. **SearXNG (preferred)** — if `SEARXNG_BASE_URL` points at a [SearXNG](https://docs.searxng.org) instance, search hits its JSON API: structured results, no CAPTCHAs, no browser. The included compose profile spins one up next to sortie:

   ```sh
   # 1. change secret_key in searxng/settings.yml (e.g. openssl rand -hex 32)
   # 2. start sortie together with searxng:
   docker compose --profile search up -d --build
   # 3. in .env: SEARXNG_BASE_URL=http://searxng:8080
   ```

   Bring-your-own instance works too — the only requirement is `json` in the `search.formats` list of its `settings.yml` (a 403 from the instance is the telltale sign it's missing).

2. **Browser-engine fallback** — without SearXNG, sortie drives real search engines in a headless browser, trying Bing → DuckDuckGo → Brave until one answers. In line with the project's scope rules, an engine that presents a CAPTCHA or anti-bot challenge is _skipped, never bypassed_; if every engine challenges, the search fails with a clear reason.

## Fetch: URL → Markdown

```sh
sortie fetch https://en.wikipedia.org/wiki/Transformer_(deep_learning) > article.md
sortie fetch https://arxiv.org/pdf/1706.03762 --format text
```

The page is rendered in the real browser (so JS-built content is included), boilerplate (nav, ads, footers) is stripped with a Readability pass, and the result is converted to GitHub-flavored Markdown. Flags: `--format markdown|text|json` (json = the full result object incl. `finalUrl`, `title`, `contentType`, `truncated`), `--max-chars <n>` (default 80000), `--out <file>`.

## PDF support

`fetch`, `extract`, and agent runs all work on PDF URLs (arXiv papers, reports, invoices):

- Detected three ways: `.pdf` URL, `application/pdf` content-type, or Chromium's aborted-navigation behavior.
- Downloaded through the browser's request context, so cookies apply — authenticated PDFs work.
- Converted to text with `--- Page N ---` markers.
- Caps: 20 MB download, 100 pages, 200k chars. Oversized documents are truncated with a flag, not failed.

An agent that navigates to a PDF gets the text as an observation and can keep working from it.
