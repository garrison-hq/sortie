---
affected_files: []
cycle_number: 4
mission_slug: assisted-captcha-solving-01KV8XMZ
reproduction_command:
reviewed_at: '2026-06-16T23:14:07Z'
reviewer_agent: unknown
verdict: rejected
wp_id: WP07
---

# WP07 Review — Cycle 2: REJECTED (one regression)

Reviewed fix commit `2fbbc26`. The cycle-1 blocker is genuinely closed and I confirmed it
end-to-end: I ran the e2e **keyless** (`ANTHROPIC_API_KEY=""`) and got **5/5 passed** (45.9 s).
Lazy provider works, the screencast repaint nudge is sound, the e2e restructure is acceptable,
T036 is keyless-deterministic, and the fixture dedup is done. Validation is all green
(core 250, server 57, all typechecks, lint).

**However, the way the lazy provider was wired introduced a new, silent normal-run regression
for keyed CLI `batch` agent runs.** That is a real still-open defect (the exact class cycle-2 was
told to reject for), so this is one more cycle.

---

## Issue 1 (BLOCKER) — `provider: undefined` in `executeAgent` drops the queue-injected provider override

`packages/core/src/runtime/queue.ts:951` was changed from `provider: ctx.provider` to
`provider: undefined`. That silences the eager key-validation correctly, but it also throws away a
provider that was _legitimately injected into the queue_ — which only the assist path needs to be
undefined.

Trace of the regression (keyed, normal run — nothing to do with assist):

- `packages/core/src/cli.ts:1015` (`batch`) builds `const provider = buildProviderOverride(values)`.
  `buildProviderOverride` (cli.ts:343) returns a **constructed** provider whenever the user passes
  `--provider` and/or `--model` (it calls `createProvider({ provider, model })`).
- cli.ts:1037 injects it: `createRunQueue(store, { concurrency, provider })`.
- Pre-fix: the queue's `getProvider()` returned that injected `opts.provider`
  (queue.ts:254–257), `ctx.provider` exposed it (queue.ts:572), and `executeAgent` forwarded it
  via `runAgent({ provider: ctx.provider })`. The override was honored.
- Post-fix: `executeAgent` hardcodes `provider: undefined`, so `runAgent`'s thunk runs
  `opts.provider ?? createProvider()` → `createProvider()` with **no args**, reading purely from
  env. The CLI's `--provider`/`--model` override is silently discarded; the run falls back to env
  defaults (anthropic / `claude-sonnet-4-6`).

The breakage is also **inconsistent**: `executeExtract` (queue.ts:897) still uses `ctx.provider`,
so `sortie batch --model X` with _extract_ specs honors the override while the same flag with
_agent_ specs silently ignores it. Same queue, two different behaviors.

This is silent (no error, wrong model used) and affects a normal keyed path, so it's a blocker
rather than cosmetic. No test covers `sortie batch --provider/--model` for agent specs, which is
why core 250/250 stayed green over a behavior change.

### Why the eager-key worry does NOT apply to the injected provider

The reason cycle-1 needed laziness was that constructing the provider validates the key _before_
detection can pause. But a queue-injected provider is **already constructed** by the time the
queue exists (the CLI built it during arg parsing, before any run). Forwarding an
already-constructed provider to `runAgent` does no key validation at run time and does not block
the assist pause. The only case that must stay lazy is when **no** provider was injected
(`opts.provider === undefined`) — the assist/server/e2e path — where `createProvider()` must be
deferred to the first `chat()`.

### Fix direction

Forward the injected provider when present, fall back to lazy construction when it isn't. Keep
`executeAgent` from forcing the eager `ctx.provider` getter for the no-injection case. Two clean
options:

- Expose the raw optional injected provider on `ExecuteRunCtx` _without_ a forcing getter (e.g.
  carry `opts.provider` through as an `injectedProvider?: LlmProvider` field that is just the
  variable at queue.ts:254, never calling `getProvider()`), and pass
  `provider: ctx.injectedProvider` into `runAgent`. When undefined, `runAgent`'s existing thunk
  stays lazy — exactly the assist behavior you want. When set, the override is honored and no key
  is validated at pause time.
- Or pass a thunk: `provider: () => ctx.<lazy injected-or-undefined>` — but the field approach is
  simpler since `runAgent` already memoises via its own thunk.

Then add a small regression test so this can't silently break again: a queue with an injected
provider + an injected/real agent executor should observe that injected provider reach `runAgent`
(e.g. assert the injected provider's `chat`/`id` is the one used), and confirm an assist run with
**no** injected provider still pauses keyless. Re-run the keyless e2e (should stay 5/5).

---

## What IS correct (verified, no rework needed)

- **Lazy provider for the assist path — fixed and verified.** `loop.ts` defers `createProvider()`
  behind `getProvider()` (memoised thunk) resolved only at the first `provider.chat()`
  (loop.ts:199), which runs _after_ `handleChallengeStep` (loop.ts:187–190). `ctx.provider` is a
  lazy getter (loop.ts:130–137, `satisfies ExecutionContext`), so extract/search tools
  (tools.ts:419,440) still resolve the same thunk only when actually invoked (post-detection).
  I confirmed an assist run pauses at `awaiting_human` on step 0 with **no key** (e2e T035/T035b).
- **No regression for the server/assist non-keyed flow.** Server constructs the queue with no
  injected provider (`apps/server/src/index.ts:71`), so the lazy path is exactly right there.
- **Screencast repaint nudge is sound.** One-shot `Runtime.evaluate` opacity toggle after
  `Page.startScreencast`, guarded by `screencastStarted && !session.stopped`, `silent:true`,
  errors swallowed (best-effort), fires exactly once per attach — no loop, no teardown change to
  WP05's approved scoping/origin-guard/teardown. The live-view e2e now receives a frame.
- **e2e restructure is an acceptable assertion.** Resolving on the first `lv:frame` proves the
  screencast round-trip end-to-end; the forwarded `lv:mouse` click is still sent (C-001 human
  click, not an automated solver), and is treated as best-effort because viewport coordinates
  can't be guaranteed. Combined with awaiting_human (asserted earlier), the 30 s timeout guard,
  the non-blocking test (T035b), the timeout→`captcha_unsolved` test (T035c), and the
  assist-off/no-pause test (T036), the lifecycle is adequately covered. The auto-resume transition
  is exercised but not strictly asserted, which is reasonable given coordinate flakiness.
- **T036** asserts assist-off → graceful-fail, no `awaiting_human`, keyless-deterministic. Good.
- **Fixture dedup** done: `apps/ui/e2e/fixtures/` removed; served `apps/ui/public/e2e/
fake-challenge.html` remains.
- **Validation green:** keyless e2e **5 passed**; core typecheck clean + **250/250**; server
  typecheck clean + **57/57**; mcp + ui typecheck clean (ui incl. `tsconfig.e2e.json`); root
  `pnpm lint` clean.

Fix Issue 1 (forward the injected provider; keep undefined-injection lazy), add the small
regression test, re-run the keyless e2e, and this should pass.
