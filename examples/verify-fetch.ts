/**
 * Live verification of @garrison-hq/sortie's URL -> Markdown fetch on real pages.
 *
 * Run from the repo root:
 *   npx tsx examples/verify-fetch.ts
 *
 * Checks (no LLM key needed — fetchPage is deterministic):
 *   1. Wikipedia article (Readability path): markdown headings present,
 *      article prose present, nav/chrome boilerplate stripped.
 *   2. quotes.toscrape.com/js (JS-rendered): content that only exists after
 *      client-side rendering appears in the markdown.
 *   3. example.com (minimal page — exercises the Readability-null fallback):
 *      body text survives.
 *   4. maxChars truncation sets the truncated flag and the marker.
 */
// Import the built package directly (the repo root is not a workspace consumer
// of @garrison-hq/sortie, so the bare specifier is not resolvable from examples/).
import { fetchPage } from '../packages/core/dist/index.js';

let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  const status = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  console.log(`[${status}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  // --- 1. Wikipedia article (Readability main-content path) ---------------
  const wiki = await fetchPage({ url: 'https://en.wikipedia.org/wiki/Web_scraping' });
  check('wikipedia: contentType is html', wiki.contentType === 'html');
  check(
    'wikipedia: title mentions Web scraping',
    /web scraping/i.test(wiki.title),
    `title=${JSON.stringify(wiki.title)}`,
  );
  check(
    'wikipedia: markdown has headings',
    /^#{1,4} /m.test(wiki.markdown),
    `first heading: ${JSON.stringify(wiki.markdown.match(/^#{1,4} .*$/m)?.[0])}`,
  );
  check('wikipedia: article prose present', /data extraction|extracting data/i.test(wiki.markdown));
  const navJunk = ['Jump to content', 'Create account', 'Toggle the table of contents'].filter(
    (s) => wiki.markdown.includes(s),
  );
  check(
    'wikipedia: nav/chrome boilerplate stripped',
    navJunk.length === 0,
    navJunk.length > 0 ? `found: ${navJunk.join(', ')}` : `markdown length=${wiki.markdown.length}`,
  );

  console.log('\n--- wikipedia markdown, first 10 lines ---');
  for (const line of wiki.markdown.split('\n').slice(0, 10)) console.log(line);
  console.log('--- end excerpt ---\n');

  // --- 2. JS-rendered page (post-JS DOM is what gets converted) -----------
  const js = await fetchPage({ url: 'https://quotes.toscrape.com/js/' });
  check('quotes/js: contentType is html', js.contentType === 'html');
  check(
    'quotes/js: JS-rendered quote text present',
    js.text.includes('The world as we have created it'),
    `text length=${js.text.length}`,
  );
  check('quotes/js: a quote author present', js.text.includes('Albert Einstein'));

  // --- 3. Minimal page (Readability-null fallback path) -------------------
  const minimal = await fetchPage({ url: 'https://example.com/' });
  check('example.com: contentType is html', minimal.contentType === 'html');
  check(
    'example.com: body text survives the fallback',
    minimal.markdown.includes('Example Domain') || minimal.text.includes('Example Domain'),
    `markdown=${JSON.stringify(minimal.markdown.slice(0, 120))}`,
  );
  check('example.com: not truncated', minimal.truncated === false);

  // --- 4. Truncation contract ---------------------------------------------
  const tiny = await fetchPage({
    url: 'https://en.wikipedia.org/wiki/Web_scraping',
    maxChars: 500,
  });
  check('maxChars: truncated flag set', tiny.truncated === true);
  check(
    'maxChars: markdown capped with marker',
    tiny.markdown.length <= 500 + '...[truncated]'.length &&
      tiny.markdown.endsWith('...[truncated]'),
    `length=${tiny.markdown.length}`,
  );

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error('verify-fetch failed:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
