/**
 * Semantic extraction: distilled page + zod schema -> validated JSON,
 * via a forced tool call against the configured LLM provider.
 */
import { z } from 'zod';
import type { Page, Response } from 'playwright';
import type {
  ChatMessage,
  ExtractOptions,
  ExtractResult,
  PageSnapshot,
  TokenUsage,
  ToolDefinition,
} from '../contracts.js';
import { createProvider } from '../llm/index.js';
import { BrowserManager, distillPage } from '../browser/index.js';
import {
  downloadPdf,
  isAbortedNavigation,
  isPdfUrl,
  pdfToDocument,
  pdfToSnapshot,
  sniffPdfResponse,
} from '../pdf/index.js';
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionUserMessage } from './prompts.js';

export { jsonSchemaToZod } from './schema.js';
export { EXTRACTION_SYSTEM_PROMPT } from './prompts.js';

const SUBMIT_TOOL_NAME = 'submit_result';
const MAX_VALIDATION_RETRIES = 2;
const NETWORK_IDLE_TIMEOUT_MS = 10_000;

/**
 * Navigate a page to `url` and wait for it to settle: DOMContentLoaded,
 * then network-idle capped at 10s (best effort — never throws on the
 * idle wait, since busy pages may never go idle).
 */
export async function navigateAndSettle(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => {});
}

/**
 * Navigate `page` to `url` with PDF detection: `.pdf` URL suffix (pre-route,
 * no navigation), the goto response's content-type, or a header sniff after
 * `net::ERR_ABORTED` (headless Chromium aborts PDF navigations). Returns a
 * parsed-PDF `PageSnapshot` when the URL serves a PDF; returns undefined when
 * the page navigated and settled normally (HTML path — distill as usual).
 */
export async function navigateOrPdfSnapshot(
  page: Page,
  url: string,
): Promise<PageSnapshot | undefined> {
  if (isPdfUrl(url)) {
    return pdfSnapshotFor(page, url);
  }

  let response: Response | null;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    if (isAbortedNavigation(err) && (await sniffPdfResponse(page.context().request, url))) {
      return pdfSnapshotFor(page, url);
    }
    throw err;
  }
  if (isPdfContentType(response?.headers()['content-type'])) {
    return pdfSnapshotFor(page, response?.url() ?? url);
  }

  await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => {});
  return undefined;
}

/** Download + parse a PDF (sharing the context's cookies) into a snapshot. */
async function pdfSnapshotFor(page: Page, url: string): Promise<PageSnapshot> {
  const data = await downloadPdf(page.context().request, url);
  const doc = await pdfToDocument(data);
  return pdfToSnapshot(url, doc);
}

function isPdfContentType(value: string | undefined): boolean {
  return (value ?? '').toLowerCase().includes('application/pdf');
}

/**
 * Extract structured data from a web page (or a pre-built snapshot).
 *
 * Uses `opts.snapshot` directly when given (no browser at all — the PDF
 * path), else reuses `opts.page`, else navigates a fresh browser page to
 * `opts.url` (detecting PDFs and parsing them into a snapshot). The snapshot
 * is handed to the provider, which must call `submit_result` with data
 * matching `opts.schema`. Invalid outputs are fed back to the model for
 * correction (up to 2 retries).
 */
export async function extract<T>(opts: ExtractOptions<T>): Promise<ExtractResult<T>> {
  let manager: BrowserManager | undefined;

  try {
    let snapshot = opts.snapshot;
    if (!snapshot) {
      let page = opts.page;
      if (!page) {
        if (!opts.url) {
          throw new Error(
            'extract: one of `url`, `page`, or `snapshot` must be provided in ExtractOptions.',
          );
        }
        manager = new BrowserManager();
        page = await manager.newPage();
        snapshot = await navigateOrPdfSnapshot(page, opts.url);
      }
      snapshot ??= await distillPage(page);
    }
    const provider = opts.provider ?? createProvider();

    const jsonSchema = z.toJSONSchema(opts.schema, { io: 'input' }) as Record<string, unknown>;
    const tool: ToolDefinition = {
      name: SUBMIT_TOOL_NAME,
      description: 'Submit the extracted data',
      inputSchema: jsonSchema,
    };

    const messages: ChatMessage[] = [
      { role: 'user', content: buildExtractionUserMessage(snapshot, opts.instruction) },
    ];
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let lastIssues = '';

    for (let attempt = 0; attempt <= MAX_VALIDATION_RETRIES; attempt++) {
      const response = await provider.chat({
        system: EXTRACTION_SYSTEM_PROMPT,
        messages,
        tools: [tool],
        toolChoice: { name: SUBMIT_TOOL_NAME },
        maxTokens: 8192,
      });
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;

      const call = response.toolCalls.find((c) => c.name === SUBMIT_TOOL_NAME);
      if (!call) {
        throw new Error(
          `extract: model did not call ${SUBMIT_TOOL_NAME} (stopReason: ${response.stopReason}, provider: ${provider.id}).`,
        );
      }

      const parsed = opts.schema.safeParse(call.input);
      if (parsed.success) {
        return { data: parsed.data, url: snapshot.url, usage };
      }

      lastIssues = formatIssues(parsed.error);
      if (attempt < MAX_VALIDATION_RETRIES) {
        messages.push({
          role: 'assistant',
          content: response.text ?? '',
          toolCalls: response.toolCalls,
        });
        messages.push({
          role: 'toolResult',
          toolCallId: call.id,
          content: `Validation failed: ${lastIssues}. Call ${SUBMIT_TOOL_NAME} again with corrected data.`,
        });
      }
    }

    throw new Error(
      `extract: output failed schema validation after ${MAX_VALIDATION_RETRIES + 1} attempts. Issues: ${lastIssues}`,
    );
  } finally {
    if (manager) {
      await manager.close();
    }
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}
