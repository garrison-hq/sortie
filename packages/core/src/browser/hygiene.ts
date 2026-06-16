/**
 * Browser fingerprint hygiene helpers.
 *
 * These are minimal, honest measures that make Chromium look less like a
 * broken headless bot (C-002): realistic UA/locale/timezone, masking
 * navigator.webdriver, and disabling the AutomationControlled blink feature.
 * They do NOT defeat any specific challenge or add a stealth toolkit.
 *
 * Manual live-verification note (not CI — see charter R6/R10):
 *   Run against https://2captcha.com/demo/turnstile or https://www.google.com/recaptcha/api2/demo
 *   with `assist: true` and confirm the page scores/loads without an immediate bot-block.
 *   This is a developer smoke-test only; CI uses unit tests below.
 */

const DEFAULT_VIEWPORT = { width: 1280, height: 900 } as const;

/**
 * Returns Playwright `newContext()` options that reduce obvious automation
 * fingerprints: a current desktop-Chrome UA, en-US locale, America/New_York
 * timezone, and the standard 1280x900 viewport.
 */
export function hygieneContextOptions(): {
  userAgent: string;
  locale: string;
  timezoneId: string;
  viewport: { width: number; height: number };
} {
  return {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { ...DEFAULT_VIEWPORT },
  };
}

/**
 * Init script injected via `context.addInitScript()` when hygiene is active.
 * Sets `navigator.webdriver` to `undefined` so it is no longer detectable as
 * a defined property by page-side scripts.
 */
export const WEBDRIVER_MASK_SCRIPT =
  'Object.defineProperty(navigator, "webdriver", { get: () => undefined });';

/**
 * Chromium launch args that disable the AutomationControlled banner/flag.
 * Keep this list minimal — aggressive flags can destabilise headless (see WP02 risks).
 */
export function hygieneLaunchArgs(): string[] {
  return ['--disable-blink-features=AutomationControlled'];
}

/**
 * Returns a promise that resolves after a humanised delay between `min` and
 * `max` milliseconds.  Pass a deterministic `rng` in tests so the delay is
 * predictable (e.g. `() => 0` for instant resolution).
 *
 * @param min   Lower bound in ms (default 120).
 * @param max   Upper bound in ms (default 480).
 * @param rng   Random-number generator returning [0, 1).  Defaults to Math.random.
 */
export async function humanizedDelay(
  min = 120,
  max = 480,
  rng: () => number = Math.random,
): Promise<void> {
  const ms = Math.round(min + rng() * (max - min));
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
