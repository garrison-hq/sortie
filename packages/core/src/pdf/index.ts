/**
 * PDF download + text extraction.
 *
 * PDFs are downloaded through a Playwright `APIRequestContext` (it shares the
 * browser context's cookies, so authenticated PDFs work) and parsed with
 * unpdf's serverless pdf.js build. Hard caps keep pathological documents from
 * blowing up memory or LLM context: 20MB download, 100 pages, 200k extracted
 * characters.
 *
 * Headless Chromium aborts PDF navigations (net::ERR_ABORTED), so callers
 * detect PDFs three ways: URL suffix (`isPdfUrl`), the goto response's
 * content-type, or a HEAD/GET header sniff (`sniffPdfResponse`).
 */
import type { APIRequestContext } from 'playwright';
import { z } from 'zod';
import { extractText, getDocumentProxy, getMeta } from 'unpdf';
import type { PageSnapshot, PdfDocument } from '../contracts.js';

/** Download size cap — refuse anything larger before parsing. */
export const PDF_MAX_BYTES = 20 * 1024 * 1024;
/** Page cap applied during text extraction. */
export const PDF_MAX_PAGES = 100;
/** Character cap across all extracted pages. */
export const PDF_MAX_CHARS = 200_000;

/** Outline used for PDF snapshots — there is no live DOM to distill. */
export const PDF_SNAPSHOT_OUTLINE = '(PDF document — no interactive elements)';

const SNAPSHOT_TEXT_MAX = 12_000;
const TRUNCATION_MARKER = '...[truncated]';
/** The %PDF header must appear within the first 1024 bytes (per spec). */
const PDF_MAGIC = '%PDF-';

/**
 * True for navigation errors that mean the browser refused to render the
 * resource inline — the signature of a PDF (or other download) navigation.
 * Headless Chromium classically aborts these with `net::ERR_ABORTED`; newer
 * versions start a download instead ("page.goto: Download is starting").
 * Callers follow up with `sniffPdfResponse` before treating it as a PDF.
 */
export function isAbortedNavigation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('ERR_ABORTED') || err.message.includes('Download is starting');
}

/** True when the URL's pathname ends in ".pdf" (query/hash ignored). */
export function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

/**
 * Sniff whether `url` serves a PDF without downloading the body: HEAD first,
 * falling back to a GET (headers only — body discarded) for servers that
 * reject HEAD. Returns false on any network failure; callers treat that as
 * "not a PDF" and let the normal navigation error surface instead.
 */
export async function sniffPdfResponse(request: APIRequestContext, url: string): Promise<boolean> {
  try {
    const head = await request.head(url);
    if (head.ok()) {
      return isPdfContentType(head.headers()['content-type']);
    }
  } catch {
    // Some servers reject HEAD entirely — fall through to GET.
  }

  try {
    const response = await request.get(url);
    const result = response.ok() && isPdfContentType(response.headers()['content-type']);
    await response.dispose();
    return result;
  } catch {
    return false;
  }
}

function isPdfContentType(value: string | undefined): boolean {
  return (value ?? '').toLowerCase().includes('application/pdf');
}

export interface DownloadPdfOptions {
  /** Size cap in bytes. Default 20MB. */
  maxBytes?: number;
}

/**
 * Download a PDF through `request` (sharing the browser context's cookies).
 * Throws on non-2xx responses, on bodies exceeding `maxBytes` (checked
 * against the Content-Length header before the body is read, then against
 * the actual bytes), and on responses that are not PDFs at all.
 */
export async function downloadPdf(
  request: APIRequestContext,
  url: string,
  opts: DownloadPdfOptions = {},
): Promise<Uint8Array> {
  const maxBytes = opts.maxBytes ?? PDF_MAX_BYTES;
  const response = await request.get(url);

  try {
    if (!response.ok()) {
      throw new Error(
        `downloadPdf: ${url} responded ${response.status()} ${response.statusText()}.`,
      );
    }

    const declared = Number(response.headers()['content-length'] ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(
        `downloadPdf: ${url} declares ${declared} bytes, over the ${maxBytes}-byte cap.`,
      );
    }

    const body = await response.body();
    if (body.byteLength > maxBytes) {
      throw new Error(
        `downloadPdf: ${url} is ${body.byteLength} bytes, over the ${maxBytes}-byte cap.`,
      );
    }
    if (!body.subarray(0, 1024).includes(PDF_MAGIC)) {
      const contentType = response.headers()['content-type'] ?? 'unknown';
      throw new Error(
        `downloadPdf: response from ${url} is not a PDF (no %PDF header; content-type: ${contentType}).`,
      );
    }

    return body;
  } finally {
    await response.dispose().catch(() => {});
  }
}

export interface PdfToDocumentOptions {
  /** Page cap. Default 100. */
  maxPages?: number;
  /** Character cap across all included pages. Default 200_000. */
  maxChars?: number;
}

/** Title from PDF metadata — anything non-string or blank becomes undefined. */
const PdfTitleSchema = z.string().trim().min(1);

/**
 * Parse PDF bytes into a `PdfDocument`: metadata title (when present) plus
 * per-page extracted text, capped at `maxPages` pages and `maxChars` total
 * characters (`truncated` flags any cut). Throws on unparseable bytes.
 */
export async function pdfToDocument(
  data: Uint8Array,
  opts: PdfToDocumentOptions = {},
): Promise<PdfDocument> {
  const maxPages = opts.maxPages ?? PDF_MAX_PAGES;
  const maxChars = opts.maxChars ?? PDF_MAX_CHARS;

  // pdf.js may transfer (detach) the buffer it is handed — parse a copy so
  // the caller's bytes stay usable.
  const pdf = await getDocumentProxy(new Uint8Array(data));
  try {
    let title: string | undefined;
    try {
      const { info } = await getMeta(pdf);
      const parsed = PdfTitleSchema.safeParse(info['Title']);
      title = parsed.success ? parsed.data : undefined;
    } catch {
      // Metadata is optional — a missing/corrupt Info dictionary is fine.
    }

    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const included = text.slice(0, maxPages);
    let truncated = totalPages > included.length;

    const pages: string[] = [];
    let remaining = maxChars;
    for (const raw of included) {
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const pageText = raw.trim();
      if (pageText.length > remaining) {
        pages.push(pageText.slice(0, remaining));
        remaining = 0;
        truncated = true;
      } else {
        pages.push(pageText);
        remaining -= pageText.length;
      }
    }

    return { title, numPages: totalPages, pages, truncated };
  } finally {
    await pdf.destroy();
  }
}

/**
 * Render a `PdfDocument` as Markdown: optional `# title` heading, then each
 * page's text under a `--- Page N ---` marker. Pure — length capping is the
 * caller's job (the fetch module applies `maxChars`).
 */
export function pdfToMarkdown(doc: PdfDocument): string {
  const parts: string[] = [];
  if (doc.title) {
    parts.push(`# ${doc.title}`);
  }
  doc.pages.forEach((pageText, i) => {
    parts.push(`--- Page ${i + 1} ---`);
    if (pageText.length > 0) {
      parts.push(pageText);
    }
  });
  return parts.join('\n\n');
}

/**
 * Build a `PageSnapshot` for a PDF so extraction/agent flows that consume
 * snapshots work unchanged: no elements, a fixed outline explaining the
 * absence, and page-marked text capped at 12k characters.
 */
export function pdfToSnapshot(url: string, doc: PdfDocument): PageSnapshot {
  let text = doc.pages.map((pageText, i) => `--- Page ${i + 1} ---\n${pageText}`).join('\n\n');
  if (text.length > SNAPSHOT_TEXT_MAX) {
    text = text.slice(0, SNAPSHOT_TEXT_MAX - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
  }

  return {
    url,
    title: doc.title ?? fileNameFromUrl(url) ?? 'PDF document',
    outline: PDF_SNAPSHOT_OUTLINE,
    elements: [],
    text,
  };
}

function fileNameFromUrl(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split('/').at(-1);
    return last || undefined;
  } catch {
    return undefined;
  }
}
