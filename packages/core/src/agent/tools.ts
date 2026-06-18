/**
 * Agent tool surface + executor.
 *
 * `AGENT_TOOLS` is the tool list handed to the acting model; `executeAction()`
 * carries out a single tool call against a live page and returns a concise
 * observation string for the model. It never throws — every failure becomes
 * an "Error: ..." observation so the loop can keep going.
 *
 * SECURITY INVARIANT: credential values must never leak into observations.
 * The model supplies `{{cred:NAME}}` placeholders; the executor substitutes
 * real values only at the point of typing, echoes back the placeholder form,
 * and scrubs every outgoing observation for raw credential values.
 */
import { z } from 'zod';
import type { Page, Locator } from 'playwright';
import type { LlmProvider, ToolDefinition } from '../contracts.js';
import { resolveRef } from '../browser/index.js';
import { extract, navigateAndSettle } from '../extract/index.js';
import { extractArticle, htmlToMarkdown, stripBoilerplate } from '../fetch/markdown.js';
import {
  downloadPdf,
  isAbortedNavigation,
  pdfToDocument,
  pdfToMarkdown,
  sniffPdfResponse,
} from '../pdf/index.js';
import { search } from '../search/index.js';

export interface ExecutionContext {
  page: Page;
  credentials: Record<string, string>;
  provider: LlmProvider;
}

const ACTION_TIMEOUT_MS = 5_000;
const WAIT_FOR_TEXT_TIMEOUT_MS = 10_000;
const MAX_WAIT_SECONDS = 10;
const MAX_SCROLL_PAGES = 20;
const EXTRACT_OBSERVATION_MAX = 4_000;
const PDF_OBSERVATION_MAX = 4_000;
const SEARCH_OBSERVATION_MAX = 3_000;
const SEARCH_SNIPPET_MAX = 200;
const SEARCH_MAX_RESULTS = 10;
const SEARCH_DEFAULT_RESULTS = 5;
const READ_PAGE_MIN_CHARS = 500;
const READ_PAGE_MAX_CHARS = 8_000;
const READ_PAGE_DEFAULT_CHARS = 6_000;
const ERROR_MESSAGE_MAX = 500;
const TRUNCATION_MARKER = '...[truncated]';
const CRED_PLACEHOLDER_RE = /\{\{cred:([A-Z0-9_]+)\}\}/g;

// ---------------------------------------------------------------------------
// Tool input schemas — zod is the source of truth; the JSON Schemas in
// AGENT_TOOLS are derived from these, and executeAction validates against
// the same schemas before acting.
// ---------------------------------------------------------------------------

const navigateInput = z.object({
  url: z
    .string()
    .describe('Absolute URL to navigate to, including the protocol (e.g. "https://example.com").'),
});

const clickInput = z.object({
  ref: z
    .string()
    .describe('Element ref from the latest page snapshot, e.g. "e12" for the element [e12].'),
});

const dismissInput = z.object({});

const typeInput = z.object({
  ref: z.string().describe('Ref of the input/textarea to type into, from the latest snapshot.'),
  text: z
    .string()
    .describe(
      'Text to type. The field is cleared first. To enter a credential, use the placeholder ' +
        '{{cred:NAME}} with one of the available credential names — never guess secret values.',
    ),
  submit: z
    .boolean()
    .optional()
    .describe('If true, press Enter after typing (submits most forms). Default false.'),
});

const selectInput = z.object({
  ref: z.string().describe('Ref of the <select> element, from the latest snapshot.'),
  value: z
    .string()
    .describe('Option to choose, matched by option value first, then visible label.'),
});

const scrollInput = z.object({
  direction: z.enum(['up', 'down']).describe('Direction to scroll.'),
  pages: z
    .number()
    .int()
    .min(1)
    .max(MAX_SCROLL_PAGES)
    .optional()
    .describe('Number of viewport heights to scroll. Default 1.'),
});

const waitInput = z.object({
  seconds: z
    .number()
    .min(0)
    .max(MAX_WAIT_SECONDS)
    .optional()
    .describe('Seconds to pause (max 10). Ignored when forText is given. Default 1.'),
  forText: z
    .string()
    .optional()
    .describe('If given, wait until this exact text appears on the page (10s cap).'),
});

const extractInput = z.object({
  instruction: z
    .string()
    .describe(
      'Natural-language description of what to extract, e.g. ' +
        '"all product names and prices in the results list".',
    ),
});

const searchInput = z.object({
  query: z.string().min(1).describe('Web search query, e.g. "Attention Is All You Need arxiv".'),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_MAX_RESULTS)
    .optional()
    .describe('Number of results to return (1-10). Default 5.'),
});

const readPageInput = z.object({
  maxChars: z
    .number()
    .int()
    .min(READ_PAGE_MIN_CHARS)
    .max(READ_PAGE_MAX_CHARS)
    .optional()
    .describe('Cap on the returned Markdown length (500-8000 characters). Default 6000.'),
});

const doneInput = z.object({
  result: z
    .record(z.string(), z.unknown())
    .describe('The final structured result object answering the goal.'),
});

const failInput = z.object({
  reason: z
    .string()
    .describe('Clear explanation of why the goal cannot be completed (what blocked you).'),
});

function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
}

/** Tool definitions handed to the acting model, in the order it should learn them. */
export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: 'navigate',
    description:
      'Go to an absolute URL in the browser and wait for the page to settle. ' +
      'All element refs from previous snapshots become stale afterwards.',
    inputSchema: toInputSchema(navigateInput),
  },
  {
    name: 'click',
    description:
      'Click the element [eN] identified by ref in the LATEST page snapshot. ' +
      'Refs go stale after any navigation — only use refs from the most recent snapshot.',
    inputSchema: toInputSchema(clickInput),
  },
  {
    name: 'type',
    description:
      'Clear the field [eN] and type text into it. Use {{cred:NAME}} placeholders for ' +
      'credentials (you never see the real values). Set submit:true to press Enter afterwards.',
    inputSchema: toInputSchema(typeInput),
  },
  {
    name: 'select',
    description:
      'Choose an option in the dropdown/select element [eN], matching by option value or ' +
      'by visible label.',
    inputSchema: toInputSchema(selectInput),
  },
  {
    name: 'scroll',
    description:
      'Scroll the page up or down by whole viewport pages (default 1) to reveal more content ' +
      'before taking the next snapshot.',
    inputSchema: toInputSchema(scrollInput),
  },
  {
    name: 'wait',
    description:
      'Pause for a few seconds (max 10), or wait until specific text appears on the page ' +
      '(10s cap). Use after actions that trigger slow page updates.',
    inputSchema: toInputSchema(waitInput),
  },
  {
    name: 'extract',
    description:
      'Semantically extract data from the CURRENT page as loose JSON, guided by your ' +
      'instruction. The extracted JSON appears in your observation — use this to collect ' +
      'list or detail data you need for the final result.',
    inputSchema: toInputSchema(extractInput),
  },
  {
    name: 'search',
    description:
      'Search the web and get a numbered list of results (title, URL, snippet). Runs in a ' +
      'separate tab — the current page and its element refs are untouched. Use navigate to ' +
      'open a result URL.',
    inputSchema: toInputSchema(searchInput),
  },
  {
    name: 'read_page',
    description:
      "Read the CURRENT page's main content as clean Markdown (boilerplate stripped, no " +
      'navigation). Cheap and instant — prefer this over extract when you just need to read ' +
      'prose like an article or documentation.',
    inputSchema: toInputSchema(readPageInput),
  },
  {
    name: 'dismiss',
    description:
      'Close/dismiss a blocking dialog, modal, popup, cookie banner, or error overlay ' +
      '(e.g. "something went wrong"/"Oeps", a promo or session modal). Presses Escape and ' +
      'clicks common close controls ("Close", "×", "OK", "Sluiten", "Dismiss", "Accepteren", ' +
      '"Probeer opnieuw") even when they are not present as refs in the snapshot. Use this when ' +
      'an overlay blocks the page or a click keeps timing out, then continue. Does NOT bypass ' +
      'CAPTCHAs or anti-bot walls — use fail for those.',
    inputSchema: toInputSchema(dismissInput),
  },
  {
    name: 'done',
    description:
      'The goal is fully achieved. Submit the final structured result object. ' +
      'Include every piece of data the goal asked for.',
    inputSchema: toInputSchema(doneInput),
  },
  {
    name: 'fail',
    description:
      'The goal cannot be completed (blocked, CAPTCHA, missing page/data, access denied, ...). ' +
      'Explain exactly why so a human can act on it.',
    inputSchema: toInputSchema(failInput),
  },
];

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Execute one tool call against the live page and return an observation
 * string for the model. Never throws: failures (bad input, stale refs,
 * timeouts, navigation races) come back as "Error: ..." observations.
 *
 * Every observation is scrubbed of raw credential values before returning.
 */
export async function executeAction(
  ctx: ExecutionContext,
  tool: string,
  input: Record<string, unknown>,
): Promise<string> {
  let observation: string;
  try {
    observation = await dispatch(ctx, tool, input);
  } catch (err) {
    observation = `Error: ${errorMessage(err)}`;
  }
  return redactSecrets(observation, ctx.credentials);
}

async function dispatch(
  ctx: ExecutionContext,
  tool: string,
  input: Record<string, unknown>,
): Promise<string> {
  switch (tool) {
    case 'navigate':
      return doNavigate(ctx, input);
    case 'click':
      return doClick(ctx, input);
    case 'dismiss':
      return doDismiss(ctx);
    case 'type':
      return doType(ctx, input);
    case 'select':
      return doSelect(ctx, input);
    case 'scroll':
      return doScroll(ctx, input);
    case 'wait':
      return doWait(ctx, input);
    case 'extract':
      return doExtract(ctx, input);
    case 'search':
      return doSearch(ctx, input);
    case 'read_page':
      return doReadPage(ctx, input);
    // Termination semantics (validating the result, ending the run) belong to
    // the agent loop; the executor just acknowledges.
    case 'done':
      return doDone(input);
    case 'fail':
      return doFail(input);
    default:
      return (
        `Error: unknown tool "${tool}". Available tools: ` +
        AGENT_TOOLS.map((t) => t.name).join(', ')
      );
  }
}

async function doNavigate(ctx: ExecutionContext, input: Record<string, unknown>): Promise<string> {
  const parsed = navigateInput.safeParse(input);
  if (!parsed.success) return invalidInput('navigate', parsed.error);
  const { url } = parsed.data;
  if (!isAbsoluteHttpUrl(url)) {
    return `Error: navigate requires an absolute http(s) URL including the protocol; got "${url}"`;
  }
  try {
    await navigateAndSettle(ctx.page, url);
  } catch (err) {
    // Headless Chromium aborts PDF navigations (net::ERR_ABORTED) —
    // sniff the headers and surface the PDF's content instead of an error.
    if (isAbortedNavigation(err) && (await sniffPdfResponse(ctx.page.context().request, url))) {
      return await pdfObservation(ctx.page, url);
    }
    throw err;
  }
  return `Navigated to ${ctx.page.url()}`;
}

async function doClick(ctx: ExecutionContext, input: Record<string, unknown>): Promise<string> {
  const parsed = clickInput.safeParse(input);
  if (!parsed.success) return invalidInput('click', parsed.error);
  const located = await locatorForRef(ctx.page, parsed.data.ref);
  if (typeof located === 'string') return located;
  // Describe before clicking — the click may navigate away.
  const desc = await describeLocator(located);
  try {
    await located.click({ timeout: ACTION_TIMEOUT_MS });
  } catch (err) {
    const msg = errorMessage(err);
    // A timeout / pointer-interception almost always means the target is
    // hidden or covered by a dialog/overlay/banner. Steer the agent to clear
    // the blocker instead of retrying the same (still-covered) element.
    if (/timeout|intercept|not (?:visible|stable|enabled|clickable)|outside/i.test(msg)) {
      return (
        `Error: click on [${parsed.data.ref}] (${desc}) failed: ${msg}. ` +
        'The element is likely hidden or covered by a dialog/overlay/cookie banner or an ' +
        'error popup. Call the dismiss tool to close the blocker (it finds close controls even ' +
        'when they are not in the snapshot), then retry — do NOT repeat this same click.'
      );
    }
    return `Error: ${msg}`;
  }
  await ctx.page
    .waitForLoadState('domcontentloaded', { timeout: ACTION_TIMEOUT_MS })
    .catch(() => {});
  return `Clicked [${parsed.data.ref}] ${desc}`;
}

/** Accessible-name match for a close/dismiss control (role=button path). */
const DISMISS_NAME_RE =
  /^\s*(close|sluiten|sluit|dismiss|ok|got it|akkoord|accepteren|×|✕|✖|x)\s*$/i;
/** Visible-text match for a close/dismiss control (covers clickable <p>/<span>/<div>). */
const DISMISS_TEXT_RE =
  /^\s*(close|sluiten|sluit|dismiss|ok|got it|akkoord|accepteren|probeer opnieuw|opnieuw proberen|×|✕|✖)\s*$/i;

async function doDismiss(ctx: ExecutionContext): Promise<string> {
  const page = ctx.page;
  // Ordered strategies — most specific first. Each may match several elements;
  // we click the first VISIBLE one. The text strategy catches close controls
  // that aren't real buttons/links (e.g. <p>Close</p>) and so never appear as
  // refs in the distilled snapshot.
  const strategies: Array<{ how: string; loc: Locator }> = [
    { how: 'button', loc: page.getByRole('button', { name: DISMISS_NAME_RE }) },
    {
      how: 'aria-label',
      loc: page.locator(
        '[aria-label*="close" i], [aria-label*="dismiss" i], [aria-label*="sluit" i]',
      ),
    },
    { how: 'text', loc: page.getByText(DISMISS_TEXT_RE) },
    { how: 'class', loc: page.locator('[class*="close" i], [class*="dismiss" i]') },
  ];
  for (const { how, loc } of strategies) {
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 8); i++) {
      const el = loc.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const label = (
        (await el.innerText().catch(() => '')) ||
        (await el.getAttribute('aria-label').catch(() => '')) ||
        'control'
      )
        .trim()
        .replaceAll(/\s+/g, ' ')
        .slice(0, 40);
      try {
        await el.click({ timeout: ACTION_TIMEOUT_MS });
        await page.waitForLoadState('domcontentloaded', { timeout: 1_500 }).catch(() => {});
        return `Dismissed an overlay by clicking "${label}" (${how}). Re-examine the fresh snapshot and continue your task.`;
      } catch {
        // Not actionable — try the next candidate.
      }
    }
  }
  await page.keyboard.press('Escape').catch(() => {});
  return (
    'No obvious close control was clickable; pressed Escape to dismiss any overlay. ' +
    'Re-examine the snapshot — if the blocker is still there, take a different path.'
  );
}

async function doType(ctx: ExecutionContext, input: Record<string, unknown>): Promise<string> {
  const parsed = typeInput.safeParse(input);
  if (!parsed.success) return invalidInput('type', parsed.error);
  const { ref, text, submit } = parsed.data;
  const located = await locatorForRef(ctx.page, ref);
  if (typeof located === 'string') return located;

  const resolved = resolveCredentials(text, ctx.credentials);
  if ('missing' in resolved) {
    return unknownCredentialsError(resolved.missing, ctx.credentials);
  }

  const desc = await describeLocator(located);
  await located.fill(resolved.value, { timeout: ACTION_TIMEOUT_MS });
  if (submit) {
    await located.press('Enter', { timeout: ACTION_TIMEOUT_MS });
    await ctx.page
      .waitForLoadState('domcontentloaded', { timeout: ACTION_TIMEOUT_MS })
      .catch(() => {});
  }
  // CRITICAL: echo the placeholder form of the text, never the resolved value.
  return `Typed "${clip(text, 100)}" into [${ref}] ${desc}${submit ? ' and pressed Enter' : ''}`;
}

async function doSelect(ctx: ExecutionContext, input: Record<string, unknown>): Promise<string> {
  const parsed = selectInput.safeParse(input);
  if (!parsed.success) return invalidInput('select', parsed.error);
  const { ref, value } = parsed.data;
  const located = await locatorForRef(ctx.page, ref);
  if (typeof located === 'string') return located;
  const desc = await describeLocator(located);
  try {
    await located.selectOption({ value }, { timeout: ACTION_TIMEOUT_MS });
  } catch {
    await located.selectOption({ label: value }, { timeout: ACTION_TIMEOUT_MS });
  }
  return `Selected "${value}" in [${ref}] ${desc}`;
}

async function doScroll(ctx: ExecutionContext, input: Record<string, unknown>): Promise<string> {
  const parsed = scrollInput.safeParse(input);
  if (!parsed.success) return invalidInput('scroll', parsed.error);
  const pages = parsed.data.pages ?? 1;
  const sign = parsed.data.direction === 'up' ? -1 : 1;
  await ctx.page.evaluate(
    (args: { deltaPages: number }) => {
      const win = globalThis as unknown as {
        innerHeight: number;
        scrollBy(x: number, y: number): void;
      };
      win.scrollBy(0, win.innerHeight * args.deltaPages);
    },
    { deltaPages: sign * pages },
  );
  return `Scrolled ${parsed.data.direction} ${pages} viewport page${pages === 1 ? '' : 's'}`;
}

async function doWait(ctx: ExecutionContext, input: Record<string, unknown>): Promise<string> {
  const parsed = waitInput.safeParse(input);
  if (!parsed.success) return invalidInput('wait', parsed.error);
  const { seconds, forText } = parsed.data;
  if (forText !== undefined && forText.length > 0) {
    await ctx.page.getByText(forText).first().waitFor({ timeout: WAIT_FOR_TEXT_TIMEOUT_MS });
    return `Text "${forText}" appeared on the page`;
  }
  const s = Math.min(Math.max(seconds ?? 1, 0), MAX_WAIT_SECONDS);
  await ctx.page.waitForTimeout(s * 1000);
  return `Waited ${s}s`;
}

async function doExtract(ctx: ExecutionContext, input: Record<string, unknown>): Promise<string> {
  const parsed = extractInput.safeParse(input);
  if (!parsed.success) return invalidInput('extract', parsed.error);
  const result = await extract({
    page: ctx.page,
    schema: z.record(z.string(), z.unknown()),
    instruction: parsed.data.instruction,
    provider: ctx.provider,
  });
  const data = result.data;
  let json = JSON.stringify(data);
  if (json.length > EXTRACT_OBSERVATION_MAX) {
    json = json.slice(0, EXTRACT_OBSERVATION_MAX) + TRUNCATION_MARKER;
  }
  // Fallback: when the semantic pass returns nothing, the model can miss short
  // status lines (e.g. a "Verification Success" banner) that readability treats
  // as boilerplate. Surface the raw visible page text so the agent can still
  // read clearly-present content instead of concluding "nothing is here".
  const isEmpty =
    data == null || (typeof data === 'object' && Object.keys(data as object).length === 0);
  if (isEmpty) {
    const raw = await ctx.page
      .evaluate((): string => {
        const doc = (globalThis as unknown as { document: { body: { innerText?: string } | null } })
          .document;
        return doc.body && typeof doc.body.innerText === 'string' ? doc.body.innerText : '';
      })
      .catch(() => '');
    const snippet = raw.replaceAll(/\s+/g, ' ').trim().slice(0, EXTRACT_OBSERVATION_MAX);
    if (snippet.length > 0) {
      return `Extracted: ${json}\n\n(No structured fields matched. Visible page text: "${snippet}")`;
    }
  }
  return `Extracted: ${json}`;
}

async function doSearch(ctx: ExecutionContext, input: Record<string, unknown>): Promise<string> {
  const parsed = searchInput.safeParse(input);
  if (!parsed.success) return invalidInput('search', parsed.error);
  const { query } = parsed.data;
  const maxResults = parsed.data.maxResults ?? SEARCH_DEFAULT_RESULTS;
  // Browser-engine searches run in a TEMPORARY page so the agent's page
  // (and the refs in its latest snapshot) is never navigated away.
  const tempPage = await ctx.page.context().newPage();
  try {
    const response = await search(query, {
      maxResults,
      page: tempPage,
      provider: ctx.provider,
    });
    if (response.results.length === 0) {
      return `Search for "${query}" returned no results. Try a different query.`;
    }
    const lines = response.results.map((r) => {
      const snippet = r.snippet ? `\n   ${clip(r.snippet, SEARCH_SNIPPET_MAX)}` : '';
      return `${r.position}. ${r.title} — ${r.url}${snippet}`;
    });
    return clip(`Search results for "${query}":\n${lines.join('\n')}`, SEARCH_OBSERVATION_MAX);
  } finally {
    await tempPage.close().catch(() => {});
  }
}

async function doReadPage(ctx: ExecutionContext, input: Record<string, unknown>): Promise<string> {
  const parsed = readPageInput.safeParse(input);
  if (!parsed.success) return invalidInput('read_page', parsed.error);
  const maxChars = parsed.data.maxChars ?? READ_PAGE_DEFAULT_CHARS;
  // Pure DOM -> Markdown conversion on the live page's content: no
  // navigation, no LLM call.
  const url = ctx.page.url();
  const html = await ctx.page.content();
  const contentHtml = extractArticle(html, url)?.contentHtml ?? stripBoilerplate(html, url);
  const markdown = htmlToMarkdown(contentHtml);
  return `Page content as Markdown:\n${clip(markdown, maxChars)}`;
}

function doDone(input: Record<string, unknown>): string {
  const parsed = doneInput.safeParse(input);
  if (!parsed.success) return invalidInput('done', parsed.error);
  return 'Final result received; goal marked complete.';
}

function doFail(input: Record<string, unknown>): string {
  const parsed = failInput.safeParse(input);
  if (!parsed.success) return invalidInput('fail', parsed.error);
  return `Failure recorded: ${clip(parsed.data.reason, 300)}`;
}

/**
 * Substitute `{{cred:NAME}}` placeholders in `text` with real credential values.
 * Returns `{ value }` on success, or `{ missing }` listing unknown credential
 * names (the substitution is aborted so no partial secret leaks).
 */
function resolveCredentials(
  text: string,
  credentials: Record<string, string>,
): { value: string } | { missing: string[] } {
  const missing: string[] = [];
  const value = text.replaceAll(CRED_PLACEHOLDER_RE, (match, name: string) => {
    const cred = credentials[name];
    if (cred === undefined) {
      missing.push(name);
      return match;
    }
    return cred;
  });
  return missing.length > 0 ? { missing } : { value };
}

function unknownCredentialsError(missing: string[], credentials: Record<string, string>): string {
  const available = Object.keys(credentials).sort((a, b) => a.localeCompare(b));
  return (
    `Error: unknown credential name(s): ${missing.join(', ')}. ` +
    `Available credential names: ${available.length > 0 ? available.join(', ') : '(none)'}`
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a ref to a Locator, or return an "Error: ..." observation string. */
async function locatorForRef(page: Page, ref: string): Promise<Locator | string> {
  const locator = resolveRef(page, ref); // throws on malformed refs -> caught upstream
  if ((await locator.count()) === 0) {
    return (
      `Error: ref ${ref} not found in current page ` +
      '(refs go stale after navigation — use the latest snapshot)'
    );
  }
  return locator;
}

/**
 * Best-effort short description of an element for observations,
 * e.g. 'link "Add to cart"'. Never throws; never reads input values
 * (a value could be a secret).
 */
async function describeLocator(locator: Locator): Promise<string> {
  try {
    // Self-contained callback — serialized and run in the browser, so it only
    // uses structural types (this package compiles without the "dom" lib).
    return await locator.first().evaluate((node: unknown): string => {
      const el = node as {
        tagName: string;
        getAttribute(name: string): string | null;
        innerText?: string;
      };

      const inputRole = (type: string): string => {
        if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') {
          return 'button';
        }
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        return 'textbox';
      };

      const implicitRole = (tag: string): string => {
        if (tag === 'a') return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'input') return inputRole((el.getAttribute('type') ?? 'text').toLowerCase());
        return tag;
      };

      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || implicitRole(tag);

      const collapse = (s: string): string => s.replaceAll(/\s+/g, ' ').trim();
      const name =
        collapse(el.getAttribute('aria-label') ?? '') ||
        collapse(typeof el.innerText === 'string' ? el.innerText : '') ||
        collapse(el.getAttribute('placeholder') ?? '');
      const clipped = name.length > 60 ? name.slice(0, 60) : name;
      return clipped ? `${role} "${clipped}"` : role;
    });
  } catch {
    return 'element';
  }
}

/**
 * Observation for navigating to a PDF URL: the document is downloaded through
 * the context's request (sharing cookies) and parsed, but the browser never
 * renders it — the agent's page stays on the previous URL.
 */
async function pdfObservation(page: Page, url: string): Promise<string> {
  const data = await downloadPdf(page.context().request, url);
  const doc = await pdfToDocument(data);
  const header =
    `${url} is a PDF document (${doc.numPages} page${doc.numPages === 1 ? '' : 's'}) — ` +
    'no interactive elements; the browser remains on the previous page. Content:';
  return clip(`${header}\n${pdfToMarkdown(doc)}`, PDF_OBSERVATION_MAX);
}

function invalidInput(tool: string, error: z.ZodError): string {
  const issues = error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
  return `Error: invalid input for ${tool}: ${issues}`;
}

function isAbsoluteHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + TRUNCATION_MARKER : s;
}

/**
 * Normalize an error into a short single-line message. Playwright "Call log"
 * dumps are stripped — they are long and rarely actionable for the model.
 */
function errorMessage(err: unknown): string {
  let message = err instanceof Error ? err.message : String(err);
  const callLog = message.indexOf('Call log:');
  if (callLog !== -1) message = message.slice(0, callLog);
  message = message.replaceAll(/\s+/g, ' ').trim();
  if (message.length > ERROR_MESSAGE_MAX) {
    message = message.slice(0, ERROR_MESSAGE_MAX) + TRUNCATION_MARKER;
  }
  return message.length > 0 ? message : 'unknown error';
}

/**
 * Replace any raw credential value that slipped into `text` (e.g. via a
 * thrown error or a model echoing a secret) with its {{cred:NAME}} placeholder.
 */
function redactSecrets(text: string, credentials: Record<string, string>): string {
  let out = text;
  for (const [name, value] of Object.entries(credentials)) {
    if (value.length === 0) continue;
    out = out.split(value).join(`{{cred:${name}}}`);
  }
  return out;
}
