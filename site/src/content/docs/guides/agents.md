---
title: Web agents
description: Multi-step browser agents with a strict credential security model.
---

For multi-step tasks — "log in, search for X, collect the first 20 results" — the agent loop plans and executes navigation, clicks, typing, and pagination, recovering from failures along the way, and ends by submitting output that validates against your schema.

## Running an agent

```sh
SAUCE_PASSWORD=... sortie agent https://www.saucedemo.com \
  --goal "log in as standard_user with password {{cred:SAUCE_PASSWORD}}, add the backpack to the cart, and report the cart total" \
  --cred SAUCE_PASSWORD \
  --schema '{"type":"object","properties":{"total":{"type":"string"}},"required":["total"]}'
```

Useful flags: `--max-steps <n>` (default 25), `--storage-state <path>` (reuse a Playwright storage-state JSON), `--profile <name>` / `--save-profile <name>` ([login profiles](/sortie/guides/queries-profiles/#login-profiles)), `--out <file>`, `--trace <file>` (full step-by-step run trace), `--headful`.

## The credential security model

`--cred NAME` (repeatable) exposes the value of environment variable `NAME` to the action executor only. **The model never sees the value:**

- Prompts, goals, and traces contain only the `{{cred:NAME}}` placeholder.
- Substitution happens at the moment of typing into the page.
- Outgoing observations are scrubbed for raw credential values.
- Values are never printed and never persisted.

This invariant is load-bearing — a path that leaks a raw value to the model or to persisted state is treated as a security vulnerability, not a bug.

## From the SDK

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

## Reliability

The page is re-distilled before every step, so element references self-heal after navigations and layout changes — a stale reference produces an error observation the model recovers from, never a crashed run. Agents also get `search` (find pages without leaving the current one) and `read_page` (read the current page as Markdown without an LLM round-trip) as built-in tools.

## Scope boundaries

CAPTCHA solving and anti-bot evasion are deliberately out of scope. Runs that hit such walls fail gracefully with a clear reason instead of attempting a bypass. Be polite to the sites you automate.
