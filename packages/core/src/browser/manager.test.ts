/**
 * Unit tests for BrowserManager (manager.ts).
 *
 * Regression coverage for SC-002 / F-1: fingerprint-hygiene launch args must
 * NOT leak from an assist run to a subsequent non-assist run sharing the same
 * BrowserManager (and therefore the same underlying browser process).
 *
 * All tests mock `chromium.launch` so no real browser is required.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Browser } from 'playwright';
import * as playwright from 'playwright';

// ---------------------------------------------------------------------------
// Minimal mocks for Playwright browser / context / page
// ---------------------------------------------------------------------------

function makeMockPage() {
  return { close: vi.fn().mockResolvedValue(undefined) };
}

function makeMockContext(page: ReturnType<typeof makeMockPage>) {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    newPage: vi.fn().mockResolvedValue(page),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    storageState: vi.fn().mockResolvedValue({}),
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
    }),
    _listeners: listeners,
  };
}

function makeMockBrowser(context: ReturnType<typeof makeMockContext>) {
  return {
    isConnected: vi.fn().mockReturnValue(true),
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// F-1 regression: non-assist launch args are byte-identical regardless of
// whether an assist page was created first (SC-002 / AS-1 / FR-002).
// ---------------------------------------------------------------------------

describe('BrowserManager — F-1 regression: hygiene launch-arg isolation (SC-002)', () => {
  let launchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Spy on chromium.launch so we can inspect the args it was called with.
    const page = makeMockPage();
    const ctx = makeMockContext(page);
    const browser = makeMockBrowser(ctx);
    launchSpy = vi
      .spyOn(playwright.chromium, 'launch')
      .mockResolvedValue(browser as unknown as Browser);
  });

  afterEach(() => {
    launchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('chromium.launch is called WITHOUT --disable-blink-features=AutomationControlled even when fingerprintHygiene=true', async () => {
    // This test MUST fail against the original leaking implementation where
    // hygieneLaunchArgs() was spread into the chromium.launch args.
    const { BrowserManager } = await import('./manager.js');
    const manager = new BrowserManager();

    // Simulate an assist run creating a page with fingerprintHygiene.
    await manager.newPage({ fingerprintHygiene: true });

    // chromium.launch must NOT have received the automation-masking arg.
    expect(launchSpy).toHaveBeenCalledTimes(1);
    const callArgs = launchSpy.mock.calls[0] as [{ args?: string[] }];
    const launchArgs: string[] = callArgs[0]?.args ?? [];
    expect(launchArgs).not.toContain('--disable-blink-features=AutomationControlled');

    await manager.close();
  });

  it('a non-assist newPage after an assist newPage does NOT see automation-masking args at launch', async () => {
    // Scenario: assist run launches browser first, non-assist run reuses it.
    // Neither run should inject the flag process-wide.
    const page = makeMockPage();
    const ctx = makeMockContext(page);
    const browser = makeMockBrowser(ctx);
    // Override so the already-connected browser is reused on second newPage.
    launchSpy.mockResolvedValue(browser as unknown as Browser);

    const { BrowserManager } = await import('./manager.js');
    const manager = new BrowserManager();

    // First call: assist=true (would have leaked the flag under the old code).
    await manager.newPage({ fingerprintHygiene: true });

    // Second call: non-assist run reuses the already-launched browser.
    await manager.newPage({ fingerprintHygiene: false });

    // chromium.launch must only have been called once (shared browser), and
    // without the automation flag — confirming the flag cannot affect the
    // non-assist context even when an assist run ran first.
    expect(launchSpy).toHaveBeenCalledTimes(1);
    const callArgs = launchSpy.mock.calls[0] as [{ args?: string[] }];
    const launchArgs: string[] = callArgs[0]?.args ?? [];
    expect(launchArgs).not.toContain('--disable-blink-features=AutomationControlled');

    await manager.close();
  });

  it('context-level hygiene (UA, locale, timezoneId) IS applied for assist runs but NOT for non-assist runs', async () => {
    const page1 = makeMockPage();
    const ctx1 = makeMockContext(page1);
    const page2 = makeMockPage();
    const ctx2 = makeMockContext(page2);

    // Return different contexts for the two newPage calls.
    const browser = {
      isConnected: vi.fn().mockReturnValue(true),
      newContext: vi.fn().mockResolvedValueOnce(ctx1).mockResolvedValueOnce(ctx2),
      close: vi.fn().mockResolvedValue(undefined),
    };
    launchSpy.mockResolvedValue(browser as unknown as Browser);

    const { BrowserManager } = await import('./manager.js');
    const manager = new BrowserManager();

    // Assist run → context should receive hygiene opts and init script.
    await manager.newPage({ fingerprintHygiene: true });
    const assistContextCall = browser.newContext.mock.calls[0] as [Record<string, unknown>];
    expect(assistContextCall[0]).toHaveProperty('userAgent');
    expect(ctx1.addInitScript).toHaveBeenCalledWith(expect.stringContaining('webdriver'));

    // Non-assist run → context should NOT receive hygiene opts or init script.
    await manager.newPage({ fingerprintHygiene: false });
    const nonAssistContextCall = browser.newContext.mock.calls[1] as [Record<string, unknown>];
    expect(nonAssistContextCall[0]).not.toHaveProperty('userAgent');
    expect(ctx2.addInitScript).not.toHaveBeenCalled();

    await manager.close();
  });
});
