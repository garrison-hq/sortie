---
work_package_id: WP07
title: 'Edges: CLI/MCP --assist + fallback + e2e fake-challenge'
dependencies:
- WP03
- WP04
- WP05
- WP06
requirement_refs:
- FR-001
- FR-002
- FR-017
planning_base_branch: feat/assisted-captcha-solving
merge_target_branch: feat/assisted-captcha-solving
branch_strategy: Planning artifacts for this feature were generated on feat/assisted-captcha-solving. During /spec-kitty.implement this WP may branch from a dependency-specific base, but completed changes must merge back into feat/assisted-captcha-solving unless the human explicitly redirects the landing branch.
subtasks:
- T032
- T033
- T034
- T035
- T036
agent: "claude:opus:reviewer:reviewer"
shell_pid: "478161"
history:
- '2026-06-16T19:47:16Z: created by /spec-kitty.tasks'
authoritative_surface: apps/ui/e2e/
execution_mode: code_change
owned_files:
- packages/core/src/cli.ts
- apps/mcp/src/index.ts
- apps/ui/e2e/**
tags: []
---

# WP07 — Edges: CLI/MCP --assist + fallback + e2e fake-challenge

## Objective

Expose `assist` at the CLI and MCP entry points, with a graceful fallback in non-interactive
contexts that cannot stream to a human, and prove the whole lifecycle end-to-end against a
deterministic local fake-challenge page. Add an assist-off regression assertion.

## Context

- CLI: `packages/core/src/cli.ts` (`agent`, `batch` subcommands). MCP: `apps/mcp/src/index.ts`
  (`run_agent` tool). UI e2e harness: `apps/ui/e2e/`.
- Uses the full stack from WP03–WP06.
- Design references: `../research.md` (R8/R10), `../spec.md` (FR-017, SC-001..005),
  `../quickstart.md`.
- **C-001**: the e2e "solves" the fake challenge via a forwarded human-style click — not by
  any automated solver. The fixture's "challenge" is a button a human (the test) clicks.

Run `spec-kitty agent action implement WP07 --agent <name>` (after WP03–WP06).

## Subtasks

### T032 — CLI `--assist` + fallback

**Steps**:

1. Add `--assist` to `agent` and `batch`; set `spec.assist` accordingly (default off).
2. Add `--assist-timeout <ms>` mapping to `assistSolveTimeoutMs` (optional).
3. If assist is on but no live-view-capable server is reachable, log a clear warning and
   downgrade to graceful-fail behavior (R8); document in `--help`.
   **Validation**: `--assist` sets the flag; unreachable-server path warns + downgrades.

### T033 — MCP assist arg + non-interactive fallback

**Steps**:

1. Add an optional `assist` boolean to the `run_agent` tool schema (default false).
2. MCP/stdio is non-interactive: if `assist` is true, log a warning and run with assist
   effectively disabled (detection still fails gracefully with a clear reason naming the
   challenge family + the profile to refresh). Document the limitation in the tool
   description.
   **Validation**: assist=true in MCP does not hang; fails gracefully on a challenge.

### T034 — Local fake-challenge fixture

**Steps**:

1. Add a static HTML page (served by the e2e harness) whose markers match `detectChallenge`
   (e.g. text "verify you are human" + a Turnstile-like container) and a button that, when
   clicked, mutates the DOM / navigates so the challenge "clears".
2. Keep it fully local — no third-party network.
   **Validation**: `detectChallenge` flags it; clicking the button clears it.

### T035 — e2e lifecycle

**Steps**:

1. Playwright e2e: start an assisted run against the fixture → assert run goes
   `awaiting_human`, a `lv:frame` is received, a forwarded canvas click clears the challenge,
   the run auto-resumes and completes.
2. Assert non-blocking: a second queued run completes while the first is paused (FR-016).
3. Assert timeout path: with a tiny `assistSolveTimeoutMs`, an unsolved run fails with
   `captcha_unsolved` (FR-015).
   **Validation**: `pnpm --filter @garrison-hq/sortie-ui e2e` green (the lifecycle subset).

### T036 — Assist-off regression

**Steps**:

1. Add an assertion (e2e or integration) that with assist off, a challenge yields today's
   graceful-fail and no live view / banner / pause occurs (FR-002, SC-002).
   **Validation**: assist-off behavior unchanged.

## Definition of Done

- `--assist` (CLI) and `assist` (MCP) wired with documented non-interactive fallback.
- Deterministic e2e proves detect→pause→stream→input→auto-resume, non-blocking, and timeout.
- Assist-off regression asserted. No automated solver anywhere (C-001).

## Reviewer guidance

- Confirm the e2e "solve" is a forwarded human click, not programmatic challenge-answering.
- Confirm non-interactive contexts never hang waiting for a human.
- Confirm the fixture makes no third-party network calls (CI determinism).

## Risks

- e2e flakiness around screencast timing — assert on the run reaching `awaiting_human` and on
  a received frame rather than pixel content; allow generous waits.

## Activity Log

- 2026-06-16T22:09:58Z – claude:sonnet:implementer:implementer – shell_pid=388326 – Started implementation via action command
- 2026-06-16T22:23:06Z – claude:sonnet:implementer:implementer – shell_pid=388326 – Ready for review: CLI --assist/--assist-timeout with warn+fallback; MCP assist schema+warning; fake-challenge fixture; Playwright e2e covering detect→pause→frame→click→resume, non-blocking, timeout→captcha_unsolved, assist-OFF regression. Zero LLM calls needed in e2e. typecheck+test+lint all green.
- 2026-06-16T22:23:55Z – claude:opus:reviewer:reviewer – shell_pid=412835 – Started review via action command
- 2026-06-16T22:30:12Z – claude:opus:reviewer:reviewer – shell_pid=412835 – Moved to planned
- 2026-06-16T22:31:00Z – claude:sonnet:implementer:implementer – shell_pid=425842 – Started implementation via action command
- 2026-06-16T23:08:16Z – claude:sonnet:implementer:implementer – shell_pid=425842 – Fixed cycle-1: lazy provider acquisition; assist.spec runs green keyless (5/5 passed); deduped fixture; fixed liveview static-page screencast; restructured T035-liveview to resolve on first frame
- 2026-06-16T23:09:05Z – claude:opus:reviewer:reviewer – shell_pid=478161 – Started review via action command
- 2026-06-16T23:14:07Z – claude:opus:reviewer:reviewer – shell_pid=478161 – Moved to planned
