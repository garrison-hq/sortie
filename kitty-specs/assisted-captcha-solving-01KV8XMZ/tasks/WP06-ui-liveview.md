---
work_package_id: WP06
title: 'UI: live canvas + input + banner/sound + assist toggle'
dependencies:
- WP01
- WP05
requirement_refs:
- FR-001
- FR-008
- FR-009
- FR-010
- FR-011
planning_base_branch: feat/assisted-captcha-solving
merge_target_branch: feat/assisted-captcha-solving
branch_strategy: Planning artifacts for this feature were generated on feat/assisted-captcha-solving. During /spec-kitty.implement this WP may branch from a dependency-specific base, but completed changes must merge back into feat/assisted-captcha-solving unless the human explicitly redirects the landing branch.
subtasks:
- T027
- T028
- T029
- T030
- T031
agent: "claude:sonnet:implementer:implementer"
shell_pid: "370109"
history:
- '2026-06-16T19:47:16Z: created by /spec-kitty.tasks'
authoritative_surface: apps/ui/src/
execution_mode: code_change
owned_files:
- apps/ui/src/components/LiveView.tsx
- apps/ui/src/views/RunDetail.tsx
- apps/ui/src/views/NewRun.tsx
- apps/ui/src/ws.ts
tags: []
---

# WP06 — UI: live canvas + input + banner/sound + assist toggle

## Objective

Render the screencast to a canvas and capture/forward operator input so the human can solve
the challenge in the real remote page; show an `awaiting_human` banner with an audible alert,
Resume/Cancel controls, and a countdown; and add the assist toggle to New Run.

## Context

- Run detail: `apps/ui/src/views/RunDetail.tsx` (screenshot pane, step timeline,
  `useRunEvents`). New Run form: `apps/ui/src/views/NewRun.tsx`. WS client:
  `apps/ui/src/ws.ts` (read-only today).
- Uses WP01 types/events and WP05's live-view protocol.
- Design references: `../contracts/live-view-protocol.md`, `../research.md` (R4),
  `../spec.md` (FR-008/009/010/011 — alerting is in-UI banner + sound).

Run `spec-kitty agent action implement WP06 --agent <name>` (after WP01, WP05).

## Subtasks

### T027 — `LiveView.tsx`

**Steps**:

1. Component takes `runId` + a send() channel; on `lv:frame` draws the JPEG to a `<canvas>`.
2. Capture `mousedown/up/move/wheel` + `keydown/up` on the canvas; map client coords → page
   coords using the latest frame metadata + canvas size (R4); send `lv:mouse`/`lv:key`.
3. Send `lv:attach` on mount when the run is `awaiting_human`; `lv:detach` on unmount.
   **Validation**: a canvas click emits a correctly-mapped `lv:mouse`.

### T028 — `RunDetail.tsx` banner + sound + controls

**Steps**:

1. On `run-awaiting-human`: show a prominent banner ("Solve the challenge below — auto-resumes
   when cleared"), play a short audible alert (respect a mute toggle), and mount `LiveView`.
2. Show **Resume** and **Cancel** buttons and a countdown derived from `assist.deadlineAt`.
3. On `run-resumed`/`run-finished`: dismiss the banner and live view.
   **Validation**: banner + sound + countdown appear on the event; controls call the channel.

### T029 — `ui/ws.ts` outbound + events + reconnect

**Steps**:

1. Add an outbound `send(msg)` for `lv:*` (attach/detach/mouse/key/resume/cancel).
2. Handle the new `run-awaiting-human`/`run-resumed` events in the typed union.
3. On reconnect while a run is `awaiting_human`, re-fetch the run record and re-`lv:attach`.
   **Validation**: control round-trips; reconnection re-attaches the session.

### T030 — `NewRun.tsx` assist toggle

**Steps**:

1. Add an "Assist (human-in-the-loop CAPTCHA)" checkbox that sets `assist` in the submitted
   spec; default off. Short helper text noting it streams the live browser for you to solve.
   **Validation**: toggling on includes `assist: true` in the POST body.

### T031 — UI component/e2e wiring

**Steps**:

1. Add a component test (or wire into the e2e in WP07) asserting the banner + a mapped input
   send on a simulated `run-awaiting-human` + `lv:frame`.
   **Validation**: test green.

## Definition of Done

- Live interactive view renders and forwards input; banner + sound + controls + countdown
  work; assist toggle sets the flag.
- Reconnect re-attaches a paused session.
- The UI never tries to solve the challenge — it only relays the human's input (C-001).

## Reviewer guidance

- Verify coordinate mapping handles canvas scaling / HiDPI (no 1:1 assumption).
- Verify the audible alert is dismissible/mutable and not annoying on repeat.
- Confirm assist-off runs render exactly as today (no live view, no banner).

## Risks

- Canvas input fidelity (key modifiers, wheel). Keep the mapping in `LiveView` and unit-test
  the coordinate transform.

## Activity Log

- 2026-06-16T21:58:05Z – claude:sonnet:implementer:implementer – shell_pid=370109 – Started implementation via action command
- 2026-06-16T22:05:37Z – claude:sonnet:implementer:implementer – shell_pid=370109 – Ready for review
