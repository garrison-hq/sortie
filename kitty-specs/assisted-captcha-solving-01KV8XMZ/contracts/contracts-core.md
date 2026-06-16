# Contract: `packages/core/src/contracts.ts` additions

All additive; existing shapes unchanged so assist-off behavior is byte-identical (FR-002).
zod schemas are authoritative; the TypeScript below is the intended shape.

## RunSpec — opt-in flag + timeout override

```ts
// extend the existing agent run spec schema
assist: z.boolean().optional().default(false),                  // FR-001
assistSolveTimeoutMs: z.number().int().min(30_000).max(3_600_000)
  .optional(),                                                  // FR-014 (default 600_000 applied in queue)
```

## Status enums

```ts
type AgentStatus = 'success' | 'failed' | 'max_steps' | 'awaiting_human'; // +awaiting_human
type RunStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'max_steps'
  | 'cancelled'
  | 'awaiting_human'; // +awaiting_human
```

## Canonical failure reason

```ts
const FAILURE_REASON_CAPTCHA_UNSOLVED = 'captcha_unsolved'; // FR-015 token used in failureReason
```

## Challenge family + detection result

```ts
type ChallengeFamily = 'recaptcha' | 'hcaptcha' | 'turnstile' | 'cloudflare' | 'generic' | 'http';

interface ChallengeDetection {
  detected: boolean;
  family: ChallengeFamily;
  signal: string; // human-readable matched marker/status
  via: 'http' | 'content' | 'marker' | 'frame';
}
```

## AssistState (on RunRecord / AgentRunResult)

```ts
interface AssistState {
  family: ChallengeFamily;
  signal: string;
  stepIndex: number;
  challengeUrl: string;
  pausedAt: number; // epoch ms
  deadlineAt: number; // epoch ms
  resolvedAt?: number;
  resolution?: 'solved' | 'timeout' | 'cancelled';
  solveSource?: 'auto' | 'manual';
}

// AgentRunResult gains:  assist?: AssistState
// RunRecord (store)     gains:  assist?: AssistState
```

## RunEvent union additions

```ts
type RunEvent =
  | /* existing */ RunQueued
  | RunStarted
  | RunStep
  | RunScreenshot
  | RunFinished
  | { type: 'run-awaiting-human'; runId: string; batchId?: string; assist: AssistState }
  | {
      type: 'run-resumed';
      runId: string;
      batchId?: string;
      resolution: 'solved' | 'cancelled';
      solveSource?: 'auto' | 'manual';
    };
```

## Agent loop outcome

```ts
// internal StepOutcome union gains a non-terminal pause:
type StepOutcome =
  | { kind: 'continue' }
  | { kind: 'success'; output: unknown }
  | { kind: 'failed'; reason: string }
  | { kind: 'awaiting_human'; detection: ChallengeDetection }; // NEW
```
