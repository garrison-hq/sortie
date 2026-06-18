# Quickstart: Assisted CAPTCHA Solving

How to exercise the feature once implemented, and how to verify it per the charter.

## Enable assist mode

- **UI**: toggle **Assist (human-in-the-loop CAPTCHA)** on the New Run form.
- **CLI**: `node packages/core/dist/cli.js agent --assist --goal "..." --url "..."`
  (also `batch --assist`). Requires the sortie server running for the human path; without a
  reachable server it logs a warning and falls back to graceful-fail.
- **MCP**: pass `assist: true` to `run_agent`. Non-interactive stdio has no human path → it
  downgrades to graceful-fail (documented limitation).
- **API**: `POST /api/runs` with `{ spec: { ..., assist: true, assistSolveTimeoutMs? } }`.

## The assisted-solve loop (happy path)

1. Start an assisted run against a site that challenges (or the local fake-challenge fixture
   below).
2. When a challenge fires, the run flips to **`awaiting_human`**; the UI shows a banner +
   plays a sound and opens the **live view** of the run's page.
3. Solve the challenge directly in the live view (real mouse/keyboard, forwarded to the
   remote page). Other queued runs keep running meanwhile.
4. On clear, the run **auto-resumes** (or click **Resume**); clearance cookies are banked
   into the active profile. Use **Cancel** to abandon.
5. If unsolved within the timeout (default **10 min**), the run fails with
   `failureReason: captcha_unsolved`.

## Verify (per charter — live-page standard)

### Unit — detection (CI)

`pnpm --filter @garrison-hq/sortie-core test` — `challenge/detect.test.ts` asserts each
family (reCAPTCHA / hCaptcha / Turnstile / Cloudflare / generic markers / HTTP 403,429) on
fixtures (NFR-003) and asserts clean pages are NOT flagged (false-positive guard).

### e2e — pause/resume lifecycle (CI, deterministic)

A local **fake-challenge page** (static HTML with matching markers + a "clear" button that
mutates the DOM) drives: detect → `awaiting_human` → screencast frame received → forwarded
click clears it → auto-resume → run completes. Run via the UI e2e harness
(`pnpm --filter @garrison-hq/sortie-ui e2e`). Asserts: other runs progress while paused
(non-blocking); timeout path yields `captcha_unsolved`.

### Live — avoidance hygiene (manual, not CI)

Against a public Turnstile/reCAPTCHA **demo** page, confirm assist-on reduces challenge
frequency vs assist-off, and that a banked profile skips the challenge on a second run
(SC-003). Not in CI (third-party pages are flaky / rate-limited / policy-sensitive).

### Regression — assist off

Existing core + server + e2e suites pass unchanged; a challenge with assist off still
fails gracefully exactly as today (FR-002, SC-002).

## Boundary reminder (C-001)

Nothing in this feature solves a challenge automatically. No LLM/vision, no third-party
solver. If you find yourself adding code that _answers_ a challenge, stop — that is out of
scope and against the charter.

## Deployment caveat (R9)

The live-view input channel is live remote control of a browser. On a network-exposed
deployment, put authentication in front of the sortie server before enabling assist. The
local-first default assumes a trusted operator.
