/**
 * Live verification of @nanofish/core's browser layer against a real page.
 *
 * Run from the repo root:
 *   npx tsx examples/verify-browser.ts
 *
 * Checks (against https://books.toscrape.com/):
 *   1. BrowserManager launches chromium and opens a page.
 *   2. distillPage() produces a PageSnapshot with:
 *      - title containing "Books"
 *      - >= 20 link elements
 *      - non-empty outline and text, both within their caps
 *   3. resolveRef() round-trip: a link ref resolves to exactly one Locator
 *      whose href matches the snapshot element's href.
 */
// Import the built package directly (the repo root is not a workspace consumer
// of @nanofish/core, so the bare specifier is not resolvable from examples/).
import { BrowserManager, distillPage, resolveRef } from '../packages/core/dist/index.js';

const TARGET_URL = 'https://books.toscrape.com/';
const OUTLINE_CAP = 15_000 + '...[truncated]'.length;
const TEXT_CAP = 12_000 + '...[truncated]'.length;

let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  const status = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  console.log(`[${status}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const manager = new BrowserManager();
  try {
    await manager.launch({ headless: true });
    const page = await manager.newPage();
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

    const snapshot = await distillPage(page);

    // --- Snapshot assertions -------------------------------------------------
    check(
      'snapshot.title contains "Books"',
      snapshot.title.includes('Books'),
      `title=${JSON.stringify(snapshot.title)}`,
    );

    const links = snapshot.elements.filter((el) => el.role === 'link');
    check(
      'snapshot.elements contains >= 20 links',
      links.length >= 20,
      `${links.length} links of ${snapshot.elements.length} total elements`,
    );

    check(
      'outline is non-empty and within cap',
      snapshot.outline.length > 0 && snapshot.outline.length <= OUTLINE_CAP,
      `outline length=${snapshot.outline.length} (cap=${OUTLINE_CAP})`,
    );

    check(
      'text is non-empty and within cap',
      snapshot.text.length > 0 && snapshot.text.length <= TEXT_CAP,
      `text length=${snapshot.text.length} (cap=${TEXT_CAP})`,
    );

    console.log('\n--- First 15 outline lines ---');
    for (const line of snapshot.outline.split('\n').slice(0, 15)) {
      console.log(line);
    }
    console.log('--- end outline excerpt ---\n');

    // --- resolveRef round trip ----------------------------------------------
    const link = links.find((el) => el.href !== undefined);
    if (!link || link.href === undefined) {
      check('found a link element with an href to round-trip', false);
    } else {
      const locator = resolveRef(page, link.ref);
      const count = await locator.count();
      check(`resolveRef("${link.ref}") matches exactly one element`, count === 1, `count=${count}`);

      const rawHref = await locator.getAttribute('href');
      // snapshot href is the resolved absolute URL; the attribute may be relative.
      const resolvedHref = rawHref === null ? null : new URL(rawHref, snapshot.url).toString();
      check(
        'round-tripped href matches snapshot element href',
        resolvedHref === link.href,
        `attribute=${JSON.stringify(rawHref)} resolved=${JSON.stringify(resolvedHref)} snapshot=${JSON.stringify(link.href)}`,
      );
    }
  } finally {
    await manager.close();
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error('verify-browser failed:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
