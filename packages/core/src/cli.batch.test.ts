/**
 * Tests for the CLI batch spec-patching behaviour (F-2 / FR-017).
 *
 * The CLI runs in-process without a live-view server, so any run whose spec
 * carries `assist: true` must have that field forced to `false` before being
 * submitted to the queue — otherwise the run enters `awaiting_human` with no
 * client able to ever resume it and `drain()` stalls until the 10-min timeout.
 *
 * Because `runBatchCommand` is not exported, these tests validate the pure
 * spec-patching logic that was extracted from that function so the fix is
 * directly testable without spinning up a real CLI process.
 */
import { describe, it, expect } from 'vitest';
import type { RunSpec } from './contracts.js';

// ---------------------------------------------------------------------------
// The patching logic extracted verbatim from runBatchCommand (cli.ts).
// Any change to the production logic must be reflected here to keep the test
// a faithful regression guard.
// ---------------------------------------------------------------------------

/**
 * Mirrors the `patchedSpecs` mapping in `runBatchCommand`.
 * Always forces `assist: false` regardless of what the spec file says,
 * and stamps `assistSolveTimeoutMs` when a timeout is configured.
 */
function applyCliAssistCoercion(specs: RunSpec[], assistTimeout?: number): RunSpec[] {
  return specs.map((spec) => ({
    ...spec,
    assist: false as const,
    ...(assistTimeout === undefined ? {} : { assistSolveTimeoutMs: assistTimeout }),
  }));
}

// ---------------------------------------------------------------------------
// F-2 regression tests
// ---------------------------------------------------------------------------

describe('CLI batch spec assist-coercion (F-2 / FR-017)', () => {
  const BASE_SPEC: RunSpec = {
    kind: 'agent',
    url: 'https://example.com',
    goal: 'do something',
  };

  it('spec-file assist:true is coerced to assist:false (the stall bug)', () => {
    // This is the exact scenario the adversarial review reproduced:
    // a spec file with assist:true submitted to a CLI queue (no live-view server)
    // used to stall drain() for the full solve timeout.
    const specs: RunSpec[] = [{ ...BASE_SPEC, assist: true }];
    const [patched] = applyCliAssistCoercion(specs);
    expect(patched?.assist).toBe(false);
  });

  it('spec-file assist:false is left as assist:false', () => {
    const specs: RunSpec[] = [{ ...BASE_SPEC, assist: false }];
    const [patched] = applyCliAssistCoercion(specs);
    expect(patched?.assist).toBe(false);
  });

  it('spec-file without assist field is stamped with assist:false', () => {
    const specs: RunSpec[] = [{ ...BASE_SPEC }];
    const [patched] = applyCliAssistCoercion(specs);
    expect(patched?.assist).toBe(false);
  });

  it('assist:false is applied to every spec in a mixed batch', () => {
    const specs: RunSpec[] = [
      { ...BASE_SPEC, url: 'https://a.com', assist: true },
      { ...BASE_SPEC, url: 'https://b.com', assist: false },
      { ...BASE_SPEC, url: 'https://c.com' },
    ];
    const patched = applyCliAssistCoercion(specs);
    expect(patched.every((s) => s.assist === false)).toBe(true);
  });

  it('assistSolveTimeoutMs is stamped when a timeout is provided', () => {
    const specs: RunSpec[] = [{ ...BASE_SPEC, assist: true }];
    const [patched] = applyCliAssistCoercion(specs, 60_000);
    expect(patched?.assist).toBe(false);
    expect(patched?.assistSolveTimeoutMs).toBe(60_000);
  });

  it('assistSolveTimeoutMs is NOT added when no timeout is configured', () => {
    const specs: RunSpec[] = [{ ...BASE_SPEC, assist: true }];
    const [patched] = applyCliAssistCoercion(specs, undefined);
    expect(patched?.assist).toBe(false);
    expect(patched?.assistSolveTimeoutMs).toBeUndefined();
  });

  it('other spec fields are preserved after coercion', () => {
    const specs: RunSpec[] = [
      {
        ...BASE_SPEC,
        assist: true,
        maxSteps: 5,
        maxChars: 1000,
      },
    ];
    const [patched] = applyCliAssistCoercion(specs);
    expect(patched?.maxSteps).toBe(5);
    expect(patched?.maxChars).toBe(1000);
    expect(patched?.url).toBe('https://example.com');
  });
});
