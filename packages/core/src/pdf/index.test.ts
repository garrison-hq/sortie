import { describe, expect, it } from 'vitest';
import type { APIRequestContext, APIResponse } from 'playwright';
import {
  PDF_SNAPSHOT_OUTLINE,
  downloadPdf,
  isPdfUrl,
  pdfToDocument,
  pdfToMarkdown,
  pdfToSnapshot,
  sniffPdfResponse,
} from './index.js';

// ---------------------------------------------------------------------------
// Fixture: a minimal valid PDF built programmatically (one text run per page,
// Helvetica, optional /Info Title) so tests need no binary checked in.
// ---------------------------------------------------------------------------

function escapePdfString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
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
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R` +
    `${infoRef !== undefined ? ` /Info ${infoRef} 0 R` : ''} >>\nstartxref\n${offset}\n%%EOF\n`;

  return new TextEncoder().encode(header + objects.join('') + xref + trailer);
}

// ---------------------------------------------------------------------------
// Mocks: just the APIRequestContext/APIResponse surface the module touches.
// ---------------------------------------------------------------------------

interface MockResponseOptions {
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer;
}

function mockResponse(opts: MockResponseOptions = {}): APIResponse {
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

// ---------------------------------------------------------------------------

describe('isPdfUrl', () => {
  it('matches .pdf pathnames regardless of case, query, and hash', () => {
    expect(isPdfUrl('https://arxiv.org/pdf/1706.03762.pdf')).toBe(true);
    expect(isPdfUrl('https://example.com/a/B.PDF?download=1#page=2')).toBe(true);
  });

  it('rejects non-pdf paths, .pdf only in the query, and invalid URLs', () => {
    expect(isPdfUrl('https://arxiv.org/abs/1706.03762')).toBe(false);
    expect(isPdfUrl('https://example.com/view?file=paper.pdf')).toBe(false);
    expect(isPdfUrl('not a url')).toBe(false);
  });
});

describe('pdfToDocument', () => {
  it('extracts the metadata title and one text entry per page', async () => {
    const data = buildFixturePdf({
      title: 'Tiny Fixture',
      pageTexts: ['Hello first page', 'Hello second page'],
    });
    const doc = await pdfToDocument(data);

    expect(doc.title).toBe('Tiny Fixture');
    expect(doc.numPages).toBe(2);
    expect(doc.pages).toEqual(['Hello first page', 'Hello second page']);
    expect(doc.truncated).toBe(false);
  });

  it('leaves title undefined when the PDF has no Info dictionary', async () => {
    const doc = await pdfToDocument(buildFixturePdf({ pageTexts: ['no metadata here'] }));
    expect(doc.title).toBeUndefined();
    expect(doc.pages).toEqual(['no metadata here']);
  });

  it('caps pages at maxPages and flags truncation', async () => {
    const data = buildFixturePdf({ pageTexts: ['page one', 'page two', 'page three'] });
    const doc = await pdfToDocument(data, { maxPages: 2 });

    expect(doc.numPages).toBe(3);
    expect(doc.pages).toEqual(['page one', 'page two']);
    expect(doc.truncated).toBe(true);
  });

  it('caps total characters at maxChars, cutting mid-page', async () => {
    const data = buildFixturePdf({ pageTexts: ['aaaaaaaaaa', 'bbbbbbbbbb'] });
    const doc = await pdfToDocument(data, { maxChars: 15 });

    expect(doc.pages).toEqual(['aaaaaaaaaa', 'bbbbb']);
    expect(doc.truncated).toBe(true);
  });

  it("does not consume the caller's bytes (buffer stays usable)", async () => {
    const data = buildFixturePdf({ pageTexts: ['reuse me'] });
    await pdfToDocument(data);
    // pdf.js transfers the buffer it is handed; the module must parse a copy.
    const again = await pdfToDocument(data);
    expect(again.pages).toEqual(['reuse me']);
  });

  it('throws on bytes that are not a parseable PDF', async () => {
    await expect(pdfToDocument(new TextEncoder().encode('%PDF-1.4 but garbage'))).rejects.toThrow();
  });
});

describe('pdfToMarkdown', () => {
  it('renders the title heading and --- Page N --- markers in order', () => {
    const markdown = pdfToMarkdown({
      title: 'Tiny Fixture',
      numPages: 2,
      pages: ['first page text', 'second page text'],
      truncated: false,
    });

    expect(markdown).toBe(
      '# Tiny Fixture\n\n--- Page 1 ---\n\nfirst page text\n\n--- Page 2 ---\n\nsecond page text',
    );
  });

  it('omits the heading when there is no title and skips empty page bodies', () => {
    const markdown = pdfToMarkdown({ numPages: 2, pages: ['only text', ''], truncated: false });
    expect(markdown).toBe('--- Page 1 ---\n\nonly text\n\n--- Page 2 ---');
  });
});

describe('pdfToSnapshot', () => {
  it('builds an element-free snapshot with the fixed outline and page markers', () => {
    const snapshot = pdfToSnapshot('https://example.com/papers/tiny.pdf', {
      title: 'Tiny Fixture',
      numPages: 2,
      pages: ['first page text', 'second page text'],
      truncated: false,
    });

    expect(snapshot.url).toBe('https://example.com/papers/tiny.pdf');
    expect(snapshot.title).toBe('Tiny Fixture');
    expect(snapshot.outline).toBe(PDF_SNAPSHOT_OUTLINE);
    expect(snapshot.elements).toEqual([]);
    expect(snapshot.text).toContain('--- Page 1 ---\nfirst page text');
    expect(snapshot.text).toContain('--- Page 2 ---\nsecond page text');
  });

  it('falls back to the URL filename, then a generic title', () => {
    const doc = { numPages: 1, pages: ['x'], truncated: false };
    expect(pdfToSnapshot('https://example.com/a/paper.pdf?v=2', doc).title).toBe('paper.pdf');
    expect(pdfToSnapshot('https://example.com/', doc).title).toBe('PDF document');
  });

  it('caps snapshot text at 12k characters with a truncation marker', () => {
    const snapshot = pdfToSnapshot('https://example.com/big.pdf', {
      numPages: 1,
      pages: ['x'.repeat(20_000)],
      truncated: true,
    });

    expect(snapshot.text.length).toBe(12_000);
    expect(snapshot.text.endsWith('...[truncated]')).toBe(true);
  });
});

describe('downloadPdf', () => {
  const pdfBody = Buffer.from(buildFixturePdf({ pageTexts: ['hi'] }));

  it('returns the body bytes for a healthy PDF response', async () => {
    const request = mockRequest({
      get: async () =>
        mockResponse({ headers: { 'content-type': 'application/pdf' }, body: pdfBody }),
    });
    const bytes = await downloadPdf(request, 'https://example.com/a.pdf');
    expect(Buffer.from(bytes).equals(pdfBody)).toBe(true);
  });

  it('throws on non-2xx responses', async () => {
    const request = mockRequest({ get: async () => mockResponse({ status: 404 }) });
    await expect(downloadPdf(request, 'https://example.com/a.pdf')).rejects.toThrow(/404/);
  });

  it('throws on an over-cap Content-Length header before reading the body', async () => {
    const request = mockRequest({
      get: async () =>
        mockResponse({
          headers: { 'content-length': '999' },
          body: pdfBody,
        }),
    });
    await expect(
      downloadPdf(request, 'https://example.com/a.pdf', { maxBytes: 100 }),
    ).rejects.toThrow(/declares 999 bytes.*100-byte cap/);
  });

  it('throws when the actual body exceeds the cap (no Content-Length)', async () => {
    const request = mockRequest({ get: async () => mockResponse({ body: pdfBody }) });
    await expect(
      downloadPdf(request, 'https://example.com/a.pdf', { maxBytes: 10 }),
    ).rejects.toThrow(/over the 10-byte cap/);
  });

  it('throws when the response body is not a PDF', async () => {
    const request = mockRequest({
      get: async () =>
        mockResponse({
          headers: { 'content-type': 'text/html' },
          body: Buffer.from('<html>not a pdf</html>'),
        }),
    });
    await expect(downloadPdf(request, 'https://example.com/a.pdf')).rejects.toThrow(
      /not a PDF.*text\/html/,
    );
  });
});

describe('sniffPdfResponse', () => {
  it('returns true when HEAD reports application/pdf', async () => {
    const request = mockRequest({
      head: async () => mockResponse({ headers: { 'content-type': 'application/pdf' } }),
    });
    expect(await sniffPdfResponse(request, 'https://example.com/a')).toBe(true);
  });

  it('returns false when HEAD reports a non-PDF content type', async () => {
    const request = mockRequest({
      head: async () => mockResponse({ headers: { 'content-type': 'text/html; charset=utf-8' } }),
    });
    expect(await sniffPdfResponse(request, 'https://example.com/a')).toBe(false);
  });

  it('falls back to GET headers when HEAD throws', async () => {
    const request = mockRequest({
      head: () => Promise.reject(new Error('HEAD not supported')),
      get: async () => mockResponse({ headers: { 'content-type': 'application/pdf' } }),
    });
    expect(await sniffPdfResponse(request, 'https://example.com/a')).toBe(true);
  });

  it('falls back to GET headers when HEAD is rejected with 405', async () => {
    const request = mockRequest({
      head: async () => mockResponse({ status: 405 }),
      get: async () => mockResponse({ headers: { 'content-type': 'application/pdf' } }),
    });
    expect(await sniffPdfResponse(request, 'https://example.com/a')).toBe(true);
  });

  it('returns false when both HEAD and GET fail', async () => {
    const request = mockRequest({
      head: () => Promise.reject(new Error('down')),
      get: () => Promise.reject(new Error('down')),
    });
    expect(await sniffPdfResponse(request, 'https://example.com/a')).toBe(false);
  });
});
