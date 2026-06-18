import { describe, expect, it } from 'vitest';
import { buildAgentSystemPrompt } from './prompts.js';

describe('buildAgentSystemPrompt', () => {
  const base = { goal: 'order 1kg tomatoes', credentialNames: [], maxSteps: 25 };

  it('includes the goal and the step budget', () => {
    const p = buildAgentSystemPrompt({ ...base, maxSteps: 7 });
    expect(p).toContain('order 1kg tomatoes');
    expect(p).toContain('budget of 7 steps');
  });

  it('without assist: tells the agent to FAIL on a CAPTCHA / anti-bot wall', () => {
    const p = buildAgentSystemPrompt(base);
    expect(p).toContain('call the fail tool');
    expect(p).toContain('Never attempt to bypass CAPTCHAs');
    expect(p).not.toContain('human-in-the-loop');
  });

  it('with assist: a HUMAN solves challenges — do NOT fail on a CAPTCHA', () => {
    const p = buildAgentSystemPrompt({ ...base, assistEnabled: true });
    expect(p).toContain('human-in-the-loop');
    expect(p).toContain('a HUMAN solves it for you');
    expect(p).toMatch(/do NOT call fail/);
    // It must NOT keep the unconditional "fail on a CAPTCHA" instruction.
    expect(p).not.toContain('or other anti-bot wall, call the fail tool');
  });

  it('mentions credential placeholders only when credentials are provided', () => {
    const withCreds = buildAgentSystemPrompt({
      ...base,
      credentialNames: ['COLLECTANDGO_PASSWORD'],
    });
    expect(withCreds).toContain('{{cred:COLLECTANDGO_PASSWORD}}');
    const noCreds = buildAgentSystemPrompt(base);
    expect(noCreds).toContain('No credentials are available');
  });
});
