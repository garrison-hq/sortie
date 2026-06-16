# Implementation Plan: Assisted CAPTCHA Solving

**Branch**: `feat/assisted-captcha-solving` | **Date**: 2026-06-16 | **Spec**: [spec.md](spec.md)
**Mission**: assisted-captcha-solving-01KV8XMZ (id `01KV8XMZQ0XZ23FFNVAVSS9E40`)
**Input**: Feature specification from `kitty-specs/assisted-captcha-solving-01KV8XMZ/spec.md`

## Branch contract

- Current branch: `feat/assisted-captcha-solving`
- Planning/base branch: `feat/assisted-captcha-solving`
- Mission merge target: `feat/assisted-captcha-solving` (lane worktrees merge here); this branch PRs to `main` (PR #3).

## Summary

Add an opt-in `assist` mode to sortie runs. When on, the browser is hardened with
fingerprint hygiene and prefers authenticated profiles to **reduce** how often anti-bot
challenges fire. When a challenge is detected mid-run, the run enters a new non-terminal
status `awaiting_human`: the agent loop suspends, the run yields its queue-worker slot
(other runs keep going), and the server opens a **live interactive view** of that run's
page — a CDP screencast streamed to a UI canvas, with the operator's mouse/keyboard
forwarded back to the page via CDP input. The human solves the challenge in the real
remote page; sortie auto-resumes when the challenge clears (or on manual Resume), banks
the resulting clearance cookies into the active profile, and continues the agent from the
paused step. If unsolved within a configurable timeout (default 10 min) the run fails with
reason `captcha_unsolved`. Contexts that cannot stream to a human (MCP, headless/
non-interactive) fall back to today's graceful-fail.

**Hard constraint (C-001):** no software ever solves the challenge — no LLM/vision, no
third-party solver service. A human performs the verification; sortie only streams the
page and forwards input.

## Technical Context

**Language/Version**: TypeScript (strict, ESM, NodeNext), Node ≥ 20.
**Primary Dependencies**: Playwright (Chromium + CDP via `context.newCDPSession`), Fastify

- `@fastify/websocket` (server live view), React/Vite (UI), zod (boundary schemas), SQLite
  store. No new runtime dependency is expected; CDP screencast/input is built into Playwright.
  **Storage**: existing SQLite `store/` (runs, profiles metadata) + on-disk profile
  storage-state JSON (`<dataDir>/profiles/<name>.json`, 0600). Banked clearance cookies reuse
  this path.
  **Testing**: vitest unit tests (`*.test.ts`) co-located in `packages/core`; Playwright e2e
  in `apps/ui/e2e`; live-page verification per charter (the-internet.herokuapp.com / public
  challenge demos).
  **Target Platform**: Linux server (remote Docker host) + browser UI; honor
  `SORTIE_HOST`/`SORTIE_PORT`, never bind hardcoded localhost.
  **Project Type**: web (monorepo: `packages/core` engine, `apps/server`, `apps/ui`,
  `apps/mcp`).
  **Performance Goals**: screencast frame latency ≤1s; operator input round-trip ≤500ms
  (NFR-001); detection overhead ≤100ms/step (NFR-002); streaming active only while paused
  (NFR-004).
  **Constraints**: C-001 (no automated solving), C-002 (hygiene not evasion), C-003/C-004
  (input/stream scoped to the paused run, authenticated client only), C-005 (host binding),
  C-006 (zod at boundaries).
  **Scale/Scope**: single-tenant/local-first; default queue concurrency 5; a handful of
  concurrent `awaiting_human` runs at most.

## Charter Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

No `.kittify/charter/charter.md` exists — formal Charter Check is **skipped (charter
absent)**. The de-facto project charter in `CLAUDE.md` is honored as binding:

| Charter principle (CLAUDE.md)                                                       | Status in this plan                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Anti-bot evasion and CAPTCHA bypass are explicitly out of scope; fail gracefully." | **Honored & extended deliberately.** No automated solving (C-001). "Avoidance" is fingerprint hygiene only (C-002). The new path is _human_ solving; the graceful-fail path is preserved for assist-off and non-interactive contexts (FR-002, FR-017). This is a conscious, user-approved scope addition recorded in the spec. |
| zod is the source of truth at boundaries                                            | New run-spec field, WS messages, and resume payloads are zod-validated (C-006).                                                                                                                                                                                                                                                |
| Never hardcode model/base URL; never bind hardcoded localhost                       | No model/URL hardcoding; server continues to honor `SORTIE_HOST`/`SORTIE_PORT` (C-005).                                                                                                                                                                                                                                        |
| Browser features verified against a live page                                       | Detection + avoidance verified against live challenge/demo pages; pause/resume e2e against a locally-served fake-challenge page (FR/NFR verification).                                                                                                                                                                         |

**Gate result: PASS** (no unjustified violations; the CAPTCHA-handling scope change is
explicit, bounded by C-001/C-002, and approved).

## Project Structure

### Documentation (this feature)

```
kitty-specs/assisted-captcha-solving-01KV8XMZ/
├── plan.md              # This file
├── research.md          # Phase 0 output — key technical decisions
├── data-model.md        # Phase 1 output — entities, statuses, state machine
├── quickstart.md        # Phase 1 output — how to exercise the feature
├── contracts/           # Phase 1 output — type/protocol contracts
│   ├── contracts-core.md       # contracts.ts additions (RunSpec.assist, status, events)
│   ├── live-view-protocol.md   # WS screencast + input message protocol
│   └── http-endpoints.md       # resume/cancel REST endpoints
└── tasks.md             # Phase 2 (/spec-kitty.tasks — NOT created here)
```

### Source Code (repository root)

```
packages/core/src/
├── contracts.ts                     # +RunSpec.assist; +RunStatus 'awaiting_human';
│                                     #  +AgentStatus 'awaiting_human'; +RunEvent
│                                     #  'run-awaiting-human'|'run-resumed'; +reason
│                                     #  'captcha_unsolved'; assist/timeout config
├── challenge/
│   ├── detect.ts                    # NEW: shared detectChallenge() (extracted from search)
│   └── detect.test.ts               # NEW: fixture-based detection unit tests
├── search/engines.ts                # refactor: call shared detectChallenge()
├── browser/
│   ├── manager.ts                   # +fingerprint hygiene context opts; expose CDP session
│   └── hygiene.ts                   # NEW: UA/locale/timezone/webdriver-mask helpers
├── agent/loop.ts                    # post-distill challenge check; emit pause; await resume
├── runtime/queue.ts                 # awaiting_human pause (non-blocking) + resume + timeout
├── profiles.ts                      # +bankAssistSolve(): persist storage state post-solve
└── store/                           # status/reason persistence (existing update paths)

apps/server/src/
├── ws.ts                            # +outbound screencast frames; +inbound input messages
├── liveview.ts                      # NEW: CDP screencast<->WS bridge + input dispatch
└── routes.ts                        # +POST /api/runs/:id/resume ; +cancel reason

apps/ui/src/
├── ws.ts                            # +outbound send() for input/control messages
├── views/RunDetail.tsx              # +awaiting_human banner+sound; +live-view canvas
└── components/LiveView.tsx          # NEW: canvas render of frames + input capture

apps/mcp/src/index.ts                # +assist arg; non-interactive => graceful fallback
packages/core/src/cli.ts             # +--assist flag (agent/batch); fallback if no server
```

**Structure Decision**: Extend the existing monorepo in place. Detection becomes a shared
`packages/core/src/challenge/` module (single source of truth, reused by both the search
chain and the agent loop). The interactive live view is isolated in
`apps/server/src/liveview.ts` (CDP↔WS bridge) and `apps/ui/src/components/LiveView.tsx`
(canvas + input), keeping the new remote-control surface in one auditable place.

## Phase sequencing (for /spec-kitty.tasks)

1. **Contracts & detection (foundation)** — contracts.ts additions; extract shared
   `detectChallenge()` + unit tests; refactor `search/engines.ts` to use it. No behavior
   change when assist off.
2. **Avoidance** — fingerprint hygiene context options + `hygiene.ts`; assist prefers
   profile/session reuse; humanized pacing. Live-verify against demo pages.
3. **Pause lifecycle (engine)** — loop post-distill detection → `awaiting_human` outcome;
   queue non-blocking pause + resume + timeout(→`captcha_unsolved`); cookie banking.
4. **Live view (server)** — `liveview.ts` CDP screencast↔WS bridge; inbound input dispatch;
   resume/cancel endpoints; auth scoping.
5. **UI** — LiveView canvas + input capture; awaiting_human banner + sound; resume/cancel
   controls; ws outbound channel.
6. **Edges & fallbacks** — MCP/CLI `--assist` + non-interactive graceful fallback;
   reconnect-resumes-session; multi-run independence.
7. **Verification** — detection fixtures; e2e pause/resume against local fake-challenge
   page; live avoidance check; assist-off regression.

## Security & Threat Model (carried from spec — gates Phase 4/5)

Live remote control is the highest-risk surface. Mitigations are requirements, not
optional: input accepted only over the authenticated UI WS; bound to exactly one
`awaiting_human` run's page; rejected unless that run is paused; navigation initiated via
the channel constrained to the run's origin; frames streamed only to the authenticated
client and only while paused; never logged/persisted beyond existing screenshot handling;
banked cookies reuse profile storage guarantees (on-disk, 0600, never in DB/API);
disconnect is resumable, not an open-control grant; stuck pauses bounded by the timeout and
non-blocking queue. See `contracts/live-view-protocol.md` for the enforced message rules.

## Complexity Tracking

No Charter Check violations to justify. The one notable complexity — bidirectional WS for
input forwarding (today the WS is server→client only) — is intrinsic to the user-approved
"remote interactive solving" decision and is contained in `liveview.ts` + `LiveView.tsx`.
