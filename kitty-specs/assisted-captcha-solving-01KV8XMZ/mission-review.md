# Mission Review — Assisted CAPTCHA Solving (`assisted-captcha-solving-01KV8XMZ`)

**Reviewer**: senior post-merge mission reviewer
**Mission**: `assisted-captcha-solving-01KV8XMZ` (mission_number=1, 7/7 WPs done)
**Merged as**: squash commit `f042bca` on `feat/assisted-captcha-solving`
**Baseline**: `origin/main` @ `1e7e714`
**Diff reviewed**: `git diff 1e7e714..HEAD -- packages/core/src apps/server/src apps/ui/src apps/mcp/src`
**Reviewed at**: 2026-06-17

---

## Final Verdict: **PASS WITH NOTES**

The feature is functionally coherent, builds clean, and is fully green built-fresh
(typecheck, lint, core 252, server 57, keyless assist e2e 5/5). The defining charter
constraint **C-001 (no automated solving) is fully honored** and the interactive
remote-control security surface is well-defended (per-dispatch `awaiting_human`
re-check, origin navigation guard with `Page.enable`, single-session scoping,
server-level teardown on every finish path, 0600 cookie banking, no frame-byte logging,
no hardcoded localhost).

It does **not** rise to PASS because two accepted requirements are materially weaker
than the spec states and the merged code/comments imply they are complete:

- **FR-003 (fingerprint hygiene when assist on)** is implemented but **never wired into
  any live execution path** — effective dead code (HIGH).
- **FR-011 auto-resume-on-clear** is **not implemented** — only manual Resume/Cancel
  exists; the spec's primary-flow step 5 ("sortie detects the challenge has cleared and
  auto-resumes") is unmet, and the code's "auto-resume" naming is misleading (MEDIUM).

Neither is a release blocker for a local-first, opt-in, default-off feature: with assist
on, a human still solves via the live view and clicks Resume; hygiene's absence only
means challenges fire at the un-hardened baseline rate. But both are real gaps against
"Accepted" requirements and should be tracked.

### Findings by severity

| Severity | Count |
| -------- | ----- |
| CRITICAL | 0     |
| HIGH     | 1     |
| MEDIUM   | 3     |
| LOW      | 4     |

No CRITICAL or HIGH-security findings. The single HIGH is a functional/dead-code gap
(FR-003 not wired), not a security or correctness defect in the paths that do run.

---

## Build / Test / Lint reality (run built-fresh)

| Check                | Command                                                             | Result                               |
| -------------------- | ------------------------------------------------------------------- | ------------------------------------ |
| Build                | `pnpm build`                                                        | ✅ exit 0 (all packages)             |
| Typecheck            | `pnpm -r typecheck`                                                 | ✅ exit 0 (core/ui/mcp/server clean) |
| Lint                 | `pnpm lint`                                                         | ✅ exit 0 (eslint, no warnings)      |
| Core tests           | `cd packages/core && pnpm test`                                     | ✅ **252 passed** (19 files)         |
| Server tests         | `cd apps/server && pnpm test`                                       | ✅ **57 passed** (2 files)           |
| Assist e2e (keyless) | `ANTHROPIC_API_KEY="" pnpm exec playwright test e2e/assist.spec.ts` | ✅ **5 passed** (45.6s)              |

The e2e proves the real lifecycle end-to-end with **zero LLM calls**: detect→pause
(`awaiting_human`)→screencast frame→forwarded `lv:mouse`→manual resume, plus
non-blocking (T035b), timeout→`captcha_unsolved` (T035c, 31.7s), and assist-off
graceful-fail (T036).

---

## C-001 enforcement (highest-priority check) — **PASS**

Grepped the entire merged codebase (`packages`, `apps`, `*.ts`/`*.tsx`) for any
automated challenge-solving: `2captcha|anti-captcha|capmonster|deathbycaptcha`,
`grecaptcha.execute/getResponse`, `*.setResponse`, captcha tokens, vision/OCR/tesseract,
audio-challenge, automated checkbox clicks. **No solver code exists.**

Every match is one of: detection-only (`challenge/detect.ts` — explicit "ONLY detects …
never attempts to solve or bypass", `detect.ts:9`), the graceful-fail constant
(`FAILURE_REASON_CAPTCHA_UNSOLVED`, `contracts.ts:274`), the human-relay live view
("ONLY relays human input", `liveview.ts:14-15`; "only relays the human's input",
`LiveView.tsx:11`), or doc/UI copy.

The only "answer" to a challenge is a forwarded human `lv:mouse`/`lv:key` event mapped to
CDP `Input.dispatchMouseEvent`/`dispatchKeyEvent` (`liveview.ts:367, 394`). The agent
loop's "re-detect" after resume (`loop.ts:319-346`) only re-runs `detectChallengeOnPage`
to decide solved-vs-still-blocked; it never inspects or answers the challenge. The agent
system prompt still carries the charter line "Never attempt to bypass CAPTCHAs"
(`prompts.ts:62`). **C-001 result: clean.**

---

## Security review of the remote-control surface — **PASS**

| Threat-model control                         | Status | Evidence                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input gated to `awaiting_human`              | ✅     | `dispatchMouse`/`dispatchKey` call `isRunAwaitingHuman()` which **re-reads `store.getRun(runId).status` at dispatch time** — guards the timeout/auto-resume race, not just attach-time (`liveview.ts:355-356, 391-392, 477-491`). Two status-flip tests assert drop (`liveview.test.ts`).                                                                                              |
| Input scoped to owned connection             | ✅     | `isActiveSession` rejects when `session.runId !== msg.runId`; one session per `connId`; second attach replaces the first (`liveview.ts:112-113, 457-470`). Hijack test present.                                                                                                                                                                                                        |
| Origin-navigation constraint actually fires  | ✅     | `Page.enable` is sent on the fresh CDP session (`liveview.ts:169`) so `Page.frameNavigated` is actually delivered; top-frame nav to a different origin tears the session down (`liveview.ts:180-193`). Regression test asserts `Page.enable` was sent (`liveview.test.ts:462, 494`) — this was WP05 cycle-5 Issue 1, fix landed.                                                       |
| Live-view torn down on finish/timeout/resume | ✅     | Single server-level `queue.onEvent` listener (registered once, not per-conn) calls `stopSessionForRun` on `run-finished`/`run-resumed` (`ws.ts:35-39`). Queue emits `run-finished` on timeout (`queue.ts:525`) and cancel, `run-resumed` on resume (`queue.ts:767`). `stopSession` stops screencast + detaches CDP + clears both maps (`liveview.ts:303-313`). No CDP/screencast leak. |
| Banking 0600, never DB/API                   | ✅     | `bankAssistSolve` → `persistProfileState` (dir 0700, file 0600; `profiles.ts:92-98, 112-123`); only stamps `lastUsedAt` metadata via `touchProfile`. `run-resumed` carries only `resolution`/`solveSource` (`queue.ts:767-773`); profile state JSON never enters store or any API response.                                                                                            |
| No frame-byte logging                        | ✅     | `dataB64` is raw base64 from CDP, explicitly "never logged" (`liveview.ts:285`); frames not persisted beyond existing screenshot capture.                                                                                                                                                                                                                                              |
| No hardcoded localhost (C-005)               | ✅     | Server listens on `SORTIE_HOST:SORTIE_PORT`, default `0.0.0.0:3470` (`apps/server/src/index.ts:17, 65-66, 93`). No `localhost`/`127.0.0.1` literals in server source (only e2e harness).                                                                                                                                                                                               |
| Bidirectional WS input validation            | ✅     | Every inbound text frame is zod-validated against `LvClientMessageSchema` (discriminated union); non-text frames, malformed JSON, and schema-fails are dropped + logged, never thrown across the socket (`ws.ts:57-81`). Mouse coords validated against viewport before dispatch (`liveview.ts:359-365`).                                                                              |

**Auth caveat (documented, accepted):** the control channel inherits the server's
local-first **unauthenticated** trust model. R9 / spec Assumptions explicitly scope this
to a single trusted operator and require external auth for network-exposed deployments;
this is documented in code (`liveview.ts:22-24`, `ws.ts:20-21`, `routes.ts:148`) and is
in-scope-as-designed, not a defect.

---

## FR Coverage Matrix

| FR                                                                    | Verdict             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-001 opt-in `assist` (CLI/UI/run-spec, default off)                 | ADEQUATE            | `RunSpec.assist` zod default false (`contracts.ts:418`); UI toggle (`NewRun.tsx:168, 231, 385`); CLI `--assist` flag (`cli.ts`). _Caveat:_ CLI/MCP intentionally force `assistEnabled=false` (see FR-017). Run-spec + UI + server path is the live one and works (e2e).                                                                                                                                                                |
| FR-002 assist-off behavior unchanged                                  | ADEQUATE            | Detection is a deliberate no-op when off (`loop.ts:187`); T036 e2e asserts assist-off graceful-fail with no `awaiting_human`; full existing suite green unchanged.                                                                                                                                                                                                                                                                     |
| FR-003 fingerprint hygiene when assist on                             | **MISSING (wired)** | `hygiene.ts` + `manager.ts` `fingerprintHygiene` path are correct and unit-tested, but **no execution path ever sets `fingerprintHygiene: true`**. `executeAgent`/`executeExtract`/`executeFetch` call `newPage({ storageStatePath })` with no hygiene flag (`queue.ts:894, 951, 1022`); `runAgent`'s own launch never passes it either. `grep fingerprintHygiene` over src returns only `manager.ts`+`contracts.ts`. See Finding H-1. |
| FR-004 prefer/reuse persisted session                                 | ADEQUATE            | Profile → storage-state path resolution in queue (`queue.ts:270-282`, `resolveSessionState`); `newPage` loads `storageStatePath` (`manager.ts:69-74`). Independent of the hygiene gap.                                                                                                                                                                                                                                                 |
| FR-005 humanized pacing when assist on                                | ADEQUATE            | `humanizedDelay()` called between steps when assist on (`loop.ts:195-197`) and after a cleared challenge (`loop.ts:349`); `humanizedDelay` unit-tested with injectable rng (`hygiene.ts:62`).                                                                                                                                                                                                                                          |
| FR-006 detect recaptcha/hcaptcha/turnstile/cloudflare/generic/403-429 | ADEQUATE            | `detectChallenge` covers all families via HTTP→frame→content order (`detect.ts:73-124`); 25 fixture tests incl. each family (`detect.test.ts`).                                                                                                                                                                                                                                                                                        |
| FR-007 → `awaiting_human`, suspend actions                            | ADEQUATE            | Loop yields `awaiting_human` (`loop.ts:329-346`); queue persists status + frees slot (`queue.ts:457, 478`); store column + migration (`db.ts`, `store.ts`). e2e T035 asserts the transition.                                                                                                                                                                                                                                           |
| FR-008 stream live view while paused                                  | ADEQUATE            | CDP screencast bridge (`liveview.ts:202-232`), canvas render (`LiveView.tsx`); e2e asserts a real `lv:frame` arrives.                                                                                                                                                                                                                                                                                                                  |
| FR-009 capture operator mouse/keyboard → page                         | ADEQUATE            | `LiveView.tsx` captures mouse/key/wheel, maps coords, forwards `lv:*`; server maps to CDP input (`liveview.ts:353-405`).                                                                                                                                                                                                                                                                                                               |
| FR-010 in-UI banner + audible alert                                   | ADEQUATE            | `AwaitingBanner` `role="alert" aria-live="assertive"` + `playAlert` Web Audio + mute (`RunDetail.tsx:84-159`).                                                                                                                                                                                                                                                                                                                         |
| FR-011 auto-resume on clear + manual Resume/Cancel                    | **PARTIAL**         | Manual Resume/Cancel fully implemented (WS `lv:resume`/`lv:cancel` `liveview.ts:435-453`; HTTP `POST /resume` `routes.ts:149`; `DELETE` cancel `routes.ts:134`). **Auto-resume-on-clear is not implemented** — no watcher polls the paused page; the post-resume re-detect only runs _after_ a human triggers resume (`loop.ts:315-346`). See Finding M-1.                                                                             |
| FR-012 resume continues from paused step                              | ADEQUATE            | Same page kept alive (no rebuild); loop re-enters at the paused index after `wakeResolve` (`loop.ts:303-351`; `queue.ts:783`); e2e T035 round-trip.                                                                                                                                                                                                                                                                                    |
| FR-013 bank clearance cookies into profile                            | ADEQUATE            | `bankAssistSolve` on resume when a profile is set (`queue.ts:746-750`, `profiles.ts:112-123`); `lastUsedAt` stamped.                                                                                                                                                                                                                                                                                                                   |
| FR-014 configurable solve timeout (default 10m)                       | ADEQUATE            | `assistSolveTimeoutMs` (30k–3.6M, clamped); default `600_000` (`queue.ts:63, 431-435`); zod + server validate bounds (`contracts.ts:419`, `validate.ts:99-104`).                                                                                                                                                                                                                                                                       |
| FR-015 timeout → `captcha_unsolved`                                   | ADEQUATE            | `expirePausedRun` sets `failed` + `FAILURE_REASON_CAPTCHA_UNSOLVED` (`queue.ts:503-543`); e2e T035c asserts it (real 31.7s wait).                                                                                                                                                                                                                                                                                                      |
| FR-016 paused run does not block queue                                | ADEQUATE            | Hook does `active--; settleWaiters(); pump()` before suspending (`queue.ts:478-483`); cap `maxConcurrentAwaitingHuman` default 3 degrades gracefully (`queue.ts:423-427`); e2e T035b + queue unit tests.                                                                                                                                                                                                                               |
| FR-017 non-interactive (MCP/headless CLI) falls back gracefully       | ADEQUATE            | MCP forces `assistEnabled:false` + stderr warning + tool-schema note (`mcp/index.ts:411-457`); CLI forces false + `warnAssistUnavailableInCli` (`cli.ts`). No hang path.                                                                                                                                                                                                                                                               |
| FR-018 statuses/reasons in record + live events                       | ADEQUATE            | `awaiting_human`/`captcha_unsolved`/`assist` persisted (store) and surfaced via `run-awaiting-human`/`run-resumed`/`run-finished` events (`contracts.ts:538-562`; `ws.ts` passthrough; CLI formats them `cli.ts:995-998`).                                                                                                                                                                                                             |

---

## NFR Check

| NFR                                                 | Verdict                       | Notes                                                                                                                                                                                                                                 |
| --------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-001 frames ≤1s / input ≤500ms                   | ASSERTION-ONLY                | No latency test; backpressure drop-to-latest design (`liveview.ts:257-271`) is reasonable but unmeasured. Local-first, acceptable.                                                                                                    |
| NFR-002 detection ≤100ms/step                       | ASSERTION-ONLY                | Detector is two cheap `page.evaluate` calls + string scan; no perf assertion exists. Plausible but unverified.                                                                                                                        |
| NFR-003 ≥95% TP, ≤1 FP on fixtures                  | AUTOMATED-TESTED              | Genuine: per-family true-positive fixtures **plus** a clean-page false-positive set with an explicit "at most 1 false positive across the entire clean-page set" assertion (`detect.test.ts:29-145`). Real constraint, not synthetic. |
| NFR-004 zero idle-streaming bandwidth               | AUTOMATED-TESTED (structural) | Screencast only starts on `lv:attach` for an `awaiting_human` run and is torn down on every finish path (`ws.ts:35-39`, `liveview.ts:303-327`). Teardown tests present. No idle stream possible.                                      |
| NFR-005 100% banked-cookie reuse in validity window | ASSERTION-ONLY                | Banking writes storage state (`bankAssistSolve`) and `newPage` reloads it (`manager.ts:69-74`); no automated round-trip-reuse test against a live site (charter R6/R10 keeps that as manual live-verify). Mechanism present.          |

---

## Drift findings

- **D-1 (LOW)** — CLI `batch` stamps `assist: false` onto every spec when `--assist` is
  passed (`cli.ts` `patchedSpecs`), overriding any `assist:true` already in the specs
  file. Intentional (CLI has no live view) and documented, but it means a specs file's
  own `assist:true` is silently downgraded under `--assist`. Minor surprise; harmless
  given CLI cannot stream anyway.
- **D-2 (LOW)** — No scope creep toward evasion beyond C-002. Hygiene is limited to a
  realistic UA/locale/tz, `navigator.webdriver` mask, and the single
  `--disable-blink-features=AutomationControlled` arg (`hygiene.ts:42-51`), with an
  explicit "no stealth toolkit" comment. C-002 respected. (No drift — recorded as
  positive confirmation.)
- **D-3 (LOW)** — `search/engines.ts` refactor onto the shared detector preserves exact
  legacy reason strings via `detectionToReason` (`detect.ts:225-233`); existing search
  tests stay green. Clean consolidation, no behavior drift.

## Risk / dead-code findings

- **H-1 (HIGH) — FR-003 hygiene is dead code.** The entire `fingerprintHygiene`
  plumbing (`BrowserLaunchOptions.fingerprintHygiene`, `manager.ts` hygiene branch,
  `hygiene.ts` UA/locale/tz/webdriver-mask/launch-arg) is never enabled by any caller.
  Neither `runAgent` (`loop.ts:121-124`) nor the queue executors
  (`queue.ts:894/951/1022`) pass `fingerprintHygiene: true` — and nothing maps
  `assist`/`assistEnabled` → hygiene. `grep -rn fingerprintHygiene packages/core/src`
  returns matches **only inside `manager.ts` and `contracts.ts`**. Net effect: with
  assist on, the browser is **not** hardened, so the "reduce how often challenges fire"
  half of the feature (spec Summary item 1, FR-003) does not actually run. Unit tests
  pass because they exercise `manager.newPage({ fingerprintHygiene: true })` directly,
  masking the missing wiring. _Fix:_ thread `spec.assist` (and `runAgent`'s
  `assistEnabled`) into the `newPage`/`launch` calls. Non-blocking for an opt-in,
  default-off feature, but it is an Accepted FR that does nothing today.
- **M-1 (MEDIUM) — FR-011 auto-resume-on-clear not implemented; misleading naming.**
  There is no mechanism that watches the paused page and resumes when the challenge
  clears. `onAwaitingHuman` only resolves on explicit `resume()` (manual `lv:resume`/HTTP)
  or timeout; the loop's re-detect runs _after_ that manual signal (`loop.ts:315-346`).
  Spec primary-flow step 5 and AS-2 phrasing ("sortie detects the challenge has cleared
  and auto-resumes") are unmet — the operator must click Resume. The codebase repeatedly
  calls the manual-resume-then-re-detect path "auto-resume" (`loop.ts:18,90`;
  `ws.ts:32`; `liveview.ts:350`; e2e comment), which overstates what ships. The e2e does
  **not** assert auto-resume — it resolves on first frame and explicitly notes
  `run-resumed` "depends on button coordinates … which we do not assert"
  (`assist.spec.ts:138` block). _Fix or re-scope:_ either add a poll-on-clear watcher, or
  correct the spec/FR-011 wording and code comments to "manual Resume (+ post-resume
  re-detect)".
- **M-2 (MEDIUM) — `GET /api/runs?status=awaiting_human` not filterable.**
  `RUN_STATUSES` in `validate.ts:20-27` (used to validate the list-runs `status` query)
  omits `awaiting_human`, so a client cannot filter the run list to paused runs via the
  API, even though the status is a first-class `RunStatus` (`contracts.ts:372`) and the
  UI surfaces it. Partial FR-018 surfacing gap. _Fix:_ add `'awaiting_human'` to
  `RUN_STATUSES`.
- **M-3 (MEDIUM, fixed-verify) — lazy-provider change: both paths confirmed working.**
  WP07 cycles 1–3 churned on eager provider construction (keyless assist runs died
  before detection) and its regression (injected CLI `--provider`/`--model` dropped). The
  merged state is correct: `runAgent` resolves the provider lazily on first `chat()`
  (`loop.ts:100-106`); the queue forwards the **already-constructed** injected provider
  via `ctx.injectedProvider` (`queue.ts:140, 585, 969`) rather than `undefined`, so the
  CLI override survives while the keyless assist-pause path still defers `createProvider()`.
  Verified: keyless e2e 5/5 (assist pauses with no key); core suite green (injected-provider
  path covered). No residual defect — recorded as cleared.
- **R-4 (LOW) — loop's interim `AssistState` has `deadlineAt === pausedAt`.**
  `handleChallengeStep` builds an `AssistState` with `pausedAt: startedAt, deadlineAt:
startedAt` (`loop.ts:336-337`) only used when the challenge is still present _after_ the
  human attempt. The queue's hook computes the authoritative deadline and overwrites the
  persisted assist state (`queue.ts:436-457`), so the zero-window value never reaches the
  store on the live path. Harmless today; brittle if the loop's `assist` were ever
  surfaced directly. No action required.

## Silent-failure candidates (reviewed — all acceptable by design)

- `notifyStep` swallows observer errors (`loop.ts:500-507`) — by contract (live view must
  not kill the agent). OK.
- Screenshot sink swallows all capture errors (`queue.ts:195-198`) — best-effort by
  design. OK.
- `bankAssistSolve` failures are swallowed on resume (`queue.ts:752-755`) — banking must
  not abort a resume; the run still completes. OK, but note: a cookie-banking failure is
  invisible to the operator (no event/log), so FR-013 can silently no-op. LOW.
- `detectChallengeOnPage` `page.evaluate` failures fall back to empty inputs
  (`detect.ts:189-203`) — non-fatal by design; could under-detect on a crashed page. OK.
- Origin-guard when `attachedOrigin` is empty (CDP `getTargetInfo` failed) blocks **all**
  input (fail-closed) — correct posture (`liveview.ts:139-141, 186`).

---

## Cross-WP integration seams (verified)

- `contracts.ts` — additive only; existing shapes byte-identical (FR-002 preserved).
  zod schemas authoritative for RunSpec, AssistState, RunEvent, all `lv:*` messages (C-006).
- `queue.ts` / `loop.ts` — the pause handoff (loop `onAwaitingHuman` → queue hook →
  `wakeResolve` → loop re-detect) is the most intricate seam; slot accounting is balanced
  across pause (`active--`), timeout/cancel/resume (`active++`), and `.finally` (`active--`).
  The WP04 cycle-3 timeout/closed-page concern is handled: re-detect is `.catch`-guarded
  (`loop.ts:326-327`) and `runItem` checks `wasTerminated()` before requeue (`queue.ts:630`).
  Queue unit suite (560 lines) + e2e timeout test exercise this.
- `store/db.ts` + `store/store.ts` — additive `assist TEXT` column with idempotent
  `ALTER TABLE` migration (`db.ts:128-134`); JSON round-trip in `store.ts`.

---

## Non-blocking open items (recommended follow-ups)

1. **Wire FR-003 hygiene** into the agent/queue execution paths (H-1) or down-grade FR-003
   to "implemented, not enabled" with a tracked ticket.
2. **Reconcile FR-011 auto-resume** (M-1): implement a poll-on-clear watcher, or correct
   spec wording + the "auto-resume" comments to reflect manual-resume reality.
3. **Add `awaiting_human` to `RUN_STATUSES`** so the run list is filterable by it (M-2).
4. Surface banking failures (event/log) so a silent FR-013 no-op is observable (R-3/LOW).
5. Add latency micro-checks for NFR-001/002 if they ever become contractual, and a
   live banked-cookie-reuse verification for NFR-005 (currently manual per charter R6/R10).
