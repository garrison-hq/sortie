---
work_package_id: WP05
title: 'Server live view: CDP screencast↔WS + input + endpoints'
dependencies:
- WP01
- WP02
- WP04
requirement_refs:
- FR-008
- FR-011
- NFR-001
- NFR-004
planning_base_branch: feat/assisted-captcha-solving
merge_target_branch: feat/assisted-captcha-solving
branch_strategy: Planning artifacts for this feature were generated on feat/assisted-captcha-solving. During /spec-kitty.implement this WP may branch from a dependency-specific base, but completed changes must merge back into feat/assisted-captcha-solving unless the human explicitly redirects the landing branch.
subtasks:
- T021
- T022
- T023
- T024
- T025
- T026
agent: "claude:sonnet:implementer:implementer"
shell_pid: "303834"
history:
- '2026-06-16T19:47:16Z: created by /spec-kitty.tasks'
authoritative_surface: apps/server/src/
execution_mode: code_change
owned_files:
- apps/server/src/liveview.ts
- apps/server/src/ws.ts
- apps/server/src/routes.ts
tags: []
---

# WP05 — Server live view: CDP screencast↔WS + input + endpoints

## Objective

While a run is `awaiting_human`, stream its page to the UI via CDP screencast over the
existing WebSocket and forward operator mouse/keyboard back via CDP input — scoped and
authorized per the threat model. Add resume/cancel endpoints. **The server only relays human
input; it never solves a challenge (C-001).**

## Context

- WS server: `apps/server/src/ws.ts` (`/api/events`, `toWireEvent()`, screenshot push;
  currently server→client only).
- Routes: `apps/server/src/routes.ts` (POST `/api/runs`, GET/DELETE `/api/runs/:id`,
  screenshot serving).
- Uses WP02's CDP session accessor, WP04's `resume(runId)`/cancel + `pausedRuns`, and WP01's
  live-view message schemas + `run-awaiting-human`/`run-resumed` events.
- Design references: `../contracts/live-view-protocol.md`, `../contracts/http-endpoints.md`,
  `../research.md` (R1/R3/R4/R9), `../spec.md` Security & Threat Model.

Run `spec-kitty agent action implement WP05 --agent <name>` (after WP01, WP02, WP04).

## Subtasks

### T021 — `liveview.ts` screencast bridge

**Steps**:

1. New module managing a `LiveViewSession { runId, cdpSession, clientConnId, viewport,
lastFrameMeta }`.
2. On a connection's `lv:attach { runId }` for an `awaiting_human` run it owns: get the page's
   CDP session (WP02 accessor), `Page.startScreencast` (jpeg, capped quality/maxWidth), and
   forward each `Page.screencastFrame` to the client as `lv:frame` (incl. metadata), then
   `Page.screencastFrameAck`.
3. Backpressure: keep only the latest frame if the client lags (drop intermediate frames).
4. Stop screencast and clear session on stop/resume/cancel/timeout/disconnect.
   **Validation**: frames flow only while paused; none when not (NFR-004).

### T022 — `liveview.ts` input dispatch + coord mapping

**Steps**:

1. Map inbound `lv:mouse`/`lv:key` to CDP `Input.dispatchMouseEvent`/`dispatchKeyEvent`.
2. Coordinates arrive already in page pixels (client maps using frame metadata, R4); validate
   they fall within the viewport before dispatch.
3. Constrain navigation initiated via input to the run's current origin.
   **Validation**: a forwarded click on the fake-challenge page (WP07 e2e) clears it.

### T023 — `ws.ts` bidirectional + new events

**Steps**:

1. Parse inbound socket text as live-view messages (WP01 parsers); dispatch `lv:attach/detach/
mouse/key/resume/cancel`.
2. `lv:resume`→`queue.resume(runId)`; `lv:cancel`→cancel path (T024).
3. Add `run-awaiting-human`/`run-resumed` to `toWireEvent()` (pass through, rewriting any
   path fields like existing screenshot handling).
   **Validation**: events reach the client; control messages drive the queue.

### T024 — `routes.ts` resume + cancel

**Steps**:

1. `POST /api/runs/:id/resume` — 200 (running) / 404 / 409-if-not-awaiting (see
   `../contracts/http-endpoints.md`).
2. Extend `DELETE /api/runs/:id` to handle `awaiting_human` (tear down live view, mark
   cancelled, `assist.resolution='cancelled'`).
   **Validation**: state-machine guards enforced.

### T025 — Validation & scoping (security)

**Steps**:

1. All inbound messages zod-validated; malformed dropped + logged (never throw on socket).
2. Enforce: one `LiveViewSession` per connection; input accepted only for that connection's
   attached run AND only while `awaiting_human`; reject/ignore otherwise.
3. Never log frame bytes; do not persist frames.
   **Validation**: covered by T026; matches C-003/C-004.

### T026 — Server tests

**Steps**:

1. Input rejected when run not `awaiting_human` or not owned by the connection.
2. Resume endpoint: 200/404/409 paths.
3. Frames emitted only while paused; stop on resume/cancel.
   **Validation**: `pnpm --filter @garrison-hq/sortie-server test` (or project equivalent) green.

## Definition of Done

- Interactive live view works while paused; input forwarded via CDP; controls drive the queue.
- Threat-model scoping enforced and tested; nothing persisted/logged that shouldn't be.
- No challenge-solving logic (C-001).

## Reviewer guidance

- Walk the scoping rules in T025 against C-003/C-004 line by line.
- Confirm screencast lifecycle is tied strictly to `awaiting_human`.
- Confirm host binding still honors `SORTIE_HOST`/`SORTIE_PORT` (C-005); no hardcoded localhost.

## Risks

- Bidirectional WS is new (was server→client only). Keep the inbound parser strict and the
  control surface tiny. Document the deployment auth caveat (R9) in code comments + quickstart.

## Activity Log

- 2026-06-16T21:22:26Z – claude:sonnet:implementer:implementer – shell_pid=303834 – Started implementation via action command
- 2026-06-16T21:35:05Z – claude:sonnet:implementer:implementer – shell_pid=303834 – Ready for review: CDP screencast bridge + input relay + bidirectional WS + resume/cancel HTTP endpoints. typecheck 0 errors, 298 tests passing, lint clean.
