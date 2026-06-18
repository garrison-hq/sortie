# Phase 1 Data Model: Assisted CAPTCHA Solving

Entities, new/changed fields, and the run state machine. zod schemas in `contracts.ts` are
the source of truth (C-006); shapes below are the design intent.

## Run status state machine

```
queued ──► running ──► success
              │  │  └──► failed
              │  └─────► max_steps
              │
              ├──► awaiting_human ──(solved: auto/manual Resume)──► running
              │           │
              │           ├──(timeout 10m default)──► failed (reason=captcha_unsolved)
              │           └──(operator Cancel)──────► cancelled
              │
              └──► cancelled
```

- `awaiting_human` is **non-terminal** and **non-blocking**: the run holds its live browser
  context but not a queue-worker slot.
- A run may enter `awaiting_human` more than once (challenge re-appears after a partial/
  incorrect solve).
- Each `awaiting_human` entry records the step index and a deadline.

## Entities

### RunSpec (changed)

New optional field:

- `assist?: boolean` — opt-in; default `false`. When false, behavior is unchanged (FR-002).
- `assistSolveTimeoutMs?: number` — per-run override of the default solve timeout
  (default 600_000 = 10 min; FR-014).

### RunStatus / AgentStatus (changed)

- `RunStatus`: add `'awaiting_human'`.
- `AgentStatus`: add `'awaiting_human'` (loop can return this non-terminal outcome).
- Failure reason vocabulary: add canonical `captcha_unsolved` (FR-015). `failureReason`
  stays a free-text string but uses this token for the timeout case so the UI/API can
  branch on it.

### AssistState (new — attached to RunRecord / AgentRunResult)

Describes the current/last human-assist episode:

- `family: 'recaptcha' | 'hcaptcha' | 'turnstile' | 'cloudflare' | 'generic' | 'http'`
- `signal: string` — which marker/status matched (for the operator-facing message).
- `stepIndex: number` — loop step at which the run paused.
- `challengeUrl: string` — page URL when paused.
- `pausedAt: number` (epoch ms) and `deadlineAt: number` (epoch ms).
- `resolvedAt?: number`, `resolution?: 'solved' | 'timeout' | 'cancelled'`.
- `solveSource?: 'auto' | 'manual'`.

### ChallengeDetection (new — pure detector result)

Returned by the shared detector; not persisted directly.

- `detected: boolean`
- `family: AssistState['family']`
- `signal: string`
- `via: 'http' | 'content' | 'marker' | 'frame'`

### RunEvent (changed union)

Add two variants (existing: `run-queued | run-started | run-step | run-screenshot |
run-finished`):

- `run-awaiting-human` — `{ runId, batchId?, assist: AssistState }`
- `run-resumed` — `{ runId, batchId?, resolution: 'solved' | 'cancelled', solveSource? }`

Live-view frame/input traffic is **not** modeled as RunEvents — it is a separate,
higher-frequency message family on the same socket (see `contracts/live-view-protocol.md`)
to avoid polluting the run-event log and history.

### LiveViewSession (new — server-side, transient, not persisted)

Exists only while a run is `awaiting_human`:

- `runId: string`
- `cdpSession` — Playwright CDPSession bound to the run's page.
- `clientConnId` — the single authenticated WS connection authorized to view/control.
- `viewport: { width, height }` and last frame `metadata` for coordinate mapping.
- lifecycle: created on pause, torn down on resume/cancel/timeout/disconnect-expiry.

### Profile / ProfileStateSummary (changed)

- Storage-state banking reuses the existing on-disk profile JSON (0600). After a solve,
  `bankAssistSolve()` writes `page.context().storageState()` back.
- Optional metadata: `lastAssistedAt?: number` (epoch ms) for audit/"recently assisted"
  surfacing. No cookie names/values are ever surfaced (unchanged guarantee).

### Queue internal (new, not a contract)

- `pausedRuns: Map<runId, { item, page, context, assist: AssistState, deadlineTimer }>`.
- `maxConcurrentAwaitingHuman: number` (config, default 3) — cap on live paused contexts;
  exceeding it degrades a new challenge to graceful-fail.

## Validation rules

- `assist` defaults false everywhere; absent ⇒ legacy behavior.
- `assistSolveTimeoutMs` clamped to a sane range (e.g. 30s–60m).
- A `resume`/`cancel` is valid only when the target run is currently `awaiting_human`;
  otherwise rejected (404/409 on HTTP, ignored+logged on WS).
- Input/control messages valid only for the run that owns the requesting connection's
  live-view session.

## Persistence touchpoints

- `store/`: run status transitions to/from `awaiting_human`; `failureReason` =
  `captcha_unsolved` on timeout; steps continue to be appended; optional `assist` snapshot
  on the run record.
- Profiles: storage-state file rewrite + optional `lastAssistedAt` metadata.
- No schema migration needed beyond additive status/reason values and an optional JSON
  column/field for `assist` state (follow the store's existing serialization pattern).
