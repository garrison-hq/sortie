---
title: MCP server
description: Give any MCP-capable agent the web as an API, locally.
---

`apps/mcp` exposes sortie over the [Model Context Protocol](https://modelcontextprotocol.io) (stdio), so any MCP-capable agent — Claude Code included — can use the web like an API:

| Tool              | What it does                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `web_outline`     | Distill a URL into title + interactive-element outline + visible text. No LLM key needed.  |
| `web_search`      | Web search via SearXNG or the browser-engine fallback chain. No LLM key needed.            |
| `web_fetch`       | Fetch a URL — HTML or PDF — as clean main-content Markdown. No LLM key needed.             |
| `web_extract`     | Schema-grounded semantic extraction from a URL (uses the configured provider).             |
| `run_agent`       | Multi-step browser agent: goal + startUrl in, schema-validated output out.                 |
| `run_saved_query` | Replay a saved query by name (optional URL/instruction override); persisted as a real run. |

`web_extract` and `run_agent` also accept a `profile` parameter to start from a [saved login session](/sortie/guides/queries-profiles/#login-profiles).

## Wiring it up

```json
{
  "mcpServers": {
    "sortie": {
      "command": "node",
      "args": ["apps/mcp/dist/index.js"]
    }
  }
}
```

(A ready-made `.mcp.json` ships at the repo root.)

## Credentials over MCP

For `run_agent` credentials, prefer `env:` references — `{"PASSWORD": "env:SHOP_PASSWORD"}` is resolved from the _server's_ environment at call time, so secrets never travel through the MCP client, and (as everywhere in sortie) the model only ever sees `{{cred:NAME}}` placeholders.
