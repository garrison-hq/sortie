# WP05 Review — Cycle 2 (file: review-cycle-4) — CHANGES REQUESTED

Reviewer: claude:opus:reviewer. Re-review of the fix commit `e10724c` on top of `16932d2`.

**Summary:** Two of the three cycle-1 security gaps (Finding 2: input status-gate; Finding 3:
session teardown on finish/timeout/resume) are genuinely fixed and genuinely tested. Validation
is green (server typecheck clean, server 56 tests, core 250 tests, root lint clean — matches the
implementer's report). All prior PASS items still hold (C-001 relay-only, C-005 host binding via
`SORTIE_HOST`/`SORTIE_PORT` default `0.0.0.0`, no frame-byte logging, backpressure drop-to-latest,
resume/cancel endpoints, no scope creep). The trivially-green `GET /api/health` placeholder
(`describe('WebSocket inbound message routing')`) was correctly removed.

**However, Finding 1 (navigation-to-origin constraint) is NOT genuinely closed.** The guard is
registered but is _inert at runtime_ against a real Playwright CDP session, and the new test gives
false confidence because it bypasses CDP delivery. This is blocking: the contract claims the
origin constraint is _enforced_, and right now it is not.

---

## Blocking issue

### Issue 1 (SECURITY — Finding 1 origin constraint is dead code at runtime): `Page.frameNavigated` is never delivered to the live-view CDP session because `Page.enable` is never sent on it

`apps/server/src/liveview.ts:167` registers `cdpSession.on('Page.frameNavigated', …)` on the
session returned by `queue.cdpSessionForRun(runId)`, which is
`packages/core/src/browser/manager.ts:97` → `page.context().newCDPSession(page)`.

In the Chromium DevTools Protocol, **Page-domain lifecycle events such as `Page.frameNavigated`
are delivered only to a CDP session that has itself called `Page.enable`.** Domain enablement is
per-session. Verified against the bundled playwright-core:

- `newCDPSession(page)` does `rootSession.attachToTarget(targetId)` — it returns a **fresh,
  separate** flat session with a new sessionId (`crBrowser.js:503-517`,
  `crConnection.js:181`). It does **not** enable any domain on that session.
- Playwright's own `Page.enable` calls are on its **internal** `_mainFrameSession._client`
  (`crPage.js:266,372,631`) — a _different_ session from the one handed to the live-view module.

Consequently the live-view session never has `Page` enabled, so Chromium will never emit
`Page.frameNavigated` to it. The origin-guard listener therefore **never fires in production**.
A forwarded click/keystroke that navigates the authenticated page to an arbitrary origin will
_not_ tear down the session — exactly the threat the constraint is supposed to mitigate, and
exactly what `contracts/live-view-protocol.md` claims is "enforced."

Note the asymmetry that hides this: `Page.screencastFrame` works without `Page.enable` because it
is a direct consequence of the `Page.startScreencast` command, not a gated lifecycle event. So the
screencast bridge functions live while the origin guard silently does not.

**Fix:** Send `Page.enable` on the live-view CDP session before registering the
`Page.frameNavigated` handler (e.g. `await cdpSession.send('Page.enable')` right after
`cdpSessionForRun` returns, before / alongside `Page.startScreencast`). Then add an
**integration-level** assertion that the handler is actually wired to CDP delivery — e.g. assert
the session sent `Page.enable`, or (better) verify against a live page
(the-internet.herokuapp.com / a same-site→cross-site link) that a real cross-origin navigation
tears the session down. A live-page check is the project's stated verification standard for
browser-automation features.

### Issue 2 (TESTS — Finding 1 test is trivially green; it does not guard the production path)

`liveview.test.ts` "navigating the top frame to a foreign origin tears down the session"
(lines 441-495) and "navigation within the same origin does NOT tear down the session"
(lines 497-551) both drive the guard via `cdp.emitEvent('Page.frameNavigated', …)`, which
**directly invokes the registered JS handler**. This passes regardless of whether the handler
would ever receive that event from a real CDP session — i.e. it would pass even though the
production guard is inert (Issue 1). The test exercises the comparison logic (top-frame filter,
scheme+host+port origin equality, teardown + `lv:stopped`), all of which are correct, but it does
**not** guard the claim that the constraint is enforced end-to-end.

**Fix:** Add an assertion that the session enables the Page domain
(`expect(cdp.send).toHaveBeenCalledWith('Page.enable')`) so the unit test fails if `Page.enable`
is dropped, and/or cover the real CDP delivery path in the WP07 e2e against a live navigation.

---

## What is correct (verified, no action needed)

- **Finding 2 (input status re-check):** `dispatchMouse`/`dispatchKey` (`liveview.ts:319-371`)
  now call `isRunAwaitingHuman(connId, runId)` on every dispatch, which re-reads
  `store.getRun(runId).status` via the `sessionStores` map (threaded in at attach,
  `liveview.ts:158`). The two status-flip tests (lines 279-352) drop input correctly and would
  fail against pre-fix code (pre-fix `dispatchMouse`/`dispatchKey` only called `isActiveSession`,
  which never reads status). The runId-mismatch test (356-389) and hijack test (393-433) also
  genuinely guard the `isActiveSession` mismatch branch and the second-attach rejection.
- **Finding 3 (teardown on finish/timeout/resume):** `ws.ts:35-39` registers a single
  server-level `queue.onEvent` listener (once, at route registration — not per-connection) that
  calls `stopSessionForRun` on `run-finished`/`run-resumed`. Confirmed against
  `packages/core/src/runtime/queue.ts`: timeout (`expirePausedRun`, line 517) emits
  `run-finished`; cancel-of-paused (line 706-707) emits both; manual + auto resume
  (`resume()`, line 755) emit `run-resumed`. So all teardown paths are covered.
  `stopSessionForRun` → `stopSession` stops the screencast, detaches the CDP session, and deletes
  the `sessions` + `sessionStores` entries (no dangling handler/map leak). The three teardown
  tests (lines 559-675) would all fail pre-fix (no server-level listener existed).

## Validation results

- `apps/server` typecheck: clean.
- `apps/server` test: 56 passed.
- `packages/core` test: 250 passed.
- root `pnpm lint`: clean.

## How to clear this cycle

Implement `Page.enable` on the live-view CDP session (Issue 1), strengthen the origin test to
guard the real delivery path (Issue 2), and verify cross-origin teardown against a live page.
Findings 2 and 3 are accepted as-is — do not regress them.
