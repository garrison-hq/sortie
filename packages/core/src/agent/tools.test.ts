import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import type { LlmProvider } from '../contracts.js';
import { AGENT_TOOLS, executeAction, type ExecutionContext } from './tools.js';

/** Provider stub — executeAction only needs it for the extract tool. */
const fakeProvider: LlmProvider = {
  id: 'fake:test',
  chat: () => Promise.reject(new Error('provider must not be called in this test')),
};

/** Distinctive secret that would be obvious if it ever leaked. */
const SECRET = 'sup3r-s3cret-hunter2-XyZ';

interface FakeLocatorOptions {
  /** Elements matched by the ref selector (0 simulates a stale ref). */
  count?: number;
  /** If set, locator.fill() rejects with this error. */
  fillError?: Error;
  /** HTML returned by page.content() (read_page tests). */
  html?: string;
}

interface FakeLocatorLog {
  filled: string[];
  pressed: string[];
}

function makeFakePage(opts: FakeLocatorOptions = {}): { page: Page; log: FakeLocatorLog } {
  const log: FakeLocatorLog = { filled: [], pressed: [] };
  const locator = {
    count: () => Promise.resolve(opts.count ?? 1),
    first: () => ({
      // describeLocator runs in-browser in production; here it just fails,
      // which executeAction degrades to the generic description "element".
      evaluate: () => Promise.reject(new Error('no browser in unit tests')),
    }),
    fill: (text: string) => {
      if (opts.fillError) return Promise.reject(opts.fillError);
      log.filled.push(text);
      return Promise.resolve();
    },
    press: (key: string) => {
      log.pressed.push(key);
      return Promise.resolve();
    },
    click: () => Promise.resolve(),
  };
  const page = {
    locator: () => locator,
    url: () => 'https://example.com/',
    waitForLoadState: () => Promise.resolve(),
    content: () => Promise.resolve(opts.html ?? '<html><body></body></html>'),
  } as unknown as Page;
  return { page, log };
}

function makeCtx(
  credentials: Record<string, string>,
  locatorOpts: FakeLocatorOptions = {},
): { ctx: ExecutionContext; log: FakeLocatorLog } {
  const { page, log } = makeFakePage(locatorOpts);
  return { ctx: { page, credentials, provider: fakeProvider }, log };
}

describe('executeAction — credential placeholder substitution', () => {
  it('fills the real value but echoes only the {{cred:NAME}} placeholder', async () => {
    const { ctx, log } = makeCtx({ PASSWORD: SECRET });

    const observation = await executeAction(ctx, 'type', {
      ref: 'e3',
      text: '{{cred:PASSWORD}}',
    });

    // The page received the real secret...
    expect(log.filled).toEqual([SECRET]);
    // ...but the observation never does — only the placeholder form.
    expect(observation).toContain('{{cred:PASSWORD}}');
    expect(observation).not.toContain(SECRET);
  });

  it('substitutes placeholders embedded in larger text and supports submit', async () => {
    const { ctx, log } = makeCtx({ TOKEN: SECRET });

    const observation = await executeAction(ctx, 'type', {
      ref: 'e1',
      text: 'Bearer {{cred:TOKEN}}',
      submit: true,
    });

    expect(log.filled).toEqual([`Bearer ${SECRET}`]);
    expect(log.pressed).toEqual(['Enter']);
    expect(observation).toContain('Bearer {{cred:TOKEN}}');
    expect(observation).not.toContain(SECRET);
  });

  it('rejects unknown credential names, listing names only — never values', async () => {
    const { ctx, log } = makeCtx({ PASSWORD: SECRET, API_KEY: 'another-secret-value' });

    const observation = await executeAction(ctx, 'type', {
      ref: 'e3',
      text: '{{cred:NOPE}}',
    });

    expect(observation).toMatch(/^Error: unknown credential name\(s\): NOPE/);
    expect(observation).toContain('Available credential names: API_KEY, PASSWORD');
    expect(observation).not.toContain(SECRET);
    expect(observation).not.toContain('another-secret-value');
    // Nothing was typed into the page.
    expect(log.filled).toEqual([]);
  });

  it('scrubs credential values that leak through thrown errors', async () => {
    const { ctx } = makeCtx(
      { PASSWORD: SECRET },
      { fillError: new Error(`element rejected value "${SECRET}"`) },
    );

    const observation = await executeAction(ctx, 'type', {
      ref: 'e3',
      text: '{{cred:PASSWORD}}',
    });

    expect(observation).toMatch(/^Error:/);
    expect(observation).not.toContain(SECRET);
    expect(observation).toContain('{{cred:PASSWORD}}');
  });
});

describe('executeAction — error observations', () => {
  it('returns an unknown-tool error listing the available tools', async () => {
    const { ctx } = makeCtx({});

    const observation = await executeAction(ctx, 'teleport', {});

    expect(observation).toContain('Error: unknown tool "teleport"');
    for (const tool of AGENT_TOOLS) {
      expect(observation).toContain(tool.name);
    }
  });

  it('returns a stale-ref error when the ref matches no element', async () => {
    const { ctx } = makeCtx({}, { count: 0 });

    const observation = await executeAction(ctx, 'click', { ref: 'e999' });

    expect(observation).toContain('Error: ref e999 not found');
    expect(observation).toContain('refs go stale after navigation');
  });

  it('turns malformed refs into an error observation instead of throwing', async () => {
    const { ctx } = makeCtx({});

    const observation = await executeAction(ctx, 'click', { ref: 'not-a-ref' });

    expect(observation).toMatch(/^Error:.*Invalid element ref "not-a-ref"/);
  });

  it('turns invalid input into an error observation instead of throwing', async () => {
    const { ctx } = makeCtx({});

    const observation = await executeAction(ctx, 'click', {});

    expect(observation).toMatch(/^Error: invalid input for click/);
  });
});

describe('executeAction — search and read_page', () => {
  it('registers search and read_page before the terminal done/fail tools', () => {
    const names = AGENT_TOOLS.map((tool) => tool.name);
    expect(names.indexOf('search')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('search')).toBeLessThan(names.indexOf('done'));
    expect(names.indexOf('read_page')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('read_page')).toBeLessThan(names.indexOf('done'));
  });

  it('rejects search input without a query (validated before any page is opened)', async () => {
    const { ctx } = makeCtx({});

    const observation = await executeAction(ctx, 'search', {});

    expect(observation).toMatch(/^Error: invalid input for search/);
    expect(observation).toContain('query');
  });

  it('rejects out-of-range search maxResults', async () => {
    const { ctx } = makeCtx({});

    const observation = await executeAction(ctx, 'search', { query: 'nanofish', maxResults: 50 });

    expect(observation).toMatch(/^Error: invalid input for search/);
    expect(observation).toContain('maxResults');
  });

  it('rejects out-of-range read_page maxChars', async () => {
    const { ctx } = makeCtx({});

    const observation = await executeAction(ctx, 'read_page', { maxChars: 100 });

    expect(observation).toMatch(/^Error: invalid input for read_page/);
    expect(observation).toContain('maxChars');
  });

  it('read_page converts the current page content to Markdown without navigating', async () => {
    const { ctx } = makeCtx(
      {},
      { html: '<html><body><h1>Hello</h1><p>Plain prose paragraph.</p></body></html>' },
    );

    const observation = await executeAction(ctx, 'read_page', {});

    expect(observation).toContain('Page content as Markdown:');
    expect(observation).toContain('Hello');
    expect(observation).toContain('Plain prose paragraph.');
  });
});
