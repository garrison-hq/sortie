---
title: SDK
description: The typed programmatic API of @garrison-hq/sortie.
---

`@garrison-hq/sortie` exposes a fully typed API. zod schemas are the source of truth for output shapes — the result type is inferred from your schema.

```sh
npm install @garrison-hq/sortie
npx playwright install chromium
```

## `extract()`

```ts
import { z } from 'zod';
import { extract } from '@garrison-hq/sortie';

const Books = z.object({
  books: z.array(z.object({ title: z.string(), price: z.number() })),
});

const { data, usage } = await extract({
  url: 'https://books.toscrape.com',
  schema: Books,
  instruction: 'the books listed on the page',
});
// data is typed as { books: { title: string; price: number }[] }
```

`extract` accepts one of `url` (navigates a fresh page), `page` (reuses an open Playwright page), or `snapshot` (pre-built — the PDF path). The provider defaults to env-driven construction; pass `provider` to override.

## `runAgent()`

```ts
import { z } from 'zod';
import { runAgent } from '@garrison-hq/sortie';

const result = await runAgent({
  goal: 'log in as standard_user with password {{cred:SAUCE_PASSWORD}}, add the backpack to the cart, and report the cart total',
  startUrl: 'https://www.saucedemo.com',
  schema: z.object({ total: z.string() }),
  credentials: { SAUCE_PASSWORD: process.env.SAUCE_PASSWORD! }, // value never reaches the model
  maxSteps: 15,
  onStep: (step) => console.error(`[${step.index + 1}] ${step.action.tool}`),
});

if (result.status === 'success') {
  console.log(result.output); // { total: string }
}
```

## Everything else

| Export                                                    | What it is                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------ |
| `search()`, `fetchPage()`                                 | Web search and URL → Markdown fetch (no LLM key needed)                  |
| `createProvider()`                                        | Env-driven LLM provider construction with overrides                      |
| `BrowserManager`, `withPage`, `distillPage`, `resolveRef` | The browser layer                                                        |
| `jsonSchemaToZod()`                                       | Accept JSON Schema inputs where zod is needed                            |
| `createRunStore`, `createRunQueue`                        | SQLite persistence + the run queue (worker pool, rate limiting, retries) |

All shared types live in [`packages/core/src/contracts.ts`](https://github.com/garrison-hq/sortie/blob/main/packages/core/src/contracts.ts) — the single source of truth for every cross-module type.
