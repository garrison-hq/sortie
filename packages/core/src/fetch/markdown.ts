/**
 * Pure HTML -> Markdown helpers for the fetch module.
 *
 * Parsing happens Node-side with linkedom on `page.content()` output (no
 * in-page script injection — target-page CSP can't interfere). Readability
 * isolates the main article; pages it can't score fall back to
 * `stripBoilerplate`. Conversion is turndown + the GFM plugin (tables,
 * strikethrough, task lists) with atx headings and fenced code blocks.
 */
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

type ParsedDocument = ReturnType<typeof parseHTML>['document'];

/** Tags that never carry main content — removed by the fallback path. */
const BOILERPLATE_TAGS = [
  'script',
  'style',
  'noscript',
  'template',
  'nav',
  'header',
  'footer',
  'aside',
  'iframe',
] as const;

/** Attributes rewritten to absolute URLs against the page's final URL. */
const URL_ATTRIBUTES = [
  ['a', 'href'],
  ['img', 'src'],
] as const;

/**
 * Minimum article text length (Readability's own charThreshold default).
 * Readability 0.6 returns its best attempt even below the threshold, where
 * it tends to keep nav junk — short pages go to `stripBoilerplate` instead.
 */
const ARTICLE_MIN_CHARS = 500;

export interface ArticleContent {
  /** Headline as identified by Readability, when it found one. */
  title?: string;
  /** Main-content HTML with link/image URLs resolved to absolute. */
  contentHtml: string;
}

let turndown: TurndownService | undefined;

/** Shared, lazily-built turndown instance (construction is not free). */
function getTurndown(): TurndownService {
  if (!turndown) {
    turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    });
    turndown.use(gfm);
    turndown.remove(['script', 'style', 'noscript']);
  }
  return turndown;
}

/** Rewrite a[href] / img[src] in place to absolute URLs against `baseUrl`. */
function absolutizeUrls(document: ParsedDocument, baseUrl: string): void {
  for (const [tag, attr] of URL_ATTRIBUTES) {
    for (const el of document.querySelectorAll(`${tag}[${attr}]`)) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      try {
        el.setAttribute(attr, new URL(value, baseUrl).href);
      } catch {
        // Unresolvable href (malformed base or value) — leave it untouched.
      }
    }
  }
}

/**
 * Run Readability over `html` to isolate the main article. Returns undefined
 * when Readability can't find/score an article (short or unusual pages) or
 * throws — callers fall back to `stripBoilerplate`. URLs in the returned
 * content are already resolved absolute against `url`.
 */
export function extractArticle(html: string, url: string): ArticleContent | undefined {
  const { document } = parseHTML(html);
  // Absolutize before Readability runs: its output is a serialized string.
  absolutizeUrls(document, url);

  let article: {
    title: string | null | undefined;
    content: string | null | undefined;
    textContent: string | null | undefined;
  } | null;
  try {
    article = new Readability(document).parse();
  } catch {
    return undefined;
  }

  const contentHtml = article?.content?.trim();
  if (!contentHtml) return undefined;
  if ((article?.textContent?.trim().length ?? 0) < ARTICLE_MIN_CHARS) return undefined;

  const title = article?.title?.trim();
  return { ...(title ? { title } : {}), contentHtml };
}

/**
 * Fallback boilerplate removal for pages Readability rejects: drop
 * script/style/nav/header/footer/aside/iframe (and friends) from the body
 * and return the remaining HTML, URLs resolved absolute against `url`.
 */
export function stripBoilerplate(html: string, url: string): string {
  const { document } = parseHTML(html);
  for (const tag of BOILERPLATE_TAGS) {
    for (const el of document.querySelectorAll(tag)) {
      el.remove();
    }
  }
  absolutizeUrls(document, url);
  return (document.body?.innerHTML ?? '').trim();
}

/** Convert HTML to GFM Markdown (atx headings, fenced code blocks). */
export function htmlToMarkdown(html: string): string {
  return getTurndown().turndown(html).trim();
}

/**
 * Collect links from `html`, resolving relative hrefs against `baseUrl`.
 * Non-http(s) schemes (mailto:, javascript:, ...) are skipped; duplicate
 * URLs keep the first occurrence's text.
 */
export function collectLinks(html: string, baseUrl: string): { text: string; url: string }[] {
  const { document } = parseHTML(html);
  const seen = new Set<string>();
  const links: { text: string; url: string }[] = [];

  for (const anchor of document.querySelectorAll('a[href]')) {
    let resolved: URL;
    try {
      resolved = new URL(anchor.getAttribute('href') ?? '', baseUrl);
    } catch {
      continue;
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
    if (seen.has(resolved.href)) continue;
    seen.add(resolved.href);

    const text = (anchor.textContent ?? '').replaceAll(/\s+/g, ' ').trim();
    links.push({ text, url: resolved.href });
  }

  return links;
}

/**
 * Render Markdown as plain text: code fences keep their contents, links and
 * images keep their labels, heading/emphasis/blockquote markers are dropped.
 * Best-effort by design — the markdown is the canonical representation.
 */
export function markdownToText(markdown: string): string {
  return (
    markdown
      // Lazy match to the closing fence: linear on unmatched input, no nested
      // quantifier — the sonarjs/slow-regex heuristic flags it defensively.
      // eslint-disable-next-line sonarjs/slow-regex -- lazy, single-pass; not ReDoS-prone
      .replaceAll(/```[^\n]*\n([\s\S]*?)```/g, '$1') // fenced code -> contents
      .replaceAll(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images -> alt text
      // Bounded negated character classes ([^\]]*, [^)]*): linear, no backtracking
      // ambiguity. Flagged defensively by sonarjs/slow-regex.
      // eslint-disable-next-line sonarjs/slow-regex -- bounded negated classes; not ReDoS-prone
      .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> label
      .replaceAll(/^#{1,6}\s+/gm, '') // heading markers
      .replaceAll(/^>\s?/gm, '') // blockquote markers
      .replaceAll(/^[-*_]{3,}\s*$/gm, '') // horizontal rules
      .replaceAll(/(\*\*|__)([^*_]+)\1/g, '$2') // bold
      .replaceAll(/([*_])([^*_]+)\1/g, '$2') // italics
      .replaceAll(/`([^`]+)`/g, '$1') // inline code
      .replaceAll(/\n{3,}/g, '\n\n')
      .trim()
  );
}
