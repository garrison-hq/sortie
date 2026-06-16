---
work_package_id: WP02
title: Browser fingerprint hygiene (avoidance)
dependencies: []
requirement_refs:
- FR-003
- FR-004
- FR-005
- NFR-005
planning_base_branch: feat/assisted-captcha-solving
merge_target_branch: feat/assisted-captcha-solving
branch_strategy: Planning artifacts for this feature were generated on feat/assisted-captcha-solving. During /spec-kitty.implement this WP may branch from a dependency-specific base, but completed changes must merge back into feat/assisted-captcha-solving unless the human explicitly redirects the landing branch.
subtasks:
- T007
- T008
- T009
- T010
agent: "claude:sonnet:implementer:implementer"
shell_pid: "207001"
history:
- '2026-06-16T19:47:16Z: created by /spec-kitty.tasks'
authoritative_surface: packages/core/src/browser/
execution_mode: code_change
owned_files:
- packages/core/src/browser/manager.ts
- packages/core/src/browser/hygiene.ts
tags: []
---

# WP02 — Browser fingerprint hygiene (avoidance)

## Objective

When `assist` is on, create the Playwright context so automation stops looking like a broken
headless bot — realistic UA/locale/timezone, masked `navigator.webdriver`, and the
automation-controlled blink feature disabled. Also expose a CDP session accessor and a
humanized-delay helper that later WPs reuse. **This is hygiene, not evasion (C-002): no code
here defeats any specific challenge.**

## Context

- Browser lifecycle is in `packages/core/src/browser/manager.ts` (`launch()`, `newPage()`/
  context creation with `DEFAULT_VIEWPORT` and optional `storageState`).
- Design references: `../spec.md` (FR-003/004/005, C-002), `../research.md` (R6),
  `../plan.md` (source tree).
- Profile/session reuse already works via `storageState`; assist should _prefer_ it.

Run `spec-kitty agent action implement WP02 --agent <name>` to start (no dependencies;
parallel with WP01).

## Subtasks

### T007 — `browser/hygiene.ts`

**Steps**:

1. New file exporting `hygieneContextOptions()` → `{ userAgent, locale, timezoneId,
viewport }` with a realistic current desktop-Chrome UA, `en-US`, a common timezone,
   reusing `DEFAULT_VIEWPORT`.
2. Export `WEBDRIVER_MASK_SCRIPT` (init script setting `navigator.webdriver => undefined`)
   and `hygieneLaunchArgs()` → `['--disable-blink-features=AutomationControlled']`.
3. Export `humanizedDelay(min=120, max=480)` returning a bounded random delay (vary by call;
   do not use Math.random in a way that breaks determinism in tests — accept an optional rng).
   **Validation**: pure module, unit-testable.

### T008 — Apply hygiene in `manager.ts`

**Steps**:

1. Extend launch/context options with `fingerprintHygiene?: boolean` (driven by `assist`).
2. When true: merge `hygieneContextOptions()` into `newContext`, add `hygieneLaunchArgs()`
   to launch, and `context.addInitScript(WEBDRIVER_MASK_SCRIPT)`.
3. When false/absent: context is created exactly as today (no diff).
   **Validation**: assist-off context options unchanged.

### T009 — CDP session accessor + delay helper export

**Steps**:

1. Add a method to obtain a `CDPSession` for a page (`context.newCDPSession(page)`), returned
   alongside the page (or a helper `cdpSessionFor(page)`), for WP05's live view.
2. Re-export `humanizedDelay` from the browser module surface for WP03's loop pacing.
   **Validation**: accessor returns a working CDPSession against a live page.

### T010 — Unit test + live-verify note

**Steps**:

1. Unit test: assist-on produces the expected context options + init script; assist-off
   does not.
2. Add a short comment/doc note describing the manual live-verification (Turnstile/reCAPTCHA
   demo page) per charter — not run in CI (R10/R6).
   **Validation**: `pnpm --filter @garrison-hq/sortie-core test` green.

## Definition of Done

- Hygiene applied only when assist on; assist-off path unchanged.
- CDP accessor + delay helper exported for downstream WPs.
- No stealth/evasion toolkit added; changes are minimal and honest (C-002).

## Reviewer guidance

- Verify no dependency added; flags are minimal.
- Confirm assist-off context is byte-identical to current behavior.
- Confirm nothing here attempts to solve/answer a challenge.

## Risks

- Over-aggressive Chromium flags can destabilize headless. Keep to the documented minimal set.

## Activity Log

- 2026-06-16T20:18:33Z – claude:sonnet:implementer:implementer – shell_pid=207001 – Started implementation via action command
- 2026-06-16T20:22:48Z – claude:sonnet:implementer:implementer – shell_pid=207001 – Ready for review: hygiene.ts + manager.ts updated, CDP accessor added, 12 new unit tests all passing, typecheck clean, lint clean
