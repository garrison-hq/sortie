# Feature Specification: Assisted CAPTCHA Solving

**Mission**: assisted-captcha-solving-01KV8XMZ
**Mission ID**: 01KV8XMZQ0XZ23FFNVAVSS9E40
**Created**: 2026-06-16
**Target branch**: main
**Status**: Draft — ready for `/spec-kitty.plan`

## Summary

Today a sortie run that hits an anti-bot challenge (reCAPTCHA, hCaptcha, Cloudflare
Turnstile, "verify you are human" interstitials) dead-ends: the agent is instructed to
call `fail`. This feature adds an **opt-in `assist` mode** that does two things:

1. **Reduces how often challenges fire** through browser fingerprint hygiene and
   authenticated-session reuse — making the automation look like a normal browser
   rather than a broken headless bot.
2. **Lets a human solve the challenge when one does fire**, by pausing the run and
   streaming the live browser into the sortie UI so the operator can interact with the
   page directly. Once solved, the run resumes and the resulting clearance cookies are
   banked into the login profile so the challenge rarely returns.

The hard line — preserved from the project charter — is that **no software ever solves
the challenge**. No LLM vision, no third-party solver service. A real human does the
human-verification step; sortie only gets out of the way and back in.

## User Scenarios & Testing

### Primary flow — assisted solve

1. Operator starts an agent run with assist mode enabled (CLI `--assist`, UI toggle, or
   `assist: true` in the run spec).
2. The run proceeds normally until a page presents an anti-bot challenge.
3. sortie detects the challenge, pauses the run (status `awaiting_human`), and raises an
   in-UI banner with an audible alert.
4. The operator opens the run, sees the live browser view streamed from the run's page,
   and solves the challenge with mouse/keyboard directly in that view.
5. sortie detects the challenge has cleared and auto-resumes the agent from where it
   paused. (The operator can also click **Resume** manually, or **Cancel**.)
6. The run completes. The session/clearance cookies obtained during the solve are saved
   into the active login profile.
7. A later run against the same site, while those cookies are valid, does not present the
   challenge again.

### Secondary flow — unattended / timeout

1. A challenge fires on an assisted run but the operator is away.
2. Other queued runs keep executing normally while this one waits.
3. After the configured solve timeout (default 10 minutes) with no solve, the run fails
   gracefully with reason `captcha_unsolved`.

### Secondary flow — non-interactive context

1. An assist-enabled run is launched where no human can be streamed to (MCP server,
   headless/non-interactive CLI).
2. On challenge detection, sortie falls back to today's behavior: fail gracefully with a
   clear reason naming the challenge and (if applicable) the profile to refresh.

### Acceptance scenarios

- **AS-1**: Given assist mode is **off**, when a run hits a challenge, then behavior is
  identical to today (agent fails with a clear reason) and no streaming/pause occurs.
- **AS-2**: Given assist mode is **on** and a human is available, when a challenge fires,
  then the run enters `awaiting_human`, the operator solves it via the UI, and the run
  resumes and completes.
- **AS-3**: Given a challenge was solved on a prior run, when a new run visits the same
  domain within cookie validity, then no challenge is presented (banked cookies reused).
- **AS-4**: Given an assisted run is `awaiting_human`, when other runs are queued, then
  those runs continue executing and are not blocked by the paused run.
- **AS-5**: Given an assisted run is `awaiting_human`, when the solve timeout elapses with
  no solve, then the run fails with reason `captcha_unsolved`.

### Edge cases

- Challenge re-appears after a partial/incorrect solve → run stays `awaiting_human`.
- Operator cancels mid-solve → run ends as failed/cancelled with a clear reason.
- Multiple runs are `awaiting_human` at once → each has an independent live view; solving
  one does not affect another.
- The page navigates during solving → the stream and input stay bound to the run's page.
- The UI connection drops mid-solve → on reconnect the operator can resume the same
  `awaiting_human` session (run is not silently failed by a transient disconnect).
- Detection false-positive (page is not really a challenge) → operator uses manual
  **Resume** to continue.

## Requirements

### Functional Requirements

| ID     | Requirement                                                                                                                                                                              | Status   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| FR-001 | An opt-in `assist` mode is exposed via CLI flag (`--assist`), a UI toggle, and a run-spec field; it defaults to **off**.                                                                 | Accepted |
| FR-002 | When assist is off, run behavior is unchanged from today, including failing gracefully on a detected challenge.                                                                          | Accepted |
| FR-003 | When assist is on, the browser applies fingerprint hygiene (realistic user-agent, locale, timezone; suppression of obvious automation signals) to reduce challenge frequency.            | Accepted |
| FR-004 | When assist is on and a login profile is supplied, the run prefers and reuses the persisted authenticated session.                                                                       | Accepted |
| FR-005 | When assist is on, agent interactions use modest humanized pacing.                                                                                                                       | Accepted |
| FR-006 | sortie detects anti-bot challenges covering at least: reCAPTCHA, hCaptcha, Cloudflare Turnstile/interstitial, generic "verify you are human" text, and HTTP 403/429 challenge responses. | Accepted |
| FR-007 | On challenge detection with assist on, the run transitions to a new `awaiting_human` status and suspends all automated actions on that page.                                             | Accepted |
| FR-008 | While `awaiting_human`, sortie streams a live view of the run's browser page to the UI.                                                                                                  | Accepted |
| FR-009 | While `awaiting_human`, the UI captures the operator's mouse and keyboard input and applies it to the live page so the human can solve the challenge.                                    | Accepted |
| FR-010 | Entering `awaiting_human` raises an in-UI banner and an audible alert identifying the run and the challenge.                                                                             | Accepted |
| FR-011 | sortie auto-resumes the run when the challenge clears, and also provides manual **Resume** and **Cancel** controls.                                                                      | Accepted |
| FR-012 | On resume, the agent continues from the step at which it paused.                                                                                                                         | Accepted |
| FR-013 | After a successful solve, updated session state (including clearance cookies) is persisted into the active login profile for reuse on later runs.                                        | Accepted |
| FR-014 | The solve timeout is configurable (per-run override and a default); the default is 10 minutes.                                                                                           | Accepted |
| FR-015 | If the timeout elapses without a solve, the run fails gracefully with reason `captcha_unsolved`.                                                                                         | Accepted |
| FR-016 | A run that is `awaiting_human` does not block the queue; other queued runs continue to execute.                                                                                          | Accepted |
| FR-017 | In contexts that cannot present a live view to a human (MCP, headless/non-interactive), assist mode falls back to the graceful-fail behavior with a clear reason.                        | Accepted |
| FR-018 | Failure reasons and statuses produced by assist mode are reflected in the run record/contract and surfaced through existing run-history and live-event channels.                         | Accepted |

### Non-Functional Requirements

| ID      | Requirement                                                                                                                                            | Status   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| NFR-001 | Streamed frames reflect the live page within ≤1s, and operator input round-trips to the page in ≤500ms, over typical broadband/LAN.                    | Accepted |
| NFR-002 | Challenge detection adds ≤100ms overhead per agent step.                                                                                               | Accepted |
| NFR-003 | Detection achieves ≥95% true-positive rate against the fixture set of the supported challenge families, with ≤1 false-positive across the fixture set. | Accepted |
| NFR-004 | Live-view streaming and the input channel are active only while a run is `awaiting_human`; they add zero bandwidth when no run is paused.              | Accepted |
| NFR-005 | A banked clearance cookie is reused on subsequent runs to the same domain 100% of the time while the cookie is within its validity window.             | Accepted |

### Constraints

| ID    | Constraint                                                                                                                                                                                                                                            | Status   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| C-001 | No automated solving of any kind — no LLM/vision solving, no third-party solver services (e.g. 2captcha/anti-captcha). A human performs the verification. The charter line "Never attempt to bypass CAPTCHAs or anti-bot protections" stays in force. | Accepted |
| C-002 | "Avoidance" is limited to fingerprint hygiene and legitimate session reuse so automation does not look broken; it must not actively defeat a specific challenge.                                                                                      | Accepted |
| C-003 | Operator input forwarding is scoped to the single page of the `awaiting_human` run, only while paused, and only over the authenticated UI connection.                                                                                                 | Accepted |
| C-004 | The live view may expose authenticated-session content; only the authenticated UI client may view or control it.                                                                                                                                      | Accepted |
| C-005 | Server code must not bind hardcoded `localhost`; it honors `SORTIE_HOST`/`SORTIE_PORT` (existing project constraint).                                                                                                                                 | Accepted |
| C-006 | zod schemas remain the source of truth for any new structured data crossing a boundary (run spec, live-view messages, events).                                                                                                                        | Accepted |

## Security & Threat Model

Interactive remote solving introduces a meaningfully larger attack surface than the
existing observe-only live view. This section is a required input to planning.

- **Live remote control of a real browser.** While `awaiting_human`, operator input is
  replayed into a live, possibly authenticated page.
  - _Mitigations:_ accept input only over the authenticated UI connection; bind the input
    channel to exactly one run's page; reject input unless that run is `awaiting_human`;
    constrain navigation initiated through the channel so it cannot be repurposed to drive
    the browser to arbitrary origins.
- **Exposure of authenticated-session content.** The streamed frames can show logged-in
  pages, cookies-in-effect content, and personal data.
  - _Mitigations:_ stream only to the authenticated client; stream only while paused; never
    persist raw frames beyond what existing screenshot handling already does; do not log
    frame contents.
- **Cookie/clearance banking.** Banked clearance cookies are sensitive session material.
  - _Mitigations:_ reuse the existing profile storage guarantees (on-disk only, 0600 perms,
    never returned in API responses, never written to the database).
- **Unauthorized takeover / connection hijack.** A second client must not be able to seize
  control of a paused run's page.
  - _Mitigations:_ require authentication on the control channel; scope control to the run;
    treat transient disconnects as resumable rather than granting open control.
- **Denial of service via stuck pauses.** A forgotten paused run could hold resources.
  - _Mitigations:_ configurable solve timeout (default 10 min) → `captcha_unsolved`; paused
    runs are non-blocking so they cannot stall the queue.

## Success Criteria

| ID     | Criterion                                                                                                                                    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| SC-001 | An operator can solve a live CAPTCHA on a running agent entirely from the UI, with no code changes, and the run then completes successfully. |
| SC-002 | With assist mode off, end-to-end behavior is identical to the current release (existing tests pass unchanged).                               |
| SC-003 | After solving a challenge once, a repeat run against the same site within cookie validity is not presented with the challenge again.         |
| SC-004 | An unsolved challenge fails within the configured timeout with reason `captcha_unsolved`, while other queued runs complete unaffected.       |
| SC-005 | No code path solves a challenge automatically; this is demonstrable by tests and review.                                                     |

## Key Entities

- **Run** — gains an `awaiting_human` status, a configurable solve-timeout, and a
  `captcha_unsolved` failure reason; carries the `assist` setting.
- **Challenge detection result** — which challenge family was detected and the signal that
  matched, used to drive the pause and the operator-facing message.
- **Live-view session** — the streamed-frames + operator-input pairing bound to one paused
  run's page; exists only while `awaiting_human`.
- **Login profile / session state** — persisted authenticated session, extended to bank
  clearance cookies captured during a solve.
- **Awaiting-human alert** — the in-UI banner + audible signal emitted when a run pauses.

## Out of Scope

- Any automated, LLM-based, or third-party CAPTCHA solving (explicitly excluded — C-001).
- Anti-bot evasion beyond basic fingerprint hygiene and session reuse (C-002).
- Off-device alerting (webhooks, email, push). Alerting is in-UI banner + sound only.
- A local headed-browser solving mode. Solving is via remote UI streaming only.

## Assumptions

- sortie is operated by a trusted operator on an authenticated UI; this is a local-first /
  single-tenant deployment, not a public multi-tenant service.
- The remote browser runs headless on the host; the live view is produced by streaming that
  page to the UI rather than by opening a local desktop window.
- Most challenge friction on real sites is reduced primarily by reusing an authenticated
  profile and banked clearance cookies; interactive solving is the exception path, not the
  norm.
- The existing WebSocket live-event channel and profile storage are the foundations this
  feature extends.

## Dependencies

- Existing browser engine, agent loop, run queue, WebSocket live view, and login-profile
  storage.
- The existing search-challenge detection signals, to be generalized into shared
  challenge detection.
