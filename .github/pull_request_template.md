<!--
Thanks for the PR. Before opening, please confirm the checklist below
so review can focus on the change itself. See CONTRIBUTING.md for
context on each item.
-->

## What this changes

<!-- One paragraph. WHY this change is needed, not what the code does. -->

## Linked issue

<!--
Every non-trivial PR should link an issue. See CONTRIBUTING.md §"Open
an issue first". If this is a typo fix or obvious bug, say so instead.
-->

Fixes #

## Checklist

- [ ] Read `CLAUDE.md` and `CONTRIBUTING.md`.
- [ ] Scope is minimal — no unrelated cleanup, no speculative
      abstractions, no "while I'm here" refactors.
- [ ] Stays inside the hard scope boundaries (no CAPTCHA/anti-bot
      capability; credential placeholder model preserved).
- [ ] `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass.
- [ ] If this touches browser automation: live verification performed
      (which script/site, and what you observed — describe below).
- [ ] If a new runtime dependency was added: justification paragraph
      included below.
- [ ] Docs updated in the same PR if this contradicts `README.md` or
      `CLAUDE.md`.

## Live verification (if applicable)

<!-- e.g. "ran npx tsx examples/verify-browser.ts — 4/4 checks green" -->

## Notes for reviewers

<!-- Tricky bits, known limitations, trade-offs. -->
