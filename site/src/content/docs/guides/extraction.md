---
title: Semantic extraction
description: Schema-grounded extraction that locates data by meaning, not selectors.
---

Extraction is sortie's core primitive: a URL plus a schema in, validated JSON out. The page is rendered in a real Chromium browser, distilled into a compact LLM-readable outline, and the model is forced to submit data matching your schema.

## From the CLI

```sh
sortie extract https://books.toscrape.com \
  --schema '{"type":"object","properties":{"books":{"type":"array","items":{"type":"object","properties":{"title":{"type":"string"},"price":{"type":"number"}},"required":["title","price"]}}},"required":["books"]}' \
  --instruction "the list of books on the page"
```

- `--schema` accepts inline JSON or `@path/to/schema.json`.
- `--instruction` is an optional natural-language hint ("the product list", "only sold-out items").
- Other flags: `--out <file>`, `--headful` (visible browser), `--provider anthropic|openai`, `--model <m>`.

## From the SDK

zod schemas are the source of truth — the output type is inferred:

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

## Why it doesn't break when layouts change

There are no CSS or XPath selectors to go stale. Each run re-renders and re-distills the live page, and the model locates content by meaning within that snapshot. Outputs that fail schema validation are fed back to the model for correction (up to 2 retries), so transient misreads self-correct instead of failing the run.

## PDFs

`extract` works on PDF URLs too — the document is downloaded through the browser's request context (cookies apply, so authenticated PDFs work) and converted to text before extraction. See [PDF support](/sortie/guides/search-fetch/#pdf-support) for caps and details.

## Replayable extractions

Any extraction worth running twice can be saved as a named query and replayed across pages — see [Saved queries](/sortie/guides/queries-profiles/).
