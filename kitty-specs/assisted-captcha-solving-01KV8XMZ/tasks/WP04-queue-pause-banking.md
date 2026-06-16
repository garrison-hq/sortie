---
work_package_id: WP04
title: 'Queue: non-blocking pause/resume/timeout + cookie banking'
dependencies:
- WP01
- WP03
requirement_refs:
- FR-007
- FR-011
- FR-012
- FR-013
- FR-014
- FR-015
- FR-016
- NFR-005
planning_base_branch: feat/assisted-captcha-solving
merge_target_branch: feat/assisted-captcha-solving
branch_strategy: Planning artifacts for this feature were generated on feat/assisted-captcha-solving. During /spec-kitty.implement this WP may branch from a dependency-specific base, but completed changes must merge back into feat/assisted-captcha-solving unless the human explicitly redirects the landing branch.
subtasks:
- T015
- T016
- T017
- T018
- T019
- T020
agent: "claude:sonnet:implementer:implementer"
shell_pid: "245227"
history:
- '2026-06-16T19:47:16Z: created by /spec-kitty.tasks'
authoritative_surface: packages/core/src/runtime/
execution_mode: code_change
owned_files:
- packages/core/src/runtime/queue.ts
- packages/core/src/profiles.ts
- packages/core/src/store/**
tags: []
---

# WP04 — Queue: non-blocking pause/resume/timeout + cookie banking

## Objective

Turn `awaiting_human` into a non-blocking queue state: a paused run keeps its live browser
context but yields its worker slot so other runs keep processing. Add resume, a configurable
solve timeout (default 10 min → `captcha_unsolved`), a cap on concurrent paused runs, cookie
banking into the active profile after a solve, and store persistence of the new
status/reason/assist data.

## Context

- Queue: `packages/core/src/runtime/queue.ts` — `pump()` (fills up to `concurrency`),
  `runItem()` (single attempt; on app outcome calls `finishRun`, on infra error retries),
  event emission, screenshot sink.
- Profiles: `packages/core/src/profiles.ts` — `persistProfileState(page, path)` (0600).
- Store: `packages/core/src/store/**` — run create/update, status, failureReason.
- Depends on WP01 (types/events) and WP03 (loop returns `awaiting_human` + exposes a resume
  signal).
- Design references: `../research.md` (R2/R7), `../data-model.md`, `../contracts/*`.

Run `spec-kitty agent action implement WP04 --agent <name>` (after WP01, WP03).

## Subtasks

### T015 — `pausedRuns` map + non-blocking `pauseRun()`

**Steps**:

1. Add `pausedRuns: Map<runId, { item, page, context, assist: AssistState, deadlineTimer,
resumeSignal }>`.
2. When `runItem()` receives an `awaiting_human` outcome: build `AssistState` (family,
   signal, stepIndex, challengeUrl, pausedAt, deadlineAt), store status `awaiting_human`,
   move the run into `pausedRuns`, emit `run-awaiting-human`, and **do not requeue**.
3. Free the worker and call `pump()` so other eligible runs proceed (FR-016).
4. Keep the run's browser context/page alive (do not close — needed for the human to solve).
   **Validation**: covered by T020.

### T016 — `resume(runId)` + cookie banking + `run-resumed`

**Steps**:

1. Public `resume(runId)`: valid only when status is `awaiting_human`.
2. Before continuing, if the run uses a profile, call `bankAssistSolve(page, profile)`.
3. Signal the loop's resume (WP03 interface) to continue on the same page; set status
   `running`; emit `run-resumed { solveSource }`.
4. On completion the normal `finishRun` path runs.
   **Validation**: resume re-enters and finishes; cookies persisted.

### T017 — Solve timeout + concurrent-pause cap

**Steps**:

1. On pause, arm a timer = `assistSolveTimeoutMs ?? DEFAULT (600_000)`; clamp per schema.
2. On expiry: tear down live view (WP05 hook), set status `failed`,
   `failureReason = 'captcha_unsolved'`, `assist.resolution='timeout'`, emit `run-finished`.
3. Add `maxConcurrentAwaitingHuman` (config, default 3). If exceeded when a new challenge
   fires, degrade that run to graceful-fail with a clear reason instead of pausing.
   **Validation**: timeout path and cap covered by T020.

### T018 — `profiles.bankAssistSolve()`

**Steps**:

1. Add `bankAssistSolve(page, profileName, store)` that reuses `persistProfileState` to write
   `page.context().storageState()` back to the profile path (0600, on-disk, never DB/API).
2. Stamp `lastAssistedAt` (and `lastUsedAt`) metadata.
   **Validation**: profile file updated with new cookies after a simulated solve.

### T019 — Store persistence

**Steps**:

1. Persist transitions to/from `awaiting_human`, the `assist` snapshot on the run record,
   and `failureReason='captcha_unsolved'`, following the store's existing serialization
   pattern (additive; no migration beyond a new optional field/value).
   **Validation**: reloading a run shows correct status/assist/reason.

### T020 — Queue unit tests

**Steps**:

1. A paused run does NOT block others (a second queued run completes while one is
   `awaiting_human`).
2. Timeout → `failed` + `captcha_unsolved`.
3. `resume()` re-enters and finishes; banking called when a profile is set.
4. Cap exceeded → graceful-fail, not pause.
   **Validation**: `pnpm --filter @garrison-hq/sortie-core test` green.

## Definition of Done

- `awaiting_human` is non-blocking; other runs progress.
- Resume, timeout→`captcha_unsolved`, cap, banking, and persistence all work + tested.
- No challenge-answering logic anywhere (C-001).

## Reviewer guidance

- Confirm the worker slot is freed on pause (no blocked `pump`).
- Confirm paused browser context is NOT torn down until resolve/timeout/cancel.
- Confirm banked state reuses profile storage guarantees (0600, never DB/API).

## Risks

- Leaking live browser contexts on paused runs — the cap + timeout bound this; ensure
  teardown on every terminal transition (resume-complete, timeout, cancel, process error).

## Activity Log

- 2026-06-16T20:37:29Z – claude:sonnet:implementer:implementer – shell_pid=245227 – Started implementation via action command
- 2026-06-16T21:04:37Z – claude:sonnet:implementer:implementer – shell_pid=245227 – Ready for review
