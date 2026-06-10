/**
 * E2E suite for the sortie playground UI, run against the real stack:
 * production server + SQLite store + browser-worker queue + a live LLM.
 *
 * Exactly ONE live LLM call happens in this suite (the 'book list' extract
 * run); every later test (history, exports) reuses the run it created, so
 * the file must run on a single worker in declaration order (enforced by
 * playwright.config.ts and the serial describe block).
 *
 * Review artifacts: full-page PNGs of each major UI state are written to
 * apps/ui/e2e-artifacts/ for human review.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const ARTIFACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'e2e-artifacts');

const POETRY_URL = 'https://books.toscrape.com/catalogue/category/books/poetry_23/index.html';
const POETRY_BOOK_COUNT = 19;
const INSTRUCTION_PLACEHOLDER = 'the list of books on the page';

/** Full-page capture of a major UI state for human review. */
async function captureState(page: Page, name: string): Promise<void> {
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  await page.screenshot({ path: join(ARTIFACTS_DIR, `${name}.png`), fullPage: true });
}

/** The run created by the live flow; later tests assert against it. */
let liveRunId = '';

// ---------------------------------------------------------------------------
// 1. Shell
// ---------------------------------------------------------------------------

test.describe('shell', () => {
  test('serves the app: nav renders and the WS dot turns connected', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('nav.nav .wordmark')).toHaveText('sortie');
    await expect(page.getByRole('link', { name: 'New Run' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Runs' })).toBeVisible();
    // The dot flips to .on once /api/events is open.
    await expect(page.locator('.ws-dot.on')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.ws-dot.on')).toHaveAttribute('title', /connected/);
  });

  test('Runs view is initially empty or lists runs', async ({ page }) => {
    await page.goto('/#/runs');
    await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
    // Fresh data dir => empty state; tolerate an existing table per spec.
    await expect(page.locator('.empty-state, table.runs-table').first()).toBeVisible();
    // The status filter toolbar is always present.
    await expect(page.getByRole('button', { name: 'all', exact: true })).toBeVisible();
  });

  test('health endpoint answers ok', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. New Run form UX
// ---------------------------------------------------------------------------

test.describe('new run form', () => {
  test('invalid schema JSON disables submit and shows the invalid indicator', async ({ page }) => {
    await page.goto('/#/new');
    await page.locator('input[type="url"]').fill('https://example.com');
    await page.locator('textarea.mono').fill('{ this is not JSON');
    await expect(page.locator('.json-indicator.invalid')).toBeVisible();
    await expect(page.locator('.json-indicator.invalid')).toContainText('✗');
    await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled();
    // Recovering to valid JSON re-enables submit.
    await page.locator('textarea.mono').fill('{"type":"object"}');
    await expect(page.locator('.json-indicator.valid')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start run' })).toBeEnabled();
  });

  test('empty schema on extract kind keeps submit disabled', async ({ page }) => {
    await page.goto('/#/new');
    await page.locator('input[type="url"]').fill('https://example.com');
    await expect(page.locator('.json-indicator.invalid')).toHaveText('required for extract');
    await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled();
  });

  test('preset button fills a valid schema and enables submit', async ({ page }) => {
    await page.goto('/#/new');
    await page.getByRole('button', { name: 'preset: book list' }).click();
    await expect(page.locator('input[type="url"]')).toHaveValue('https://books.toscrape.com');
    await expect(page.getByPlaceholder(INSTRUCTION_PLACEHOLDER)).toHaveValue(
      'the list of books on the page',
    );
    await expect(page.locator('.json-indicator.valid')).toContainText('valid JSON');
    const schemaText = await page.locator('textarea.mono').inputValue();
    const schema = JSON.parse(schemaText) as { required?: string[] };
    expect(schema.required).toContain('books');
    await expect(page.getByRole('button', { name: 'Start run' })).toBeEnabled();
  });

  test('kind toggle swaps the instruction/goal fields', async ({ page }) => {
    await page.goto('/#/new');
    // extract (default): instruction input, no goal textarea, no max steps.
    await expect(page.getByPlaceholder(INSTRUCTION_PLACEHOLDER)).toBeVisible();
    await expect(page.getByText('Goal', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Max steps')).toHaveCount(0);

    await page.getByRole('button', { name: 'agent', exact: true }).click();
    await expect(page.getByText('Goal', { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder(/log in as standard_user/)).toBeVisible();
    await expect(page.getByPlaceholder(INSTRUCTION_PLACEHOLDER)).toHaveCount(0);
    await expect(page.getByText('Max steps')).toBeVisible();
    await expect(page.getByText('Start URL')).toBeVisible();

    await page.getByRole('button', { name: 'extract', exact: true }).click();
    await expect(page.getByPlaceholder(INSTRUCTION_PLACEHOLDER)).toBeVisible();
    await expect(page.getByText('Goal', { exact: true })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// 3-5. The live flow and everything that reuses its run
// ---------------------------------------------------------------------------

test.describe.serial('live extract run', () => {
  test('book list preset runs to success with live screenshot and output', async ({ page }) => {
    test.setTimeout(420_000); // navigation + queue + a real LLM call

    await page.goto('/#/new');
    await page.getByRole('button', { name: 'preset: book list' }).click();
    await page.locator('input[type="url"]').fill(POETRY_URL);
    await page.getByPlaceholder(INSTRUCTION_PLACEHOLDER).fill('all books on this page');
    await expect(page.getByRole('button', { name: 'Start run' })).toBeEnabled();
    await captureState(page, '01-new-run-form');

    // Submit redirects straight to the run detail view.
    await page.getByRole('button', { name: 'Start run' }).click();
    await page.waitForURL(/#\/runs\/[^/]+$/, { timeout: 15_000 });
    const match = /#\/runs\/([^/]+)$/.exec(page.url());
    expect(match?.[1]).toBeTruthy();
    liveRunId = decodeURIComponent(match![1]!);

    const chip = page.locator('.run-header .chip');
    await expect(chip).toHaveText(/queued|running/, { timeout: 30_000 });
    await expect(chip).toHaveText('running', { timeout: 60_000 });
    await expect(page.locator('.kind-badge')).toHaveText('extract');
    await captureState(page, '02-run-detail-running');

    await expect(chip).toHaveText('success', { timeout: 300_000 });

    // A screenshot actually rendered in the live pane.
    const img = page.locator('.screenshot-box img');
    await expect(img).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);

    // Event activity reached the live view: the screenshot event advanced
    // the "step #N" hint next to the pane title.
    await expect(page.locator('.pane-title .hint').first()).toHaveText(/step #\d+/);

    // Final output JSON: a books array with all 19 poetry titles.
    await expect(page.locator('pre.json')).toBeVisible({ timeout: 15_000 });
    const output = JSON.parse(await page.locator('pre.json').innerText()) as {
      books: Array<{ title: string; price: number }>;
    };
    expect(Array.isArray(output.books)).toBe(true);
    expect(output.books).toHaveLength(POETRY_BOOK_COUNT);
    for (const book of output.books) {
      expect(typeof book.title).toBe('string');
      expect(book.title.length).toBeGreaterThan(0);
      expect(typeof book.price).toBe('number');
    }

    // The step log reflects the run: extract runs have no agent steps and
    // the timeline says so explicitly.
    await expect(page.locator('.timeline-empty')).toHaveText('Extract runs have no agent steps.');

    await captureState(page, '03-run-detail-success');
  });

  test('Runs history lists the run; filters and row navigation work', async ({ page }) => {
    expect(liveRunId, 'live run must have been created').not.toBe('');
    const shortId = liveRunId.slice(0, 8);

    await page.goto('/#/runs');
    const row = page
      .locator('table.runs-table tbody tr')
      .filter({ has: page.getByText(shortId, { exact: true }) });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.chip')).toHaveText('success');
    await expect(row).toContainText('extract');
    await expect(row).toContainText(POETRY_URL);
    await captureState(page, '04-runs-history');

    // Status filter chips: 'failed' shows the empty state on a fresh data
    // dir, 'success' shows the run again, 'all' restores everything.
    await page.getByRole('button', { name: 'failed', exact: true }).click();
    await expect(page.locator('.empty-state')).toHaveText('No failed runs.');
    await expect(row).toHaveCount(0);
    await page.getByRole('button', { name: 'success', exact: true }).click();
    await expect(row).toHaveCount(1);
    await page.getByRole('button', { name: 'all', exact: true }).click();
    await expect(row).toHaveCount(1);

    // Row click returns to the run detail view.
    await row.click();
    await expect(page).toHaveURL(new RegExp(`#/runs/${liveRunId}$`));
    await expect(page.locator('.run-header .chip')).toHaveText('success');
    // Replay: the persisted screenshot loads on a fresh detail mount too.
    const img = page.locator('.screenshot-box img');
    await expect(img).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
  });

  test('Download JSON produces a parseable blob containing the books array', async ({ page }) => {
    expect(liveRunId, 'live run must have been created').not.toBe('');
    await page.goto(`/#/runs/${liveRunId}`);
    await expect(page.locator('.run-header .chip')).toHaveText('success');

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download JSON' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(`run-${liveRunId.slice(0, 8)}.json`);

    const filePath = await download.path();
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as {
      id: string;
      status: string;
      output: { books: unknown[] };
    };
    expect(parsed.id).toBe(liveRunId);
    expect(parsed.status).toBe('success');
    expect(parsed.output.books).toHaveLength(POETRY_BOOK_COUNT);
  });

  test('GET /api/export (no batch filter) includes the run', async ({ request }) => {
    expect(liveRunId, 'live run must have been created').not.toBe('');

    const res = await request.get('/api/export?format=json');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/json');
    expect(res.headers()['content-disposition']).toContain('export.json');
    const runs = (await res.json()) as Array<{
      id: string;
      url: string;
      status: string;
      output?: { books?: unknown[] };
    }>;
    const run = runs.find((r) => r.id === liveRunId);
    expect(run).toBeDefined();
    expect(run!.status).toBe('success');
    expect(run!.url).toBe(POETRY_URL);
    expect(run!.output?.books).toHaveLength(POETRY_BOOK_COUNT);

    // CSV export also answers (flattened: one row per book + header).
    const csv = await request.get('/api/export?format=csv');
    expect(csv.status()).toBe(200);
    expect(csv.headers()['content-type']).toContain('text/csv');
    const csvText = await csv.text();
    expect(csvText).toContain(liveRunId);
    expect(csvText.trim().split('\n').length).toBeGreaterThan(POETRY_BOOK_COUNT);
  });
});

// ---------------------------------------------------------------------------
// 6. API robustness
// ---------------------------------------------------------------------------

test.describe('api robustness', () => {
  test('unknown run id answers 404 with a JSON error', async ({ request }) => {
    const res = await request.get('/api/runs/00000000-0000-0000-0000-000000000000');
    expect(res.status()).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('Run not found.');
  });

  test('invalid specs answer 400 with problem details', async ({ request }) => {
    const res = await request.post('/api/runs', {
      data: { spec: { kind: 'bogus', url: '' } },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string; details?: string[] };
    expect(body.error).toBe('Invalid run spec.');
    expect(body.details?.length).toBeGreaterThan(0);

    // extract without a schema is rejected too.
    const noSchema = await request.post('/api/runs', {
      data: { spec: { kind: 'extract', url: 'https://example.com' } },
    });
    expect(noSchema.status()).toBe(400);

    // Missing spec entirely.
    const noSpec = await request.post('/api/runs', { data: {} });
    expect(noSpec.status()).toBe(400);
  });

  test('export rejects unknown formats', async ({ request }) => {
    const res = await request.get('/api/export?format=xml');
    expect(res.status()).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Invalid query parameters.');
  });

  test('screenshot path traversal attempts are rejected', async ({ request }) => {
    // Encoded traversal in the run id segment.
    const idTraversal = await request.get('/api/runs/..%2F../screenshots/0');
    expect([400, 404]).toContain(idTraversal.status());
    expect(idTraversal.headers()['content-type'] ?? '').not.toContain('image');

    // Traversal in the screenshot index segment.
    const idxTraversal = await request.get('/api/runs/abcdef/screenshots/..%2F..%2Fsortie.db');
    expect([400, 404]).toContain(idxTraversal.status());
    expect(idxTraversal.headers()['content-type'] ?? '').not.toContain('image');

    // Raw (un-encoded) traversal must not escape either.
    const raw = await request.get('/api/runs/../../screenshots/0');
    expect(raw.status()).not.toBe(500);
    expect(raw.headers()['content-type'] ?? '').not.toContain('image');
  });
});
