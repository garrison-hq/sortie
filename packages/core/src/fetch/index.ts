/**
 * URL -> clean Markdown fetch (HTML or PDF).
 *
 * HTML pages are navigated with Playwright, then `page.content()` (the
 * post-JS DOM) is reduced to main-content Markdown via Readability with a
 * boilerplate-stripping fallback. PDFs are detected three ways — `.pdf` URL
 * suffix (pre-route, no navigation), the goto response's content-type, or a
 * header sniff after `net::ERR_ABORTED` (headless Chromium aborts PDF
 * navigations) — and parsed via the pdf module.
 */
import type { Page, Response } from 'playwright';
import type { FetchPageOptions, FetchPageResult } from '../contracts.js';
import { BrowserManager } from '../browser/index.js';
import {
  downloadPdf,
  isAbortedNavigation,
  isPdfUrl,
  pdfToDocument,
  pdfToMarkdown,
  sniffPdfResponse,
} from '../pdf/index.js';
import {
  collectLinks,
  extractArticle,
  htmlToMarkdown,
  markdownToText,
  stripBoilerplate,
} from './markdown.js';

export {
  collectLinks,
  extractArticle,
  htmlToMarkdown,
  markdownToText,
  stripBoilerplate,
} from './markdown.js';
export type { ArticleContent } from './markdown.js';

/** Default cap on markdown/text length (queued fetch runs use 40k). */
export const FETCH_MAX_CHARS = 80_000;

const TRUNCATION_MARKER = '...[truncated]';
const NETWORK_IDLE_TIMEOUT_MS = 10_000;

/**
 * Fetch `opts.url` and return its main content as Markdown (plus a plain-text
 * rendering). Works on HTML pages and PDFs. Either reuses `opts.page`
 * (navigating it to the URL) or launches a browser and cleans it up.
 */
export async function fetchPage(opts: FetchPageOptions): Promise<FetchPageResult> {
  const maxChars = opts.maxChars ?? FETCH_MAX_CHARS;
  let manager: BrowserManager | undefined;
  let page = opts.page;

  try {
    if (!page) {
      manager = new BrowserManager();
      await manager.launch({ headless: opts.headless });
      page = await manager.newPage({ storageStatePath: opts.storageStatePath });
    }

    // PDF pre-route: obvious PDF URLs skip navigation entirely.
    if (isPdfUrl(opts.url)) {
      return await fetchPdf(page, opts, opts.url, maxChars);
    }

    let response: Response | null;
    try {
      response = await page.goto(opts.url, { waitUntil: 'domcontentloaded' });
    } catch (err) {
      // Headless Chromium aborts PDF navigations — sniff before surfacing.
      if (isAbortedNavigation(err) && (await sniffPdfResponse(page.context().request, opts.url))) {
        return await fetchPdf(page, opts, opts.url, maxChars);
      }
      throw err;
    }
    if (isPdfContentType(response?.headers()['content-type'])) {
      return await fetchPdf(page, opts, response?.url() ?? opts.url, maxChars);
    }

    // Settle like extract() does: network-idle capped, never throws.
    await page
      .waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS })
      .catch(() => {});

    return await fetchHtml(page, opts, maxChars);
  } finally {
    if (manager) {
      await manager.close();
    }
  }
}

/** HTML branch: post-JS DOM -> article (or stripped body) -> Markdown. */
async function fetchHtml(
  page: Page,
  opts: FetchPageOptions,
  maxChars: number,
): Promise<FetchPageResult> {
  const html = await page.content();
  const finalUrl = page.url();

  const article = extractArticle(html, finalUrl);
  const contentHtml = article?.contentHtml ?? stripBoilerplate(html, finalUrl);
  const markdown = cap(htmlToMarkdown(contentHtml), maxChars);
  const text = cap(markdownToText(markdown.value), maxChars);
  const title = article?.title ?? (await page.title());

  return {
    url: opts.url,
    finalUrl,
    title,
    markdown: markdown.value,
    text: text.value,
    ...(opts.includeLinks ? { links: collectLinks(contentHtml, finalUrl) } : {}),
    contentType: 'html',
    truncated: markdown.truncated || text.truncated,
  };
}

/** PDF branch: download via the context's request (shares cookies) + parse. */
async function fetchPdf(
  page: Page,
  opts: FetchPageOptions,
  finalUrl: string,
  maxChars: number,
): Promise<FetchPageResult> {
  const data = await downloadPdf(page.context().request, finalUrl);
  const doc = await pdfToDocument(data);
  const markdown = cap(pdfToMarkdown(doc), maxChars);
  const text = cap(doc.pages.join('\n\n'), maxChars);

  return {
    url: opts.url,
    finalUrl,
    title: doc.title ?? fileNameFromUrl(finalUrl) ?? 'PDF document',
    markdown: markdown.value,
    text: text.value,
    ...(opts.includeLinks ? { links: [] } : {}),
    contentType: 'pdf',
    truncated: doc.truncated || markdown.truncated || text.truncated,
  };
}

/** Cut `value` at `maxChars`, ending in the truncation marker when cut. */
function cap(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { value, truncated: false };
  }
  const keep = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  return { value: value.slice(0, keep) + TRUNCATION_MARKER, truncated: true };
}

function isPdfContentType(value: string | undefined): boolean {
  return (value ?? '').toLowerCase().includes('application/pdf');
}

function fileNameFromUrl(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split('/').at(-1);
    return last || undefined;
  } catch {
    return undefined;
  }
}
