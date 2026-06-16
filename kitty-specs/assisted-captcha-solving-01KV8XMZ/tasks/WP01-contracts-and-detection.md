---
work_package_id: WP01
title: Contracts & shared challenge detection
dependencies: []
requirement_refs:
- FR-001
- FR-006
- FR-015
- FR-018
- NFR-003
planning_base_branch: feat/assisted-captcha-solving
merge_target_branch: feat/assisted-captcha-solving
branch_strategy: Planning artifacts for this feature were generated on feat/assisted-captcha-solving. During /spec-kitty.implement this WP may branch from a dependency-specific base, but completed changes must merge back into feat/assisted-captcha-solving unless the human explicitly redirects the landing branch.
base_branch: kitty/mission-assisted-captcha-solving-01KV8XMZ
base_commit: cbeab34eebe11d7b4c406a8a6e40cc92f70c22e2
created_at: '2026-06-16T20:00:06.710591+00:00'
subtasks:
- T001
- T002
- T003
- T004
- T005
- T006
shell_pid: "198825"
agent: "claude:opus:reviewer:reviewer"
history:
- '2026-06-16T19:47:16Z: created by /spec-kitty.tasks'
authoritative_surface: packages/core/src/challenge/
execution_mode: code_change
owned_files:
- packages/core/src/contracts.ts
- packages/core/src/challenge/**
- packages/core/src/search/engines.ts
tags: []
---

# WP01 — Contracts & shared challenge detection

## Objective

Add every cross-boundary type assist mode needs, and extract the existing search-only
challenge detection into one shared module reused by both the search chain and (in WP03)
the agent loop. **Nothing changes behaviorally when `assist` is off**, and existing search
tests must stay green.

## Context

- Source of truth for cross-module types is `packages/core/src/contracts.ts` (zod schemas).
- Today challenge detection lives only inside `packages/core/src/search/engines.ts`
  (`CHALLENGE_MARKERS`, HTTP 403/429/202 checks, `SearchChallengeError`).
- Design references: `../spec.md` (FR-001/006/015/018, NFR-003),
  `../data-model.md`, `../contracts/contracts-core.md`, `../research.md` (R5).
- **C-001**: detection only flags challenges — it must never attempt to solve them.

Run `spec-kitty agent action implement WP01 --agent <name>` to start (no dependencies).

## Subtasks

### T001 — RunSpec `assist` + `assistSolveTimeoutMs`

**Purpose**: opt-in flag + per-run timeout override.
**Steps**:

1. In the agent run spec schema, add `assist: z.boolean().optional().default(false)`.
2. Add `assistSolveTimeoutMs: z.number().int().min(30_000).max(3_600_000).optional()`.
3. Export the inferred TS types; keep all other fields unchanged.
   **Validation**: parsing a spec without `assist` yields `assist === false`.

### T002 — Status / reason / assist types

**Purpose**: model the pause state and assist metadata.
**Steps** (see `../contracts/contracts-core.md`):

1. `AgentStatus` and `RunStatus` gain `'awaiting_human'`.
2. Add `ChallengeFamily` union and `ChallengeDetection` interface/schema.
3. Add `AssistState` (family, signal, stepIndex, challengeUrl, pausedAt, deadlineAt,
   resolvedAt?, resolution?, solveSource?).
4. Add `assist?: AssistState` to `AgentRunResult` and the store `RunRecord`.
5. Export `FAILURE_REASON_CAPTCHA_UNSOLVED = 'captcha_unsolved'`.
6. Extend the internal `StepOutcome` union with `{ kind: 'awaiting_human'; detection }`.
   **Validation**: typecheck passes; no existing field renamed/removed.

### T003 — Live-view + event WS message schemas

**Purpose**: one zod home for the new wire messages so server (WP05) and UI (WP06) share them.
**Steps** (see `../contracts/live-view-protocol.md`):

1. Add `RunEvent` variants `run-awaiting-human` and `run-resumed`.
2. Add zod schemas for server→client `lv:started|lv:frame|lv:stopped` and client→server
   `lv:attach|lv:detach|lv:mouse|lv:key|lv:resume|lv:cancel`.
3. Export discriminated-union parsers for inbound and outbound live-view messages.
   **Validation**: round-trip parse of each message shape succeeds; malformed input rejected.

### T004 — Shared `challenge/detect.ts`

**Purpose**: single detector for all callers.
**Steps** (see `../research.md` R5):

1. Create `packages/core/src/challenge/detect.ts`.
2. Export pure `detectChallenge({ status, title, bodyText, url, frameUrls? }):
ChallengeDetection | null` covering: reCAPTCHA (`recaptcha`, `grecaptcha`), hCaptcha
   (`hcaptcha`), Turnstile/Cloudflare (`challenges.cloudflare.com`, `cf-chl`, "checking your
   browser"), generic markers ("verify you are human", "are you a robot", "unusual
   traffic"), HTTP 403/429.
3. Export page-aware `detectChallengeOnPage(page, snapshot): Promise<ChallengeDetection |
null>` that reads status/title/body/iframe srcs and calls the pure function.
4. Keep the marker/status constants here as the single source.
   **Validation**: covered by T006.

### T005 — Refactor `search/engines.ts` onto the shared detector

**Purpose**: remove duplicate logic; one source of truth.
**Steps**:

1. Replace the inline marker/status logic with a call to `detectChallenge(...)`.
2. Preserve `SearchChallengeError` semantics (engine-specific 202/DDG handling can pass
   extra signals into the shared function or remain a thin engine-specific wrapper).
3. Do not change the search fallback-chain behavior.
   **Validation**: existing search tests pass unchanged.

### T006 — `challenge/detect.test.ts`

**Purpose**: fixture-based confidence (NFR-003).
**Steps**:

1. Add fixtures (HTML/title/status) for each family + a few clean pages.
2. Assert each challenge family is detected with the right `family`/`via`.
3. Assert clean pages return `null` (false-positive guard; ≤1 across the set).
   **Validation**: `pnpm --filter @garrison-hq/sortie-core test` green.

## Definition of Done

- All six subtasks complete; typecheck + lint + core tests pass.
- Assist-off behavior byte-identical; search tests unchanged.
- No solving logic introduced (C-001).

## Reviewer guidance

- Confirm contract additions are purely additive.
- Confirm `engines.ts` behavior is preserved (diff the detection outcomes).
- Confirm detector has no side effects / no challenge-answering.

## Activity Log

- 2026-06-16T20:00:07Z – claude:sonnet:implementer:implementer – shell_pid=176215 – Assigned agent via action command
- 2026-06-16T20:15:28Z – claude:sonnet:implementer:implementer – shell_pid=176215 – Ready for review
- 2026-06-16T20:15:55Z – claude:opus:reviewer:reviewer – shell_pid=198825 – Started review via action command
