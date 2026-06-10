# Contributing to sortie

sortie is built by one person alongside other work. Response times are
measured in days to weeks, not hours. Not every proposal will land —
some will be out of scope (see "Scope boundaries" below), some will be
fine in principle but need to wait until they're load-bearing. That's
the pace. If that's a dealbreaker, fork — the AGPL explicitly allows it.

This document covers how to contribute productively given those
constraints.

---

## Before you start

Read, in order:

1. [`README.md`](./README.md) — what sortie is, the security model for
   credentials and login profiles, and the documented limitations.
2. [`CLAUDE.md`](./CLAUDE.md) — binding conventions for any contributor
   (human or AI): layout, commands, and the project's hard rules.
3. [`PROMPT.md`](./PROMPT.md) — the original project spec; useful for
   understanding what the platform is ultimately aiming at.

---

## Open an issue first

For anything beyond an obvious typo or a small bug fix, **open an issue
before a PR**. Scope is deliberately narrow; good proposals that don't
fit right now are better captured as issues than as PRs that go stale.
Issue templates in [`.github/ISSUE_TEMPLATE/`](./.github/ISSUE_TEMPLATE)
cover bug reports and feature proposals.

---

## Hard scope boundaries

These are not up for debate in PRs (open an issue if you think the
world has changed):

- **No CAPTCHA solving, no anti-bot evasion, no fingerprint spoofing.**
  Runs that hit such walls must fail gracefully with a clear reason.
  PRs adding bypass capability will be closed regardless of code
  quality.
- **Credentials never reach the model.** The `{{cred:NAME}}`
  placeholder model (substitution at type-time, observation scrubbing,
  no persistence) is a load-bearing invariant. Any change touching
  `agent/`, tracing, or logging must preserve it.
- **No hardcoded models, base URLs, or `localhost` binds.** Providers
  and endpoints come from config/env (`OPENAI_BASE_URL` may point at
  Ollama/vLLM/etc.); the server binds `SORTIE_HOST`/`SORTIE_PORT`.

---

## Development setup

Requires Node >= 22 and pnpm.

```sh
pnpm install
pnpm exec playwright install chromium
cp .env.example .env        # fill in an LLM key for live work; unit tests need none
pnpm build
```

Day-to-day commands:

```sh
pnpm typecheck && pnpm lint && pnpm test   # must pass before any PR
pnpm dev                                   # server + built UI
pnpm dev:ui                                # Vite dev server with /api proxy
pnpm --filter @garrison-hq/sortie-ui e2e   # full-stack e2e (one live LLM call)
```

---

## The verification standard

Unit tests are necessary but not sufficient. **Any change that touches
browser automation must be verified against a live page** — the project
uses books.toscrape.com, saucedemo.com, and the-internet.herokuapp.com
as stable targets, and `examples/` contains ready-made verification
scripts (`npx tsx examples/verify-browser.ts`, etc.). Say in your PR
which live verification you ran and what you observed.

---

## Code rules

- TypeScript strict, ESM only (`type: module`, NodeNext resolution).
- zod schemas are the source of truth for all structured data crossing
  a boundary (LLM output, API payloads, user-supplied extraction
  schemas). Don't hand-roll validation next to an existing schema.
- Cross-module types live in `packages/core/src/contracts.ts` — one
  definition, modules implement against it.
- New runtime dependencies need a justification paragraph in the PR
  description: what it does, why an existing dep or the stdlib isn't
  enough, and what the alternatives were. The dependency surface is
  deliberately small.
- Scope discipline: don't bundle cleanup with fixes, don't add
  abstractions for hypothetical requirements, comments explain _why_
  not _what_.

---

## Pull requests

The PR template asks you to confirm:

- Linked issue (or an explanation of why this didn't need one).
- `pnpm typecheck`, `pnpm lint`, `pnpm test` pass.
- Live verification performed for browser-touching changes.
- Docs updated in the same PR if the change contradicts `README.md` or
  `CLAUDE.md`.

One logical change per commit; a ≤72-char subject line, body explains
_why_.

---

## Licensing

Contributions are accepted under the project's license,
**AGPL-3.0-only**. By opening a PR you confirm you have the right to
contribute the code under these terms. No CLA, no DCO sign-off — just
don't submit code you don't have the right to license this way.

---

## Code of conduct

This project follows the Contributor Covenant 2.1. See
[`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

---

## Security issues

**Do not open a public issue for a security-sensitive bug.** See
[`SECURITY.md`](./SECURITY.md) for the private reporting path.
