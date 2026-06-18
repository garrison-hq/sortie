# Adversarial Final Review — assisted-captcha-solving-01KV8XMZ

Reviewer role: independent, skeptical "try to break it" pass over the full feature diff
(`git diff 1e7e714..HEAD -- packages/core/src apps/server/src apps/ui/src apps/mcp/src`),
HEAD = `e57a812`. Prior gates: per-WP reviews + mission review (PASS WITH NOTES, 3
findings remediated). This pass scrutinizes the newest commit (`e57a812`: hygiene
wiring, auto-resume watcher, `awaiting_human` in RUN_STATUSES) hardest.

## Verdict: SHIP WITH FOLLOW-UPS

No CRITICAL issues. No security holes. C-001 holds. The auto-resume watcher is
race-safe and leak-free on every terminal path I could construct. Two real MEDIUM
correctness/spec issues and a few LOW/NIT observations are documented below; none
block a local-first single-operator ship, but F-1 and F-2 should be fixed soon
because they affect non-UI embedders and the "assist-off is identical to today"
guarantee.

---

## Validation results (all run, all green)

| Check                | Command                                                                           | Result                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Build                | `pnpm build`                                                                      | PASS (core → ui → server → mcp)                                                                                       |
| Typecheck            | `pnpm -r typecheck`                                                               | PASS (5 projects)                                                                                                     |
| Lint                 | `pnpm lint`                                                                       | PASS (eslint, 0 findings)                                                                                             |
| Core tests           | `cd packages/core && pnpm test`                                                   | PASS — **256 passed** (19 files)                                                                                      |
| Server tests         | `cd apps/server && pnpm test`                                                     | PASS — **58 passed** (2 files)                                                                                        |
| Assist e2e (keyless) | `cd apps/ui && ANTHROPIC_API_KEY="" pnpm exec playwright test e2e/assist.spec.ts` | PASS — **5 passed** (45.9s) incl. auto-resume, non-blocking, 31.7s timeout→captcha_unsolved, assist-off graceful-fail |

---

## Findings

### F-1 (MEDIUM) — Fingerprint-hygiene launch arg leaks across the shared browser (breaks "assist-off byte-identical")

- **File:** `packages/core/src/browser/manager.ts:38-54` (`launch`), called from `newPage:67`; queue shares one `BrowserManager` (`packages/core/src/runtime/queue.ts:268`).
- **Trigger:** The queue uses a single, lazily-launched `BrowserManager` for ALL runs. `launch()` short-circuits on `this.browser?.isConnected()` and applies `--disable-blink-features=AutomationControlled` **only at first launch, process-wide**. Per-context hygiene (UA/locale/timezone/webdriver mask) is correctly per-`newContext` and does NOT leak. The launch ARG does.
- **Why it's real:**
  - If an **assist** run launches the browser first, every later **non-assist** run inherits `--disable-blink-features=AutomationControlled`. That contradicts the spec's FR-002 / AS-1 / SC-002 promise that assist-off behavior is "byte-identical to today" — a non-assist run can now silently carry an automation-masking flag it would never have had.
  - Conversely, if a non-assist run launches first, a later assist run does NOT get the launch arg (it only gets per-context hygiene), so FR-003 hygiene is partially applied and non-deterministic depending on run ordering.
  - Untested: there is no `manager.test.ts` covering launch-arg sharing; the behavior is invisible to the suite.
- **Suggested direction:** Either (a) make the launch arg always-on (it is a benign, honest flag and the spec already permits hygiene; this removes the ordering dependence), or (b) give assist runs their own `BrowserManager`/browser process so launch args are scoped, or (c) move the de-automation entirely to per-context init scripts and drop the launch arg. Document whichever is chosen.

### F-2 (MEDIUM) — `assist:true` in a CLI batch spec file hangs `sortie batch` for the full solve window (FR-017 fallback bypassed)

- **File:** `packages/core/src/cli.ts:1027-1035` (`runBatchCommand`), `validateSpec:820-865`, `loadSpecsFile:925`.
- **Trigger:** The CLI `agent` command hard-sets `assistEnabled=false` and the CLI batch path coerces `assist:false` **only when the `--assist` flag is passed** (`...(values.assist ? { assist: false } : {})`). A spec FILE line that contains `"assist": true` (and no `--assist` flag) is cast `as RunSpec` and submitted unchanged. `validateSpec` never inspects `assist`.
- **Why it's real (reproduced):** I drove a real in-process `createRunQueue` (no live-view server) with `{ assist:true, assistSolveTimeoutMs:30000 }` and a challenge-positive page. `drain()` did NOT resolve — the run sat in `awaiting_human` past a 5s race deadline (confirmed status `awaiting_human`). In production the CLI batch would block until the per-run solve timeout fires (default **10 minutes**, up to 60 min), then fail with `captcha_unsolved`. The spec's FR-017 says a non-interactive CLI must "fall back to the graceful-fail behavior" — here it stalls for up to 10 min and shows an unresolvable `awaiting_human` status no one can clear.
- **Generalization:** The queue itself has no concept of "no live view available" — it pauses any `assist:true` run regardless of whether a UI client can ever attach. MCP and the CLI flag path guard this by forcing `assist:false`; the spec-file path is the one hole. Any programmatic embedder of the queue with `assist:true` and no UI hits the same stall.
- **Suggested direction:** Coerce `assist` to `false` in `runBatchCommand` unconditionally (the CLI has no live view), independent of the `--assist` flag — i.e. drop the `values.assist ?` guard so spec-file `assist:true` is also neutralized. Optionally add `validateSpec` coercion/warning.

### F-3 (LOW) — `lv:stopped { reason: 'timeout' }` is declared but never emitted; timeout leaves the live view to be torn down only via `run-finished`

- **File:** `apps/server/src/liveview.ts` (no `reason:'timeout'` sender), `apps/server/src/ws.ts:35-39` (server-level `stopSessionForRun` on `run-finished`), schema `LvStoppedSchema` (`packages/core/src/contracts.ts`).
- **Trigger:** On solve-timeout, `expirePausedRun` emits `run-finished`; the server listener calls `stopSessionForRun` (detaches CDP) but sends NO `lv:stopped`. The `'timeout'` enum member of `LvStoppedSchema` is dead.
- **Why it's real but low:** The UI still closes the live view because `RunDetail` dismisses on the `run-finished` RunEvent (`apps/ui/src/views/RunDetail.tsx:290`). So functionally the operator's view closes; only the explicit, typed `lv:stopped{timeout}` signal is missing. No correctness impact; a minor protocol/UX inconsistency.
- **Suggested direction:** Either emit `lv:stopped{reason:'timeout'}` from the timeout teardown path, or drop the unused enum member.

### F-4 (LOW) — Concurrent in-flight detections during auto-resume polling

- **File:** `packages/core/src/runtime/queue.ts:532-557` (`autoResumeRun`).
- **Trigger:** The poll interval fires every 1500ms and does NOT pause while `detectChallengeOnPage` (async, does two `page.evaluate` round-trips) is in flight. On a slow page, multiple detections stack concurrently on the same page.
- **Why it's real but low:** No correctness bug — `autoResumeResolved` guards via synchronous `pausedRuns.get` + `delete`, so only the first "cleared" result wins; the rest no-op. It is merely wasteful CDP/eval traffic. Acceptable.
- **Suggested direction (optional):** Add an in-flight guard so a tick is skipped while the previous detection is pending.

### NIT — Misleading comment in `manager.ts` / hygiene scope

`newPage` comment claims hygiene "context is created with a realistic UA..." which is correct, but the launch-arg leak (F-1) is not noted. The `liveview.ts:140` comment "origin guard will block all input when origin is empty" is slightly inaccurate — input is not per-event origin-checked; an empty `attachedOrigin` instead causes the FIRST real navigation to tear the session down. The security outcome is fine; the comment overstates the mechanism.

---

## Targeted attack-surface assessments

### Auto-resume watcher race / leak (highest scrutiny) — CLEAN

- **Double-resume (auto + manual):** Both `resume()` (`queue.ts:846`) and `autoResumeResolved` (`564`) synchronously `pausedRuns.delete(runId)` and guard on `pausedRuns.get/has` before doing anything async. The poll's `.then` re-checks `pausedRuns.has(runId)` after the async detect (`548`). JS single-threading + synchronous delete means exactly one resolver wins. No double `run-resumed`, no double banking. Verified.
- **Auto-resume after timeout/cancel:** `autoResumeRun` re-checks `pausedRuns.has` both before (`534`) and after (`548`) the async detect; `expirePausedRun`/`cancel` delete synchronously and `clearTimeout`/`stopPollInterval`. A tick already past its guard cannot resurrect a finalized run. The e2e `M1-poll-cleared-on-timeout` test asserts zero auto-resume after timeout (`queue.test.ts:1235`). Verified.
- **Interval leak:** `stopPollInterval` is called on every terminal path — manual resume (`851`), auto-resume (`568`), timeout (`617`), cancel (`811`), and shutdown (via `expirePausedRun`, `928-930`). No early-return path reaches a terminal state without it. Verified.
- **Closed-page during poll:** `detectChallengeOnPage` runs `page.evaluate`; if the context was closed between ticks it throws and is swallowed by `.catch(()=>{})` (`554`) — and the post-detect guard prevents acting on a deleted run. No throw escapes to crash the queue. Verified. NOTE: a closed/blank page makes `detectChallengeOnPage` return `null` ("cleared"), which would auto-resume — but by then the run is already out of `pausedRuns`, so the guard neutralizes it.
- **Slot accounting (WP04 bug class):** Auto-resume mirrors manual resume exactly — `active++` in the post-banking `.finally` (`603`) matched by the `active--` in `pump().finally` (`381`) when the resumed `runItem` settles. Timeout/cancel also `active++` before `wakeResolve` (`646`, `835`) with explanatory comments and the `T-reg`/Bug-1 regression tests (`queue.test.ts:715`). Net effect is zero on every path. Verified.

### C-001 (no automated solving) — CONFIRMED

Full-codebase grep for `solve|2captcha|anticaptcha|vision|ocr|recognize|answer.*challenge|click.*checkbox` across `packages/core/src apps/server/src apps/mcp/src` (excluding detection/timeout/banking/human-relay identifiers) returns nothing. The auto-resume watcher only calls `detectChallengeOnPage` (re-detect), never any solver. `liveview.ts` only relays human mouse/key input via CDP. The agent loop has no vision/solve path. Detection module header and all relay code reaffirm C-001. Demonstrably clean.

### Remote-control security — CLEAN (re-verified on merged code)

- Input gated to `awaiting_human` + owned conn: `dispatchMouse`/`dispatchKey` call `isActiveSession` (conn owns this runId, `liveview.ts:457`) AND `isRunAwaitingHuman` (store status re-read at dispatch, `477`). The store re-check sits BEFORE the async banking in both resume paths (`autoResumeResolved` sets status `running` synchronously at `572` before banking), so in-flight input after resume is dropped.
- Origin guard: `Page.enable` is now sent (`169`) before subscribing to `Page.frameNavigated` (`180`); top-frame navigation off `attachedOrigin` tears the session down. Empty origin → first real navigation triggers teardown. Sound.
- Teardown on all finish paths: server-level `queue.onEvent` listener (`ws.ts:35`) calls `stopSessionForRun` on `run-finished` AND `run-resumed`, covering timeout/auto-resume/non-WS HTTP paths; per-conn `socket.on('close')` tears down on disconnect; `lv:resume`/`lv:cancel` tear down before handing control back.
- No frame logging: `dataB64` is forwarded raw and never logged (`sendFrame:285` comment + verified no log of frame bytes).
- Banking 0600 / never-DB: `persistProfileState` chmods dir 0700 + file 0600 (`profiles.ts:92-98`); `bankAssistSolve` writes only to disk + stamps metadata, never DB/API (`112-123`).
- SORTIE_HOST/PORT (C-005): no new hardcoded `localhost` bind introduced in server code.

### Concurrency / queue — CLEAN

Non-blocking pause holds (hook frees the slot with `active--` + `pump()` at `495-497`; `drain`/`settleWaiters` count `active + pausedRuns.size` so paused runs don't falsely satisfy drain). Cap (`maxConcurrentAwaitingHuman`, default 3) degrades extra challenged runs gracefully with context teardown (`704-720`). Timeout → `failed`+`captcha_unsolved` (`630-636`). Lazy/injected provider verified: server constructs `createRunQueue(store)` with no provider (lazy `createProvider` on first `chat`, preserving keyless pause); CLI `--provider` is injected and forwarded via `injectedProvider` (regression tests `T-reg-injected-provider`/`T-reg-no-inject`, `queue.test.ts:952/988`).

### General bug hunt

- Error paths: screenshot sink, banking, detection, CDP sends all `.catch`-swallow by design and are correctly scoped; none swallow a real run outcome. `runItem`'s `wasTerminated()` guard (`741`) prevents double-finish/re-queue of a timeout-finalized run.
- Contract parity: UI `types.ts` `RunEvent`/`LvClientMessage`/`AssistState` match server zod schemas in `contracts.ts`. `run-resumed.resolution` is `'solved'|'cancelled'` on both sides; `'timeout'` is an `AssistState.resolution` value surfaced via `run-finished`, not `run-resumed` — consistent.
- Coord mapping (`LiveView.mapCanvasToPage`): scales by deviceWidth/canvasWidth, subtracts `offsetTop`, divides by `pageScaleFactor`; rounds. No off-by-one found; server-side viewport bounds-check (`dispatchMouse:359`) clamps out-of-range.
- DB migration: additive `ALTER TABLE runs ADD COLUMN assist` wrapped in try/catch (`db.ts`), safe on re-open.

---

## Bottom line

The newest, riskiest code — the auto-resume watcher — is race-safe and leak-free; the
security posture for live remote control and cookie banking holds; C-001 is demonstrably
intact; and the entire validation matrix is green. Ship is gated only on two MEDIUM
follow-ups: the launch-arg leak (F-1, breaks the assist-off-identical guarantee and is
order-dependent) and the CLI/embedder spec-file `assist:true` stall (F-2, FR-017
fallback hole). Neither endangers a local-first single-operator deployment, but both
should be scheduled before the feature is relied on by non-UI consumers.

**Verdict: SHIP WITH FOLLOW-UPS** (fix F-1 and F-2 next).
