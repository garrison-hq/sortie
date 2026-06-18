import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import type { Page } from 'playwright';
import type {
  ChatRequest,
  ChatResponse,
  ChallengeDetection,
  LlmProvider,
  StepRecord,
} from '../contracts.js';
import { runAgent } from './loop.js';

// ---------------------------------------------------------------------------
// Module mock for challenge detection (WP03 tests)
// ---------------------------------------------------------------------------
vi.mock('../challenge/detect.js', () => ({
  detectChallengeOnPage: vi.fn(),
}));

// After mocking, import the mock handle so tests can control return values.
import { detectChallengeOnPage } from '../challenge/detect.js';

const START_URL = 'https://example.com/start';
const SECRET = 'sup3r-s3cret-hunter2-XyZ';

/**
 * Minimal fake page: enough surface for navigateAndSettle, distillPage
 * (evaluate returns an empty-but-valid walker result), and the loop's
 * url/title bookkeeping. No browser involved.
 */
function makeFakePage(): Page {
  let currentUrl = 'about:blank';
  return {
    goto: (url: string) => {
      currentUrl = url;
      return Promise.resolve(null);
    },
    waitForLoadState: () => Promise.resolve(),
    waitForTimeout: () => Promise.resolve(),
    url: () => currentUrl,
    title: () => Promise.resolve('Fake Page'),
    evaluate: () => Promise.resolve({ elements: [], text: '' }),
  } as unknown as Page;
}

/** Provider that replays scripted responses and records every request. */
function makeScriptedProvider(script: Array<{ tool: string; input: unknown; text?: string }>): {
  provider: LlmProvider;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  let turn = 0;
  const provider: LlmProvider = {
    id: 'fake:scripted',
    chat: (req: ChatRequest): Promise<ChatResponse> => {
      requests.push(req);
      const entry = script[turn];
      if (!entry) return Promise.reject(new Error('scripted provider ran out of turns'));
      turn += 1;
      return Promise.resolve({
        text: entry.text ?? '',
        toolCalls: [{ id: `call-${turn}`, name: entry.tool, input: entry.input }],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    },
  };
  return { provider, requests };
}

describe('runAgent — done-tool schema validation retry', () => {
  it('feeds validation errors back to the model and succeeds on the corrected result', async () => {
    const schema = z.object({ name: z.string() });
    const { provider, requests } = makeScriptedProvider([
      { tool: 'done', input: { result: { name: 42 } }, text: 'submitting' },
      { tool: 'done', input: { result: { name: 'fish' } }, text: 'fixed it' },
    ]);
    const observed: StepRecord[] = [];

    const result = await runAgent({
      goal: 'extract the name',
      startUrl: START_URL,
      schema,
      provider,
      page: makeFakePage(),
      credentials: { PASSWORD: SECRET },
      onStep: (step) => observed.push(step),
    });

    expect(result.status).toBe('success');
    expect(result.output).toEqual({ name: 'fish' });
    expect(result.finalUrl).toBe(START_URL);

    // First done was rejected by the schema and fed back as an observation.
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.observation).toMatch(/^Validation failed: name/);
    expect(result.steps[0]!.observation).toContain('call done again');
    expect(result.steps[1]!.observation).toBe('Goal completed; result accepted.');

    // The retry turn received the validation failure as a toolResult reply.
    expect(requests).toHaveLength(2);
    const retryReply = requests[1]!.messages.find((m) => m.role === 'toolResult');
    expect(retryReply).toBeDefined();
    expect(retryReply!.content).toContain('Validation failed');

    // StepRecords keep the model's raw action input and reasoning text.
    expect(result.steps[0]!.action).toEqual({ tool: 'done', input: { result: { name: 42 } } });
    expect(result.steps[0]!.thought).toBe('submitting');

    // onStep observed every step in order.
    expect(observed.map((s) => s.index)).toEqual([0, 1]);

    // Usage is summed across turns.
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
  });

  it('never sends credential values to the provider — names and placeholders only', async () => {
    const { provider, requests } = makeScriptedProvider([
      { tool: 'done', input: { result: { ok: true } } },
    ]);

    const result = await runAgent({
      goal: 'log in',
      startUrl: START_URL,
      provider,
      page: makeFakePage(),
      credentials: { PASSWORD: SECRET },
    });

    expect(result.status).toBe('success');
    for (const req of requests) {
      const wire = JSON.stringify(req);
      expect(wire).not.toContain(SECRET);
      // The model is told the credential NAME and the placeholder form.
      expect(req.system).toContain('PASSWORD');
      expect(req.system).toContain('{{cred:PASSWORD}}');
    }
  });
});

describe('runAgent — termination', () => {
  it('returns status "failed" with the reason when the model calls fail', async () => {
    const { provider } = makeScriptedProvider([
      { tool: 'fail', input: { reason: 'A CAPTCHA blocks the login form.' } },
    ]);

    const result = await runAgent({
      goal: 'log in',
      startUrl: START_URL,
      provider,
      page: makeFakePage(),
    });

    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('A CAPTCHA blocks the login form.');
    expect(result.steps).toHaveLength(1);
  });

  it('returns status "max_steps" when the budget runs out', async () => {
    const { provider } = makeScriptedProvider([
      { tool: 'wait', input: { seconds: 0 } },
      { tool: 'wait', input: { seconds: 0 } },
    ]);

    const result = await runAgent({
      goal: 'never finishes',
      startUrl: START_URL,
      provider,
      page: makeFakePage(),
      maxSteps: 2,
    });

    expect(result.status).toBe('max_steps');
    expect(result.failureReason).toContain('2');
    expect(result.steps).toHaveLength(2);
  });

  it('returns status "failed" when the model produces no tool call', async () => {
    const provider: LlmProvider = {
      id: 'fake:no-tools',
      chat: () =>
        Promise.resolve({
          text: 'I refuse to use tools.',
          toolCalls: [],
          stopReason: 'end',
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
    };

    const result = await runAgent({
      goal: 'anything',
      startUrl: START_URL,
      provider,
      page: makeFakePage(),
    });

    expect(result.status).toBe('failed');
    expect(result.failureReason).toContain('no tool call');
    expect(result.steps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// WP03 — Challenge detection + pause/resume tests (T014)
// ---------------------------------------------------------------------------

/** A ChallengeDetection fixture for reCAPTCHA. */
const RECAPTCHA_DETECTION: ChallengeDetection = {
  detected: true,
  family: 'recaptcha',
  signal: 'grecaptcha',
  via: 'marker',
};

describe('runAgent — WP03 challenge detection + pause/resume (T014)', () => {
  const mockDetect = vi.mocked(detectChallengeOnPage);

  beforeEach(() => {
    // Default: no challenge detected (safe baseline for all tests).
    mockDetect.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // T014 §1 — assist ON: yields awaiting_human; LLM is NOT called on paused step.
  it('assist ON: pauses with awaiting_human when a challenge is detected; LLM not called', async () => {
    // First call (initial detect) → challenge; second call (recheck after resume)
    // → still challenged → returns awaiting_human immediately.
    mockDetect.mockResolvedValue(RECAPTCHA_DETECTION);

    const { provider, requests } = makeScriptedProvider([
      // The LLM should never be invoked — if it is, the test will fail via
      // "scripted provider ran out of turns".
      { tool: 'done', input: { result: null } },
    ]);

    const awaitingHumanCalls: Array<{ detection: ChallengeDetection; stepIndex: number }> = [];

    const result = await runAgent({
      goal: 'anything',
      startUrl: START_URL,
      provider,
      page: makeFakePage(),
      assistEnabled: true,
      onAwaitingHuman: async (detection, stepIndex) => {
        awaitingHumanCalls.push({ detection, stepIndex });
        // Simulate the human NOT solving the challenge (recheck will still fire).
      },
    });

    // The run paused, not failed/succeeded.
    expect(result.status).toBe('awaiting_human');
    expect(result.assist).toBeDefined();
    expect(result.assist!.family).toBe('recaptcha');
    expect(result.assist!.stepIndex).toBe(0);

    // onAwaitingHuman was called with the right detection and step index.
    expect(awaitingHumanCalls).toHaveLength(1);
    expect(awaitingHumanCalls[0]!.detection).toEqual(RECAPTCHA_DETECTION);
    expect(awaitingHumanCalls[0]!.stepIndex).toBe(0);

    // CRITICAL: the LLM was NOT called on the paused step (C-001, T014 §3).
    expect(requests).toHaveLength(0);
  });

  // T014 §1 — assist OFF: unchanged behavior; detection is a no-op.
  it('assist OFF: detection is a no-op; loop proceeds normally', async () => {
    // Even though the detector would fire, assist is off so it must be ignored.
    mockDetect.mockResolvedValue(RECAPTCHA_DETECTION);

    const { provider, requests } = makeScriptedProvider([
      { tool: 'done', input: { result: { ok: true } } },
    ]);

    const result = await runAgent({
      goal: 'anything',
      startUrl: START_URL,
      provider,
      page: makeFakePage(),
      // assistEnabled defaults to false — omitted deliberately.
    });

    // Loop must complete normally (not paused).
    expect(result.status).toBe('success');
    // LLM was called — detection was a no-op.
    expect(requests).toHaveLength(1);
    // The mock was NOT called because assist is off.
    expect(mockDetect).not.toHaveBeenCalled();
  });

  // T014 §2 — Resume: continues from paused step and completes after human solves.
  it('resumes from the paused step and completes after the human solves the challenge', async () => {
    // Step 0: initial detect → challenge; recheck after onAwaitingHuman → cleared.
    // Step 1: detect → null (clean page); LLM completes with done.
    let detectCallCount = 0;
    mockDetect.mockImplementation(async () => {
      detectCallCount += 1;
      // Call 1: initial detect at step 0 → challenge present.
      // Call 2: recheck after onAwaitingHuman resolves → cleared.
      // Call 3+: any subsequent step detect → null (clean).
      return detectCallCount === 1 ? RECAPTCHA_DETECTION : null;
    });

    const { provider, requests } = makeScriptedProvider([
      // After resume the loop continues at step 0 (same index) and the LLM
      // is invoked once the challenge has cleared.
      { tool: 'done', input: { result: { resumed: true } } },
    ]);

    let resumeCallCount = 0;
    const result = await runAgent({
      goal: 'anything',
      startUrl: START_URL,
      provider,
      page: makeFakePage(),
      assistEnabled: true,
      onAwaitingHuman: async () => {
        resumeCallCount += 1;
        // Human solved the challenge — onAwaitingHuman resolves, loop rechecks
        // and finds the page clean, then continues to the LLM call.
      },
    });

    // The run completed successfully after the human solve.
    expect(result.status).toBe('success');
    expect((result.output as { resumed: boolean }).resumed).toBe(true);

    // onAwaitingHuman was called once (one pause).
    expect(resumeCallCount).toBe(1);

    // LLM was called once — on the same step after challenge cleared.
    expect(requests).toHaveLength(1);

    // detectChallengeOnPage was called twice: initial detect + recheck.
    expect(detectCallCount).toBe(2);
  });
});
