/**
 * Live verification of @nanofish/core's PDF support against a real paper.
 *
 * Run from the repo root (extract step needs the provider key in .env):
 *   npx tsx examples/verify-pdf.ts
 *
 * Target: https://arxiv.org/pdf/1706.03762 ("Attention Is All You Need").
 *
 * Checks:
 *   1. fetchPage() on a PDF URL: contentType 'pdf', page markers in the
 *      markdown, recognizable paper text.
 *   2. extract() on the same PDF URL (pdfToSnapshot path): schema-validated
 *      {title, authors} where the title matches the paper and the authors
 *      include Vaswani.
 */
// Import the built package directly (the repo root is not a workspace consumer
// of @nanofish/core, so the bare specifier is not resolvable from examples/).
import {
  createProvider,
  extract,
  fetchPage,
  jsonSchemaToZod,
} from '../packages/core/dist/index.js';

const PDF_URL = 'https://arxiv.org/pdf/1706.03762';

let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  const status = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  console.log(`[${status}] ${label}${detail ? ` — ${detail}` : ''}`);
}

function loadDotEnv(): void {
  try {
    process.loadEnvFile(new URL('../.env', import.meta.url).pathname);
  } catch {
    // .env missing — rely on the ambient environment.
  }
}

async function main(): Promise<void> {
  loadDotEnv();

  // --- 1. fetchPage on a PDF URL -------------------------------------------
  const result = await fetchPage({ url: PDF_URL });
  check('fetch: contentType is pdf', result.contentType === 'pdf');
  check(
    'fetch: markdown contains page markers',
    result.markdown.includes('--- Page 1 ---') && result.markdown.includes('--- Page 2 ---'),
  );
  check(
    'fetch: paper title text present',
    /attention is all you need/i.test(result.markdown),
    `markdown length=${result.markdown.length}`,
  );
  check(
    'fetch: recognizable paper prose present',
    /transformer/i.test(result.markdown) && /self-attention/i.test(result.markdown),
  );

  console.log('\n--- PDF markdown, first 8 lines ---');
  for (const line of result.markdown.split('\n').slice(0, 8)) console.log(line);
  console.log('--- end excerpt ---\n');

  // --- 2. extract() on the PDF (snapshot path, needs an LLM key) -----------
  const schema = jsonSchemaToZod({
    type: 'object',
    properties: {
      title: { type: 'string' },
      authors: { type: 'array', items: { type: 'string' } },
    },
    required: ['title', 'authors'],
  });
  const provider = createProvider();
  console.log(`Provider: ${provider.id} — extracting {title, authors} from the PDF...`);
  const extracted = await extract({
    url: PDF_URL,
    schema,
    instruction: 'the title of this paper and the list of its authors',
    provider,
  });
  const data = extracted.data as { title: string; authors: string[] };
  check(
    'extract: title matches the paper',
    /attention is all you need/i.test(data.title),
    `title=${JSON.stringify(data.title)}`,
  );
  check(
    'extract: authors include Vaswani',
    data.authors.some((a) => /vaswani/i.test(a)),
    `authors=${JSON.stringify(data.authors)}`,
  );
  check(
    'extract: several authors returned',
    data.authors.length >= 3,
    `${data.authors.length} authors`,
  );

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error('verify-pdf failed:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
