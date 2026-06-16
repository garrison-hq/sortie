/**
 * Browser lifecycle management on top of Playwright chromium.
 *
 * - `BrowserManager` owns a single lazily-launched browser plus any contexts
 *   created through `newPage()`, and tears everything down in `close()`.
 * - `withPage()` is a one-shot convenience: launch -> run -> always clean up.
 */
import { mkdir, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';
import type { BrowserLaunchOptions, PageSessionOptions } from '../contracts.js';
import { hygieneContextOptions, hygieneLaunchArgs, WEBDRIVER_MASK_SCRIPT } from './hygiene.js';

const DEFAULT_VIEWPORT = { width: 1280, height: 900 } as const;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class BrowserManager {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private contexts = new Set<BrowserContext>();
  private closed = false;

  /**
   * Lazily launch chromium (headless by default). Safe to call multiple
   * times; concurrent calls share a single launch.
   * When `opts.fingerprintHygiene` is true, adds `--disable-blink-features=AutomationControlled`
   * to the launch args (C-002: hygiene only, not evasion).
   */
  async launch(opts?: BrowserLaunchOptions): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;

    this.closed = false;
    const extraArgs = opts?.fingerprintHygiene ? hygieneLaunchArgs() : [];
    this.launching = chromium
      .launch({ headless: opts?.headless ?? true, args: extraArgs })
      .then((browser) => {
        this.browser = browser;
        return browser;
      })
      .finally(() => {
        this.launching = null;
      });
    return this.launching;
  }

  /**
   * Create a fresh browser context (1280x900 viewport) and a page in it.
   * If `opts.storageStatePath` points to an existing file, it is loaded as
   * the context's storage state (cookies + localStorage, for session reuse).
   * If `opts.fingerprintHygiene` is true, the context is created with a
   * realistic UA/locale/timezone and navigator.webdriver is masked via an
   * init script (C-002: hygiene only, no specific challenge is defeated).
   */
  async newPage(
    opts?: PageSessionOptions & Pick<BrowserLaunchOptions, 'fingerprintHygiene'>,
  ): Promise<Page> {
    const browser = await this.launch({ fingerprintHygiene: opts?.fingerprintHygiene });

    let storageState: string | undefined;
    if (opts?.storageStatePath) {
      if (await fileExists(opts.storageStatePath)) {
        storageState = opts.storageStatePath;
      }
    }

    const hygieneOpts = opts?.fingerprintHygiene ? hygieneContextOptions() : {};
    const context = await browser.newContext({
      viewport: { ...DEFAULT_VIEWPORT },
      ...(storageState ? { storageState } : {}),
      ...hygieneOpts,
    });
    this.contexts.add(context);
    context.on('close', () => this.contexts.delete(context));

    if (opts?.fingerprintHygiene) {
      await context.addInitScript(WEBDRIVER_MASK_SCRIPT);
    }

    return context.newPage();
  }

  /**
   * Open a CDP session for `page`, for use by WP05's live-view instrumentation.
   * The caller is responsible for detaching/closing the session.
   */
  async cdpSessionFor(page: Page): Promise<CDPSession> {
    return page.context().newCDPSession(page);
  }

  /**
   * Persist the storage state (cookies + localStorage) of the page's context
   * to `path`, creating parent directories as needed.
   */
  async saveStorageState(page: Page, path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await page.context().storageState({ path });
  }

  /** Close all contexts and the browser. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // If a launch is in flight, wait for it so we can close the result.
    if (this.launching) {
      try {
        await this.launching;
      } catch {
        // Launch failed; nothing to close.
      }
    }

    const contexts = [...this.contexts];
    this.contexts.clear();
    await Promise.allSettled(contexts.map((ctx) => ctx.close()));

    const browser = this.browser;
    this.browser = null;
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Browser already gone (crashed/disconnected) — closing is best-effort.
      }
    }
  }
}

export interface WithPageOptions extends BrowserLaunchOptions, PageSessionOptions {}

/**
 * Convenience: launch a browser, open a page, run `fn(page)`, and always
 * clean up (even when `fn` throws).
 */
export async function withPage<T>(
  opts: WithPageOptions | undefined,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const manager = new BrowserManager();
  try {
    await manager.launch({
      headless: opts?.headless,
      fingerprintHygiene: opts?.fingerprintHygiene,
    });
    const page = await manager.newPage({
      storageStatePath: opts?.storageStatePath,
      fingerprintHygiene: opts?.fingerprintHygiene,
    });
    return await fn(page);
  } finally {
    await manager.close();
  }
}
