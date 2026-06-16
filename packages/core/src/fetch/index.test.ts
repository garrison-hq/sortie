import { describe, expect, it } from 'vitest';
import type { APIRequestContext, APIResponse, Page } from 'playwright';
import { FETCH_MAX_CHARS, fetchPage } from './index.js';

// ---------------------------------------------------------------------------
// Fixture: a minimal valid PDF built programmatically (same construction as
// pdf/index.test.ts) so the PDF branch needs no binary checked in.
// ---------------------------------------------------------------------------

function escapePdfString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('(', String.raw`\(`)
    .replaceAll(')', String.raw`\)`);
}

function buildFixturePdf(opts: { title?: string; pageTexts: string[] }): Uint8Array {
  const { title, pageTexts } = opts;
  const fontRef = 3 + pageTexts.length * 2;
  const kids = pageTexts.map((_, i) => `${3 + i * 2} 0 R`).join(' ');

  const objects: string[] = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageTexts.length} >>\nendobj\n`,
  ];
  pageTexts.forEach((text, i) => {
    const pageRef = 3 + i * 2;
    const contentRef = pageRef + 1;
    objects.push(
      `${pageRef} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontRef} 0 R >> >> /Contents ${contentRef} 0 R >>\nendobj\n`,
    );
    const stream = `BT /F1 12 Tf 72 720 Td (${escapePdfString(text)}) Tj ET`;
    objects.push(
      `${contentRef} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  });
  objects.push(
    `${fontRef} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
  );

  let infoRef: number | undefined;
  if (title !== undefined) {
    infoRef = fontRef + 1;
    objects.push(`${infoRef} 0 obj\n<< /Title (${escapePdfString(title)}) >>\nendobj\n`);
  }

  const header = '%PDF-1.4\n';
  const offsets: number[] = [];
  let offset = header.length;
  for (const obj of objects) {
    offsets.push(offset);
    offset += obj.length;
  }

  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  const infoEntry = infoRef === undefined ? '' : ` /Info ${infoRef} 0 R`;
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R` +
    `${infoEntry} >>\nstartxref\n${offset}\n%%EOF\n`;

  return new TextEncoder().encode(header + objects.join('') + xref + trailer);
}

// ---------------------------------------------------------------------------
// Mocks: just the Page/APIRequestContext surface fetchPage touches.
// ---------------------------------------------------------------------------

function mockResponse(opts: {
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer;
}): APIResponse {
  const status = opts.status ?? 200;
  return {
    ok: () => status >= 200 && status < 300,
    status: () => status,
    statusText: () => '',
    headers: () => opts.headers ?? {},
    body: async () => opts.body ?? Buffer.alloc(0),
    dispose: async () => {},
  } as unknown as APIResponse;
}

function mockRequest(handlers: {
  get?: () => Promise<APIResponse>;
  head?: () => Promise<APIResponse>;
}): APIRequestContext {
  return {
    get: handlers.get ?? (() => Promise.reject(new Error('unexpected GET'))),
    head: handlers.head ?? (() => Promise.reject(new Error('unexpected HEAD'))),
  } as unknown as APIRequestContext;
}

/** Request context serving `pdf` bytes for both the sniff and the download. */
function pdfRequest(pdf: Uint8Array): APIRequestContext {
  const headers = { 'content-type': 'application/pdf' };
  return mockRequest({
    head: async () => mockResponse({ headers }),
    get: async () => mockResponse({ headers, body: Buffer.from(pdf) }),
  });
}

interface MockPageOptions {
  html?: string;
  finalUrl?: string;
  title?: string;
  gotoError?: Error;
  responseContentType?: string;
  request?: APIRequestContext;
}

function mockPage(opts: MockPageOptions = {}): Page & { gotoCalls: string[] } {
  const gotoCalls: string[] = [];
  const page = {
    gotoCalls,
    goto: async (url: string) => {
      gotoCalls.push(url);
      if (opts.gotoError) throw opts.gotoError;
      return {
        headers: () => ({ 'content-type': opts.responseContentType ?? 'text/html' }),
        url: () => opts.finalUrl ?? url,
      };
    },
    waitForLoadState: async () => {},
    content: async () => opts.html ?? '<html><body><p>empty</p></body></html>',
    url: () => opts.finalUrl ?? 'https://example.com/page',
    title: async () => opts.title ?? 'Mock Title',
    context: () => ({ request: opts.request ?? mockRequest({}) }),
  };
  return page as unknown as Page & { gotoCalls: string[] };
}

// ---------------------------------------------------------------------------

const PAGE_HTML = `<html><head><title>Doc — Site</title></head><body>
  <nav><a href="/home">Home</a></nav>
  <h1>Heading</h1>
  <p>Body copy with a <a href="/rel/path">relative link</a>.</p>
  <footer>footer junk</footer>
</body></html>`;

describe('fetchPage (HTML branch)', () => {
  it('navigates the injected page and returns boilerplate-free markdown', async () => {
    const page = mockPage({
      html: PAGE_HTML,
      finalUrl: 'https://example.com/doc',
      title: 'Doc — Site',
    });
    const result = await fetchPage({ url: 'https://example.com/start', page });

    expect(page.gotoCalls).toEqual(['https://example.com/start']);
    expect(result.url).toBe('https://example.com/start');
    expect(result.finalUrl).toBe('https://example.com/doc');
    expect(result.contentType).toBe('html');
    expect(result.title).toBe('Doc — Site');
    expect(result.markdown).toContain('# Heading');
    expect(result.markdown).toContain('Body copy');
    expect(result.markdown).toContain('https://example.com/rel/path');
    expect(result.markdown).not.toContain('footer junk');
    expect(result.text).toContain('relative link');
    expect(result.truncated).toBe(false);
    expect(result.links).toBeUndefined();
  });

  it('collects absolute links when includeLinks is set', async () => {
    const page = mockPage({ html: PAGE_HTML, finalUrl: 'https://example.com/doc' });
    const result = await fetchPage({
      url: 'https://example.com/doc',
      page,
      includeLinks: true,
    });

    expect(result.links).toEqual([{ text: 'relative link', url: 'https://example.com/rel/path' }]);
  });

  it('caps markdown and text at maxChars with a truncation marker', async () => {
    const page = mockPage({ html: PAGE_HTML });
    const result = await fetchPage({ url: 'https://example.com/doc', page, maxChars: 40 });

    expect(result.truncated).toBe(true);
    expect(result.markdown.length).toBeLessThanOrEqual(40);
    expect(result.markdown.endsWith('...[truncated]')).toBe(true);
    expect(result.text.endsWith('...[truncated]')).toBe(true);
  });

  it('defaults maxChars to 80k', () => {
    expect(FETCH_MAX_CHARS).toBe(80_000);
  });

  it('surfaces non-PDF navigation errors unchanged', async () => {
    const boom = new Error('net::ERR_NAME_NOT_RESOLVED at https://nope.invalid/');
    const page = mockPage({ gotoError: boom });
    await expect(fetchPage({ url: 'https://nope.invalid/', page })).rejects.toBe(boom);
  });

  it('rethrows ERR_ABORTED when the sniff says the URL is not a PDF', async () => {
    const boom = new Error('net::ERR_ABORTED at https://example.com/weird');
    const page = mockPage({
      gotoError: boom,
      request: mockRequest({
        head: async () => mockResponse({ headers: { 'content-type': 'text/html' } }),
      }),
    });
    await expect(fetchPage({ url: 'https://example.com/weird', page })).rejects.toBe(boom);
  });
});

describe('fetchPage (PDF branch)', () => {
  const pdf = buildFixturePdf({
    title: 'Attention Is All You Need',
    pageTexts: ['First page text', 'Second page text'],
  });

  it('pre-routes .pdf URLs: downloads without navigating', async () => {
    const page = mockPage({ request: pdfRequest(pdf) });
    const result = await fetchPage({ url: 'https://arxiv.org/pdf/1706.03762.pdf', page });

    expect(page.gotoCalls).toEqual([]);
    expect(result.contentType).toBe('pdf');
    expect(result.title).toBe('Attention Is All You Need');
    expect(result.finalUrl).toBe('https://arxiv.org/pdf/1706.03762.pdf');
    expect(result.markdown).toContain('# Attention Is All You Need');
    expect(result.markdown).toContain('--- Page 1 ---');
    expect(result.markdown).toContain('--- Page 2 ---');
    expect(result.markdown).toContain('First page text');
    expect(result.text).toContain('Second page text');
    expect(result.text).not.toContain('--- Page');
    expect(result.truncated).toBe(false);
  });

  it('detects PDFs from the goto response content-type', async () => {
    const page = mockPage({
      responseContentType: 'application/pdf',
      request: pdfRequest(pdf),
    });
    const result = await fetchPage({ url: 'https://example.com/paper', page });

    expect(page.gotoCalls).toEqual(['https://example.com/paper']);
    expect(result.contentType).toBe('pdf');
    expect(result.markdown).toContain('First page text');
  });

  it('detects PDFs via header sniff after net::ERR_ABORTED', async () => {
    const page = mockPage({
      gotoError: new Error('net::ERR_ABORTED at https://example.com/download'),
      request: pdfRequest(pdf),
    });
    const result = await fetchPage({ url: 'https://example.com/download', page });

    expect(result.contentType).toBe('pdf');
    expect(result.markdown).toContain('Second page text');
  });

  it('detects PDFs via header sniff when goto starts a download instead', async () => {
    // Newer headless Chromium surfaces PDF navigations as a starting
    // download rather than net::ERR_ABORTED.
    const page = mockPage({
      gotoError: new Error('page.goto: Download is starting'),
      request: pdfRequest(pdf),
    });
    const result = await fetchPage({ url: 'https://arxiv.org/pdf/1706.03762', page });

    expect(result.contentType).toBe('pdf');
    expect(result.markdown).toContain('First page text');
  });

  it('falls back to the file name when the PDF has no title, and caps length', async () => {
    const untitled = buildFixturePdf({ pageTexts: ['x'.repeat(200)] });
    const page = mockPage({ request: pdfRequest(untitled) });
    const result = await fetchPage({
      url: 'https://example.com/files/report.pdf',
      page,
      maxChars: 60,
    });

    expect(result.title).toBe('report.pdf');
    expect(result.truncated).toBe(true);
    expect(result.markdown.length).toBeLessThanOrEqual(60);
    expect(result.markdown.endsWith('...[truncated]')).toBe(true);
  });

  it('returns an empty links array for PDFs when includeLinks is set', async () => {
    const page = mockPage({ request: pdfRequest(pdf) });
    const result = await fetchPage({
      url: 'https://example.com/a.pdf',
      page,
      includeLinks: true,
    });
    expect(result.links).toEqual([]);
  });
});
