---
affected_files: []
cycle_number: 2
mission_slug: assisted-captcha-solving-01KV8XMZ
reproduction_command:
reviewed_at: '2026-06-16T21:09:33Z'
reviewer_agent: unknown
verdict: rejected
wp_id: WP04
---

# WP04 Review — Cycle 1: CHANGES REQUESTED

Solid work overall: the non-blocking pause (FR-016), resume, cookie banking, and store
persistence are correct, and assist-off runs are unchanged. Typecheck, lint, and the 248-test
suite are all green. However, the **timeout path has two real bugs** that the timeout unit
test does not catch because it uses a mock executor that diverges from the real agent loop.
Both must be fixed before approval.

---

## Issue 1 (BLOCKING) — `expirePausedRun` underflows the worker-slot counter (`active`)

**File**: `packages/core/src/runtime/queue.ts`
**Location**: `expirePausedRun()` (~lines 405-435), compare with `resume()` (~line 717).

### The bug

The pause hook frees the worker slot with `active--` (line ~470) and then `await`s a wake
signal. Two paths wake it:

- **resume()** compensates: it does `active++` (line ~717) _before_ `wakeResolve()`, so when
  the hook returns and the run finally settles, pump's `.finally(() => active--)` (line 363)
  brings the net change back to 0. Correct.
- **expirePausedRun()** does **not** do the compensating `active++`. It calls `wakeResolve()`,
  the hook returns, the `runItem` promise that pump is awaiting settles, and pump's
  `.finally` runs `active--` anyway. Net effect: **`active` drops by 1 on every timeout**
  (and on every shutdown-expire, since `shutdown()` loops `expirePausedRun` over all paused
  runs).

### Impact

`active` underflows below 0, so `pump()`'s `while (active < concurrency)` admits more workers
than `concurrency` allows. Each solve-timeout permanently raises effective concurrency by 1 —
the concurrency cap silently degrades over the life of the process.

### Proof (reproduced locally)

A throwaway probe submitting one assist run that times out (concurrency=1), then four normal
runs, measured peak concurrent in-flight = **2** (expected 1). After the fix it must be 1.

### Fix

In `expirePausedRun`, add the same slot re-accounting `resume` performs so the subsequent
pump `.finally` nets to zero. Concretely: increment `active` before resolving the wake signal
(mirroring `resume()`), OR restructure so the hook's `active--` and the eventual `.finally`
`active--` aren't both charged against a single pump `active++`. Whatever the shape, the
invariant to restore is: **one pump `active++` is matched by exactly one net `active--` across
the pause→{resume|timeout} lifecycle.**

### Test gap to close (T020 timeout test)

The current test (`T020-timeout`) asserts only `status`, `failureReason`, `assist.resolution`,
and that `run-finished` fired — none of which observe `active`. Add an assertion that the
queue's effective concurrency is still respected _after_ a timeout (e.g. submit N normal runs
at `concurrency: 1` post-timeout and assert peak in-flight === 1), so this class of bug can't
regress.

---

## Issue 2 (BLOCKING) — Timeout against the REAL agent loop re-runs a page on a closed

context, throwing into `runItem`'s catch and re-queuing an already-failed run

**Files**:

- `packages/core/src/runtime/queue.ts` — `expirePausedRun()` closes the context (~line 421:
  `paused.context.close()`), then resolves the hook's wake signal.
- `packages/core/src/agent/loop.ts` — `handleChallengeStep()` lines 299-300.

### The bug

In the **real** loop (not the mock used by T020), after `onAwaitingHuman` resolves,
`handleChallengeStep` does NOT immediately return `awaiting_human`. It re-detects on the live
page:

```
299:  const recheckSnapshot = await distillPage(page).catch(() => snapshot);
300:  const recheck = await detectChallengeOnPage(page, recheckSnapshot);
```

On the timeout path the queue has already `context.close()`d the page before waking the hook.
`distillPage` (line 299) is guarded by `.catch`, but `detectChallengeOnPage` (line 300) is
**not** — calling it against a closed page rejects. `runAgent` has no try/catch around the
loop body, so the rejection propagates out of `executeAgent` into `runItem`'s `catch`
(queue.ts ~line 605). There it is treated as an infrastructure error and, with retry budget
left, the run is **pushed back onto the queue** (`store.updateRun({status:'queued'}); queue.push(item)`)
even though `expirePausedRun` already finalized it as `failed`/`captcha_unsolved` and emitted
`run-finished`. Result: a finished run flips back to `queued`, re-executes, and double-emits
lifecycle events.

### Why the tests don't catch it

The T020 mock `exec` returns `{ status: 'awaiting_human' }` _unconditionally_ right after the
hook resolves — it never performs the post-resume re-detect that the real loop does, and its
mock page's `context.close()` never makes subsequent calls throw. So the mock exercises a
control flow the production loop does not have.

### Fix (pick one, prefer defense-in-depth)

- Make the timeout teardown cooperative with the loop: signal the loop that it was
  terminated (the `terminated` flag already exists on `PausedRun` but is only read by the
  _queue_ hook, not surfaced to the agent loop) so `handleChallengeStep` returns immediately
  without touching the page after a timeout wake; **and/or**
- Guard line 300 the same way line 299 is guarded, and have `handleChallengeStep` treat a
  closed/destroyed page as "terminated, stop" rather than throwing; **and/or**
- In `runItem`'s catch, do not requeue (and do not re-finish) a run that is no longer in a
  retriable state because it was already terminally resolved by the timeout path.
- Add a unit test that drives the **real** `handleChallengeStep`/`runAgent` (or a mock whose
  page throws after `context.close()`) through a timeout and asserts the run ends exactly once
  as `failed`/`captcha_unsolved` with no requeue and no second `run-finished`.

---

## Notes (non-blocking, no action required to pass)

- FR-016 non-blocking pause verified: hook does `active--; settleWaiters(); pump()` then
  suspends; the `T020-FR016` test (and an independent probe) confirm a second run completes
  while one is `awaiting_human`. The pause side of slot accounting is correct.
- Banking security verified: `bankAssistSolve` reuses `persistProfileState` (0600) and only
  stamps metadata via `store.touchProfile`; no cookie data reaches the DB or any event/API
  payload. `run-resumed` carries only `resolution`/`solveSource`.
- Context lifecycle on the **happy paths** is correct: paused context kept alive
  (`pausing` flag skips teardown in `executeAgent`); resume banks then continues on the same
  page and `executeAgent`'s `finally` closes it on terminal return; shutdown expires all
  paused runs. The leak/double-handling risk is specifically the timeout path (Issues 1 & 2).
- C-001 respected: no challenge-answering logic anywhere.
- Store changes are additive (nullable `assist` column + idempotent `ALTER TABLE` migration).
- Out-of-scope edits: `contracts.ts`, `store/db.ts`, `store/store.ts`, `profiles.ts` are all
  within WP04's owned/adjacent set — no creep.

Both blocking issues are localized to the timeout/expire path; the rest of the WP is sound.
After fixing, please also harden the two test gaps noted above so the timeout path is actually
exercised end-to-end (slot accounting + real-loop closed-page behavior).
