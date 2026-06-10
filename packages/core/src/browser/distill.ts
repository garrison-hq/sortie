/**
 * Page distillation: turn a live page into a compact, LLM-readable snapshot.
 *
 * `distillPage()` tags every interactive/salient element with a sequential
 * `data-nf-ref` attribute (e1, e2, ...) and returns a `PageSnapshot` whose
 * elements reference those tags. `resolveRef()` turns a ref back into a
 * Playwright Locator.
 *
 * Refs are only valid until the next `distillPage()` call or a navigation —
 * both wipe/replace the `data-nf-ref` attributes.
 */
import type { Page, Locator } from 'playwright';
import type { DistilledElement, PageSnapshot } from '../contracts.js';

const OUTLINE_MAX = 15_000;
const TRUNCATION_MARKER = '...[truncated]';

/**
 * Mask shown instead of the real value of `input[type=password]` elements in
 * both `elements[]` and the outline. Real password values never leave the page.
 */
export const PASSWORD_MASK = '********';

/** Shape returned by the in-page walker. */
interface RawDistillResult {
  elements: DistilledElement[];
  text: string;
}

// ---------------------------------------------------------------------------
// Minimal structural DOM types — this package compiles without the "dom" lib,
// and the evaluate callback runs in the browser, so we describe just what the
// walker touches. Types are erased at runtime; the function stays serializable.
// ---------------------------------------------------------------------------
interface MinimalRect {
  width: number;
  height: number;
}
interface MinimalStyle {
  visibility: string;
  display: string;
  position: string;
  zIndex?: string;
}
interface MinimalElement {
  tagName: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getBoundingClientRect(): MinimalRect;
  matches(selector: string): boolean;
  shadowRoot?: MinimalShadowRoot | null;
  parentElement?: MinimalElement | null;
  getRootNode?(): { host?: MinimalElement | null } | undefined;
  offsetParent?: unknown;
  innerText?: string;
  href?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  type?: string;
}
interface MinimalNodeList {
  length: number;
  [index: number]: MinimalElement | undefined;
}
interface MinimalShadowRoot {
  querySelectorAll(selector: string): MinimalNodeList;
}
interface MinimalDocument {
  querySelectorAll(selector: string): MinimalNodeList;
  body: MinimalElement | null;
}
interface MinimalWindow {
  document: MinimalDocument;
  getComputedStyle(el: MinimalElement): MinimalStyle;
}

/**
 * Distill the current page into a `PageSnapshot`: interactive elements with
 * stable refs, a flat compact outline, and the trimmed visible text.
 *
 * Side effect: writes `data-nf-ref` attributes into the DOM (removing any
 * left over from a previous distill). Refs become stale on the next
 * `distillPage()` or navigation.
 */
export async function distillPage(page: Page): Promise<PageSnapshot> {
  let raw: RawDistillResult;
  try {
    // Self-contained walker — no closure over Node scope; it is serialized
    // and executed inside the browser.
    raw = await page.evaluate((passwordMask: string): RawDistillResult => {
      const win = globalThis as unknown as MinimalWindow;
      const doc = win.document;

      const isPasswordInput = (el: MinimalElement): boolean =>
        el.tagName.toLowerCase() === 'input' &&
        (el.getAttribute('type') || '').toLowerCase() === 'password';

      const NAME_LIMIT = 120;
      const TEXT_LIMIT = 12000;
      const MARKER = '...[truncated]';

      // (1+2 prep) Deep walk: document order, descending into open shadow
      // roots (consent banners and design-system widgets often live there;
      // Playwright locators pierce shadow DOM, so refs stay clickable).
      // Also strips stale refs from a previous distill in the same pass.
      const collectDeep = (
        root: MinimalDocument | MinimalShadowRoot,
        selector: string,
        out: MinimalElement[],
      ): void => {
        const all = root.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          if (!el) continue;
          if (el.getAttribute('data-nf-ref') !== null) el.removeAttribute('data-nf-ref');
          if (el.matches(selector)) out.push(el);
          if (el.shadowRoot) collectDeep(el.shadowRoot, selector, out);
        }
      };

      // (2) Select interactive elements + structural landmarks, in document
      // order (querySelectorAll guarantees order and dedupes).
      const selector = [
        'a[href]',
        'button',
        'input',
        'select',
        'textarea',
        '[role="button"]',
        '[role="link"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="combobox"]',
        '[role="textbox"]',
        '[role="searchbox"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[onclick]',
        '[contenteditable]:not([contenteditable="false"])',
        'h1',
        'h2',
        'h3',
        'h4',
        '[role="navigation"]',
        '[role="main"]',
      ].join(', ');
      const candidates: MinimalElement[] = [];
      collectDeep(doc, selector, candidates);

      // (3) Visibility: skip hidden / zero-sized / detached-from-layout
      // elements, except position:fixed (offsetParent is null for those).
      const isVisible = (el: MinimalElement): boolean => {
        const style = win.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        if (el.offsetParent === null && style.position !== 'fixed') return false;
        return true;
      };

      // Overlay detection: an element inside an open dialog/modal or a
      // fixed-position high-z-index layer (cookie banners, popups). These are
      // surfaced FIRST in the outline so truncation never hides them — when a
      // modal is open it is usually the only actionable thing on the page.
      const isOverlay = (el: MinimalElement): boolean => {
        let node: MinimalElement | null | undefined = el;
        let depth = 0;
        while (node && depth < 50) {
          const role = node.getAttribute('role');
          if (role === 'dialog' || role === 'alertdialog') return true;
          if (node.getAttribute('aria-modal') === 'true') return true;
          if (node.tagName.toLowerCase() === 'dialog') return true;
          const style = win.getComputedStyle(node);
          const z = Number(style.zIndex);
          if (style.position === 'fixed' && Number.isFinite(z) && z >= 10) return true;
          node =
            node.parentElement ?? (node.getRootNode ? (node.getRootNode()?.host ?? null) : null);
          depth += 1;
        }
        return false;
      };

      const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
      const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);

      const deriveRole = (el: MinimalElement, tag: string): string => {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit;
        if (tag === 'a') return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') return 'heading';
        if (tag === 'input') {
          const type = (el.getAttribute('type') || 'text').toLowerCase();
          if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') {
            return 'button';
          }
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          return 'textbox';
        }
        return 'generic';
      };

      const deriveName = (el: MinimalElement): string => {
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel && ariaLabel.trim()) return clip(collapse(ariaLabel), NAME_LIMIT);
        const alt = el.getAttribute('alt');
        if (alt && alt.trim()) return clip(collapse(alt), NAME_LIMIT);
        const text = typeof el.innerText === 'string' ? el.innerText : '';
        if (text.trim()) return clip(collapse(text), NAME_LIMIT);
        const placeholder = el.getAttribute('placeholder');
        if (placeholder && placeholder.trim()) return clip(collapse(placeholder), NAME_LIMIT);
        // Never fall back to the value of a password input — it is a secret.
        if (!isPasswordInput(el) && typeof el.value === 'string' && el.value.trim()) {
          return clip(collapse(el.value), NAME_LIMIT);
        }
        return '';
      };

      // (4)+(5) Assign refs, collect element descriptors.
      const elements: Array<{
        ref: string;
        role: string;
        name: string;
        tag: string;
        href?: string;
        value?: string;
        checked?: boolean;
        disabled?: boolean;
        overlay?: boolean;
      }> = [];
      let counter = 0;

      for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        if (!el || !isVisible(el)) continue;

        counter += 1;
        const ref = 'e' + counter;
        el.setAttribute('data-nf-ref', ref);

        const tag = el.tagName.toLowerCase();
        const role = deriveRole(el, tag);

        const entry: (typeof elements)[number] = {
          ref,
          role,
          name: deriveName(el),
          tag,
        };

        // `href` on anchors is the resolved absolute URL.
        if (tag === 'a' && typeof el.href === 'string' && el.href) {
          entry.href = el.href;
        }
        if (
          (tag === 'input' || tag === 'select' || tag === 'textarea') &&
          typeof el.value === 'string'
        ) {
          const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
          if (type === 'password') {
            // Redact: a non-empty mask signals "filled in" without leaking
            // the value (or even its length).
            entry.value = el.value.length > 0 ? passwordMask : '';
          } else if (type !== 'checkbox' && type !== 'radio') {
            entry.value = clip(el.value, NAME_LIMIT);
          }
        }
        if (role === 'checkbox' || role === 'radio') {
          entry.checked =
            typeof el.checked === 'boolean'
              ? el.checked
              : el.getAttribute('aria-checked') === 'true';
        }
        if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') {
          entry.disabled = true;
        }
        if (isOverlay(el)) {
          entry.overlay = true;
        }

        elements.push(entry);
      }

      // (6) Visible page text, normalized and capped.
      const bodyText = doc.body && typeof doc.body.innerText === 'string' ? doc.body.innerText : '';
      let text = bodyText
        .replace(/[^\S\n]+/g, ' ') // collapse spaces/tabs (keep newlines)
        .replace(/ ?\n ?/g, '\n') // strip space padding around newlines
        .replace(/\n{3,}/g, '\n\n') // collapse 3+ newlines
        .trim();
      if (text.length > TEXT_LIMIT) {
        text = text.slice(0, TEXT_LIMIT) + MARKER;
      }

      return { elements, text };
    }, PASSWORD_MASK);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `distillPage failed on ${page.url()}: ${reason}. ` +
        'The page may have navigated mid-distill or blocked script evaluation.',
      { cause: err },
    );
  }

  return {
    url: page.url(),
    title: await page.title(),
    outline: buildOutline(raw.elements),
    elements: raw.elements,
    text: raw.text,
  };
}

/**
 * Build the flat, compact outline string from distilled elements.
 * Pure function (no browser needed); exported for direct testing.
 */
export function buildOutline(elements: DistilledElement[]): string {
  const overlayLines: string[] = [];
  const pageLines: string[] = [];
  for (const el of elements) {
    (el.overlay ? overlayLines : pageLines).push(formatOutlineLine(el));
  }
  // Overlay/dialog elements first: they usually block the page, and putting
  // them up front guarantees the outline cap can never truncate them away.
  const lines = overlayLines.length
    ? [
        '--- overlay / dialog elements (these may block the page; deal with them first) ---',
        ...overlayLines,
        '--- main page elements ---',
        ...pageLines,
      ]
    : pageLines;
  let outline = '';
  for (const line of lines) {
    const next = outline ? `${outline}\n${line}` : line;
    if (next.length > OUTLINE_MAX) {
      return `${outline}\n${TRUNCATION_MARKER}`;
    }
    outline = next;
  }
  return outline;
}

function formatOutlineLine(el: DistilledElement): string {
  if (el.role === 'heading') {
    return `## heading "${el.name}"`;
  }
  let line = `[${el.ref}] ${el.role} "${el.name}"`;
  if (el.href !== undefined) line += ` -> ${el.href}`;
  if (el.value !== undefined) line += ` value="${el.value}"`;
  if (el.checked !== undefined) line += el.checked ? ' (checked)' : ' (unchecked)';
  if (el.disabled) line += ' (disabled)';
  return line;
}

/**
 * Resolve a ref from the latest `distillPage()` snapshot to a Locator.
 *
 * Refs are valid only until the next `distillPage()` call or a navigation;
 * after either, re-distill and use the fresh refs.
 */
export function resolveRef(page: Page, ref: string): Locator {
  if (!/^e\d+$/.test(ref)) {
    throw new Error(
      `Invalid element ref "${ref}": expected the "e<number>" form produced by distillPage() (e.g. "e12").`,
    );
  }
  return page.locator(`[data-nf-ref="${ref}"]`);
}

// Compile-time conformance with the shared contracts.
import type { DistillPageFn, ResolveRefFn } from '../contracts.js';
const _distillCheck: DistillPageFn = distillPage;
const _resolveCheck: ResolveRefFn = resolveRef;
void _distillCheck;
void _resolveCheck;
