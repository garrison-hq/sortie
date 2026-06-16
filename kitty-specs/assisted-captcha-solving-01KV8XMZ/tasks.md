# Tasks: Assisted CAPTCHA Solving

**Mission**: assisted-captcha-solving-01KV8XMZ
**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md)
**Planning base**: `main` · **Merge target**: `main` (via feature branch `feat/assisted-captcha-solving` → PR #3)

7 work packages, 36 subtasks. WP01 & WP02 are parallel foundations; WP07 closes the loop with cross-stack e2e.

## Subtask Index

| ID   | Description                                                                 | WP   | Parallel |
| ---- | --------------------------------------------------------------------------- | ---- | -------- |
| T001 | RunSpec `assist` + `assistSolveTimeoutMs` (zod)                             | WP01 |          | [D] |
| T002 | Status/reason/AssistState/ChallengeDetection/RunEvent/StepOutcome additions | WP01 |          | [D] |
| T003 | Live-view + event WS message zod schemas                                    | WP01 |          | [D] |
| T004 | Shared `challenge/detect.ts` (pure + page-aware)                            | WP01 |          | [D] |
| T005 | Refactor `search/engines.ts` onto shared detector                           | WP01 |          | [D] |
| T006 | `challenge/detect.test.ts` fixtures + false-positive guard                  | WP01 |          | [D] |
| T007 | `browser/hygiene.ts` UA/locale/tz/viewport + webdriver mask + launch args   | WP02 | [D] |
| T008 | Apply hygiene in `manager.ts` context when assist on                        | WP02 | [D] |
| T009 | Expose CDP session accessor + humanized-delay helper                        | WP02 | [D] |
| T010 | hygiene unit test + live-verify note                                        | WP02 | [D] |
| T011 | Thread `assistEnabled` through loop options/context                         | WP03 |          | [D] |
| T012 | Post-distill challenge check → `awaiting_human` (on) / legacy fail (off)    | WP03 |          | [D] |
| T013 | Resume re-entry at paused step on same page + pacing call                   | WP03 |          | [D] |
| T014 | Loop unit tests (assist on/off paths)                                       | WP03 |          | [D] |
| T015 | `pausedRuns` map + `pauseRun()` non-blocking                                | WP04 |          | [D] |
| T016 | `resume(runId)` + bank cookies + emit `run-resumed`                         | WP04 |          | [D] |
| T017 | Solve timeout (default 10m) → `captcha_unsolved`; concurrent-pause cap      | WP04 |          | [D] |
| T018 | `profiles.bankAssistSolve()` + `lastAssistedAt`                             | WP04 |          | [D] |
| T019 | Store persistence for `awaiting_human`/assist/`captcha_unsolved`            | WP04 |          | [D] |
| T020 | Queue unit tests (non-blocking, timeout, resume, cap)                       | WP04 |          | [D] |
| T021 | `liveview.ts` screencast bridge (CDP→`lv:frame`, ack, backpressure)         | WP05 |          |
| T022 | `liveview.ts` input dispatch (`lv:*`→CDP Input) + coord mapping             | WP05 |          |
| T023 | `ws.ts` bidirectional: parse/scope `lv:*`, wire new run events              | WP05 |          |
| T024 | `routes.ts` resume + extend cancel for `awaiting_human`                     | WP05 |          |
| T025 | Server-side validation/scoping of live-view messages                        | WP05 |          |
| T026 | Server tests (scoping, resume state, timeout)                               | WP05 |          |
| T027 | `LiveView.tsx` canvas render + input capture + coord map                    | WP06 |          |
| T028 | `RunDetail.tsx` awaiting_human banner + sound + Resume/Cancel + countdown   | WP06 |          |
| T029 | `ui/ws.ts` outbound `lv:*` + handle new events + reconnect re-attach        | WP06 |          |
| T030 | `NewRun.tsx` assist toggle                                                  | WP06 |          |
| T031 | UI component/e2e wiring for live view                                       | WP06 |          |
| T032 | `cli.ts` `--assist` (agent/batch) + server-reachability fallback            | WP07 |          |
| T033 | `mcp/index.ts` assist arg + non-interactive graceful fallback               | WP07 |          |
| T034 | Local fake-challenge page fixture                                           | WP07 |          |
| T035 | e2e: detect→pause→stream→input→auto-resume + non-blocking + timeout         | WP07 |          |
| T036 | Assist-off regression assertion                                             | WP07 |          |

---

## Phase 1 — Foundations (parallel)

### WP01 — Contracts & shared challenge detection

**Goal**: Establish every cross-boundary type for assist mode and a single shared challenge
detector reused by the search chain and (later) the agent loop. No behavior change when
assist is off.
**Priority**: P0 (foundation) · **Prompt**: [tasks/WP01-contracts-and-detection.md](tasks/WP01-contracts-and-detection.md)
**Independent test**: `pnpm --filter @garrison-hq/sortie-core test` passes incl. new
`challenge/detect.test.ts`; existing `search` tests stay green after refactor.
**Requirements**: FR-001, FR-006, FR-015, FR-018, NFR-003

- [x] T001 RunSpec `assist` + `assistSolveTimeoutMs` (WP01)
- [x] T002 status/reason/AssistState/ChallengeDetection/RunEvent/StepOutcome additions (WP01)
- [x] T003 live-view + event WS message zod schemas (WP01)
- [x] T004 shared `challenge/detect.ts` (WP01)
- [x] T005 refactor `search/engines.ts` onto shared detector (WP01)
- [x] T006 `challenge/detect.test.ts` fixtures + false-positive guard (WP01)

**Dependencies**: none. **Risks**: detector refactor must preserve existing search behavior.

### WP02 — Browser fingerprint hygiene (avoidance)

**Goal**: When assist is on, harden the Playwright context so automation doesn't look like a
broken headless bot (C-002 — hygiene, not evasion), and expose a CDP session accessor for
the live view.
**Priority**: P0 (foundation) · **Prompt**: [tasks/WP02-browser-hygiene.md](tasks/WP02-browser-hygiene.md)
**Independent test**: unit test asserts assist-on context options (UA/locale/tz/webdriver
mask) and that assist-off context is unchanged.
**Requirements**: FR-003, FR-004, FR-005, NFR-005

- [x] T007 `browser/hygiene.ts` presets + webdriver mask + launch args (WP02)
- [x] T008 apply hygiene in `manager.ts` when assist on (WP02)
- [x] T009 expose CDP session accessor + humanized-delay helper (WP02)
- [x] T010 hygiene unit test + live-verify note (WP02)

**Dependencies**: none (parallel with WP01). **Risks**: over-aggressive flags could
destabilize headless Chromium — keep minimal.

---

## Phase 2 — Engine pause lifecycle

### WP03 — Agent loop: detect → pause → resume

**Goal**: Insert the post-distill challenge check into the loop; pause with `awaiting_human`
when assist is on, preserve legacy graceful-fail when off, and support resuming at the
paused step on the same page.
**Priority**: P0 · **Prompt**: [tasks/WP03-agent-loop-pause.md](tasks/WP03-agent-loop-pause.md)
**Independent test**: loop unit tests — assist-on detection yields `awaiting_human`;
assist-off yields today's fail; resume continues from the paused step.
**Requirements**: FR-002, FR-006, FR-011, FR-012, NFR-002

- [x] T011 thread `assistEnabled` through loop options/context (WP03)
- [x] T012 post-distill check → `awaiting_human` (on) / legacy fail (off) (WP03)
- [x] T013 resume re-entry + pacing call (WP03)
- [x] T014 loop unit tests (WP03)

**Dependencies**: WP01.

### WP04 — Queue: non-blocking pause/resume/timeout + cookie banking

**Goal**: Make `awaiting_human` a non-blocking queue state (other runs keep running), with
resume, a configurable solve timeout (default 10m → `captcha_unsolved`), a concurrent-pause
cap, cookie banking into the profile, and store persistence.
**Priority**: P0 · **Prompt**: [tasks/WP04-queue-pause-banking.md](tasks/WP04-queue-pause-banking.md)
**Independent test**: queue unit tests — paused run doesn't block others; timeout →
`captcha_unsolved`; resume re-enters; cap degrades gracefully; profile state banked.
**Requirements**: FR-007, FR-011, FR-012, FR-013, FR-014, FR-015, FR-016, NFR-005

- [x] T015 `pausedRuns` map + `pauseRun()` non-blocking (WP04)
- [x] T016 `resume(runId)` + bank cookies + emit `run-resumed` (WP04)
- [x] T017 solve timeout → `captcha_unsolved`; concurrent-pause cap (WP04)
- [x] T018 `profiles.bankAssistSolve()` + `lastAssistedAt` (WP04)
- [x] T019 store persistence for new status/reason/assist (WP04)
- [x] T020 queue unit tests (WP04)

**Dependencies**: WP01, WP03.

---

## Phase 3 — Live view & UI

### WP05 — Server live view: CDP screencast↔WS + input + endpoints

**Goal**: Stream the paused page to the UI via CDP screencast over the WS and forward
operator input back via CDP input, scoped and authorized per the threat model; add resume/
cancel endpoints.
**Priority**: P0 · **Prompt**: [tasks/WP05-server-liveview.md](tasks/WP05-server-liveview.md)
**Independent test**: server tests — input rejected unless run is `awaiting_human` and owned
by the connection; resume endpoint enforces state; frames flow only while paused.
**Requirements**: FR-008, FR-011, NFR-001, NFR-004 (+ C-003/C-004 security)

- [ ] T021 `liveview.ts` screencast bridge (WP05)
- [ ] T022 `liveview.ts` input dispatch + coord mapping (WP05)
- [ ] T023 `ws.ts` bidirectional + wire new run events (WP05)
- [ ] T024 `routes.ts` resume + extend cancel (WP05)
- [ ] T025 server-side validation/scoping of live-view messages (WP05)
- [ ] T026 server tests (WP05)

**Dependencies**: WP01, WP02, WP04.

### WP06 — UI: live canvas + input + banner/sound + assist toggle

**Goal**: Render the screencast to a canvas, capture and forward operator input, show the
awaiting_human banner + audible alert with Resume/Cancel + countdown, and add the assist
toggle on New Run.
**Priority**: P0 · **Prompt**: [tasks/WP06-ui-liveview.md](tasks/WP06-ui-liveview.md)
**Independent test**: UI component/e2e — banner appears on `run-awaiting-human`; a canvas
click sends a mapped `lv:mouse`; Resume posts/sends control; toggle sets `assist` in spec.
**Requirements**: FR-001, FR-008, FR-009, FR-010, FR-011

- [ ] T027 `LiveView.tsx` canvas render + input capture (WP06)
- [ ] T028 `RunDetail.tsx` banner + sound + Resume/Cancel + countdown (WP06)
- [ ] T029 `ui/ws.ts` outbound `lv:*` + handle events + reconnect re-attach (WP06)
- [ ] T030 `NewRun.tsx` assist toggle (WP06)
- [ ] T031 UI component/e2e wiring (WP06)

**Dependencies**: WP01, WP05.

---

## Phase 4 — Edges & verification

### WP07 — Edges: CLI/MCP `--assist` + fallback + e2e fake-challenge

**Goal**: Expose `assist` at the CLI and MCP entry points with graceful fallback in
non-interactive contexts, and prove the whole lifecycle with a deterministic local
fake-challenge e2e, plus an assist-off regression assertion.
**Priority**: P1 · **Prompt**: [tasks/WP07-edges-and-e2e.md](tasks/WP07-edges-and-e2e.md)
**Independent test**: e2e green against the local fake-challenge fixture; MCP/headless with
assist on logs the fallback and fails gracefully; assist-off run behaves as today.
**Requirements**: FR-001, FR-002, FR-017

- [ ] T032 `cli.ts` `--assist` + server-reachability fallback (WP07)
- [ ] T033 `mcp/index.ts` assist arg + non-interactive fallback (WP07)
- [ ] T034 local fake-challenge page fixture (WP07)
- [ ] T035 e2e detect→pause→stream→input→auto-resume + non-blocking + timeout (WP07)
- [ ] T036 assist-off regression assertion (WP07)

**Dependencies**: WP03, WP04, WP05, WP06.

---

## Execution notes

- **MVP**: WP01 (foundation). **Usable vertical slice**: WP01→WP03→WP04→WP05→WP06.
- **Parallelism**: WP01 ∥ WP02; after WP04, WP05 proceeds while WP06 waits on WP05's
  protocol; WP07 last.
- **Charter gate (C-001)**: no WP may add code that _solves_ a challenge. Reviewers reject
  any auto-answer logic. Live view forwards human input only.
- Lane allocation and per-WP workspace come from `lanes.json` after `finalize-tasks`.
