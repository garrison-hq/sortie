---
work_package_id: WP03
title: 'Agent loop: detect → pause → resume'
dependencies:
- WP01
requirement_refs:
- FR-002
- FR-006
- FR-011
- FR-012
- NFR-002
planning_base_branch: feat/assisted-captcha-solving
merge_target_branch: feat/assisted-captcha-solving
branch_strategy: Planning artifacts for this feature were generated on feat/assisted-captcha-solving. During /spec-kitty.implement this WP may branch from a dependency-specific base, but completed changes must merge back into feat/assisted-captcha-solving unless the human explicitly redirects the landing branch.
subtasks:
- T011
- T012
- T013
- T014
history:
- '2026-06-16T19:47:16Z: created by /spec-kitty.tasks'
authoritative_surface: packages/core/src/agent/
execution_mode: code_change
owned_files:
- packages/core/src/agent/loop.ts
tags: []
---

# WP03 — Agent loop: detect → pause → resume

## Objective

Wire the shared detector into the agent loop after each page distill. When `assist` is on
and a challenge is detected, the loop yields a non-terminal `awaiting_human` outcome carrying
the paused step; when `assist` is off, preserve today's graceful-fail. Support re-entering
the loop at the paused step on the same page after a human solve.

## Context

- Loop: `packages/core/src/agent/loop.ts` — `runAgent(opts)`, the per-step iteration, and
  `snapshotPage(page)` (distill happens here). The execution context exposes `page`.
- Depends on WP01 types: `StepOutcome.awaiting_human`, `ChallengeDetection`, status enums,
  and `detectChallengeOnPage` from `packages/core/src/challenge/detect.ts`.
- Uses WP02's `humanizedDelay` for pacing.
- Design references: `../research.md` (R2/R3), `../data-model.md` (state machine),
  `../contracts/contracts-core.md`.
- **C-001**: detection pauses for a human; the loop never answers a challenge.

Run `spec-kitty agent action implement WP03 --agent <name>` (after WP01).

## Subtasks

### T011 — Thread `assistEnabled` through the loop

**Steps**:

1. Add `assistEnabled?: boolean` to `AgentRunOptions` (default false) and carry it in the
   execution context.
2. Add an optional `onAwaitingHuman(detection, stepIndex)` hook the queue (WP04) supplies.
   **Validation**: typecheck; default off preserves current signature behavior.

### T012 — Post-distill challenge check

**Steps**:

1. After `snapshotPage(page)` succeeds and before composing the LLM message, call
   `await detectChallengeOnPage(page, snapshot)`.
2. If a challenge is detected:
   - **assist on**: return `StepOutcome { kind: 'awaiting_human', detection }` with the
     current step index; do NOT call the LLM for this step.
   - **assist off**: keep today's behavior (the agent is prompted to `fail`; do not change
     the existing flow — i.e. no new fail path, detection here is a no-op when assist off,
     OR optionally short-circuit to the existing fail with a clear reason — match current
     behavior exactly; document the choice).
3. Keep detection overhead ≤100ms/step (NFR-002) — detection reads already-available
   snapshot data plus a light DOM/iframe check.
   **Validation**: covered by T014.

### T013 — Resume re-entry + pacing

**Steps**:

1. Provide a way to resume the same `runAgent` invocation at the paused step using the same
   `page` (e.g. the loop awaits a resume signal/promise supplied by the queue, then continues
   the for-loop without rebuilding the page).
2. On resume, re-run detection once (the challenge may have cleared) before continuing.
3. Apply `humanizedDelay()` between actions when assist is on.
   **Validation**: unit test resumes and continues from the paused index on the same page.

### T014 — Loop unit tests

**Steps**:

1. With a fake page/snapshot that trips the detector: assist-on yields `awaiting_human`;
   assist-off path matches current behavior.
2. Resume continues from the paused step and completes.
3. Assert the LLM is NOT called on the paused step.
   **Validation**: `pnpm --filter @garrison-hq/sortie-core test` green.

## Definition of Done

- Detection integrated post-distill; assist-on pauses, assist-off unchanged.
- Resume continues on the same page from the paused step.
- Tests cover on/off/resume; no challenge-answering logic (C-001).

## Reviewer guidance

- Verify assist-off diff is effectively nil in behavior.
- Verify the paused step does not consume an LLM call.
- Confirm resume reuses the live page (no rebuild → preserves session/challenge state).

## Risks

- Coupling the resume signal between loop and queue (WP04) — keep the interface small
  (a promise/callback) and documented; WP04 owns the queue side.
