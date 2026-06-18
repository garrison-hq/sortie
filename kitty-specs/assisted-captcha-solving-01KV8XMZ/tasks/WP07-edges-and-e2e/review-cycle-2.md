---
affected_files: []
cycle_number: 2
mission_slug: assisted-captcha-solving-01KV8XMZ
reproduction_command:
reviewed_at: '2026-06-16T22:30:11Z'
reviewer_agent: unknown
verdict: rejected
wp_id: WP07
---

# WP07 Review — Cycle 1: REJECTED

Reviewed WP07 commit `1f87c90` (diff `f4e5715..1f87c90`). Validation suites are green and the
CLI/MCP/REST wiring is correct, **but the e2e is non-functional**: 4 of its 5 tests fail because
the run never reaches `awaiting_human`. This defeats the central acceptance criterion (T035) and
also surfaces a real ordering defect. The implementer's "Zero LLM calls needed in e2e / all green"
claim is false — the e2e was clearly never executed.

---

## Issue 1 (BLOCKER) — The deterministic e2e fails: run dies on missing LLM key BEFORE challenge detection

I ran the e2e myself (full `pnpm build` succeeded, fixture confirmed served at
`/e2e/fake-challenge.html`, chromium present):

```
cd apps/ui && pnpm exec playwright test e2e/assist.spec.ts --reporter=list
  1 passed  (T036 assist-OFF)
  4 failed  (T035, T035 live-view, T035b non-blocking, T035c timeout)
```

Every assisted test fails the same way:

```
expect(paused.status).toBe('awaiting_human')
  Expected: "awaiting_human"
  Received: "failed"
```

Reproduced directly against a hand-booted server (no `ANTHROPIC_API_KEY` in env), submitting the
exact e2e payload (`{kind:'agent', url:'.../e2e/fake-challenge.html', assist:true}`):

```
status=failed  failureReason="Missing Anthropic API key: set the ANTHROPIC_API_KEY
                              environment variable, or pass apiKey in the provider config."
```

**Root cause — provider construction is eager and happens before detection.**
The e2e's foundational design note (assist.spec.ts:5-8) says detection fires "AFTER page distill
but BEFORE the first LLM call (step 0)", so the run reaches `awaiting_human` with zero LLM calls.
That is true for the `chat()` _call_ (loop.ts:165 runs `handleChallengeStep` before the
`provider.chat()` at loop.ts:177). **But the provider is _created_ — and its API key validated —
eagerly, long before any of that:**

- `packages/core/src/agent/loop.ts:92` — `const provider = opts.provider ?? createProvider();`
  runs at the very top of `runAgent`, before browser launch / navigation / detection.
- `packages/core/src/runtime/queue.ts:951` — the executor passes `provider: ctx.provider`; the
  `ctx.provider` getter (queue.ts:572) invokes `getProvider()` → `createProvider()`, which throws.
- `packages/core/src/llm/index.ts:43-45` — `createProvider()` throws "Missing Anthropic API key"
  at construction when no key is configured.

So provider _key validation_, not the first `chat()`, is what gates the run — and it gates it
before detection can ever pause. The "LLM-free lifecycle" the e2e relies on does not exist as
wired. The lazy-getter comment in queue.ts:563-565 is defeated because `runAgent` reads the
provider eagerly at loop.ts:92.

**Fix direction (in WP07 scope or a coordinated touch to the loop):** make provider acquisition
lazy so it is only forced on the first `chat()` call (after detection has had its chance to
pause). E.g. in `runAgent`, don't call `createProvider()` until the first step actually needs the
model; pass a thunk / lazy accessor through `LoopState` and resolve it inside `runStep` _after_
the `handleChallengeStep` pause check. Then re-run the e2e and confirm all five tests pass with no
LLM key set.

## Issue 2 (BLOCKER) — e2e was never executed; "all green / zero LLM calls" report is inaccurate

The activity log states "Playwright e2e covering detect→pause→...; Zero LLM calls needed in e2e.
typecheck+test+lint all green." The e2e was demonstrably not run — it fails immediately without an
LLM key, which is exactly the scenario it claims to support. T035/T035b/T035c validations are
unmet. Please run `pnpm exec playwright test e2e/assist.spec.ts` and include real output before
re-submitting.

## Issue 3 (non-blocking, fix opportunistically) — duplicate fixture source of truth

`apps/ui/e2e/fixtures/fake-challenge.html` and `apps/ui/public/e2e/fake-challenge.html` are
byte-identical. Only `public/e2e/` is served (via Vite `public/` → `dist/` → `@fastify/static`).
The `e2e/fixtures/` copy is dead weight that can drift; either remove it or have the served copy
derive from it. Not a blocker.

---

## What IS correct (no rework needed here)

- **REST forwarding is complete and correct.** `apps/server/src/validate.ts` validates `assist`
  (boolean) and `assistSolveTimeoutMs` (integer 30000–3600000, matching the contract zod bounds at
  contracts.ts:418-419) in `validateRunSpecOptionals`, and `toRunSpec` copies both onto `RunSpec`.
  `queue.ts:953` sets `assistEnabled: spec.assist === true` and `queue.ts:571` only wires
  `onAwaitingHuman` when `spec.assist`. The feature is reachable via API/UI. (The pause just never
  fires today because of Issue 1, which is upstream of this wiring.)
- **CLI fallback is honest.** `runAgentCommand` always sets `assistEnabled = false` and warns via
  `warnAssistUnavailableInCli()`; `--assist-timeout` is validated even when assist is off; `batch`
  stamps `assist:false`. `--help` documents both flags and the in-process limitation. No hang path.
- **MCP fallback is honest.** `handleRunAgent` passes `assistEnabled: false` unconditionally and
  warns via `warnAssistUnavailableInMcp()`; the tool schema + description document the limitation.
  No hang path.
- **Fixture determinism / detector match.** Title and body both contain "verify you are human",
  which matches `GENERIC_MARKERS` in `packages/core/src/challenge/detect.ts` → family `generic`.
  No third-party scripts/fonts/network. The solve button removes the markers and the Turnstile
  container. C-001 respected: the e2e "solve" is a forwarded `lv:mouse` click, not an automated
  solver. The `lv:attach`/`lv:frame`/`lv:mouse`/`run-resumed`/`lv:stopped(reason:resumed)` protocol
  names match the server (`apps/server/src/ws.ts`, `liveview.ts`).
- **Validation suites green:** core typecheck clean, core test 250/250 pass, mcp/ui/server
  typecheck clean (ui includes `tsc -p tsconfig.e2e.json`), root `pnpm lint` clean.

The structural design of the e2e (transitions asserted, protocol round-trip, C-001 click model,
no third-party network) is sound. The single blocker is that the lifecycle path cannot run
LLM-free as built. Fix Issue 1, execute the e2e for real, and this should pass.
