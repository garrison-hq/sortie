---
affected_files: []
cycle_number: 2
mission_slug: assisted-captcha-solving-01KV8XMZ
reproduction_command:
reviewed_at: '2026-06-16T21:39:21Z'
reviewer_agent: unknown
verdict: rejected
wp_id: WP05
---

# WP05 Review — Cycle 1 — CHANGES REQUESTED

Reviewer: claude:opus:reviewer. Build/typecheck/test/lint all pass (server typecheck clean,
server 48 tests, core 250 tests, root lint clean). The happy-path screencast bridge, resume/
cancel endpoints, backpressure (drop-to-latest), C-001 (relay-only), C-005 (no hardcoded
localhost; `0.0.0.0` default + `SORTIE_HOST`/`SORTIE_PORT`), and no-frame-byte-logging are all
correct. **However, three spec-mandated security mitigations from the Threat Model are
unimplemented, and the security tests do not actually guard the scoping claims.** This is a
live remote-control surface, so these are blocking.

---

## Blocking issues

### Issue 1 (SECURITY, T022 / spec Threat Model / research R9): navigation constraint to run origin is entirely absent

The spec Threat Model requires: _"constrain navigation initiated through the channel so it
cannot be repurposed to drive the browser to arbitrary origins."_ research.md R9 (line 145)
states _"Navigation via forwarded input is constrained to the run's current origin,"_ and
`contracts/live-view-protocol.md` claims it is _enforced_. T022 step 3 lists it as a required
step.

There is **no origin/navigation check anywhere** in `apps/server/src/liveview.ts` — not even a
TODO. `dispatchMouse`/`dispatchKey` forward input unconditionally (modulo viewport bounds).
A forwarded click on a link, or a forwarded key sequence into the address bar context, can
navigate the authenticated page to an arbitrary origin with no guard.

**Fix:** Implement an origin guard. Capture the run's origin at attach time (from the CDP
`Page.getNavigationHistory` / `Target.getTargetInfo` current URL, or pass it from the queue's
paused record) and store it on `LiveViewSession`. Subscribe to `Page.frameNavigated` (or
`Page.navigatedWithinDocument`) on the CDP session for the main frame; if a navigation leaves
the attached origin, abort it (`Page.stopLoading` + navigate back, or tear down the session
with `lv:stopped reason:'error'`). At minimum the constraint must be real and tested. If the
team decides full enforcement is deferred, that is a spec/contract change that must be
explicitly approved and the contract text updated to stop claiming "enforced" — it cannot be
silently dropped.

### Issue 2 (SECURITY, T025 / spec Threat Model): input is not re-checked against `awaiting_human` at dispatch time

The spec Threat Model requires: _"reject input unless that run is `awaiting_human`."_
`contracts/live-view-protocol.md` Validation rules: _"Input messages dropped unless run status
is `awaiting_human`."_ T025 step 2 requires input accepted _"only while `awaiting_human`."_

`liveview.ts` `dispatchMouse` (line ~250) and `dispatchKey` (line ~290) gate solely on
`isActiveSession()` (lines ~352–366), which checks only: session exists, not stopped, and
`session.runId === msg.runId`. **It never re-reads the run status.** There is no `store`
reference in the input path to do so. This is defense-in-depth the spec mandates, and it is
load-bearing because of Issue 3 (the session is not always torn down when the run leaves
`awaiting_human`).

**Fix:** Pass `store` into the dispatch path (or hold a `store` ref in the session) and drop
the input if `store.getRun(session.runId)?.status !== 'awaiting_human'`. Add a test asserting
rejection when status has flipped away from `awaiting_human`.

### Issue 3 (SECURITY / LIFECYCLE LEAK, T021 step 4): timeout path leaks the CDP screencast session

T021 step 4 requires stop+clear on _"stop/resume/cancel/timeout/disconnect."_ The teardown
seam `stopSessionForRun(runId)` is only called from:

- `routes.ts:140` (DELETE cancel) and `routes.ts:156` (HTTP resume), and
- `liveview.ts` `handleClientMessage` for `lv:resume`/`lv:cancel`/`lv:detach`/socket-close
  (via `stopSession`).

The **solve-timeout path is not covered.** `packages/core/src/runtime/queue.ts`
`expirePausedRun` (lines ~495–517) closes the browser context and emits `run-finished`, but the
queue (in `packages/core`) has no reference to the server's `liveview.ts` `sessions` map, and
**nothing in `apps/server` listens for `run-finished`/timeout to call `stopSessionForRun`.**
On timeout the live-view CDP session, its `Page.screencastFrame` handler, and the
`sessions` Map entry are left dangling against a now-closed context. Auto-resume via the
detector (queue `resume()` from inside the loop, not the HTTP/WS path) has the same gap.

**Fix:** Wire a server-side `queue.onEvent` listener in `ws.ts`/`app.ts` (or wherever the
queue is owned) that calls `stopSessionForRun(runId)` and sends `lv:stopped` with the correct
reason (`timeout`/`resumed`/`cancelled`/`error`) on `run-finished` and on `run-resumed`,
covering the timeout and auto-resume paths that bypass the HTTP/WS control surface. Add a test
that simulates a timeout/finish event and asserts the session is stopped and the CDP session
detached.

### Issue 4 (TESTS, T025/T026): security tests do not guard the scoping claims (trivially green)

T026 requires tests for: _"Input rejected when not awaiting_human / not owned"_ and _"frames
only while paused, stop on resume/cancel."_ The current `liveview.test.ts` covers resume
200/404/409, DELETE awaiting_human cancel, `stopSession` idempotency, and attach-guard when not
`awaiting_human` — all good. But the **scoping/security assertions are missing or hollow:**

- The only input-scoping tests (lines 207–234) assert no-op for an **orphan connection with no
  session at all**. There is **no test** for the actual scoping branch: a connection attached
  to run A sending input for run B (the `isActiveSession` runId-mismatch path at
  liveview.ts:357–364).
- **No test** that a second connection cannot hijack/seize a paused run already attached by a
  first connection (spec "Unauthorized takeover / connection hijack").
- **No test** that input is rejected once status leaves `awaiting_human` (because Issue 2's
  check doesn't exist).
- The `describe('WebSocket inbound message routing')` block (lines 276–290) is titled
  _"frames only while paused; stop on resume/cancel"_ but its sole test asserts
  `GET /api/health === 200`. That is a placeholder, not a guard of the claimed behavior. Frame
  emission gating and stop-on-resume/cancel are not actually exercised end-to-end.

**Fix:** Add real tests for: attach run A → input for run B rejected; second connId cannot
attach/control a run already owned (or that takeover is explicitly handled per the "resumable
disconnect" rule); input dropped after status flips off `awaiting_human`; frames stop after
resume/cancel and on timeout (covers Issue 3). Use the existing CDP/queue/store mocks; the
`emitFrame` helper already exists.

---

## Non-blocking notes (address if convenient)

- `attachSession` (liveview.ts ~108) hardcodes `viewport = { width: 1280, height: 900 }` with a
  comment "Read from CDP if available; fall back to 1280×900" — it never reads from CDP. This
  matches R4's "keep viewport fixed (DEFAULT_VIEWPORT 1280×900)" decision so it is acceptable,
  but the comment is misleading; either implement the read or simplify the comment to state the
  viewport is fixed per R4.
- `lv:resume`/`lv:cancel` WS handlers (liveview.ts ~334–349) accept `msg.runId` without checking
  it matches the connection's attached session. Under the local-first single-operator trust
  model this is acceptable (R9), and HTTP resume/cancel have the same exposure, but consider
  scoping these to the attached run for consistency with the input path, or document why control
  messages are intentionally not session-scoped.

## Out-of-scope edits — judged OK

`contracts.ts` (`cdpSessionForRun`), `index.ts` (lv schema/type exports), `queue.ts`
(`cdpSessionForRun` impl + cancel `pausedRuns` handling), and `app.ts` (pass `store` to
events route) are all minimal and necessary for WP05. No scope creep.
