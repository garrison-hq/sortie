# Examples

Runnable scripts that exercise nanofish against live sites. Each one imports the
**built** packages directly (e.g. `../packages/core/dist/index.js`) because the repo
root is not a workspace consumer — run `pnpm build` first, then execute from the
repo root with `npx tsx examples/<script>.ts`.

Scripts that drive the LLM (the agent demos and MCP verifications) read the provider
configuration from `.env` at the repo root (`NANOFISH_PROVIDER`, key, model). The
browser-only check needs no key. All scripts print `PASS`/`FAIL` checks and exit
non-zero on failure.

| Script                | What it does                                                                                                                                                                                                                                                     | Needs LLM key |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `demo-hn-digest.ts`   | Demo of the multi-step agent loop: reads the Hacker News front page, follows the "More" link to page 2, and returns the 12 highest-scoring stories as schema-validated JSON. Prints a digest table and writes the full result to `/tmp/nanofish-hn-digest.json`. | yes           |
| `verify-browser.ts`   | Verifies the browser layer against books.toscrape.com: `BrowserManager` launch, `distillPage()` snapshot quality (title, links, outline/text caps), and a `resolveRef()` round trip.                                                                             | no            |
| `verify-fetch.ts`     | Verifies URL→Markdown fetch against live pages: a Wikipedia article (headings present, nav junk stripped), quotes.toscrape.com/js (JS-rendered content), and example.com (Readability-null fallback path).                                                       | no            |
| `verify-mcp.ts`       | Connects to the nanofish MCP server as a real stdio client, lists tools, and exercises them live (including `web_search` and `web_fetch`).                                                                                                                       | yes           |
| `verify-mcp-agent.ts` | Drives the MCP server's `run_agent` tool through a live multi-step login flow on the-internet.herokuapp.com (public demo credentials).                                                                                                                           | yes           |
| `verify-pdf.ts`       | Verifies PDF support against arxiv.org/pdf/1706.03762 ("Attention Is All You Need"): `fetchPage` returns `contentType: 'pdf'` with page markers, and `extract()` pulls `{title, authors}` from the PDF.                                                          | yes           |
| `verify-search.ts`    | Verifies web search live: the browser-engine fallback chain returns ≥3 absolute-URL results; when `SEARXNG_BASE_URL` is set, also asserts the SearXNG backend answers.                                                                                           | no            |

## Etiquette

- books.toscrape.com, saucedemo.com, and the-internet.herokuapp.com are automation
  sandboxes — fine to hit in verification loops.
- Hacker News tolerates polite, rate-limited reading only. `demo-hn-digest.ts` loads
  exactly two pages per run; do not loop it or raise its page count.
- Wikipedia and arXiv are hit once per verification run (`verify-fetch.ts`,
  `verify-pdf.ts`); keep it that way. `verify-search.ts` drives real search engines —
  run it on demand, not in loops (or point it at SearXNG via `SEARXNG_BASE_URL`).
- Anti-bot evasion is out of scope everywhere; runs fail gracefully instead.
