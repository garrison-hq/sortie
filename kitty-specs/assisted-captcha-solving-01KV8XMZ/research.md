# Phase 0 Research: Assisted CAPTCHA Solving

Resolves the open technical decisions implied by the spec so Phase 1 design and
`/spec-kitty.tasks` have firm ground. Each item: Decision → Rationale → Alternatives
rejected.

## R1 — Live interactive view transport

**Decision**: Stream the paused page with Chrome DevTools Protocol `Page.startScreencast`
(JPEG/PNG frames) over the existing Fastify WebSocket to a `<canvas>` in the UI; forward
operator input back with CDP `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` /
`Input.dispatchTouchEvent`. Obtain the CDP session from Playwright via
`context.newCDPSession(page)`. Ack each screencast frame with `Page.screencastFrameAck`.

**Rationale**: CDP screencast + input is built into the Chromium that Playwright already
drives — no new dependency, works headless on the remote Docker host, and gives true
interactivity (the human operates the real page, satisfying C-001: software never solves
it). Frames are already how the existing live view thinks (screenshots); this upgrades the
same channel from periodic stills to a streamed+interactive view.

**Alternatives rejected**:

- _Static screenshot + "click to solve"_ — cannot actually solve an interactive challenge;
  the page must receive real input events.
- _VNC/noVNC sidecar_ — heavyweight, new infra, exposes the whole desktop not just the run's
  page; violates C-003 scoping.
- _Local headed browser window_ — explicitly out of scope (remote host has no display).

## R2 — Pausing the agent without blocking the queue

**Decision**: On challenge detection the agent loop returns a non-terminal outcome
(`awaiting_human`) carrying the paused step index. `runtime/queue.ts` moves the run into a
`pausedRuns` map (keyed by runId, holding the live browser context/page + a timeout
deadline) and **does not requeue or hold the worker** — `pump()` immediately continues with
other eligible runs. The browser context for the paused run is **kept alive** (tearing it
down would lose the challenge/session state). Resume re-enters the loop at the paused step
using the same page.

**Rationale**: Satisfies FR-016 (non-blocking) and the "keep running other runs" decision
while preserving the live page the human must interact with. A paused run consumes a live
browser context but not a queue-worker turn.

**Alternatives rejected**:

- _Block the worker until solved_ — one CAPTCHA stalls the queue (rejected by user).
- _Tear down + rebuild browser on resume_ — loses challenge state and any partial solve;
  defeats cookie banking.
- _Persist + cold-resume across process restart_ — out of scope for v1; a live page can't
  survive a server restart. Document that a restart while `awaiting_human` fails the run.

**Resource guard**: add a configurable cap on concurrent `awaiting_human` runs (default = a
small N, e.g. 3) so paused live contexts can't exhaust memory; exceeding the cap when a new
challenge fires degrades to graceful-fail with a clear reason.

## R3 — Auto-resume detection

**Decision**: While paused, poll the page on an interval (e.g. 1–2s) with the shared
`detectChallenge()` against the current DOM/URL/status; when it reports clear for one stable
check, auto-resume. Also accept an explicit operator **Resume** (covers false-positives and
detector blind spots) and **Cancel**. Navigation/`framenavigated` events can short-circuit
the poll to re-check promptly.

**Rationale**: The same detector that paused the run decides when it's clear — one source of
truth. Manual Resume guarantees the human is never trapped by a detector miss.

**Alternatives rejected**: relying solely on auto-detection (false-negatives trap the run);
relying solely on manual Resume (worse UX, defeats "auto-resume" in FR-011).

## R4 — Input coordinate mapping

**Decision**: The screencast frame carries device metadata (`Page.screencastFrame` includes
`metadata` with `deviceWidth/deviceHeight/offsetTop/pageScaleFactor`). The UI canvas reports
its rendered size; map client (canvas) coords → page coords with the canvas/device scale
ratio before sending. Server applies CDP input in page coordinates. Keep the page viewport
fixed (existing `DEFAULT_VIEWPORT` 1280×900) to simplify the transform.

**Rationale**: Deterministic, no guesswork; CDP input expects CSS/page pixels.

**Alternatives rejected**: assuming 1:1 canvas/page (breaks on HiDPI / responsive canvas).

## R5 — Challenge detection (shared module)

**Decision**: Extract the existing search-challenge logic (`search/engines.ts`:
`CHALLENGE_MARKERS`, HTTP 403/429/202 checks, `SearchChallengeError`) into
`packages/core/src/challenge/detect.ts` exporting a pure
`detectChallenge({ status, title, bodyText, url, frames }) → { detected, family, signal } |
null` plus a page-aware `detectChallengeOnPage(page, snapshot)`. Cover families: reCAPTCHA
(`iframe[src*="recaptcha"]`, `grecaptcha`), hCaptcha (`iframe[src*="hcaptcha"]`), Cloudflare
Turnstile/interstitial (`challenges.cloudflare.com`, `cf-chl`, "Checking your browser"),
generic markers ("verify you are human", "are you a robot", "unusual traffic"), and HTTP
403/429. `search/engines.ts` is refactored to call the shared detector (behavior-preserving;
its existing tests must stay green).

**Rationale**: One detector, two callers (search chain + agent loop) → FR-006, NFR-003,
DRY, fixture-testable.

**Alternatives rejected**: duplicating markers in the loop (drift, two test suites).

## R6 — Fingerprint hygiene (avoidance, not evasion — C-002)

**Decision**: When `assist` is on, create the Playwright context with: a realistic desktop
Chrome `userAgent`, `locale`, `timezoneId`, `viewport`, `--disable-blink-features=
AutomationControlled` launch arg, and an init script masking `navigator.webdriver`. Prefer
the run's authenticated profile/storage-state and reuse session cookies. Add modest,
bounded inter-action delays (humanized pacing).

**Rationale**: These make automation stop looking _broken/headless_; they do not defeat any
specific challenge (C-002). Most real-world friction drops simply by not advertising
automation and by reusing a logged-in session + banked clearance cookie (NFR-005).

**Alternatives rejected**: stealth plugins / fingerprint spoofing toolkits (cross into
evasion, charter-prohibited, brittle, dependency risk).

## R7 — Cookie banking

**Decision**: After a solve (auto- or manual-resume) and before continuing, if the run uses
a profile, persist `page.context().storageState()` back to the profile path via a new
`bankAssistSolve()` that reuses the existing `persistProfileState()` (0600, on-disk, never
DB/API). Stamp profile metadata `lastUsedAt`/optional `lastAssistedAt`.

**Rationale**: Captures the clearance cookie (e.g. `cf_clearance`) so later runs skip the
challenge (SC-003, NFR-005), reusing all existing profile storage guarantees.

**Alternatives rejected**: banking into the DB (violates profile storage rules); not banking
(challenge re-fires every run, defeats the payoff).

## R8 — Non-interactive fallback

**Decision**: `assist` only activates the human path when a live-view-capable server (API +
WS) is serving the run. In MCP/stdio and headless/non-interactive CLI, detection still
fires but, with no human reachable, the run gracefully fails with a clear reason naming the
challenge family and the profile to refresh (today's behavior). The CLI/MCP detect server
reachability (or an explicit `--assist` + interactive flag) and downgrade with a logged
warning.

**Rationale**: FR-017; never hang a headless run waiting for a human who can't arrive.

## R9 — WS authentication / control scoping

**Decision**: The live-view input/control channel is accepted only on the authenticated UI
WebSocket connection and only for a run currently in `awaiting_human`; messages are
zod-validated, bound to `{ runId }`, and rejected otherwise. Today the API is unauthenticated
(local-first trust model) — this plan keeps that trust model but **documents** that enabling
assist on an exposed deployment requires the existing/forthcoming auth in front of the
server. Navigation via forwarded input is constrained to the run's current origin.

**Rationale**: Matches the spec threat model (C-003/C-004) within the project's local-first
assumption; makes the deployment caveat explicit rather than silent.

**Alternatives rejected**: adding a full auth system now (out of scope); ignoring the risk
(unacceptable for a remote-control surface).

## R10 — e2e test challenge page

**Decision**: For deterministic CI, serve a **local fake-challenge page** (static HTML whose
markers match `detectChallenge`, with a button that "clears" the challenge by mutating the
DOM/navigating) to exercise detect → pause → stream → input → auto-resume without a real
CAPTCHA. Live avoidance hygiene is verified separately/manually against a public Turnstile or
reCAPTCHA demo (not in CI — third-party pages are flaky and rate-limited).

**Rationale**: Real CAPTCHAs are non-deterministic and provider-policy-sensitive; a local
fixture makes the lifecycle CI-stable while charter live-verification still happens manually.

**Alternatives rejected**: driving a real CAPTCHA in CI (flaky, against provider terms,
can't be auto-solved by design).
