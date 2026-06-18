import { describe, expect, it, vi } from 'vitest';

// Mock the extract module so we can drive the "semantic pass returned nothing"
// branch deterministically (the real extract needs a live page + provider).
vi.mock('../extract/index.js', () => ({
  extract: () =>
    Promise.resolve({
      data: {},
      url: 'https://example.com/',
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  navigateAndSettle: () => Promise.resolve(),
}));

import type { Page } from 'playwright';
import type { LlmProvider } from '../contracts.js';
import { executeAction, type ExecutionContext } from './tools.js';

const fakeProvider: LlmProvider = {
  id: 'fake:test',
  chat: () => Promise.reject(new Error('provider must not be called')),
};

/** Page whose evaluate() returns the given visible body text. */
function ctxWithBodyText(text: string): ExecutionContext {
  const page = {
    evaluate: () => Promise.resolve(text),
    url: () => 'https://example.com/',
    waitForLoadState: () => Promise.resolve(),
  } as unknown as Page;
  return { page, credentials: {}, provider: fakeProvider };
}

describe('extract tool — raw-text fallback when semantic extraction is empty', () => {
  it('surfaces the visible page text so the agent is not blind to it', async () => {
    const ctx = ctxWithBodyText('Verification Success... Hooray!');
    const observation = await executeAction(ctx, 'extract', {
      instruction: 'find the confirmation',
    });
    expect(observation).toContain('Extracted: {}');
    expect(observation).toContain('Verification Success... Hooray!');
  });

  it('adds no fallback note when there is no visible text', async () => {
    const ctx = ctxWithBodyText('');
    const observation = await executeAction(ctx, 'extract', { instruction: 'find anything' });
    expect(observation).toBe('Extracted: {}');
  });
});
