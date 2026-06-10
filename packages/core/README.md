# @garrison-hq/sortie

**Query and act on the web like it were an API.** Local-first web agents: semantic extraction, multi-step browser automation, web search, URL → Markdown fetch — natural-language goal in, schema-validated JSON out, driven by a real Chromium browser on your machine.

This package contains the sortie SDK, engine, and the `sortie` CLI. Full documentation, the playground UI, the REST/WebSocket server, and the MCP server live in the monorepo:

**→ [github.com/garrison-hq/sortie](https://github.com/garrison-hq/sortie)**

```sh
npm install @garrison-hq/sortie
npx playwright install chromium
```

```ts
import { extract } from '@garrison-hq/sortie';
import { z } from 'zod';

// reads ANTHROPIC_API_KEY / OPENAI_API_KEY etc. from the environment
const { data } = await extract({
  url: 'https://books.toscrape.com',
  schema: z.object({
    books: z.array(z.object({ title: z.string(), price: z.number() })),
  }),
  instruction: 'the list of books on the page',
});
```

License: [AGPL-3.0-only](https://github.com/garrison-hq/sortie/blob/main/LICENSE).
