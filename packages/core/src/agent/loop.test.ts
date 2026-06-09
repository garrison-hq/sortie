import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Page } from 'playwright';
import type { ChatRequest, ChatResponse, LlmProvider, StepRecord } from '../contracts.js';
import { runAgent } from './loop.js';

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
