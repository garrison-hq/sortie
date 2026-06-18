/**
 * Shared challenge / CAPTCHA detection module (T004).
 *
 * Single source of truth for all challenge-detection logic. Used by:
 *  - `search/engines.ts`  — SERP bot-wall detection (was inline there)
 *  - `agent/loop.ts`      — page-level challenge detection while running (WP03)
 *
 * IMPORTANT — C-001: this module ONLY detects challenges, it never attempts
 * to solve or bypass them.
 */
import type { Page } from 'playwright';
import type { ChallengeDetection, ChallengeFamily, PageSnapshot } from '../contracts.js';

// ---------------------------------------------------------------------------
// Marker / signal constants — single source of truth
// ---------------------------------------------------------------------------

/** How much body text (chars) to inspect for markers. */
const CHALLENGE_TEXT_LIMIT = 4_000;

/** Hard cap for each page.evaluate detection probe — a probe must never be able
 * to freeze the agent loop if the page is in a stuck/busy state. */
const DETECT_EVAL_TIMEOUT_MS = 4_000;

/** reCAPTCHA frame URL fragments. */
const RECAPTCHA_FRAME_PATTERNS = ['recaptcha.net/recaptcha', 'google.com/recaptcha'] as const;

/** hCaptcha frame URL fragment. */
const HCAPTCHA_FRAME_PATTERN = 'hcaptcha.com' as const;

/** Cloudflare Turnstile / challenge interstitial patterns. */
const CLOUDFLARE_FRAME_PATTERN = 'challenges.cloudflare.com' as const;
const CLOUDFLARE_BODY_MARKERS = ['cf-chl', 'checking your browser', 'just a moment'] as const;

/** Generic bot-wall text markers (case-insensitive).
 * Order matters: more-specific tokens (grecaptcha, recaptcha, hcaptcha) must
 * come before the shorter 'captcha' substring so classifyGenericMarker assigns
 * the correct family when the page only contains, e.g., "grecaptcha". */
const GENERIC_MARKERS = [
  'grecaptcha',
  'recaptcha',
  'hcaptcha',
  'captcha',
  'unusual traffic',
  'are you a robot',
  'verify you are human',
  'verifying you are human',
  'verify you are not a robot',
] as const;

/** DuckDuckGo-specific anomaly modal marker. */
const DDG_ANOMALY_MARKER = 'bots use duckduckgo' as const;

/**
 * Full-page interstitial markers for the PAGE-AWARE path (agent loop).
 *
 * Deliberately EXCLUDES the bare service names ('recaptcha'/'grecaptcha'/
 * 'hcaptcha'/'captcha'): invisible reCAPTCHA v3 puts a "protected by reCAPTCHA"
 * badge + script on most ordinary login/form pages, so matching those words
 * caused the agent to pause on pages with no challenge to solve. These phrases
 * only appear on pages that are actually blocking the user.
 */
const INTERSTITIAL_MARKERS: ReadonlyArray<{ text: string; family: ChallengeFamily }> = [
  { text: 'cf-chl', family: 'cloudflare' },
  { text: 'checking your browser', family: 'cloudflare' },
  { text: 'just a moment', family: 'cloudflare' },
  { text: 'unusual traffic', family: 'generic' },
  { text: 'are you a robot', family: 'generic' },
  { text: 'verify you are human', family: 'generic' },
  { text: 'verifying you are human', family: 'generic' },
  { text: 'verify you are not a robot', family: 'generic' },
  { text: DDG_ANOMALY_MARKER, family: 'generic' },
];

// ---------------------------------------------------------------------------
// Pure detection function
// ---------------------------------------------------------------------------

export interface DetectChallengeInput {
  /** HTTP response status (0 if unavailable). */
  status: number;
  /** Page <title>. */
  title: string;
  /** Visible body text (any length — we cap internally). */
  bodyText: string;
  /** Current page URL. */
  url: string;
  /** iframe src URLs on the page (optional, enables frame-based detection). */
  frameUrls?: string[];
}

/**
 * Pure, synchronous challenge detector. Returns a `ChallengeDetection` when a
 * challenge is found, or `null` for a normal page.
 *
 * Check order: HTTP status → frame src → content markers.
 */
export function detectChallenge(input: DetectChallengeInput): ChallengeDetection | null {
  const { status, title, bodyText, frameUrls = [] } = input;

  // 1. HTTP-status gate — 403/429 are definitive regardless of content.
  if (status === 403 || status === 429) {
    return {
      detected: true,
      family: 'http',
      signal: `HTTP ${status}`,
      via: 'http',
    };
  }

  // 2. Frame-URL inspection (highest fidelity for JS-rendered challenges).
  for (const src of frameUrls) {
    const lower = src.toLowerCase();

    if (RECAPTCHA_FRAME_PATTERNS.some((p) => lower.includes(p))) {
      return { detected: true, family: 'recaptcha', signal: src, via: 'frame' };
    }
    if (lower.includes(HCAPTCHA_FRAME_PATTERN)) {
      return { detected: true, family: 'hcaptcha', signal: src, via: 'frame' };
    }
    if (lower.includes(CLOUDFLARE_FRAME_PATTERN)) {
      return { detected: true, family: 'turnstile', signal: src, via: 'frame' };
    }
  }

  // 3. Content inspection (title + capped body text).
  const haystack = `${title}\n${bodyText.slice(0, CHALLENGE_TEXT_LIMIT)}`.toLowerCase();

  // Cloudflare body markers (interstitials that don't use an iframe).
  for (const marker of CLOUDFLARE_BODY_MARKERS) {
    if (haystack.includes(marker)) {
      return { detected: true, family: 'cloudflare', signal: marker, via: 'content' };
    }
  }

  // DuckDuckGo anomaly modal.
  if (haystack.includes(DDG_ANOMALY_MARKER)) {
    return { detected: true, family: 'generic', signal: DDG_ANOMALY_MARKER, via: 'content' };
  }

  // Generic markers — covers reCAPTCHA/hCaptcha titles, "unusual traffic", etc.
  for (const marker of GENERIC_MARKERS) {
    if (haystack.includes(marker)) {
      return classifyGenericMarker(marker);
    }
  }

  return null;
}

/** Map a generic text marker to the most specific family we can infer. */
function classifyGenericMarker(marker: string): ChallengeDetection {
  let family: ChallengeFamily = 'generic';
  if (marker === 'recaptcha' || marker === 'grecaptcha') family = 'recaptcha';
  else if (marker === 'hcaptcha') family = 'hcaptcha';
  return { detected: true, family, signal: marker, via: 'marker' };
}

// ---------------------------------------------------------------------------
// Minimal DOM interface types for page.evaluate callbacks
// (same pattern as search/engines.ts — this package excludes the "dom" lib)
// ---------------------------------------------------------------------------

interface MinimalRect {
  width: number;
  height: number;
}
interface MinimalStyle {
  display: string;
  visibility: string;
  opacity: string;
}
interface MinimalElement {
  getAttribute(name: string): string | null;
  getBoundingClientRect(): MinimalRect;
  /** Present on form fields (e.g. the reCAPTCHA response token textarea). */
  value?: string;
}
interface MinimalNodeList {
  length: number;
  [index: number]: MinimalElement | undefined;
  [Symbol.iterator](): Iterator<MinimalElement>;
}
interface MinimalBody {
  innerText?: string;
}
interface MinimalDocument {
  querySelectorAll(selector: string): MinimalNodeList;
  body: MinimalBody | null;
}
interface MinimalWindow {
  document: MinimalDocument;
  getComputedStyle(element: MinimalElement): MinimalStyle;
}

// ---------------------------------------------------------------------------
// Page-aware wrapper
// ---------------------------------------------------------------------------

/**
 * Page-aware wrapper: reads HTTP status, title, body text, and iframe src
 * attributes from the live Playwright page, then delegates to `detectChallenge`.
 *
 * Falls back gracefully — if `page.evaluate` throws (e.g. page crashed), the
 * text/frame inputs are treated as empty and detection continues.
 */
export async function detectChallengeOnPage(
  page: Page,
  snapshot: PageSnapshot,
): Promise<ChallengeDetection | null> {
  // 1. Look for an ACTUAL interactive challenge widget that is VISIBLE on the
  //    page. This is the key guard against invisible reCAPTCHA v3: that variant
  //    injects a `…/recaptcha/…anchor?…size=invisible` iframe (the "protected by
  //    reCAPTCHA" badge) on most login/form pages, with nothing for a human to
  //    solve. We must NOT pause on it — only on a rendered checkbox, the image
  //    challenge (bframe), or a visible hCaptcha/Turnstile widget.
  let widget: { family: ChallengeFamily; signal: string } | null = null;
  try {
    const probe = page.evaluate((): { family: ChallengeFamily; signal: string } | null => {
      const win = globalThis as unknown as MinimalWindow;
      const isVisible = (el: MinimalElement): boolean => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 40 || rect.height < 40) return false;
        const style = win.getComputedStyle(el);
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') !== 0
        );
      };
      // A reCAPTCHA whose response token is populated has been SOLVED — it is no
      // longer a challenge even though the widget stays on screen (a v2 checkbox
      // keeps its green check). Treat it as cleared so a resume can continue
      // instead of re-pausing on the same solved widget.
      const recaptchaSolved = (): boolean => {
        for (const t of win.document.querySelectorAll('textarea[name="g-recaptcha-response"]')) {
          if ((t.value ?? '').length > 0) return true;
        }
        return false;
      };
      // Classify a single visible iframe src into a challenge family, or null.
      const classify = (
        src: string,
        rcSolved: boolean,
      ): { family: ChallengeFamily; signal: string } | null => {
        const rc =
          !rcSolved &&
          (src.includes('recaptcha.net/recaptcha') || src.includes('google.com/recaptcha'));
        if (rc && src.includes('bframe'))
          return { family: 'recaptcha', signal: 'reCAPTCHA image challenge visible' };
        if (rc && src.includes('anchor') && !src.includes('size=invisible'))
          return { family: 'recaptcha', signal: 'reCAPTCHA checkbox visible' };
        if (src.includes('hcaptcha.com'))
          return { family: 'hcaptcha', signal: 'hCaptcha widget visible' };
        if (src.includes('challenges.cloudflare.com'))
          return { family: 'turnstile', signal: 'Cloudflare Turnstile widget visible' };
        return null;
      };
      const solved = recaptchaSolved();
      for (const frame of win.document.querySelectorAll('iframe[src]')) {
        if (!isVisible(frame)) continue;
        const hit = classify((frame.getAttribute('src') ?? '').toLowerCase(), solved);
        if (hit) return hit;
      }
      return null;
    });
    // Never let a detection probe freeze the loop — cap it.
    widget = (await Promise.race([
      probe,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), DETECT_EVAL_TIMEOUT_MS)),
    ])) as { family: ChallengeFamily; signal: string } | null;
  } catch {
    // Non-fatal — fall through to the interstitial text check.
  }
  if (widget) {
    return { detected: true, family: widget.family, signal: widget.signal, via: 'frame' };
  }

  // 2. Full-page interstitials (Cloudflare "just a moment", "verify you are
  //    human", "unusual traffic", …) that block the whole page. We do NOT match
  //    bare service names here (see INTERSTITIAL_MARKERS note).
  let bodyText = '';
  try {
    const probe = page.evaluate((limit: number): string => {
      const doc = (globalThis as unknown as MinimalWindow).document;
      const text = doc.body && typeof doc.body.innerText === 'string' ? doc.body.innerText : '';
      return text.slice(0, limit);
    }, CHALLENGE_TEXT_LIMIT);
    bodyText = await Promise.race([
      probe,
      new Promise<string>((resolve) => setTimeout(() => resolve(''), DETECT_EVAL_TIMEOUT_MS)),
    ]);
  } catch {
    // Non-fatal.
  }
  const haystack = `${snapshot.title}\n${bodyText}`.toLowerCase();
  for (const { text, family } of INTERSTITIAL_MARKERS) {
    if (haystack.includes(text)) {
      return { detected: true, family, signal: text, via: 'content' };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Search-engine compatibility helpers (used by search/engines.ts — T005)
// ---------------------------------------------------------------------------

/**
 * Convert a `ChallengeDetection` to the short human-readable reason string
 * that `SearchChallengeError` has always expected.
 *
 * Preserves exact wording for DuckDuckGo anomaly and HTTP-status messages so
 * existing `search/engines.test.ts` assertions stay green.
 */
export function detectionToReason(detection: ChallengeDetection): string {
  if (detection.via === 'http') {
    return `HTTP ${detection.signal.replace('HTTP ', '')} (blocked or rate-limited)`;
  }
  if (detection.signal === DDG_ANOMALY_MARKER) {
    return 'DuckDuckGo anomaly challenge modal';
  }
  return `challenge page detected ("${detection.signal}")`;
}

/**
 * Engine-aware wrapper used by `search/engines.ts`.
 *
 * Adds engine-specific signals (DuckDuckGo HTTP 202) on top of the shared
 * detector, then converts the result to the legacy `string | null` shape that
 * `SearchChallengeError` accepts.
 */
export function detectChallengeForEngine(
  engine: string,
  status: number,
  title: string,
  bodyText: string,
): string | null {
  // Engine-specific pre-check: DDG HTTP 202 is a bot challenge.
  if (engine === 'duckduckgo' && status === 202) {
    return 'HTTP 202 (DuckDuckGo bot challenge)';
  }

  const detection = detectChallenge({ status, title, bodyText, url: '' });
  if (!detection) return null;

  return detectionToReason(detection);
}
