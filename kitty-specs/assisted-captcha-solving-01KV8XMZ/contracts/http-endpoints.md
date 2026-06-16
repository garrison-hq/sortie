# Contract: HTTP endpoints (resume / cancel)

HTTP alternatives to the WS control messages, for clients not holding the live-view socket.
Registered in `apps/server/src/routes.ts` alongside existing run routes. zod-validated.

## POST `/api/runs/:id/resume`

Manually resume a paused run (equivalent to `lv:resume`).

- **Preconditions**: run `:id` exists and status is `awaiting_human`.
- **Body**: none (or `{}`).
- **200**: updated `RunRecord` (status back to `running`).
- **404**: unknown run id.
- **409**: run is not `awaiting_human`.

Effect: bank storage state into the profile if applicable (R7), tear down the
`LiveViewSession`, emit `run-resumed { solveSource: 'manual' }`, re-enter the agent loop at
the paused step.

## POST `/api/runs/:id/cancel-assist` (or reuse DELETE `/api/runs/:id`)

Operator Cancel of a paused run.

- **Preconditions**: run `:id` exists and status is `awaiting_human`.
- **200**: updated `RunRecord` (status `cancelled`, `assist.resolution='cancelled'`).
- **409**: run is not `awaiting_human`.

> Decision: prefer the existing `DELETE /api/runs/:id` cancel path, extended to handle the
> `awaiting_human` state (tear down live view, mark cancelled). A dedicated
> `cancel-assist` route is only added if cancel semantics need to differ. Pinned during
> implementation.

## Auto-resume & timeout (no endpoint)

- Auto-resume (R3) and the solve-timeout → `captcha_unsolved` (FR-015) are driven inside the
  queue/live-view server, not via HTTP.
- On timeout: tear down live view, set status `failed`, `failureReason='captcha_unsolved'`,
  `assist.resolution='timeout'`, emit `run-finished`.

## Snapshot endpoint (optional)

Existing `GET /api/runs/:id/screenshots/:idx` already serves the last capture (the challenge
page) for clients that only poll. The live interactive view supersedes it while paused.

## Auth note (R9)

These endpoints inherit the server's current (local-first, unauthenticated) trust model.
Enabling assist on a network-exposed deployment requires auth in front of the server —
documented in `quickstart.md`, not solved here.
